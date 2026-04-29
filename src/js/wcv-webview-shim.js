/**
 * Navio Browser — WebviewShim (Phase 1 WCV migration)
 *
 * Makes WebContentsView tabs look like `<webview>` DOM elements to tabs.js,
 * allowing Phase 1 to migrate tab ownership to the main process with minimal
 * changes to the 3,348-line renderer code.
 *
 * The shim:
 *   - Extends EventTarget — addEventListener/removeEventListener work natively.
 *   - Intercepts webview-style method calls and routes them to the main process
 *     via window.navio.wcv* IPC wrappers.
 *   - Receives tab events via window.navio.onWcvTabEvent and re-dispatches them
 *     as CustomEvents so bindWebviewEvents() in tabs.js works unchanged.
 *   - StyleProxy: intercepts style.width/height/top/left → wcvSetBounds.
 *   - FakeClassList: intercepts classList.toggle('active') → wcvSwitchTab.
 *   - parentNode proxy: routes removeChild → wcvCloseTab (main destroys WCV).
 */

'use strict';

// ── FakeClassList ─────────────────────────────────────────────────────────────

class FakeClassList {
  constructor(onChange) {
    this._set = new Set();
    this._onChange = onChange || (() => {});
  }

  toggle(name, force) {
    const prev = this._set.has(name);
    const next = force !== undefined ? !!force : !prev;
    if (next) this._set.add(name);
    else this._set.delete(name);
    if (prev !== next) this._onChange(name, next);
    return next;
  }

  add(...names) { names.forEach(n => this._set.add(n)); }
  remove(...names) { names.forEach(n => { this._set.delete(n); this._onChange(n, false); }); }
  has(name) { return this._set.has(name); }
  contains(name) { return this._set.has(name); }
}

// ── StyleProxy ────────────────────────────────────────────────────────────────

class StyleProxy {
  constructor(shim) {
    this._shim = shim;
    this._props = { top: '0px', left: '0px', right: 'auto', bottom: 'auto', width: '0px', height: '0px', maxWidth: '' };
    this._pending = false;
  }

  get top() { return this._props.top; }
  set top(v) { this._props.top = String(v); this._schedule(); }

  get left() { return this._props.left; }
  set left(v) { this._props.left = String(v); this._schedule(); }

  get right() { return this._props.right; }
  set right(v) { this._props.right = String(v); }

  get bottom() { return this._props.bottom; }
  set bottom(v) { this._props.bottom = String(v); }

  get width() { return this._props.width; }
  set width(v) { this._props.width = String(v); this._schedule(); }

  get height() { return this._props.height; }
  set height(v) { this._props.height = String(v); this._schedule(); }

  get maxWidth() { return this._props.maxWidth; }
  set maxWidth(v) { this._props.maxWidth = String(v); }

  _schedule() {
    if (this._pending) return;
    this._pending = true;
    // queueMicrotask runs before the next paint — bounds are applied this frame
    queueMicrotask(() => {
      this._pending = false;
      this._flush();
    });
  }

  _flush() {
    const w = parseFloat(this._props.width) || 0;
    const h = parseFloat(this._props.height) || 0;
    const cl = this._shim.classList;
    const isVisible = cl.has('active') || cl.has('split-visible');

    if (!w || !h || !isVisible) {
      // Hide the WCV if this tab isn't visible
      if (window.navio && window.navio.wcvSetBounds) {
        window.navio.wcvSetBounds(this._shim._tabId, { x: 0, y: 0, width: 0, height: 0 });
      }
      return;
    }

    let x = 0, y = 0;
    try {
      const container = this._shim._getContainer && this._shim._getContainer();
      if (container) {
        const rect = container.getBoundingClientRect();
        x = rect.left + (parseFloat(this._props.left) || 0);
        y = rect.top + (parseFloat(this._props.top) || 0);
      }
    } catch { /* ignore */ }

    if (window.navio && window.navio.wcvSetBounds) {
      window.navio.wcvSetBounds(this._shim._tabId, {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(w),
        height: Math.round(h)
      });
    }
  }

  /** Re-flush bounds without rescheduling (called when classList changes to 'active'). */
  flushNow() {
    this._pending = false;
    this._flush();
  }
}

// ── WebviewShim ────────────────────────────────────────────────────────────────

