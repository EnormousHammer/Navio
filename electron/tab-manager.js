'use strict';

/**
 * Navio Browser — Tab Manager (Phase 1 WebContentsView migration)
 *
 * Manages tab lifecycle using WebContentsView (WCV) in the main process.
 * Each tab is a first-class WebContents owned here — no webview renderer
 * indirection. Exposes an IPC surface that the renderer shell (src/js/tabs.js)
 * uses via the WebviewShim adapter.
 *
 * IPC channels (renderer → main):
 *   wcv-create-tab    (sendSync) → { tabId, webContentsId }
 *   wcv-switch-tab    (send)     tabId
 *   wcv-close-tab     (send)     tabId
 *   wcv-navigate      (send)     { tabId, url }
 *   wcv-go-back       (send)     tabId
 *   wcv-go-forward    (send)     tabId
 *   wcv-reload        (send)     { tabId, ignoreCache }
 *   wcv-stop          (send)     tabId
 *   wcv-focus         (send)     tabId
 *   wcv-set-muted     (send)     { tabId, muted }
 *   wcv-set-bounds    (send)     { tabId, bounds: { x, y, width, height } }
 *   wcv-discard-tab   (send)     tabId
 *   wcv-restore-tab   (send)     tabId
 *   wcv-get-url       (sendSync) tabId → string
 *   wcv-can-go-back   (sendSync) tabId → boolean
 *   wcv-can-go-forward(sendSync) tabId → boolean
 *   wcv-send-to-tab   (send)     { tabId, channel, args }
 *   wcv-execute-javascript (invoke) { tabId, code } → result of wc.executeJavaScript(code)
 *
 * IPC channels (main → renderer):
 *   wcv-tab-event { tabId, type, ...payload }
 *     types: dom-ready, did-start-loading, did-stop-loading, did-finish-load,
 *            did-fail-load, did-navigate, did-navigate-in-page,
 *            page-title-updated, page-favicon-updated,
 *            render-process-gone, unresponsive, responsive,
 *            media-started-playing, media-paused, context-menu, ipc-message
 *
 * IPC from tab preload → main → renderer:
 *   wcv-tab-preload-message { tabId, channel, args } (from tab preload → main)
 *   Main forwards as wcv-tab-event { type: 'ipc-message', ... } to renderer
 */

const { WebContentsView, ipcMain, session } = require('electron');
const path = require('path');
const { wcCanGoBack, wcCanGoForward } = require('./wc-nav-history');
const { NAVIO_PARTITION_MAIN, NAVIO_PARTITION_INCOGNITO } = require('./navio-partitions');

