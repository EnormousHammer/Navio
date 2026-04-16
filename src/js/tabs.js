/**
 * Navio Browser - Tab Management System
 * Handles tab creation, switching, closing, and webview lifecycle
 */

/** In-memory webview partition; must match electron/navio-partitions.js */
const NAVIO_INCOGNITO_PARTITION = 'navio-incognito';

class TabManagerClass {
  constructor() {
    this.tabs = [];
    this.activeTabId = null;
    /** Tab receiving AI browser automation (takeover / tools); drives `tab-agent-controlled` UI. */
    this._agentControlledTabId = null;
    this.tabCounter = 0;
    /** Last tab the user focused that was a normal web page (not Navio AI chat). Used when AI chat is focused so tools still target the page they were browsing. */
    this._lastBrowserSurfaceTabId = null;

    // ── Tab Groups ────────────────────────────────────────────────────────
    this.groups = {};        // { [groupId]: { id, name, color } }
    this._groupCounter = 0;
    this._GROUP_COLORS = ['#06b6d4','#8b5cf6','#22c55e','#ef4444','#f97316','#eab308','#ec4899'];

    /** Recent closed tabs for Ctrl+Shift+T (Chrome-style). */
    this._recentlyClosed = [];

    this.tabListEl = document.getElementById('tab-list');
    this.browserContainer = document.getElementById('browser-container');
    this.newTabPage = document.getElementById('new-tab-page');

    document.getElementById('btn-new-tab').addEventListener('click', () => this.createTab());
    document.getElementById('btn-new-private-tab')?.addEventListener('click', () =>
      this.createTab(null, { incognito: true })
    );

    this._ensureTabListTrail();

    this.tabListEl.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.tabListEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Belt-and-suspenders: explicitly set pixel dimensions on resize as well,
    // since some Electron builds ignore CSS-only sizing on <webview>.
    this._containerObserver = new ResizeObserver(() => this._syncWebviewSizes());
    this._containerObserver.observe(this.browserContainer);

    /** Idle tab discard (memory): interval in `tabDiscardIdleMinutes` from config. */
    this._tabDiscardInterval = null;
    this._startTabDiscardSchedule();
  }

  // ── Passive Memory Capture ────────────────────────────────────────────
  // After the user spends ≥20 s on a real http/https page, silently store a
  // one-liner memory entry so the AI can later answer "what was that page about?"
  // A session-level Set prevents duplicate entries for the same URL per session.
  _passiveMemorySeen = new Set();

  /** Prefer `webContents.navigationHistory` over deprecated `<webview>.canGoBack` (Electron). */
  webviewCanGoBack(wv) {
    if (!wv) return false;
    try {
      const wc = typeof wv.getWebContents === 'function' ? wv.getWebContents() : null;
      const nh = wc && wc.navigationHistory;
      if (nh && typeof nh.canGoBack === 'function') return nh.canGoBack();
    } catch {
      /* ignore */
    }
    return typeof wv.canGoBack === 'function' && wv.canGoBack();
  }

  webviewCanGoForward(wv) {
    if (!wv) return false;
    try {
      const wc = typeof wv.getWebContents === 'function' ? wv.getWebContents() : null;
      const nh = wc && wc.navigationHistory;
      if (nh && typeof nh.canGoForward === 'function') return nh.canGoForward();
    } catch {
      /* ignore */
    }
    return typeof wv.canGoForward === 'function' && wv.canGoForward();
  }

  _schedulePassiveMemory(tab, wv) {
    if (tab.incognito) return;
    // Cancel any previous timer for this tab
    if (tab._memTimer) { clearTimeout(tab._memTimer); tab._memTimer = null; }
    const url = tab.url || '';
    if (!url.startsWith('http') || this._passiveMemorySeen.has(url)) return;

    tab._memTimer = setTimeout(async () => {
      // Double-check the tab hasn't navigated away
      if (tab.url !== url) return;
      try {
        const content = await window.navio.extractPageContent(wv.getWebContentsId());
        if (!content || content.error || !content.title || content.title === 'about:blank') return;
        const desc = content.description
          ? ` — ${content.description.slice(0, 120)}`
          : content.text ? ` — ${content.text.slice(0, 100).replace(/\s+/g,' ')}` : '';
        await window.navio.memoryAdd(`[Browsed] ${content.title} (${url})${desc}`);
        this._passiveMemorySeen.add(url);
      } catch { /* memory save failures are non-critical */ }
    }, 20000); // 20 seconds dwell time
  }

  _historyAdd(tab, wv, url) {
    try {
      if (tab.incognito) return;
      if (!url || !url.startsWith('http')) return;
      window.navio.historyAdd({
        url,
        title: tab.title || url,
        favicon: tab.favicon || ''
      }).catch(() => {});
    } catch (_) {}
  }

  /** Trailing flex area in the tab strip with a second "new tab" control beside empty space after the last tab. */
  _ensureTabListTrail() {
    if (this._tabListTrail) return;
    const wrap = document.createElement('div');
    wrap.className = 'tab-list-trail';
    wrap.innerHTML = `
      <button type="button" class="tab-strip-new tab-strip-new-inline" id="btn-new-tab-inline" title="New Tab (Ctrl+T)" aria-label="New tab">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
    `;
    this._tabListTrail = wrap;
    wrap.querySelector('#btn-new-tab-inline')?.addEventListener('click', () => this.createTab());
    this.tabListEl.appendChild(wrap);
  }

  _appendNodeToTabList(node) {
    const trail = this._tabListTrail;
    if (trail && trail.parentNode === this.tabListEl) {
      this.tabListEl.insertBefore(node, trail);
    } else {
      this.tabListEl.appendChild(node);
    }
  }

  _reorderPinnedTabs() {
    const pinned = this.tabs.filter((t) => t.pinned);
    const rest = this.tabs.filter((t) => !t.pinned);
    this.tabs.splice(0, this.tabs.length, ...pinned, ...rest);
    this._reRenderTabList();
  }

  _syncWebviewSizes() {
    const { width, height } = this.browserContainer.getBoundingClientRect();
    if (!width || !height) return;
    this.tabs.forEach(tab => {
      if (tab.webview) {
        tab.webview.style.width  = width  + 'px';
        tab.webview.style.height = height + 'px';
      }
    });
  }