class WebviewShim extends EventTarget {
  /**
   * @param {string} tabId           Stable renderer tab ID (e.g. "tab-3")
   * @param {number} webContentsId   Integer WebContents ID from tab-manager
   * @param {object} opts
   * @param {Function} opts.getContainer  Returns the #browser-container DOM element
   */
  constructor(tabId, webContentsId, opts = {}) {
    super();

    this._tabId = tabId;
    this._webContentsId = webContentsId;
    this._getContainer = opts.getContainer || (() => null);

    // webview compatibility flags (read/written by bindWebviewEvents)
    this._domReady = false;
    this._pendingUrl = null;

    // Fake DOM node identity
    this.id = `wv-${tabId}`;
    this.tagName = 'WEBVIEWSHIM';
    this.nodeType = 1;

    // Cached state updated from navigation events (avoids sync IPC on every call)
    this._currentUrl = '';
    this._canGoBack = false;
    this._canGoForward = false;

    // Container reference (set via _setParent when tabs.js "appends" the shim)
    this._containerRef = null;

    // Proxies for webview DOM API surface
    this.style = new StyleProxy(this);
    this.classList = new FakeClassList((name, isAdded) => this._onClassToggle(name, isAdded));

    // Subscribe to wcv-tab-event stream
    this._unsubscribeFn = null;
    this._subscribeTaEvents();
  }

  // ── Tab Event Subscription ───────────────────────────────────────────────────

  _subscribeTaEvents() {
    if (!window.navio || typeof window.navio.onWcvTabEvent !== 'function') return;
    this._unsubscribeFn = window.navio.onWcvTabEvent((ev) => {
      if (ev.tabId !== this._tabId) return;
      this._onTabEvent(ev);
    });
  }

  _onTabEvent(ev) {
    // Update cached nav state whenever the event carries it
    if (ev.canGoBack !== undefined) this._canGoBack = !!ev.canGoBack;
    if (ev.canGoForward !== undefined) this._canGoForward = !!ev.canGoForward;

    switch (ev.type) {
      case 'dom-ready': {
        this._domReady = true;
        if (this._pendingUrl) {
          const url = this._pendingUrl;
          this._pendingUrl = null;
          queueMicrotask(() => this.loadURL(url).catch(() => {}));
        }
        this.dispatchEvent(new CustomEvent('dom-ready'));
        break;
      }
      case 'did-start-loading':
        this.dispatchEvent(new CustomEvent('did-start-loading'));
        break;
      case 'did-stop-loading':
        this.dispatchEvent(new CustomEvent('did-stop-loading'));
        break;
      case 'did-finish-load': {
        if (ev.url) this._currentUrl = ev.url;
        this.dispatchEvent(new CustomEvent('did-finish-load'));
        break;
      }
      case 'did-fail-load': {
        const e = new CustomEvent('did-fail-load');
        e.errorCode = ev.errorCode;
        e.errorDescription = ev.errorDescription || '';
        e.validatedURL = ev.validatedURL || '';
        e.isMainFrame = ev.isMainFrame !== false;
        this.dispatchEvent(e);
        break;
      }
      case 'did-navigate': {
        this._currentUrl = ev.url || '';
        const e = new CustomEvent('did-navigate');
        e.url = ev.url || '';
        e.isMainFrame = ev.isMainFrame !== false;
        this.dispatchEvent(e);
        break;
      }
      case 'did-navigate-in-page': {
        if (ev.isMainFrame) this._currentUrl = ev.url || '';
        const e = new CustomEvent('did-navigate-in-page');
        e.url = ev.url || '';
        e.isMainFrame = !!ev.isMainFrame;
        this.dispatchEvent(e);
        break;
      }
      case 'page-title-updated': {
        const e = new CustomEvent('page-title-updated');
        e.title = ev.title || '';
        this.dispatchEvent(e);
        break;
      }
      case 'page-favicon-updated': {
        const e = new CustomEvent('page-favicon-updated');
        e.favicons = ev.favicons || [];
        this.dispatchEvent(e);
        break;
      }
      case 'render-process-gone': {
        const e = new CustomEvent('render-process-gone');
        e.reason = ev.reason || 'crashed';
        e.details = { reason: e.reason };
        this.dispatchEvent(e);
        // tabs.js also listens for legacy 'crashed' event
        const e2 = new CustomEvent('crashed');
        e2.reason = ev.reason || 'crashed';
        this.dispatchEvent(e2);
        break;
      }
      case 'unresponsive':
        this.dispatchEvent(new CustomEvent('unresponsive'));
        break;
      case 'responsive':
        this.dispatchEvent(new CustomEvent('responsive'));
        break;
      case 'media-started-playing':
        this.dispatchEvent(new CustomEvent('media-started-playing'));
        break;
      case 'media-paused':
        this.dispatchEvent(new CustomEvent('media-paused'));
        break;
      case 'context-menu': {
        const e = new CustomEvent('context-menu');
        e.preventDefault = () => {};
        e.x = ev.x;
        e.y = ev.y;
        e.params = ev.params || {};
        this.dispatchEvent(e);
        break;
      }
      case 'ipc-message': {
        // Forwarded from tab preload via wcv-tab-preload-message IPC
        const e = new CustomEvent('ipc-message');
        e.channel = ev.channel || '';
        e.args = ev.args || [];
        this.dispatchEvent(e);
        break;
      }
      default:
        break;
    }
  }