class TabManager {
  constructor() {
    /** Main BrowserWindow — set in init() */
    this._win = null;

    /** Map<tabId, TabEntry> */
    this._tabs = new Map();

    /** tabId of the currently-visible tab (WCV with non-zero bounds) */
    this._activeTabId = null;

    /** Monotonically increasing tab counter */
    this._tabCounter = 0;

    /** Absolute path to webview-preload.js — injected into every WCV */
    this._preloadPath = null;

    /** IPC registered flag — only register once */
    this._ipcRegistered = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Initialise the tab manager for a window.
   * Must be called once after the BrowserWindow is created.
   */
  init(win, opts = {}) {
    this._win = win;
    this._preloadPath = opts.preloadPath || path.join(__dirname, 'webview-preload.js');

    /**
     * Optional hook called once per WCV WebContents immediately after events are
     * wired. Used by main.js to attach bindNavioGuestWindowOpenOnce (popup routing,
     * external protocol handling) and auto-dark-mode sync — the same setup that
     * installNavioWebviewGuestPopupRouting applies to classic <webview> WebContents
     * via did-attach-webview / web-contents-created.
     */
    this._onWcvWebContentsCreated = opts.onWcvWebContentsCreated || null;

    // Re-layout active tab on window resize
    win.on('resize', () => this._layoutAllTabs());
    win.on('maximize', () => this._layoutAllTabs());
    win.on('unmaximize', () => this._layoutAllTabs());
    win.on('restore', () => this._layoutAllTabs());
    win.on('enter-full-screen', () => this._layoutAllTabs());
    win.on('leave-full-screen', () => this._layoutAllTabs());

    this._registerIpc();
  }

  // ── IPC Registration ─────────────────────────────────────────────────────────

  _registerIpc() {
    if (this._ipcRegistered) return;
    this._ipcRegistered = true;

    // ── Synchronous IPC (renderer blocks waiting for return) ─────────────────
    ipcMain.on('wcv-create-tab', (event, opts) => {
      try {
        const result = this.createTab(opts.url || null, {
          incognito: !!opts.incognito,
          switchTo: opts.switchTo !== false,
          guestWindowOpen: !!opts.guestWindowOpen,
          tabId: opts.tabId || undefined
        });
        event.returnValue = result;
      } catch (err) {
        console.error('[tab-manager] wcv-create-tab error:', err.message);
        event.returnValue = null;
      }
    });

    ipcMain.on('wcv-get-url', (event, tabId) => {
      const wc = this._getWc(tabId);
      event.returnValue = wc ? (wc.getURL() || '') : '';
    });

    ipcMain.on('wcv-can-go-back', (event, tabId) => {
      const wc = this._getWc(tabId);
      event.returnValue = wc ? wcCanGoBack(wc) : false;
    });

    ipcMain.on('wcv-can-go-forward', (event, tabId) => {
      const wc = this._getWc(tabId);
      event.returnValue = wc ? wcCanGoForward(wc) : false;
    });

    // ── Fire-and-forget IPC ──────────────────────────────────────────────────
    ipcMain.on('wcv-switch-tab', (_event, tabId) => { this.switchTab(tabId); });

    ipcMain.on('wcv-close-tab', (_event, tabId) => { this.closeTab(tabId); });

    ipcMain.on('wcv-navigate', (_event, { tabId, url }) => {
      const wc = this._getWc(tabId);
      if (wc && url) wc.loadURL(url).catch(() => {});
    });

    ipcMain.on('wcv-go-back', (_event, tabId) => {
      const wc = this._getWc(tabId);
      if (!wc) return;
      const nh = wc.navigationHistory;
      if (nh && typeof nh.goBack === 'function') nh.goBack();
      else if (typeof wc.goBack === 'function') wc.goBack();
    });

    ipcMain.on('wcv-go-forward', (_event, tabId) => {
      const wc = this._getWc(tabId);
      if (!wc) return;
      const nh = wc.navigationHistory;
      if (nh && typeof nh.goForward === 'function') nh.goForward();
      else if (typeof wc.goForward === 'function') wc.goForward();
    });

    ipcMain.on('wcv-reload', (_event, { tabId, ignoreCache }) => {
      const wc = this._getWc(tabId);
      if (!wc) return;
      if (ignoreCache) wc.reloadIgnoringCache();
      else wc.reload();
    });

    ipcMain.on('wcv-stop', (_event, tabId) => {
      const wc = this._getWc(tabId);
      if (wc) wc.stop();
    });

    ipcMain.on('wcv-focus', (_event, tabId) => {
      const wc = this._getWc(tabId);
      if (wc) wc.focus();
    });

    ipcMain.on('wcv-set-muted', (_event, { tabId, muted }) => {
      const wc = this._getWc(tabId);
      if (wc) wc.setAudioMuted(!!muted);
    });

    ipcMain.on('wcv-set-bounds', (_event, { tabId, bounds }) => {
      const entry = this._tabs.get(tabId);
      if (!entry) return;
      const { x = 0, y = 0, width = 0, height = 0 } = bounds;
      if (width > 0 && height > 0) {
        entry.wcv.setBounds({
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height)
        });
        entry.lastBounds = { x, y, width, height };
      } else {
        entry.wcv.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        entry.lastBounds = null;
      }
    });

    ipcMain.on('wcv-discard-tab', (_event, tabId) => {
      const entry = this._tabs.get(tabId);
      if (!entry) return;
      const wc = entry.wcv.webContents;
      entry.discardUrl = wc.getURL() || entry.url || null;
      try {
        wc.forcefullyCrashRenderer();
      } catch { /* ignore */ }
    });

    ipcMain.on('wcv-restore-tab', (_event, tabId) => {
      const entry = this._tabs.get(tabId);
      if (!entry || !entry.discardUrl) return;
      const url = entry.discardUrl;
      entry.discardUrl = null;
      entry.wcv.webContents.loadURL(url).catch(() => {});
    });

    // Send a message from the renderer shell → a specific tab's preload (replaces webview.send())
    ipcMain.on('wcv-send-to-tab', (_event, { tabId, channel, args }) => {
      const wc = this._getWc(tabId);
      if (!wc) return;
      try {
        wc.send(channel, ...(Array.isArray(args) ? args : [args]));
      } catch { /* ignore */ }
    });

    /** Full-page AI chat (`_guestDeliver`) and other code paths call `<webview>.executeJavaScript`; WCV uses this. */
    ipcMain.handle('wcv-execute-javascript', async (_event, { tabId, code }) => {
      const wc = this._getWc(tabId);
      if (!wc || typeof wc.executeJavaScript !== 'function') {
        throw new Error('Tab webContents not available');
      }
      return await wc.executeJavaScript(String(code || ''));
    });
  }