  createTab(url = null, opts = {}) {
    const id = `tab-${++this.tabCounter}`;
    const incognito = !!opts.incognito;
    const tab = {
      id,
      title: 'New Tab',
      /** User override shown in the tab strip; page title updates still fill `title`. */
      customTitle: null,
      url: url || '',
      favicon: null,
      loading: false,
      webview: null,
      pinned: false,
      incognito
    };

    // Build a clean user-agent that doesn't expose Electron
    const cleanUA = navigator.userAgent
      .replace(/Electron\/\S+\s?/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Create webview element
    const webview = document.createElement('webview');
    webview.setAttribute('id', `wv-${id}`);
    webview.setAttribute('allowpopups', '');
    // Route window.open through main setWindowOpenHandler (tabs) instead of a bare BrowserWindow.
    webview.setAttribute('webpreferences', 'nativeWindowOpen=no');
    webview.setAttribute('partition', incognito ? NAVIO_INCOGNITO_PARTITION : 'persist:navio');
    webview.setAttribute('useragent', cleanUA);
    // Always set src="about:blank" so Electron starts the guest renderer
    // immediately and fires dom-ready. Without this, dom-ready never fires
    // and any pending URL gets stuck in the queue forever (deadlock).
    webview.setAttribute('src', 'about:blank');
    webview._domReady = false;
    webview._pendingUrl = url || null;

    tab.webview = webview;

    // Listeners must be registered before the node is attached: dom-ready can fire
    // immediately on appendChild, and AI open_tab must not miss did-finish-load.
    this.bindWebviewEvents(tab);
    if (url && opts.loadWait) {
      tab._aiLoadWait = this._waitForNextWebviewLoad(webview, opts.loadWait);
    }

    this.browserContainer.appendChild(webview);

    // Size the new webview immediately and synchronously so Electron has the
    // correct viewport dimensions before dom-ready / loadURL fires.
    const { width, height } = this.browserContainer.getBoundingClientRect();
    if (width && height) {
      webview.style.width  = width  + 'px';
      webview.style.height = height + 'px';
    }

    this.tabs.push(tab);
    this.renderTabItem(tab);
    const doSwitch = opts.switchTo !== false;
    if (!doSwitch) {
      tab._inactiveSince = Date.now();
    }
    if (doSwitch) {
      this.switchToTab(id);
    }

    if (!url) {
      if (doSwitch) {
        this.showNewTabPage();
        setTimeout(() => {
          const ntpInput = document.getElementById('ntp-search-input');
          if (ntpInput) ntpInput.focus();
        }, 100);
      }
    }

    return tab;
  }

  /**
   * After the first startup tab exists: wait until the shell is presentable — NTP DOM painted
   * or the first URL has stopped loading (no visible loading spinner).
   */
  async waitForInitialShellReady() {
    const tab = this.getActiveTab();
    if (!tab || !tab.webview) {
      await this._nextPaint();
      return;
    }
    if (this.newTabPage && this.newTabPage.classList.contains('active')) {
      await this._nextPaint();
      await new Promise((r) => setTimeout(r, 140));
      return;
    }
    const wv = tab.webview;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        wv.removeEventListener('did-stop-loading', onStop);
        wv.removeEventListener('did-finish-load', onLoad);
        clearTimeout(failSafe);
        void this._nextPaint().then(() => {
          setTimeout(resolve, 160);
        });
      };
      const onStop = () => finish();
      const onLoad = () => finish();
      const failSafe = setTimeout(finish, 16000);
      queueMicrotask(() => {
        if (!tab.loading) {
          finish();
          return;
        }
        wv.addEventListener('did-stop-loading', onStop, { once: true });
        wv.addEventListener('did-finish-load', onLoad, { once: true });
      });
    });
  }

  async _nextPaint() {
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  }

  /** Internal full-page AI chat (`navio-chat-tab.html`) — not a normal browsing surface. */
  isNavioChatTabUrl(url) {
    const u = (url || '').toLowerCase();
    return u.includes('navio-chat-tab.html');
  }

  /**
   * Tab used for AI tools, page extraction, and snapshots.
   * Priority: (1) focused tab if it is a normal web page (http/https); (2) last focused
   * non-chat page when the user is on Navio AI chat or NTP; (3) first other non-chat tab.
   * Previously this always returned the first non-chat tab in strip order, which was wrong
   * when another tab was active.
   */
  getBrowserContextTab() {
    const isWebSurface = (u) =>
      typeof u === 'string' && u.startsWith('http') && !this.isNavioChatTabUrl(u);

    const active = this.getActiveTab();
    if (active && active.webview) {
      const u = active.url || '';
      if (isWebSurface(u)) {
        return active;
      }
    }

    if (this._lastBrowserSurfaceTabId) {
      const remembered = this.tabs.find((t) => t.id === this._lastBrowserSurfaceTabId);
      if (remembered && remembered.webview) {
        const u = remembered.url || '';
        if (isWebSurface(u)) {
          return remembered;
        }
      }
    }

    for (const t of this.tabs) {
      if (!t.webview) continue;
      const u = t.url || '';
      if (this.isNavioChatTabUrl(u)) continue;
      return t;
    }
    return null;
  }

  /** Tab currently receiving AI automation (null if none). */
  getAgentControlledTab() {
    if (this._agentControlledTabId == null) return null;
    return this.tabs.find((t) => t.id === this._agentControlledTabId) || null;
  }

  /**
   * Webview the agent should drive (never the chat UI webview).
   * While a tool run has locked `_agentControlledTabId`, always return that tab's webview
   * so the user can focus other tabs without stealing automation from the AI's tab.
   */
  getBrowserTargetWebview() {
    const agentTab = this.getAgentControlledTab();
    if (agentTab && agentTab.webview) return agentTab.webview;
    const t = this.getBrowserContextTab();
    return t && t.webview ? t.webview : null;
  }

  /**
   * Ensures at least one non-chat tab exists for agent tools; opens a background blank tab if needed.
   */
  ensureBrowserContextTab() {
    if (this.getBrowserContextTab()) return;
    this.createTab('about:blank', { switchTo: false });
  }

  /** Navigate a specific tab (used when the focused tab is the chat surface). */
  navigateTab(tab, resolvedUrl) {
    if (!tab || !tab.webview) return false;
    if (tab._discarded) {
      tab._discarded = false;
      tab._discardUrl = null;
    }
    tab.url = resolvedUrl;
    tab.favicon = null;
    tab.title = 'Loading…';
    this.updateTabUI(tab);
    if (tab.id === this.activeTabId) {
      this.hideNewTabPage();
    }
    const wv = tab.webview;
    if (wv._domReady) {
      const run = () => wv.loadURL(resolvedUrl).catch((err) => console.warn('navigateTab loadURL failed:', err));
      if (typeof queueMicrotask === 'function') queueMicrotask(run);
      else setTimeout(run, 0);
    } else {
      wv._pendingUrl = resolvedUrl;
    }
    return true;
  }

  /** Load a URL into a specific tab and wait for load (does not change which tab is focused). */
  async navigateTabAndWaitForLoad(tab, resolvedUrl, options = {}) {
    if (!tab || !tab.webview) return { ok: false, error: 'no tab' };
    const timeoutMs = options.timeoutMs ?? 45000;
    const settleMs = options.settleMs ?? 200;
    const wv = tab.webview;
    const loadPromise = this._waitForNextWebviewLoad(wv, { timeoutMs, settleMs });
    const started = this.navigateTab(tab, resolvedUrl);
    if (!started) return { ok: false, error: 'navigation not started' };
    return loadPromise;
  }

  /** Load a URL into the browsing-context tab (not the Navio AI chat tab). */
  async navigateBrowserContextAndWaitForLoad(resolvedUrl, options = {}) {
    this.ensureBrowserContextTab();
    const tab = this.getBrowserContextTab();
    if (!tab || !tab.webview) return { ok: false, error: 'no browser tab' };
    return this.navigateTabAndWaitForLoad(tab, resolvedUrl, options);
  }

  /**
   * Agent navigation: load in the tab the AI is driving, not necessarily the user's focused tab.
   * When `_agentControlledTabId` is set (tool loop / takeover), URLs load there so the user can
   * switch tabs freely while automation continues in the background.
   */
  async navigateForAgentAndWaitForLoad(resolvedUrl, options = {}) {
    if (this._agentControlledTabId != null) {
      const agentTab = this.tabs.find((t) => t.id === this._agentControlledTabId);
      if (agentTab && agentTab.webview) {
        return this.navigateTabAndWaitForLoad(agentTab, resolvedUrl, options);
      }
    }
    const active = this.getActiveTab();
    if (active && this.isNavioChatTabUrl(active.url || '')) {
      return this.navigateBrowserContextAndWaitForLoad(resolvedUrl, options);
    }
    return this.navigateActiveAndWaitForLoad(resolvedUrl, options);
  }

  bindWebviewEvents(tab) {
    const wv = tab.webview;

    // Sync size synchronously so Electron uses the correct viewport dimensions
    // before the first loadURL call; the page must load into the right viewport.
    wv.addEventListener('dom-ready', () => {
      wv._domReady = true;
      const { width, height } = this.browserContainer.getBoundingClientRect();
      if (width && height) {
        wv.style.width  = width  + 'px';
        wv.style.height = height + 'px';
      }
      if (wv._pendingUrl) {
        const url = wv._pendingUrl;
        wv._pendingUrl = null;
        const run = () => wv.loadURL(url).catch(err => console.warn('Pending loadURL failed:', err));
        if (typeof queueMicrotask === 'function') queueMicrotask(run);
        else setTimeout(run, 0);
      }
    });

    wv.addEventListener('did-start-loading', () => {
      tab.loading = true;
      this.updateTabUI(tab);
      if (tab.id === this.activeTabId) {
        App.showLoading(true);
      }
    });

    wv.addEventListener('did-stop-loading', () => {
      tab.loading = false;
      this.updateTabUI(tab);
      if (tab.id === this.activeTabId) {
        App.showLoading(false);
        App.updateNavigationButtons(wv);
      }
    });

    wv.addEventListener('page-title-updated', (e) => {
      tab.title = e.title || 'Untitled';
      this.updateTabUI(tab);
      if (tab.id === this.activeTabId) {
        this.updateContextTitle(tab);
      }
    });

    wv.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons && e.favicons.length > 0) {
        tab.favicon = e.favicons[0];
        this.updateTabUI(tab);
      }
    });

    wv.addEventListener('did-navigate', (e) => {
      // Subframe navigations must not clobber the tab URL or NTP visibility.
      if (e && e.isMainFrame === false) return;

      const raw = e.url || '';
      // Real top-level URL — record history and hide the new-tab overlay.
      if (raw && raw !== 'about:blank' && !raw.startsWith('data:')) {
        tab.url = raw;
        this._historyAdd(tab, wv, raw);
        if (raw.toLowerCase().includes('navio-chat-tab.html')) {
          tab.title = 'Navio AI';
          this.updateTabUI(tab);
        }
      } else if ((raw === 'about:blank' || raw === '') && !wv._pendingUrl && !tab._discarded) {
        // Back/forward to the initial blank document — clear the tab model so we
        // show the NTP again. (If we keep the old https URL, hideNewTabPage runs
        // while the webview is still about:blank and the NTP stacks above it.)
        // Skip when tab is intentionally discarded (memory): tab.url stays the restore URL.
        tab.url = '';
      }
      if (tab.id === this.activeTabId) {
        App.updateUrlBar(tab.url);
        App.updateNavigationButtons(wv);
        this.updateContextTitle(tab);
        if (tab.url) {
          this.hideNewTabPage();
        } else {
          this.showNewTabPage();
        }
      }
      if (
        tab.id === this.activeTabId &&
        tab.url &&
        tab.url.startsWith('http') &&
        !this.isNavioChatTabUrl(tab.url)
      ) {
        this._lastBrowserSurfaceTabId = tab.id;
      }
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) {
        tab.url = e.url;
        if (e.url && e.url.startsWith('http')) {
          this._historyAdd(tab, wv, e.url);
        }
        if (tab.id === this.activeTabId) {
          App.updateUrlBar(e.url);
          // SPA navigation (YouTube, etc.) — ensure NTP stays hidden
          if (e.url && e.url !== 'about:blank') {
            this.hideNewTabPage();
          }
        }
        if (
          tab.id === this.activeTabId &&
          tab.url &&
          tab.url.startsWith('http') &&
          !this.isNavioChatTabUrl(tab.url)
        ) {
          this._lastBrowserSurfaceTabId = tab.id;
        }
      }
    });

    // window.open / target=_blank is handled in the main process (did-attach-webview
    // → setWindowOpenHandler) so blank OAuth popups do not fall through as a new
    // BrowserWindow when the renderer "new-window" event has no URL yet.

    wv.addEventListener('did-fail-load', (e) => {
      if (e.isMainFrame === false) return;
      if (e.errorCode === -3) return; // Aborted/cancelled, ignore
      const validated = String(e.validatedURL || '');
      if (validated.startsWith('data:')) return;

      tab.loading = false;
      tab.title = 'Error';
      this.updateTabUI(tab);
      App.showLoading(false);
      if (tab.id === this.activeTabId) {
        this._scheduleWebviewInlineError(
          wv,
          e.errorDescription || 'Failed to load',
          tab.url || validated
        );
      }
    });

    wv.addEventListener('did-finish-load', async () => {
      // Safety net: if the guest is blank but our model still has a real URL (and
      // this tab has session history), resync — avoids a blank webview with NTP
      // hidden after some back/forward paths that omit a clean did-navigate.
      try {
        const live = typeof wv.getURL === 'function' ? (wv.getURL() || '') : '';
        const hasHistory = this.webviewCanGoBack(wv) || this.webviewCanGoForward(wv);
        if (
          tab.id === this.activeTabId &&
          tab.url &&
          (live === 'about:blank' || live === '') &&
          !wv._pendingUrl &&
          !tab.loading &&
          hasHistory
        ) {
          tab.url = '';
          App.updateUrlBar('');
          this.showNewTabPage();
        }
      } catch {
        /* ignore */
      }

      this.applyZoomToWebview(wv);
      this._schedulePassiveMemory(tab, wv);
      if (tab.id === this.activeTabId && typeof window.__navioUpdateZoomLabel === 'function') {
        window.__navioUpdateZoomLabel();
      }
      if (tab.id === this.activeTabId && typeof AssistantManager !== 'undefined' && AssistantManager.maybeProactivePageLoadHint) {
        try {
          const cfg = await window.navio.getConfig();
          if (cfg.aiProactivity === 'active' && cfg.hasApiKey) {
            AssistantManager.maybeProactivePageLoadHint(tab, wv);
          }
        } catch {
          /* ignore */
        }
      }
    });

    wv.addEventListener('context-menu', (e) => {
      e.preventDefault();
      try {
        const wcId = wv.getWebContentsId();
        window.navio.showWebviewContextMenu({
          webContentsId: wcId,
          x: e.x,
          y: e.y,
          params: e.params || {}
        });
      } catch {/* ignore */}
    });

    // Handle IPC messages from the webview-preload script
    wv.addEventListener('ipc-message', (e) => {
      try {
        const data = e.args && e.args[0];
        if (e.channel === 'navio-form-submit' && data) {
          // Credential capture — offer to save
          if (!tab.incognito && typeof PasswordManager !== 'undefined') {
            Promise.resolve(PasswordManager.showSavePrompt(data, wv)).catch(() => {});
          }
        } else if (e.channel === 'navio-login-form' && data) {
          // Login form detected — check if we have saved credentials to autofill
          if (!tab.incognito && typeof PasswordManager !== 'undefined') {
            PasswordManager.checkAutofill(data.url, wv);
          }
        } else if (e.channel === 'navio-text-selected' && data) {
          // Text selected — show inline AI toolbar
          if (typeof InlineAI !== 'undefined') {
            const wvRect = wv.getBoundingClientRect();
            InlineAI.show(data.text, wvRect.left + data.x, wvRect.top + data.y, wv);
          }
        } else if (e.channel === 'navio-selection-cleared') {
          if (typeof InlineAI !== 'undefined') InlineAI.hide();
        } else if (e.channel === 'navio-chat-host') {
          const payload = data;
          if (payload && typeof AssistantManager !== 'undefined' && AssistantManager.handleGuestChatHostMessage) {
            AssistantManager.handleGuestChatHostMessage(tab, wv, payload);
          }
        }
      } catch {}
    });
  }

  /**
   * Inline error document as data URL. Base64 avoids long percent-encoded URLs that
   * often race with pending navigations and surface as ERR_ABORTED in the guest.
   */
  _utf8ToBase64(str) {
    try {
      return btoa(unescape(encodeURIComponent(str)));
    } catch {
      try {
        return btoa(str);
      } catch {
        return '';
      }
    }
  }

  _scheduleWebviewInlineError(wv, description, pageUrl) {
    const errHtml = this._buildErrorPage(description, pageUrl);
    const b64 = this._utf8ToBase64(errHtml);
    const dataUrl = b64
      ? `data:text/html;charset=UTF-8;base64,${b64}`
      : `data:text/html;charset=utf-8,${encodeURIComponent(errHtml)}`;
    const inject = () => {
      try {
        if (typeof wv.stop === 'function') wv.stop();
      } catch {
        /* ignore */
      }
      try {
        wv.loadURL(dataUrl).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(inject));
  }

  _buildErrorPage(description, url) {
    const safeUrl = url ? url.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
    const safeDesc = (description || 'Unknown error').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
    background:#080c18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8892b4;}
  .box{text-align:center;max-width:480px;padding:40px 24px;}
  .icon{font-size:48px;margin-bottom:16px;opacity:.6;}
  h1{font-size:22px;font-weight:700;color:#e2e8f8;margin:0 0 8px;}
  p{font-size:14px;line-height:1.6;margin:0 0 24px;opacity:.7;}
  .url{font-size:12px;word-break:break-all;padding:8px 12px;background:rgba(80,160,255,.05);
    border:1px solid rgba(80,160,255,.10);border-radius:6px;margin-bottom:24px;opacity:.6;}
  button{padding:10px 24px;background:linear-gradient(135deg,#00d8ff,#5468ff);border:none;
    border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
  button:hover{opacity:.9;}
</style></head><body>
<div class="box">
  <div class="icon">⚠️</div>
  <h1>Page couldn't load</h1>
  <p>${safeDesc}</p>
  ${safeUrl ? `<div class="url">${safeUrl}</div>` : ''}
  <button onclick="history.back()">Go back</button>
</div></body></html>`;
  }

  applyZoomToWebview(wv) {
    if (!wv) return;
    const z = typeof App !== 'undefined' && App.config ? App.config.defaultZoom : 1;
    const n = typeof z === 'number' ? z : parseFloat(z);
    const factor = Number.isFinite(n) ? Math.min(3, Math.max(0.25, n)) : 1;
    try {
      wv.setZoomFactor(factor);
    } catch (e) { /* webview may not be ready */ }
  }

  applyZoomFromConfig() {
    this.tabs.forEach((t) => this.applyZoomToWebview(t.webview));
  }

  /** Hide new-tab overlay, set URL on tab, and load (fixes NTP + address bar navigation). */
  navigateActive(resolvedUrl) {
    const tab = this.getActiveTab();
    if (!tab || !tab.webview) return false;
    if (tab._discarded) {
      tab._discarded = false;
      tab._discardUrl = null;
    }
    tab.url = resolvedUrl;
    tab.favicon = null;
    tab.title = 'Loading…';
    this.updateTabUI(tab);
    this.hideNewTabPage();
    const wv = tab.webview;
    if (wv._domReady) {
      const run = () => wv.loadURL(resolvedUrl).catch(err => console.warn('navigateActive loadURL failed:', err));
      if (typeof queueMicrotask === 'function') queueMicrotask(run);
      else setTimeout(run, 0);
    } else {
      // dom-ready hasn't fired yet (very fast user action); queue it
      wv._pendingUrl = resolvedUrl;
    }
    return true;
  }

  /**
   * Attach load listeners first, then start navigation — resolves when the main load settles
   * (did-finish-load + short paint delay), on hard failure, or timeout (still ok: SPA may be idle).
   * @param {number} [options.timeoutMs] — max wait (default 45s)
   * @param {number} [options.settleMs] — buffer after did-finish-load for layout/paint (default 200ms)
   */
  async navigateActiveAndWaitForLoad(resolvedUrl, options = {}) {
    const timeoutMs = options.timeoutMs ?? 45000;
    const settleMs = options.settleMs ?? 200;
    const tab = this.getActiveTab();
    if (!tab || !tab.webview) return { ok: false, error: 'no active tab' };
    const wv = tab.webview;

    const loadPromise = this._waitForNextWebviewLoad(wv, { timeoutMs, settleMs });
    const started = this.navigateActive(resolvedUrl);
    if (!started) return { ok: false, error: 'navigation not started' };
    return loadPromise;
  }

  /**
   * Create a tab (optionally with URL) and wait until that webview finishes loading or times out.
   */
  async createTabAndWaitForLoad(url = null, options = {}) {
    const timeoutMs = options.timeoutMs ?? 45000;
    const settleMs = options.settleMs ?? 200;
    const passThrough = { ...options };
    delete passThrough.timeoutMs;
    delete passThrough.settleMs;
    delete passThrough.loadWait;
    const tab = this.createTab(url, url ? { ...passThrough, loadWait: { timeoutMs, settleMs } } : passThrough);
    if (!url) return { ok: true, tab };
    if (!tab._aiLoadWait) {
      return { tab, ok: false, error: 'Load wait was not registered for new tab' };
    }
    const result = await tab._aiLoadWait;
    delete tab._aiLoadWait;
    return { tab, ...result };
  }

  /**
   * Wait for the next did-finish-load on this webview (listeners registered before navigation).
   * Call this, then call navigateActive / loadURL / rely on pending URL.
   */
  _waitForNextWebviewLoad(wv, { timeoutMs, settleMs }) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        wv.removeEventListener('did-finish-load', onFinish);
        wv.removeEventListener('did-fail-load', onFail);
      };
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      };

      const onFinish = () => {
        try {
          const u = (wv.getURL && wv.getURL()) || '';
          // New tabs load about:blank first, then the real URL — ignore the blank finish.
          if (u === 'about:blank') return;
        } catch {
          /* ignore */
        }
        setTimeout(() => finish({ ok: true }), settleMs);
      };
      const onFail = (e) => {
        if (e.errorCode === -3) return;
        finish({ ok: false, error: e.errorDescription || 'load failed', errorCode: e.errorCode });
      };
      const timer = setTimeout(() => finish({ ok: true, timedOut: true }), timeoutMs);

      wv.addEventListener('did-finish-load', onFinish);
      wv.addEventListener('did-fail-load', onFail);
    });
  }

  switchToTab(id) {
    const prevId = this.activeTabId;
    if (prevId && prevId !== id) {
      const prevTab = this.tabs.find((t) => t.id === prevId);
      if (prevTab) prevTab._inactiveSince = Date.now();
    }

    const nextTab = this.tabs.find((t) => t.id === id);
    if (nextTab && nextTab._discarded && nextTab._discardUrl && nextTab.webview) {
      this._restoreDiscardedTab(nextTab);
    }

    this.activeTabId = id;
    if (nextTab) nextTab._inactiveSince = undefined;

    this.tabs.forEach((tab) => {
      const isActive = tab.id === id;
      tab.webview.classList.toggle('active', isActive);

      const tabEl = document.getElementById(`tabitem-${tab.id}`);
      if (tabEl) tabEl.classList.toggle('active', isActive);
    });

    // Re-sync sizes after toggling display on the active webview so it always
    // fills the container flush to all four edges.
    this._syncWebviewSizes();

    const activeTab = this.getActiveTab();
    if (activeTab) {
      document.body.classList.toggle('navio-incognito-active', !!activeTab.incognito);
      if (activeTab.url) {
        App.updateUrlBar(activeTab.url);
        this.hideNewTabPage();
      } else {
        App.updateUrlBar('');
        this.showNewTabPage();
      }
      App.updateNavigationButtons(activeTab.webview);
      this.updateContextTitle(activeTab);
      if (typeof window.__navioUpdateZoomLabel === 'function') {
        window.__navioUpdateZoomLabel();
      }
      // Move keyboard focus to the page so agent type_text / CDP input goes to the webview, not the assistant.
      if (activeTab.webview) {
        try {
          activeTab.webview.focus();
        } catch (_) {}
      }

      const u = activeTab.url || '';
      if (u.startsWith('http') && !this.isNavioChatTabUrl(u)) {
        this._lastBrowserSurfaceTabId = activeTab.id;
      }
    }
  }

  _restoreDiscardedTab(tab) {
    if (!tab || !tab.webview || !tab._discardUrl) return;
    const url = tab._discardUrl;
    tab._discarded = false;
    tab._discardUrl = null;
    tab.loading = true;
    this.updateTabUI(tab);
    try {
      tab.webview.loadURL(url);
    } catch (e) {
      console.warn('[Navio] restore discarded tab', e);
    }
  }

  _discardBackgroundTab(tab) {
    if (!tab || !tab.webview || tab._discarded) return;
    const u = (tab.url || '').trim();
    if (!u.startsWith('http')) return;
    tab._discardUrl = u;
    tab._discarded = true;
    try {
      tab.webview.loadURL('about:blank');
    } catch (e) {
      console.warn('[Navio] discard background tab', e);
      tab._discarded = false;
      tab._discardUrl = null;
    }
    this.updateTabUI(tab);
  }

  _maybeDiscardBackgroundTabs() {
    let minutes = 0;
    try {
      minutes = Number(typeof App !== 'undefined' && App.config ? App.config.tabDiscardIdleMinutes : 0) || 0;
    } catch {
      minutes = 0;
    }
    if (minutes <= 0) return;

    const ms = minutes * 60 * 1000;
    const now = Date.now();

    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue;
      if (tab.pinned) continue;
      if (tab.incognito) continue;
      if (tab._discarded) continue;
      if (tab.loading) continue;
      if (this._agentControlledTabId === tab.id) continue;
      const u = (tab.url || '').trim();
      if (!u.startsWith('http')) continue;
      if (this.isNavioChatTabUrl(u)) continue;
      const since = tab._inactiveSince;
      if (since == null || now - since < ms) continue;
      this._discardBackgroundTab(tab);
    }
  }

  _startTabDiscardSchedule() {
    if (this._tabDiscardInterval) clearInterval(this._tabDiscardInterval);
    this._tabDiscardInterval = setInterval(() => this._maybeDiscardBackgroundTabs(), 60000);
  }

  closeTab(id) {
    const index = this.tabs.findIndex(t => t.id === id);
    if (index === -1) return;

    const tab = this.tabs[index];
    if (tab.pinned) {
      if (typeof _showAppToast === 'function') {
        _showAppToast('Unpin the tab before closing it.', 'warning');
      }
      return;
    }

    // Cancel any pending passive-memory timer so it doesn't fire on a dead tab
    if (tab._memTimer) { clearTimeout(tab._memTimer); tab._memTimer = null; }

    const u = (tab.url || '').trim();
    if (u.startsWith('http')) {
      this._recentlyClosed.unshift({ url: u, incognito: !!tab.incognito });
      if (this._recentlyClosed.length > 15) this._recentlyClosed.length = 15;
    }

    // Remove webview from DOM
    if (tab.webview && tab.webview.parentNode) {
      tab.webview.parentNode.removeChild(tab.webview);
    }

    // Remove tab item from sidebar
    const tabEl = document.getElementById(`tabitem-${id}`);
    if (tabEl) tabEl.remove();

    const hadGroup = tab.groupId;
    if (this._agentControlledTabId === id) {
      this._agentControlledTabId = null;
    }
    if (this._lastBrowserSurfaceTabId === id) {
      this._lastBrowserSurfaceTabId = null;
    }
    this.tabs.splice(index, 1);

    // If the closed tab was in a group, rebuild the strip to update counts/remove empty headers
    if (hadGroup) this._reRenderTabList();
    else this._applyAgentControlledTabClasses();

    // If closing active tab, switch to another
    if (this.activeTabId === id) {
      if (this.tabs.length > 0) {
        const newIndex = Math.min(index, this.tabs.length - 1);
        this.switchToTab(this.tabs[newIndex].id);
      } else {
        this.activeTabId = null;
        this.createTab();
      }
    }
  }

  closeActiveTab() {
    if (this.activeTabId) {
      this.closeTab(this.activeTabId);
    }
  }

  getActiveTab() {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  getActiveWebview() {
    const tab = this.getActiveTab();
    return tab ? tab.webview : null;
  }

  findTabIdForWebview(wv) {
    if (!wv) return null;
    const t = this.tabs.find((x) => x.webview === wv);
    return t ? t.id : null;
  }

  /**
   * Tab that should show the “AI is controlling this tab” highlight during takeover.
   * When the Navio AI chat tab is focused, automation targets the browsing-context tab.
   */
  getTakeoverHighlightTabId() {
    const active = this.getActiveTab();
    const surfaceIsChat = !!(active && this.isNavioChatTabUrl?.(active.url || ''));
    if (surfaceIsChat) {
      const ctx = this.getBrowserContextTab?.();
      return ctx?.id ?? null;
    }
    return active?.id ?? null;
  }

  /**
   * Show which tab is receiving automated clicks/navigation. Pass null to clear.
   * Updates tab strip + webview outline classes.
   */
  setAgentControlledTab(tabId) {
    const next = tabId || null;
    const prev = this._agentControlledTabId;
    this._agentControlledTabId = next;
    this._applyAgentControlledTabClasses();
    if (next && next !== prev) {
      document.getElementById(`tabitem-${next}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }

  _applyAgentControlledTabClasses() {
    const id = this._agentControlledTabId;
    this.tabs.forEach((tab) => {
      const on = !!(id && tab.id === id);
      const el = document.getElementById(`tabitem-${tab.id}`);
      if (el) {
        el.classList.toggle('tab-agent-controlled', on);
        if (on) el.title = `${this.getTabDisplayTitle(tab)} — Navio is controlling this tab`;
        else el.removeAttribute('title');
      }
      if (tab.webview) tab.webview.classList.toggle('navio-agent-controlled-webview', on);
    });
    document.body.classList.toggle('navio-agent-has-target-tab', !!id);
  }

  /** Normal reload, or hard reload (bypass cache) when supported by the webview. */
  reloadActive(ignoreCache = false) {
    const wv = this.getActiveWebview();
    if (!wv) return;
    try {
      if (ignoreCache && typeof wv.reloadIgnoringCache === 'function') {
        wv.reloadIgnoringCache();
      } else {
        wv.reload();
      }
    } catch {
      try {
        wv.reload();
      } catch {
        /* ignore */
      }
    }
  }

  switchToAdjacentTab(delta) {
    if (!this.tabs.length) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const cur = idx < 0 ? 0 : idx;
    const len = this.tabs.length;
    const next = (cur + delta + len * 10) % len;
    this.switchToTab(this.tabs[next].id);
  }

  /** `n` 1–8: switch to that tab index; `9`: last tab (Chrome-style). */
  switchToTabOrdinal(n) {
    if (!this.tabs.length || n < 1 || n > 9) return;
    if (n === 9) {
      this.switchToTab(this.tabs[this.tabs.length - 1].id);
      return;
    }
    const i = n - 1;
    if (i < this.tabs.length) {
      this.switchToTab(this.tabs[i].id);
    }
  }

  reopenLastClosedTab() {
    while (this._recentlyClosed.length) {
      const rec = this._recentlyClosed.shift();
      if (rec && rec.url && rec.url.startsWith('http')) {
        this.createTab(rec.url, { incognito: !!rec.incognito });
        return;
      }
    }
  }

  showNewTabPage() {
    this.newTabPage.classList.add('active');
    const ticker = document.getElementById('ntp-stock-ticker');
    if (ticker) ticker.classList.add('visible');
    const apply = typeof window.__navioApplyNtpTickerReserve === 'function'
      ? window.__navioApplyNtpTickerReserve
      : null;
    if (apply) requestAnimationFrame(() => apply());
    const activeWv = this.getActiveWebview();
    if (activeWv) activeWv.classList.remove('active');
  }

  hideNewTabPage() {
    this.newTabPage.classList.remove('active');
    const ticker = document.getElementById('ntp-stock-ticker');
    if (ticker) ticker.classList.remove('visible');
    if (typeof window.__navioApplyNtpTickerReserve === 'function') {
      window.__navioApplyNtpTickerReserve();
    }
    const activeWv = this.getActiveWebview();
    if (activeWv) activeWv.classList.add('active');
  }

  renderTabItem(tab) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (tab.incognito ? ' tab-incognito' : '');
    el.id = `tabitem-${tab.id}`;

    el.innerHTML = `
      <div class="tab-favicon">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
      </div>
      <span class="tab-title${tab.customTitle ? ' tab-title-custom' : ''}" title="Double-click to rename">${this.escapeHtml(this.getTabDisplayTitle(tab))}</span>
      <button class="tab-close" title="Close tab">
        <svg width="9" height="9" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5"/></svg>
      </button>
    `;

    el.addEventListener('click', (e) => {
      if (!e.target.closest('.tab-close')) {
        this.switchToTab(tab.id);
      }
    });

    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      if (tab.pinned) {
        if (typeof _showAppToast === 'function') _showAppToast('Unpin the tab before closing.', 'warning');
        return;
      }
      this.closeTab(tab.id);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showTabContextMenu(tab.id, e.clientX, e.clientY);
    });

    const titleSpan = el.querySelector('.tab-title');
    if (titleSpan) {
      titleSpan.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        this._promptRenameTab(tab.id);
      });
    }

    this._appendNodeToTabList(el);

    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
  }

  updateTabUI(tab) {
    const el = document.getElementById(`tabitem-${tab.id}`);
    if (!el) return;

    const titleEl = el.querySelector('.tab-title');
    titleEl.textContent = this.getTabDisplayTitle(tab);
    titleEl.classList.toggle('tab-title-custom', !!tab.customTitle);
    titleEl.title = 'Double-click to rename';

    const faviconEl = el.querySelector('.tab-favicon');
    if (tab.favicon) {
      faviconEl.innerHTML = `<img src="${tab.favicon}" alt="">`;
    }

    el.classList.toggle('loading', tab.loading);
    if (tab.loading) {
      faviconEl.innerHTML = '';
    } else if (!tab.favicon) {
      faviconEl.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;
    }

    // Group color indicator
    if (tab.groupId && this.groups[tab.groupId]) {
      const color = this.groups[tab.groupId].color;
      el.style.setProperty('--tg-color', color);
      el.classList.add('in-group');
    } else {
      el.style.removeProperty('--tg-color');
      el.classList.remove('in-group');
    }

    el.classList.toggle('tab-pinned', !!tab.pinned);
    el.classList.toggle('tab-incognito', !!tab.incognito);
    el.classList.toggle('tab-discarded', !!tab._discarded);
    if (tab.webview) {
      try {
        tab.webview.classList.toggle('tab-webview-discarded', !!tab._discarded);
      } catch {
        /* ignore */
      }
    }
  }

  updateContextTitle(tab) {
    const contextEl = document.getElementById('context-page-title');
    if (contextEl) {
      const display = this.getTabDisplayTitle(tab);
      let line = tab.url ? `${display} - ${tab.url}` : 'New Tab';
      if (tab.customTitle && tab.title && tab.title !== display) {
        line = `${display} (${tab.title}) - ${tab.url}`;
      }
      if (typeof EmailAssistant !== 'undefined' && tab.url && EmailAssistant.isMailUrl(tab.url)) {
        line += ' · Mail';
      }
      contextEl.textContent = line;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /** Label shown in the tab strip and pickers (custom name wins over page title). */
  getTabDisplayTitle(tab) {
    if (!tab) return '';
    if (tab.customTitle != null && String(tab.customTitle).trim()) {
      return String(tab.customTitle).trim();
    }
    const p = (tab.title && String(tab.title).trim()) || '';
    return p || 'New Tab';
  }

  /** Group name for UI / assistant context, or null if the tab is not grouped. */
  getTabGroupLabel(tab) {
    if (!tab?.groupId || !this.groups[tab.groupId]) return null;
    const n = this.groups[tab.groupId].name;
    return n != null && String(n).trim() ? String(n).trim() : null;
  }

  setTabCustomTitle(tabId, nameOrNull) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (nameOrNull == null || !String(nameOrNull).trim()) tab.customTitle = null;
    else tab.customTitle = String(nameOrNull).trim().slice(0, 120);
    this.updateTabUI(tab);
    if (tab.id === this.activeTabId) this.updateContextTitle(tab);
  }

  _promptRenameTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const cur = this.getTabDisplayTitle(tab);
    const next = window.prompt('Tab name (leave empty to use the page title):', cur);
    if (next === null) return;
    this.setTabCustomTitle(tabId, next.trim() ? next : null);
  }

  async getActivePageContent() {
    const wv = this.getBrowserTargetWebview() || this.getActiveWebview();
    if (!wv) return null;

    try {
      const wcId = wv.getWebContentsId();
      return await window.navio.extractPageContent(wcId);
    } catch (err) {
      console.error('Failed to extract page content:', err);
      return null;
    }
  }

  async runBrowserActionWithConfirm(action, params = {}) {
    const wv = this.getActiveWebview();
    if (!wv) return { error: 'No active tab' };
    const summary = `${action} ${JSON.stringify(params)}`;
    if (!window.confirm(`Allow browser action?\n\n${summary}`)) {
      return { cancelled: true };
    }
    return window.navio.browserAction({
      webContentsId: wv.getWebContentsId(),
      action,
      params,
      userConfirmed: true
    });
  }

  // ── Tab Groups ─────────────────────────────────────────────────────────

  createGroup(name, color) {
    const id = `grp-${++this._groupCounter}`;
    this.groups[id] = { id, name: name || `Group ${this._groupCounter}`, color: color || this._GROUP_COLORS[0] };
    return id;
  }

  addTabToGroup(tabId, groupId) {
    this.removeTabFromGroup(tabId);
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !this.groups[groupId]) return;
    tab.groupId = groupId;
    this._reRenderTabList();
  }

  removeTabFromGroup(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !tab.groupId) return;
    tab.groupId = null;
    this._reRenderTabList();
  }

  // ── Rebuild the tab strip with group headers ───────────────────────────
  _reRenderTabList() {
    // Remove all existing tab items and group headers from the strip
    this.tabListEl.querySelectorAll('.tab-item, .tab-group-header').forEach(el => el.remove());

    // Separate tabs: ungrouped first, then groups
    const ungrouped = this.tabs.filter(t => !t.groupId);
    const byGroup = {};
    this.tabs.forEach(t => {
      if (t.groupId) {
        if (!byGroup[t.groupId]) byGroup[t.groupId] = [];
        byGroup[t.groupId].push(t);
      }
    });

    // Render ungrouped tabs
    ungrouped.forEach(t => this._appendTabItem(t));

    // Render grouped tabs with a header row per group
    for (const [groupId, groupTabs] of Object.entries(byGroup)) {
      const group = this.groups[groupId];
      if (!group) continue;
      const collapsed = group.collapsed || false;
      const header = this._buildGroupHeader(group, groupTabs.length, collapsed);
      this._appendNodeToTabList(header);
      if (!collapsed) groupTabs.forEach(t => this._appendTabItem(t));
    }

    if (this._tabListTrail) this.tabListEl.appendChild(this._tabListTrail);
    this._applyAgentControlledTabClasses();
  }

  _buildGroupHeader(group, tabCount, collapsed) {
    const el = document.createElement('div');
    el.className = `tab-group-header${collapsed ? ' collapsed' : ''}`;
    el.dataset.groupId = group.id;
    el.style.setProperty('--tg-color', group.color);
    el.innerHTML = `
      <span class="tgh-dot" style="background:${group.color}"></span>
      <span class="tgh-name">${this.escapeHtml(group.name)}</span>
      <span class="tgh-count">${tabCount}</span>
      <svg class="tgh-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    `;
    el.addEventListener('click', () => {
      group.collapsed = !group.collapsed;
      this._reRenderTabList();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showGroupContextMenu(group.id, e.clientX, e.clientY);
    });
    return el;
  }

  _appendTabItem(tab) {
    const existing = document.getElementById(`tabitem-${tab.id}`);
    if (existing) {
      // Move existing element to correct position
      this._appendNodeToTabList(existing);
      this.updateTabUI(tab);
    } else {
      this.renderTabItem(tab);
    }
  }

  _showGroupContextMenu(groupId, x, y) {
    this._hideTabContextMenu();
    const group = this.groups[groupId];
    if (!group) return;
    const menu = document.createElement('div');
    menu.id = 'tab-ctx-menu';
    menu.className = 'tab-ctx-menu';
    menu.innerHTML = `
      <div class="tcm-label" style="color:${group.color}">${this.escapeHtml(group.name)}</div>
      <div class="tcm-sep"></div>
      <button class="tcm-item" data-action="rename-group">Rename group</button>
      <button class="tcm-item tcm-danger" data-action="ungroup-all">Ungroup all tabs</button>
      <button class="tcm-item tcm-danger" data-action="close-group">Close all tabs in group</button>
    `;
    document.body.appendChild(menu);
    menu.style.left = `${Math.min(x, window.innerWidth - 230)}px`;
    menu.style.top  = `${Math.min(y, window.innerHeight - 140)}px`;
    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'ungroup-all') {
          this.tabs.filter(t => t.groupId === groupId).forEach(t => { t.groupId = null; });
          delete this.groups[groupId];
          this._reRenderTabList();
        } else if (btn.dataset.action === 'close-group') {
          [...this.tabs.filter(t => t.groupId === groupId)].forEach(t => this.closeTab(t.id));
        } else if (btn.dataset.action === 'rename-group') {
          const name = window.prompt('Group name:', group.name);
          if (name?.trim()) { group.name = name.trim(); this._reRenderTabList(); }
        }
        this._hideTabContextMenu();
      });
    });
    const closeOutside = (e) => {
      if (!menu.contains(e.target)) { this._hideTabContextMenu(); document.removeEventListener('mousedown', closeOutside); }
    };
    setTimeout(() => document.addEventListener('mousedown', closeOutside), 10);
  }

  // ── Tab Context Menu ───────────────────────────────────────────────────

  _showTabContextMenu(tabId, x, y) {
    this._hideTabContextMenu();
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const existingGroups = Object.values(this.groups);
    const currentGroupId = tab.groupId || null;

    const colorDots = this._GROUP_COLORS.map((c, i) =>
      `<button class="tcm-color-dot${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    const groupItems = existingGroups.length ? `
      <div class="tcm-label">Add to group</div>
      ${existingGroups.map(g => `
        <button class="tcm-item${currentGroupId === g.id ? ' tcm-active' : ''}" data-action="add-to-group" data-gid="${g.id}">
          <span class="tcm-dot" style="background:${g.color}"></span>${this.escapeHtml(g.name)}
        </button>`).join('')}
      <div class="tcm-sep"></div>` : '';

    const removeItem = currentGroupId ? `
      <button class="tcm-item" data-action="remove-from-group">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
        Remove from group
      </button>
      <div class="tcm-sep"></div>` : '';

    const otherTabs = this.tabs.filter(t => t.id !== tabId);
    const maxPair = 16;
    const pairSection = otherTabs.length
      ? `<div class="tcm-label">Group with another tab</div>
      ${otherTabs.slice(0, maxPair).map(ot => `
        <button class="tcm-item" data-action="new-group-with-tab" data-other-id="${ot.id}">
          <span class="tcm-dot" style="background:#64748b"></span>${this.escapeHtml(this.getTabDisplayTitle(ot))}
        </button>`).join('')}
      ${otherTabs.length > maxPair ? `<div class="tcm-label">${otherTabs.length - maxPair} more tabs — use “Add to group” below</div>` : ''}
      <div class="tcm-sep"></div>`
      : '';

    const pinLabel = tab.pinned ? 'Unpin tab' : 'Pin tab';

    const menu = document.createElement('div');
    menu.id = 'tab-ctx-menu';
    menu.className = 'tab-ctx-menu';
    menu.innerHTML = `
      <button class="tcm-item" data-action="rename-tab">Rename tab…</button>
      ${tab.customTitle ? '<button class="tcm-item" data-action="clear-tab-name">Use page title</button>' : ''}
      <div class="tcm-sep"></div>
      <button class="tcm-item" data-action="toggle-pin">${pinLabel}</button>
      <div class="tcm-sep"></div>
      ${pairSection}
      ${removeItem}
      ${groupItems}
      <div class="tcm-label">New group</div>
      <div class="tcm-ng-row">
        <div class="tcm-color-picker">${colorDots}</div>
        <input class="tcm-ng-input" id="tcm-ng-name" placeholder="Group name…" value="Group ${existingGroups.length + 1}" maxlength="20">
        <button class="tcm-ng-btn" id="tcm-ng-create">Create</button>
      </div>
      <div class="tcm-sep"></div>
      <button class="tcm-item tcm-danger" data-action="close-tab">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Close tab
      </button>
    `;
    document.body.appendChild(menu);

    // Position — keep within viewport
    const mw = 220;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - (menu.scrollHeight || 240) - 8)}px`;

    // Color picker selection
    let selectedColor = this._GROUP_COLORS[0];
    menu.querySelectorAll('.tcm-color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        menu.querySelectorAll('.tcm-color-dot').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
        selectedColor = dot.dataset.color;
      });
    });

    // Create group button
    menu.querySelector('#tcm-ng-create')?.addEventListener('click', () => {
      const name = menu.querySelector('#tcm-ng-name')?.value.trim() || `Group ${Object.keys(this.groups).length + 1}`;
      const gid = this.createGroup(name, selectedColor);
      this.addTabToGroup(tabId, gid);
      this._hideTabContextMenu();
    });

    // Action buttons
    menu.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.action;
        if (act === 'close-tab') this.closeTab(tabId);
        else if (act === 'rename-tab') this._promptRenameTab(tabId);
        else if (act === 'clear-tab-name') this.setTabCustomTitle(tabId, null);
        else if (act === 'toggle-pin') {
          const t = this.tabs.find((x) => x.id === tabId);
          if (t) {
            t.pinned = !t.pinned;
            this._reorderPinnedTabs();
            this.updateTabUI(t);
          }
        } else if (act === 'remove-from-group') this.removeTabFromGroup(tabId);
        else if (act === 'add-to-group') this.addTabToGroup(tabId, btn.dataset.gid);
        else if (act === 'new-group-with-tab') {
          const oid = btn.dataset.otherId;
          const ot = this.tabs.find(x => x.id === oid);
          if (ot) {
            const a = (this.getTabDisplayTitle(tab) || 'Tab').slice(0, 22);
            const b = (this.getTabDisplayTitle(ot) || 'Tab').slice(0, 22);
            const name = `${a} / ${b}`.slice(0, 36);
            const colorIdx = Object.keys(this.groups).length % this._GROUP_COLORS.length;
            const gid = this.createGroup(name, this._GROUP_COLORS[colorIdx]);
            this.addTabToGroup(tabId, gid);
            this.addTabToGroup(ot.id, gid);
          }
        }
        this._hideTabContextMenu();
      });
    });

    // Close on outside click
    const closeOutside = (e) => {
      if (!menu.contains(e.target)) {
        this._hideTabContextMenu();
        document.removeEventListener('mousedown', closeOutside);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeOutside), 10);
  }

  _hideTabContextMenu() {
    document.getElementById('tab-ctx-menu')?.remove();
  }

  async autoOrganizeTabsWithAi() {
    const cfg = await window.navio.getConfig();
    if (cfg.aiKillSwitch || !cfg.hasApiKey) {
      if (typeof _showAppToast === 'function') _showAppToast('Add an API key in Settings → AI.', 'warning');
      return;
    }
    if (this.tabs.length < 2) return;
    const lines = this.tabs.map((t, i) => `${i}: ${this.getTabDisplayTitle(t)} — ${t.url}`).join('\n');
    const messages = [
      {
        role: 'user',
        content:
          `Group these browser tabs by topic. Reply with ONLY a JSON array like [{"name":"Work","indexes":[0,2]},{"name":"Read","indexes":[1]}] using 0-based indexes from the list below. Use at most 8 groups. Tabs:\n${lines}`
      }
    ];
    let r;
    try { r = await window.navio.aiRequest({ messages }); }
    catch (e) {
      if (typeof _showAppToast === 'function') _showAppToast('AI request failed.', 'error');
      return;
    }
    if (r.error) {
      if (typeof _showAppToast === 'function') _showAppToast(r.error, 'error');
      return;
    }
    const m = r.content && r.content.match(/\[[\s\S]*\]/);
    if (!m) {
      if (typeof _showAppToast === 'function') _showAppToast('AI did not return JSON groups.', 'error');
      return;
    }
    let groups;
    try {
      groups = JSON.parse(m[0]);
    } catch {
      if (typeof _showAppToast === 'function') _showAppToast('Invalid JSON from AI.', 'error');
      return;
    }
    if (!Array.isArray(groups)) return;
    for (const g of groups) {
      const name = g.name || 'Group';
      const idxs = Array.isArray(g.indexes) ? g.indexes : Array.isArray(g.tabIndexes) ? g.tabIndexes : [];
      if (!idxs.length) continue;
      const gid = this.createGroup(name);
      for (const idx of idxs) {
        const t = this.tabs[typeof idx === 'number' ? idx : parseInt(idx, 10)];
        if (t) this.addTabToGroup(t.id, gid);
      }
    }
    if (typeof _showAppToast === 'function') _showAppToast('Tab groups updated from AI.', 'success');
  }

  async suggestCloseDuplicateTabsWithAi() {
    const cfg = await window.navio.getConfig();
    if (cfg.aiKillSwitch || !cfg.hasApiKey) {
      if (typeof _showAppToast === 'function') _showAppToast('Add an API key in Settings → AI.', 'warning');
      return;
    }
    if (this.tabs.length < 2) return;
    const lines = this.tabs.map((t, i) => `${i}: ${this.getTabDisplayTitle(t)} — ${t.url}`).join('\n');
    const messages = [
      {
        role: 'user',
        content:
          `Find duplicate or near-duplicate tabs (same URL or trivial variants). Reply with ONLY a JSON array of tab indexes to CLOSE, e.g. [2,5]. Prefer keeping the oldest index when duplicates exist. If none, reply with []. Tabs:\n${lines}`
      }
    ];
    let r;
    try { r = await window.navio.aiRequest({ messages }); }
    catch (e) {
      if (typeof _showAppToast === 'function') _showAppToast('AI request failed.', 'error');
      return;
    }
    if (r.error) {
      if (typeof _showAppToast === 'function') _showAppToast(r.error, 'error');
      return;
    }
    const m = r.content && r.content.match(/\[[\s\S]*?\]/);
    if (!m) {
      if (typeof _showAppToast === 'function') _showAppToast('AI did not return a list.', 'error');
      return;
    }
    let idxs;
    try {
      idxs = JSON.parse(m[0]);
    } catch {
      if (typeof _showAppToast === 'function') _showAppToast('Invalid JSON from AI.', 'error');
      return;
    }
    if (!Array.isArray(idxs) || idxs.length === 0) {
      if (typeof _showAppToast === 'function') _showAppToast('No duplicate tabs suggested.', 'success');
      return;
    }
    const sorted = [...new Set(idxs.map((i) => parseInt(i, 10)).filter((n) => !Number.isNaN(n)))].sort((a, b) => b - a);
    for (const idx of sorted) {
      const t = this.tabs[idx];
      if (t && !t.pinned) this.closeTab(t.id);
    }
    if (typeof _showAppToast === 'function') _showAppToast('Closed suggested duplicate tabs.', 'success');
  }
}

const TabManager = new TabManagerClass();