  // ── classList callback ────────────────────────────────────────────────────────

  _onClassToggle(name, isAdded) {
    if (name === 'active') {
      if (isAdded) {
        // Tab becoming active — tell main to show it, then apply current bounds
        if (window.navio && window.navio.wcvSwitchTab) {
          window.navio.wcvSwitchTab(this._tabId);
        }
        // Immediately push current bounds (in case _syncWebviewSizes set them earlier)
        this.style.flushNow();
      } else {
        // Tab deactivated — hide it
        if (window.navio && window.navio.wcvSetBounds) {
          window.navio.wcvSetBounds(this._tabId, { x: 0, y: 0, width: 0, height: 0 });
        }
      }
    }
  }

  // ── parentNode proxy ──────────────────────────────────────────────────────────

  /**
   * Called by tabs.js instead of container.appendChild(shim) since
   * the shim is not a real DOM node.
   */
  _setParent(container) {
    this._containerRef = container;
  }

  /**
   * tabs.js calls: if (tab.webview && tab.webview.parentNode)
   * and:           tab.webview.parentNode.removeChild(tab.webview)
   */
  get parentNode() {
    if (!this._containerRef) return null;
    const tabId = this._tabId;
    const shim = this;
    return {
      removeChild(child) {
        if (child !== shim) return;
        shim._containerRef = null;
        shim.destroy();
        if (window.navio && window.navio.wcvCloseTab) {
          window.navio.wcvCloseTab(tabId);
        }
      }
    };
  }

  // ── WebContents identity ──────────────────────────────────────────────────────

  getWebContentsId() {
    return this._webContentsId;
  }

  /**
   * tabs.js calls wv.getWebContents() for navigationHistory.canGoBack checks.
   * Returns a lightweight proxy with the same interface.
   */
  getWebContents() {
    const shim = this;
    return {
      id: shim._webContentsId,
      navigationHistory: {
        canGoBack:   () => shim._canGoBack,
        canGoForward:() => shim._canGoForward,
        goBack:      () => window.navio?.wcvGoBack?.(shim._tabId),
        goForward:   () => window.navio?.wcvGoForward?.(shim._tabId)
      },
      canGoBack:   () => shim._canGoBack,
      canGoForward:() => shim._canGoForward
    };
  }

  // ── Navigation methods ────────────────────────────────────────────────────────

  loadURL(url) {
    if (window.navio && window.navio.wcvNavigate) {
      window.navio.wcvNavigate(this._tabId, url);
    }
    return Promise.resolve();
  }

  getURL() {
    return this._currentUrl || '';
  }

  canGoBack()    { return this._canGoBack; }
  canGoForward() { return this._canGoForward; }

  goBack() {
    if (window.navio && window.navio.wcvGoBack) window.navio.wcvGoBack(this._tabId);
  }

  goForward() {
    if (window.navio && window.navio.wcvGoForward) window.navio.wcvGoForward(this._tabId);
  }

  reload() {
    if (window.navio && window.navio.wcvReload) window.navio.wcvReload(this._tabId, false);
  }

  reloadIgnoringCache() {
    if (window.navio && window.navio.wcvReload) window.navio.wcvReload(this._tabId, true);
  }

  stop() {
    if (window.navio && window.navio.wcvStop) window.navio.wcvStop(this._tabId);
  }

  focus() {
    if (window.navio && window.navio.wcvFocus) window.navio.wcvFocus(this._tabId);
  }

  setAudioMuted(muted) {
    if (window.navio && window.navio.wcvSetMuted) window.navio.wcvSetMuted(this._tabId, !!muted);
  }

  /**
   * Send a message to this tab's preload script.
   * Replaces the classic webview.send(channel, ...args) API.
   * Routes through main process: renderer → ipcMain → wc.send() → tab preload.
   */
  send(channel, ...args) {
    if (window.navio && window.navio.wcvSendToTab) {
      window.navio.wcvSendToTab(this._tabId, channel, ...args);
    }
  }

  // ── DOM compatibility ─────────────────────────────────────────────────────────

  /**
   * InlineAI toolbar uses wv.getBoundingClientRect() to position the selection toolbar.
   * Return the container rect as a fallback.
   */
  getBoundingClientRect() {
    try {
      const container = this._getContainer && this._getContainer();
      if (container) return container.getBoundingClientRect();
    } catch { /* ignore */ }
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  /** No-op: the shim has no real DOM presence. */
  remove() {}

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  destroy() {
    if (this._unsubscribeFn) {
      try { this._unsubscribeFn(); } catch { /* ignore */ }
      this._unsubscribeFn = null;
    }
  }
}

// Expose globally so tabs.js can reference it without a module import
if (typeof window !== 'undefined') {
  window.WebviewShim = WebviewShim;
}