  // ── Tab Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Tab WebContentsViews are added after the shell's view, so they stack on top.
   * Any shell UI that overlaps the page rect (downloads drawer, menus, modals)
   * would paint underneath the guest surface. Re-parent order: calling
   * addChildView on an existing child moves it to the top (Electron View API).
   */
  _elevateShellAboveTabViews() {
    const win = this._win;
    if (!win || win.isDestroyed()) return;
    try {
      const cv = win.contentView;
      if (!cv || typeof cv.addChildView !== 'function' || !cv.children) return;
      const shellWc = win.webContents;
      if (!shellWc || shellWc.isDestroyed()) return;
      const shellId = shellWc.id;
      for (const child of cv.children) {
        if (
          child instanceof WebContentsView &&
          child.webContents &&
          !child.webContents.isDestroyed() &&
          child.webContents.id === shellId
        ) {
          cv.addChildView(child);
          return;
        }
      }
    } catch (err) {
      console.warn('[tab-manager] _elevateShellAboveTabViews:', err && err.message);
    }
  }

  /**
   * Create a new WCV tab.
   * Returns { tabId, webContentsId } immediately (synchronous).
   */
  createTab(url, opts = {}) {
    const tabId = opts.tabId || `tab-${++this._tabCounter}`;
    const incognito = !!opts.incognito;
    const partition = incognito ? NAVIO_PARTITION_INCOGNITO : NAVIO_PARTITION_MAIN;

    const ses = session.fromPartition(partition);

    const wcv = new WebContentsView({
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        preload: this._preloadPath,
        sandbox: false
      }
    });

    this._win.contentView.addChildView(wcv);
    this._elevateShellAboveTabViews();

    const entry = {
      wcv,
      tabId,
      url: url || '',
      title: 'New Tab',
      favicon: null,
      loading: false,
      discardUrl: null,
      incognito,
      lastBounds: null
    };
    this._tabs.set(tabId, entry);

    // Wire navigation events → renderer shell (also invokes onWcvWebContentsCreated
    // which sets up popup routing + auto-dark via the main.js callback)
    this._wireEvents(tabId, wcv.webContents);

    // Initialise tab bounds to 0×0 (hidden) until positioned
    wcv.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    // Load URL (or blank — renderer will load real URL after dom-ready)
    const startUrl = url || 'about:blank';
    wcv.webContents.loadURL(startUrl).catch(() => {});

    if (opts.switchTo !== false) {
      this.switchTab(tabId);
    }

    return { tabId, webContentsId: wcv.webContents.id };
  }

  /**
   * Bring a tab to the front.
   * Shows the tab's WCV at its last recorded bounds; hides all others.
   */
  switchTab(tabId) {
    if (!this._tabs.has(tabId)) return false;
    this._activeTabId = tabId;
    this._layoutAllTabs();
    return true;
  }

  /** Destroy a WCV tab completely. */
  closeTab(tabId) {
    const entry = this._tabs.get(tabId);
    if (!entry) return false;
    try {
      this._win.contentView.removeChildView(entry.wcv);
    } catch { /* ignore */ }
    try {
      if (!entry.wcv.webContents.isDestroyed()) {
        entry.wcv.webContents.close({ waitForBeforeUnload: false });
      }
    } catch { /* ignore */ }
    this._tabs.delete(tabId);
    if (this._activeTabId === tabId) {
      this._activeTabId = null;
    }
    return true;
  }

  // ── Bounds Management ─────────────────────────────────────────────────────────

  /**
   * Re-apply bounds for all tabs.
   * Active tab gets its lastBounds; all others get 0×0 (hidden).
   */
  _layoutAllTabs() {
    if (!this._win || this._win.isDestroyed()) return;
    for (const [id, entry] of this._tabs) {
      if (id === this._activeTabId && entry.lastBounds) {
        const { x, y, width, height } = entry.lastBounds;
        if (width > 0 && height > 0) {
          entry.wcv.setBounds({
            x: Math.round(x), y: Math.round(y),
            width: Math.round(width), height: Math.round(height)
          });
        }
      } else {
        entry.wcv.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    }
  }

  // ── Event Wiring ─────────────────────────────────────────────────────────────

  _wireEvents(tabId, wc) {
    // Give main.js a chance to attach popup routing (bindNavioGuestWindowOpenOnce)
    // and auto-dark mode — the same hooks applied to classic webview WebContents.
    if (this._onWcvWebContentsCreated) {
      try { this._onWcvWebContentsCreated(wc); } catch { /* ignore */ }
    }

    const send = (type, payload = {}) => {
      if (!this._win || this._win.isDestroyed() || this._win.webContents.isDestroyed()) return;
      try {
        this._win.webContents.send('wcv-tab-event', { tabId, type, ...payload });
      } catch { /* ignore — window may be closing */ }
    };

    wc.on('dom-ready', () => {
      const entry = this._tabs.get(tabId);
      if (entry) entry.loading = false;
      send('dom-ready', {
        canGoBack: wcCanGoBack(wc),
        canGoForward: wcCanGoForward(wc)
      });
    });

    wc.on('did-start-loading', () => {
      const entry = this._tabs.get(tabId);
      if (entry) entry.loading = true;
      send('did-start-loading', {});
    });

    wc.on('did-stop-loading', () => {
      const entry = this._tabs.get(tabId);
      if (entry) entry.loading = false;
      send('did-stop-loading', {
        canGoBack: wcCanGoBack(wc),
        canGoForward: wcCanGoForward(wc)
      });
    });

    wc.on('did-finish-load', () => {
      send('did-finish-load', {
        url: wc.getURL(),
        canGoBack: wcCanGoBack(wc),
        canGoForward: wcCanGoForward(wc)
      });
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      send('did-fail-load', {
        errorCode,
        errorDescription: errorDescription || '',
        validatedURL: validatedURL || '',
        isMainFrame: !!isMainFrame
      });
    });

    wc.on('did-navigate', (_event, url) => {
      const entry = this._tabs.get(tabId);
      if (entry) entry.url = url;
      send('did-navigate', {
        url,
        isMainFrame: true,
        canGoBack: wcCanGoBack(wc),
        canGoForward: wcCanGoForward(wc)
      });
    });

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        const entry = this._tabs.get(tabId);
        if (entry) entry.url = url;
      }
      send('did-navigate-in-page', {
        url,
        isMainFrame: !!isMainFrame,
        canGoBack: wcCanGoBack(wc),
        canGoForward: wcCanGoForward(wc)
      });
    });

    wc.on('page-title-updated', (_event, title) => {
      const entry = this._tabs.get(tabId);
      if (entry) entry.title = title;
      send('page-title-updated', { title: title || '' });
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      const favicon = Array.isArray(favicons) && favicons[0] ? favicons[0] : null;
      const entry = this._tabs.get(tabId);
      if (entry) entry.favicon = favicon;
      send('page-favicon-updated', { favicons: favicons || [] });
    });

    wc.on('render-process-gone', (_event, details) => {
      const entry = this._tabs.get(tabId);
      if (entry) { entry.loading = false; }
      send('render-process-gone', { reason: (details && details.reason) || 'crashed' });
    });

    wc.on('unresponsive', () => send('unresponsive', {}));
    wc.on('responsive', () => send('responsive', {}));

    wc.on('media-started-playing', () => send('media-started-playing', {}));
    wc.on('media-paused', () => send('media-paused', {}));

    wc.on('context-menu', (_event, params) => {
      send('context-menu', {
        x: params.x,
        y: params.y,
        params: {
          selectionText: params.selectionText || '',
          linkURL: params.linkURL || '',
          srcURL: params.srcURL || '',
          mediaType: params.mediaType || 'none',
          isEditable: !!params.isEditable,
          misspelledWord: params.misspelledWord || ''
        }
      });
    });

    // IPC from tab preload (replaces sendToHost in the old webview model)
    // webview-preload.js sends: ipcRenderer.send('wcv-tab-preload-message', { channel, args })
    wc.ipc.on('wcv-tab-preload-message', (_event, { channel, args }) => {
      send('ipc-message', { channel: channel || '', args: args || [] });
    });

    wc.on('destroyed', () => {
      this._tabs.delete(tabId);
    });
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────

  /** Get the WebContents for a tabId (used by main.js AI tools). */
  getWebContents(tabId) {
    const entry = this._tabs.get(tabId);
    return entry && !entry.wcv.webContents.isDestroyed() ? entry.wcv.webContents : null;
  }

  /** Get the WebContents by its integer ID (used by electronWebContents.fromId fallback). */
  getWebContentsByWcId(wcId) {
    for (const entry of this._tabs.values()) {
      if (!entry.wcv.webContents.isDestroyed() && entry.wcv.webContents.id === wcId) {
        return entry.wcv.webContents;
      }
    }
    return null;
  }

  /** Snapshot of all tab state (for list_tabs tool). */
  getTabList() {
    const result = [];
    for (const [tabId, entry] of this._tabs) {
      result.push({
        tabId,
        webContentsId: entry.wcv.webContents.isDestroyed() ? null : entry.wcv.webContents.id,
        url: entry.url || '',
        title: entry.title || '',
        favicon: entry.favicon || null,
        loading: !!entry.loading,
        incognito: !!entry.incognito,
        active: tabId === this._activeTabId
      });
    }
    return result;
  }

  _getWc(tabId) {
    const entry = this._tabs.get(tabId);
    if (!entry) return null;
    const wc = entry.wcv.webContents;
    return wc.isDestroyed() ? null : wc;
  }
}

// Singleton — one tab manager per app
const tabManager = new TabManager();

module.exports = { tabManager };
