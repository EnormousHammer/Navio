/**
 * Navio Browser - Tab Management System
 * Handles tab creation, switching, closing, and webview lifecycle
 */

/** In-memory webview partition; must match electron/navio-partitions.js */
const NAVIO_INCOGNITO_PARTITION = 'navio-incognito';

/** Default label for the built-in start surface (shown in tab strip when no page title yet). */
const NAVIO_HOME_TAB_LABEL = 'Home';

class TabManagerClass {
  constructor() {
    /** `undefined` = not fetched yet; non-empty string = file URL for `<webview preload>` */
    this._webviewGuestPreloadHref = undefined;
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
    this._GROUP_COLORS = ['#60a5fa','#a78bfa','#34d399','#f87171','#fb923c','#fbbf24','#f472b6','#5eead4','#94a3b8'];

    /** Recent closed tabs for Ctrl+Shift+T (Chrome-style). */
    this._recentlyClosed = [];

    this.tabListEl = document.getElementById('tab-list');
    this.browserContainer = document.getElementById('browser-container');
    this.newTabPage = document.getElementById('new-tab-page');

    document.getElementById('btn-new-tab').addEventListener('click', () => this.createTab());
    document.getElementById('btn-new-private-tab')?.addEventListener('click', () =>
      this.createTab(null, { incognito: true })
    );
    document.getElementById('btn-navio-ai-activity')?.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._toggleNavioAiActivityMenu();
    });

    this._ensureTabListTrail();

    this.tabListEl.addEventListener('wheel', (e) => {
      // Convert vertical scroll to horizontal so a regular mouse wheel pans the tab strip.
      // Also handle deltaX so touchpad horizontal swipes scroll natively.
      if (e.deltaX !== 0 || e.deltaY !== 0) {
        e.preventDefault();
        this.tabListEl.scrollLeft += e.deltaX || e.deltaY;
      }
    }, { passive: false });

    // Belt-and-suspenders: explicitly set pixel dimensions on resize as well,
    // since some Electron builds ignore CSS-only sizing on <webview>.
    this._containerObserver = new ResizeObserver(() => this._syncWebviewSizes());
    this._containerObserver.observe(this.browserContainer);

    /** Idle tab discard (memory): interval in `tabDiscardIdleMinutes` from config. */
    this._tabDiscardInterval = null;
    this._startTabDiscardSchedule();

    // ── Split ratio (0.2 – 0.8); default 50/50 ────────────────────────
    this._splitRatio = 0.5;
    this._initSplitDivider();

    // ── Tab drag-to-reorder ────────────────────────────────────────────
    this._dragState = null;
    this._boundDragPointerMove = this._onDragPointerMove.bind(this);
    this._boundDragPointerUp   = this._onDragPointerUp.bind(this);

    setTimeout(() => {
      try {
        this.refreshNavioActivityBadge();
      } catch {
        /* ignore */
      }
    }, 0);
  }

  /**
   * Resolve absolute file URL for webview-preload.js (password capture, autofill, chat guest bridge).
   * Must run before the first tab is created — NavioApp.init awaits this.
   */
  async primeWebviewPreload() {
    if (this._webviewGuestPreloadHref !== undefined) return;
    try {
      if (window.navio && typeof window.navio.getWebviewGuestPreloadHref === 'function') {
        const href = await window.navio.getWebviewGuestPreloadHref();
        this._webviewGuestPreloadHref = typeof href === 'string' && href.length > 0 ? href : '';
      } else {
        this._webviewGuestPreloadHref = '';
      }
    } catch {
      this._webviewGuestPreloadHref = '';
    }
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
      <button type="button" class="tab-strip-new tab-strip-new-inline" id="btn-new-tab-inline" title="Home (Ctrl+T)" aria-label="New tab — Home">
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

  /** Matches `#browser-container webview { bottom: var(--ntp-ticker-reserve) }` for inline height. */
  _ntpTickerReservePx() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--ntp-ticker-reserve').trim();
      if (v.endsWith('px')) return Math.max(0, parseFloat(v) || 0);
    } catch (_) {}
    return 0;
  }

  /**
   * Resolve a valid split partner for a tab.
   * Keeps split links reciprocal: if A points to B but B does not point to A,
   * the stale link is cleared instead of corrupting B's current split.
   */
  _resolveReciprocalSplitPartner(tab) {
    if (!tab) return null;
    if (!tab.splitPartnerId) {
      if (tab.splitLeftPaneTabId) tab.splitLeftPaneTabId = null;
      return null;
    }
    const partner = this.tabs.find((t) => t.id === tab.splitPartnerId);
    if (!partner || partner.splitPartnerId !== tab.id) {
      tab.splitPartnerId = null;
      tab.splitLeftPaneTabId = null;
      return null;
    }
    return partner;
  }

  /**
   * Keep active/split visibility classes and sizes in sync without changing
   * URL bar / focus / assistant hooks (used for internal split state repair).
   */
  _refreshActiveSplitPresentation() {
    const focused = this.getActiveTab();
    const splitPartner = this._resolveReciprocalSplitPartner(focused);

    this.tabs.forEach((tab) => {
      if (!tab.webview) return;
      const isFocused = !!focused && tab.id === focused.id;
      const inSplitPair = !!(focused && splitPartner && (tab.id === focused.id || tab.id === splitPartner.id));
      tab.webview.classList.toggle('active', isFocused);
      tab.webview.classList.toggle('split-visible', inSplitPair);

      const tabEl = document.getElementById(`tabitem-${tab.id}`);
      if (tabEl) tabEl.classList.toggle('active', isFocused);
    });

    this._syncWebviewSizes();
  }

  _syncWebviewSizes() {
    const { width, height } = this.browserContainer.getBoundingClientRect();
    if (!width || !height) return;
    const reserve = this._ntpTickerReservePx();
    const usableH = Math.max(0, height - reserve);

    const focused = this.activeTabId ? this.tabs.find((t) => t.id === this.activeTabId) : null;
    const partner = this._resolveReciprocalSplitPartner(focused);

    // Show / position the resizable split divider
    if (this._splitDivider) {
      if (partner && focused) {
        const wLeft = Math.round(width * this._splitRatio);
        this._splitDivider.style.display = '';
        this._splitDivider.style.left  = `${wLeft - 4}px`;
        this._splitDivider.style.top   = '0px';
        this._splitDivider.style.height = `${usableH}px`;
      } else {
        this._splitDivider.style.display = 'none';
      }
    }

    this.tabs.forEach((tab) => {
      const wv = tab.webview;
      if (!wv) return;
      wv.classList.remove('split-left', 'split-right');

      if (partner && focused && (tab.id === focused.id || tab.id === partner.id)) {
        const ia = this.tabs.findIndex((t) => t.id === focused.id);
        const ib = this.tabs.findIndex((t) => t.id === partner.id);
        const fallbackLeft = ia <= ib ? focused : partner;
        const leftId = focused.splitLeftPaneTabId || partner.splitLeftPaneTabId;
        const leftTab = (leftId ? this.tabs.find((t) => t.id === leftId) : null) || fallbackLeft;
        const isLeft = tab.id === leftTab.id;
        const wLeft = Math.round(width * this._splitRatio);
        const wRight = Math.max(0, width - wLeft);
        wv.style.left = isLeft ? '0px' : `${wLeft}px`;
        wv.style.right = 'auto';
        wv.style.width = `${isLeft ? wLeft : wRight}px`;
        wv.style.height = `${usableH}px`;
        wv.style.top = '0px';
        wv.classList.add(isLeft ? 'split-left' : 'split-right');
      } else {
        wv.style.left = '0px';
        wv.style.right = '0px';
        wv.style.width = `${width}px`;
        wv.style.height = `${usableH}px`;
      }
    });
  }

  createTab(url = null, opts = {}) {
    const id = `tab-${++this.tabCounter}`;
    const incognito = !!opts.incognito;
    const tab = {
      id,
      title: NAVIO_HOME_TAB_LABEL,
      /** User override shown in the tab strip; page title updates still fill `title`. */
      customTitle: null,
      url: url || '',
      favicon: null,
      loading: false,
      webview: null,
      /** Tab created from guest window.open (main); may auto-close when navigation is a file download. */
      guestWindowOpen: !!opts.guestWindowOpen,
      pinned: false,
      incognito,
      /** Other tab id when this tab shares a split view (Chrome-style side-by-side). */
      splitPartnerId: null,
      /** Which tab id is laid out in the left pane (both partners share the same value). */
      splitLeftPaneTabId: null,
      /** Per-tab zoom override (null = use Settings default zoom). */
      zoomFactor: null
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
    if (this._webviewGuestPreloadHref) {
      webview.setAttribute('preload', this._webviewGuestPreloadHref);
    }
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
    this._syncWebviewSizes();

    this.tabs.push(tab);
    this.renderTabItem(tab);
    const doSwitch = opts.switchTo !== false;
    if (!doSwitch) {
      tab._inactiveSince = Date.now();
    }
    if (doSwitch) {
      this.switchToTab(id);
    }

    this._emitTabsChanged('create-tab');
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
      await new Promise((r) => setTimeout(r, 48));
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
          setTimeout(resolve, 64);
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

  _emitTabsChanged(reason = 'update') {
    try {
      window.dispatchEvent(
        new CustomEvent('navio-tabs-changed', {
          detail: {
            reason,
            activeTabId: this.activeTabId || null,
            tabCount: this.tabs.length
          }
        })
      );
    } catch {
      /* ignore */
    }
  }

  /** Internal full-page AI chat (`navio-chat-tab.html`) — not a normal browsing surface. */
  isNavioChatTabUrl(url) {
    const u = (url || '').toLowerCase();
    return u.includes('navio-chat-tab.html');
  }

  /** True for a normal https page (not internal Navio chat). */
  isHttpBrowsingSurface(tab) {
    if (!tab) return false;
    const u = tab.url || '';
    return typeof u === 'string' && u.startsWith('http') && !this.isNavioChatTabUrl(u);
  }

  /**
   * Tab used for AI tools, page extraction, and snapshots.
   * Priority: (1) agent-controlled tab (tool loop / takeover); (2) during a full-page guest
   * AI turn with a source-tab anchor, that anchored tab — even if the user focuses another site;
   * (3) focused tab if it is a normal web page (http/https); (4) anchored tab when Navio AI
   * chat is focused; (5) last focused non-chat page; (6) first other non-chat tab.
   */
  getBrowserContextTab() {
    const isWebSurface = (u) =>
      typeof u === 'string' && u.startsWith('http') && !this.isNavioChatTabUrl(u);

    const agentTab = this.getAgentControlledTab();
    if (agentTab && agentTab.webview) {
      const au = agentTab.url || '';
      if (isWebSurface(au)) return agentTab;
    }

    // Comet-style: guest full-page chat anchored to a tab — keep that tab as browsing context
    // while the turn runs, so focusing another site does not steal context from the AI task.
    try {
      const AM = typeof AssistantManager !== 'undefined' ? AssistantManager : null;
      if (AM && AM._guestChatWebview && AM._guestAnchoredTabId != null && AM._guestAnchoredTabId !== '') {
        const anchored = this.tabs.find((t) => t.id === AM._guestAnchoredTabId);
        if (anchored && anchored.webview && isWebSurface(anchored.url || '')) {
          return anchored;
        }
      }
    } catch {
      /* ignore */
    }

    const active = this.getActiveTab();
    if (active && active.webview) {
      const u = active.url || '';
      if (isWebSurface(u)) {
        return active;
      }
      // Comet-style: when the full-page AI chat is focused, always use the tab
      // it was anchored to — not the dynamically-changing _lastBrowserSurfaceTabId.
      if (this.isNavioChatTabUrl(u)) {
        const anchoredId = typeof AssistantManager !== 'undefined'
          ? AssistantManager._guestAnchoredTabId
          : null;
        if (anchoredId) {
          const anchored = this.tabs.find(t => t.id === anchoredId);
          if (anchored && anchored.webview && isWebSurface(anchored.url || '')) {
            return anchored;
          }
        }
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
      // Apply split / full layout for all webviews; do not force this pane to full width
      // or partner panes stay the wrong size until the next resize.
      this._syncWebviewSizes();
      if (tab.guestWindowOpen && typeof window.navio?.registerGuestDownloadShell === 'function') {
        try {
          if (typeof wv.getWebContentsId === 'function') {
            window.navio.registerGuestDownloadShell(wv.getWebContentsId());
          }
        } catch {
          /* ignore */
        }
      }
      if (wv._pendingUrl) {
        const url = wv._pendingUrl;
        wv._pendingUrl = null;
        const run = () => wv.loadURL(url).catch(err => console.warn('Pending loadURL failed:', err));
        if (typeof queueMicrotask === 'function') queueMicrotask(run);
        else setTimeout(run, 0);
      }
    });

    wv.addEventListener('focus', () => {
      if (tab.id === this.activeTabId) return;
      const active = this.getActiveTab();
      if (!active?.splitPartnerId) return;
      if (active.splitPartnerId === tab.id || tab.splitPartnerId === active.id) {
        this.switchToTab(tab.id);
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
        const friendly = this._navFriendlyLoadError(e.errorCode, e.errorDescription || '');
        this._scheduleWebviewInlineError(
          wv,
          friendly,
          tab.url || validated,
          e.errorCode,
          e.errorDescription || ''
        );
      }
    });

    // ── Tab crash recovery (Chrome-style "Aw snap") ──────────────────────────
    // When the guest renderer dies (OOM, site-isolated segfault, killed, etc.)
    // the webview becomes a blank black rectangle with no indication of why.
    // Render a dedicated crash card and let the user reload the URL directly.
    // 'render-process-gone' replaced 'crashed' in Electron 12+; listen for both.
    const onGuestGone = (e) => {
      tab.loading = false;
      this.updateTabUI(tab);
      try { App.showLoading(false); } catch { /* ignore */ }
      if (tab.id !== this.activeTabId) return;
      const reason = (e && (e.reason || e.details?.reason)) || 'crashed';
      const reasonMap = {
        'clean-exit': 'The page process exited unexpectedly.',
        'abnormal-exit': 'The page process exited abnormally.',
        'killed': 'The page process was killed (likely out of memory or terminated by the OS).',
        'crashed': 'The page crashed.',
        'oom': 'The page ran out of memory.',
        'launch-failed': 'The page process failed to start.',
        'integrity-failure': 'The page was blocked by integrity protection.'
      };
      const desc = reasonMap[reason] || 'The page stopped responding.';
      this._scheduleWebviewCrashPage(wv, desc, tab.url || '', reason);
    };
    wv.addEventListener('media-started-playing', () => {
      tab.isPlaying = true;
      this._updateTabAudioUI(tab.id);
    });
    wv.addEventListener('media-paused', () => {
      tab.isPlaying = false;
      this._updateTabAudioUI(tab.id);
    });

    wv.addEventListener('render-process-gone', onGuestGone);
    // Legacy fallback (older Electron) — harmless to register both.
    wv.addEventListener('crashed', () => onGuestGone({ reason: 'crashed' }));
    wv.addEventListener('unresponsive', () => {
      // Do NOT auto-inject a crash page here — many SPAs block the main thread
      // temporarily. Just mark the tab so the user can see it in the strip.
      tab.title = tab.title ? `⏳ ${tab.title}` : '⏳ Unresponsive';
      this.updateTabUI(tab);
    });
    wv.addEventListener('responsive', () => {
      // Restore title on next navigate/finish.
    });

    wv.addEventListener('did-finish-load', async () => {
      if (tab.guestWindowOpen && typeof window.navio?.unregisterGuestDownloadShell === 'function') {
        if (tab._guestShellUnregisterTimer) clearTimeout(tab._guestShellUnregisterTimer);
        tab._guestShellUnregisterTimer = setTimeout(() => {
          tab._guestShellUnregisterTimer = null;
          try {
            if (typeof wv.getWebContentsId === 'function') {
              window.navio.unregisterGuestDownloadShell(wv.getWebContentsId());
            }
          } catch {
            /* ignore */
          }
        }, 400);
      }
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
        } else if (e.channel === 'navio-guest-pointer-down') {
          try {
            if (typeof window.__navioCloseDownloadsDrawer === 'function') {
              window.__navioCloseDownloadsDrawer();
            }
          } catch {
            /* ignore */
          }
        } else if (e.channel === 'navio-chat-host') {
          const payload = data;
          const deliverGuest = () => {
            if (payload && typeof AssistantManager !== 'undefined' && AssistantManager.handleGuestChatHostMessage) {
              AssistantManager.handleGuestChatHostMessage(tab, wv, payload);
              return true;
            }
            return false;
          };
          if (payload && !deliverGuest()) {
            setTimeout(() => {
              void deliverGuest();
            }, 80);
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

  /**
   * Map Chromium net error codes to short, user-readable text (see net/base/net_error_list.h).
   */
  _navFriendlyLoadError(errorCode, errorDescription) {
    const code = Number(errorCode);
    const raw = String(errorDescription || '').trim();
    const byCode = {
      [-2]: 'The page could not be loaded (network or server error).',
      [-6]: 'The file or page was not found.',
      [-7]: 'The request timed out.',
      [-13]: 'The server returned an error.',
      [-21]: 'The network changed; try again.',
      [-102]: 'The server refused the connection.',
      [-104]: 'The connection was reset.',
      [-105]: 'Could not find that site — check the address and your DNS/network.',
      [-106]: 'No internet connection.',
      [-107]: 'Could not establish a secure connection (TLS/SSL).',
      [-109]: 'Could not reach the server.',
      [-118]: 'The connection timed out.',
      [-200]: 'The site’s security certificate is not trusted.',
      [-201]: 'The certificate date is invalid.',
      [-202]: 'The certificate does not match this site.',
      [-203]: 'The certificate is not yet valid.'
    };
    if (Number.isFinite(code) && Object.prototype.hasOwnProperty.call(byCode, code)) {
      return byCode[code];
    }
    if (Number.isFinite(code) && code <= -200 && code >= -260) {
      return 'There is a problem with the site’s security certificate.';
    }
    if (raw) {
      if (raw.startsWith('ERR_')) {
        const words = raw
          .replace(/^ERR_/, '')
          .replace(/_/g, ' ')
          .toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1) + '.';
      }
      return raw.endsWith('.') ? raw : raw + '.';
    }
    return 'The page could not be loaded.';
  }

  _scheduleWebviewInlineError(wv, description, pageUrl, errorCode, rawDescription) {
    const errHtml = this._buildErrorPage(description, pageUrl, errorCode, rawDescription);
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

  _scheduleWebviewCrashPage(wv, description, pageUrl, reason) {
    const errHtml = this._buildCrashPage(description, pageUrl, reason);
    const b64 = this._utf8ToBase64(errHtml);
    const dataUrl = b64
      ? `data:text/html;charset=UTF-8;base64,${b64}`
      : `data:text/html;charset=utf-8,${encodeURIComponent(errHtml)}`;
    const inject = () => {
      try { if (typeof wv.stop === 'function') wv.stop(); } catch { /* ignore */ }
      try { wv.loadURL(dataUrl).catch(() => {}); } catch { /* ignore */ }
    };
    requestAnimationFrame(() => requestAnimationFrame(inject));
  }

  _buildCrashPage(description, url, reason) {
    const safeUrl = url ? String(url).replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
    const safeDesc = String(description || 'The page crashed.').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeReason = String(reason || 'crashed').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
    background:#080c18;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#8892b4;}
  .box{text-align:center;max-width:520px;padding:40px 24px;}
  .icon{font-size:56px;margin-bottom:12px;opacity:.7;}
  h1{font-size:24px;font-weight:700;color:#e2e8f8;margin:0 0 8px;letter-spacing:-0.01em;}
  p{font-size:14px;line-height:1.6;margin:0 0 24px;opacity:.75;}
  .url{font-size:12px;word-break:break-all;padding:8px 12px;background:rgba(80,160,255,.05);
    border:1px solid rgba(80,160,255,.10);border-radius:6px;margin:0 0 20px;opacity:.65;}
  .tech{font-size:12px;margin:0 0 20px;opacity:.5;}
  .actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
  button{padding:10px 22px;background:linear-gradient(135deg,#00d8ff,#5468ff);border:none;
    border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
  button.ghost{background:transparent;border:1px solid rgba(80,160,255,.25);color:#cfe0ff;}
  button:hover{opacity:.9;}
</style></head><body>
<div class="box">
  <div class="icon">💥</div>
  <h1>Aw snap — this page stopped</h1>
  <p>${safeDesc}</p>
  ${safeUrl ? `<div class="url">${safeUrl}</div>` : ''}
  <div class="tech">reason: ${safeReason}</div>
  <div class="actions">
    ${safeUrl ? `<button onclick="location.href=${JSON.stringify(url)}">Reload</button>` : ''}
    <button class="ghost" onclick="history.back()">Go back</button>
  </div>
</div></body></html>`;
  }

  _buildErrorPage(description, url, errorCode, rawDescription) {
    const safeUrl = url ? url.replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
    const safeDesc = (description || 'Unknown error').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const code = Number(errorCode);
    const raw = String(rawDescription || '').trim();
    let tech = '';
    if (Number.isFinite(code) && code !== 0) {
      tech = `Error code: ${code}`;
      if (raw && raw !== description) tech += ` · ${raw.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
    } else if (raw && raw !== description) {
      tech = raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const techBlock = tech
      ? `<p style="font-size:12px;opacity:.55;margin:0 0 16px">${tech}</p>`
      : '';
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
  ${techBlock}
  ${safeUrl ? `<div class="url">${safeUrl}</div>` : ''}
  <button onclick="history.back()">Go back</button>
</div></body></html>`;
  }

  /** True when the built-in Home / new-tab surface is visible (no guest webview zoom target). */
  _isNewTabSurfaceActive() {
    try {
      const ntp = document.getElementById('new-tab-page');
      return !!(ntp && ntp.classList.contains('active'));
    } catch {
      return false;
    }
  }

  applyZoomToWebview(wv) {
    if (!wv) return;
    const tab = this.tabs.find((t) => t.webview === wv);
    const cfgZ = typeof App !== 'undefined' && App.config ? App.config.defaultZoom : 1;
    const cfgN = typeof cfgZ === 'number' ? cfgZ : parseFloat(cfgZ);
    const cfgFactor = Number.isFinite(cfgN) ? Math.min(3, Math.max(0.25, cfgN)) : 1;
    const raw = tab && tab.zoomFactor != null ? tab.zoomFactor : cfgFactor;
    const factor = Number.isFinite(raw) ? Math.min(3, Math.max(0.25, raw)) : cfgFactor;
    try {
      wv.setZoomFactor(factor);
    } catch (e) {
      /* webview may not be ready — main-process fallback for isolated builds */
      try {
        const id = typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : null;
        if (id != null && window.navio?.webviewSetZoom) {
          void window.navio.webviewSetZoom(id, factor);
        }
      } catch {
        /* ignore */
      }
    }
  }

  applyZoomFromConfig() {
    this.tabs.forEach((t) => {
      t.zoomFactor = null;
      this.applyZoomToWebview(t.webview);
    });
  }

  /**
   * Sets zoom for the active tab (persists on the tab; survives did-finish-load).
   * Pass `null` to clear override and use Settings default.
   */
  setActiveTabZoomFactor(nextFactor) {
    const tab = this.getActiveTab();
    if (this._isNewTabSurfaceActive() && typeof window.__navioSetNtpZoom === 'function') {
      if (nextFactor == null) {
        window.__navioSetNtpZoom(1);
      } else {
        window.__navioSetNtpZoom(nextFactor);
      }
      if (typeof window.__navioSyncNewTabSurfaceZoom === 'function') {
        window.__navioSyncNewTabSurfaceZoom();
      }
      if (typeof window.__navioUpdateZoomLabel === 'function') {
        window.__navioUpdateZoomLabel();
      }
      return;
    }
    const wv = this.getActiveWebview();
    if (!tab || !wv) return;
    if (nextFactor == null) {
      tab.zoomFactor = null;
    } else {
      const f = Math.min(3, Math.max(0.25, Number(nextFactor) || 1));
      tab.zoomFactor = f;
    }
    this.applyZoomToWebview(wv);
    if (typeof window.__navioSyncNewTabSurfaceZoom === 'function') {
      window.__navioSyncNewTabSurfaceZoom();
    }
    if (typeof window.__navioUpdateZoomLabel === 'function') {
      window.__navioUpdateZoomLabel();
    }
  }

  /** Step zoom for the active tab (used by Ctrl/Cmd +/−). */
  zoomActiveTabBy(delta) {
    if (
      this._isNewTabSurfaceActive() &&
      typeof window.__navioGetNtpZoom === 'function' &&
      typeof window.__navioSetNtpZoom === 'function'
    ) {
      const cur = window.__navioGetNtpZoom() || 1;
      window.__navioSetNtpZoom(cur + delta);
      if (typeof window.__navioUpdateZoomLabel === 'function') {
        window.__navioUpdateZoomLabel();
      }
      return;
    }
    const wv = this.getActiveWebview();
    if (!wv) return;
    let cur = 1;
    try {
      cur = typeof wv.getZoomFactor === 'function' ? wv.getZoomFactor() : 1;
    } catch {
      cur = 1;
    }
    if (!Number.isFinite(cur)) cur = 1;
    const next = Math.min(3, Math.max(0.25, cur + delta));
    this.setActiveTabZoomFactor(next);
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
    if (!nextTab) return;
    if (nextTab._discarded && nextTab._discardUrl && nextTab.webview) {
      this._restoreDiscardedTab(nextTab);
    }

    this.activeTabId = id;
    nextTab._inactiveSince = undefined;

    const focused = nextTab;
    const splitPartner = this._resolveReciprocalSplitPartner(focused);

    this.tabs.forEach((tab) => {
      if (!tab.webview) return;
      const isFocused = tab.id === id;
      const inSplitPair = !!(splitPartner && (tab.id === focused.id || tab.id === splitPartner.id));
      tab.webview.classList.toggle('active', isFocused);
      tab.webview.classList.toggle('split-visible', inSplitPair);

      const tabEl = document.getElementById(`tabitem-${tab.id}`);
      if (tabEl) tabEl.classList.toggle('active', isFocused);
    });

    this._syncWebviewSizes();

    const activeTab = this.getActiveTab();
    if (activeTab) {
      document.body.classList.toggle('navio-incognito-active', !!activeTab.incognito);
      const inSplit = !!(activeTab.splitPartnerId && splitPartner);
      if (activeTab.url) {
        App.updateUrlBar(activeTab.url);
        this.hideNewTabPage();
      } else {
        App.updateUrlBar('');
        if (inSplit) this.hideNewTabPage();
        else this.showNewTabPage();
      }
      App.updateNavigationButtons(activeTab.webview);
      this.updateContextTitle(activeTab);
      if (typeof window.__navioUpdateZoomLabel === 'function') {
        window.__navioUpdateZoomLabel();
      }
      // New tab surface: omnibox is the primary input. Only focus the guest webview once this tab has a real URL.
      if (activeTab.url && activeTab.webview) {
        try {
          activeTab.webview.focus();
        } catch (_) {}
      } else if (!activeTab.url && inSplit) {
        /* Split blank pane: NTP is hidden — still focus omnibox (non-split uses showNewTabPage → focus). */
        this._focusUrlBarForNewTab();
      }

      const u = activeTab.url || '';
      if (u.startsWith('http') && !this.isNavioChatTabUrl(u)) {
        this._lastBrowserSurfaceTabId = activeTab.id;
      }
    }

    // Keep the active tab chip in view — use instant scroll so rapid switches (e.g. within a group)
    // feel as snappy as Chrome; smooth scrolling reads as lag on every click.
    requestAnimationFrame(() => {
      const activeEl = document.getElementById(`tabitem-${id}`);
      if (activeEl) {
        try {
          activeEl.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
        } catch {
          activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    });

    if (typeof AssistantManager !== 'undefined' && typeof AssistantManager.onActiveTabChanged === 'function') {
      if (prevId !== id) {
        AssistantManager.onActiveTabChanged(prevId, id);
      }
    }
    this._emitTabsChanged('switch-tab');
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

    const active = this.getActiveTab();
    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue;
      if (active?.splitPartnerId === tab.id) continue;
      if (tab.pinned) continue;
      if (tab.incognito) continue;
      if (tab._discarded) continue;
      if (tab.loading) continue;
      if (this._agentControlledTabId === tab.id) continue;
      // Don't discard a tab that has an active AI chat turn in progress
      const _sk = typeof AssistantManager !== 'undefined' ? AssistantManager._storageKeyForTabId?.(String(tab.id)) : null;
      if (_sk && AssistantManager?._busyTabs?.has(_sk)) continue;
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
    if (tab._guestShellUnregisterTimer) {
      clearTimeout(tab._guestShellUnregisterTimer);
      tab._guestShellUnregisterTimer = null;
    }
    if (tab.guestWindowOpen && typeof window.navio?.unregisterGuestDownloadShell === 'function' && tab.webview) {
      try {
        if (typeof tab.webview.getWebContentsId === 'function') {
          window.navio.unregisterGuestDownloadShell(tab.webview.getWebContentsId());
        }
      } catch {
        /* ignore */
      }
    }

    let closedWasInSplit = false;
    if (tab.splitPartnerId) {
      closedWasInSplit = true;
      const pid = tab.splitPartnerId;
      this._clearSplitPartner(id);
      const p = this.tabs.find((t) => t.id === pid);
      if (p) this.updateTabUI(p);
    }

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

    if (typeof AssistantManager !== 'undefined' && typeof AssistantManager.onTabClosed === 'function') {
      AssistantManager.onTabClosed(id, {
        groupId: tab.groupId || null,
        incognito: !!tab.incognito,
        archiveTitle: (this.getTabDisplayTitle(tab) || tab.title || '').trim()
      });
    }

    // If the closed tab was in a group, rebuild the strip to update counts/remove empty headers
    if (hadGroup) this._reRenderTabList();
    else this._applyAgentControlledTabClasses();

    if (closedWasInSplit && this.activeTabId && this.activeTabId !== id) {
      this.switchToTab(this.activeTabId);
    }

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
    this._emitTabsChanged('close-tab');
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

  _clearSplitPartner(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!tab.splitPartnerId) {
      if (tab.splitLeftPaneTabId) tab.splitLeftPaneTabId = null;
      return;
    }
    const pid = tab.splitPartnerId;
    const p = this.tabs.find((t) => t.id === pid);
    tab.splitPartnerId = null;
    tab.splitLeftPaneTabId = null;
    if (p && p.splitPartnerId === tab.id) {
      p.splitPartnerId = null;
      p.splitLeftPaneTabId = null;
    }
    this._refreshActiveSplitPresentation();
  }

  /**
   * Put both tabs in one colored group (Chrome-style): split pairs stay grouped in the strip.
   * If one tab is already grouped, the other joins that group. If both are in different groups,
   * they merge into a new split-named group.
   */
  _assignSharedGroupForSplitPair(a, b) {
    if (!a || !b) return;
    if (a.groupId && b.groupId && a.groupId === b.groupId) return;

    if (a.groupId && !b.groupId) {
      this.addTabToGroup(b.id, a.groupId);
      return;
    }
    if (!a.groupId && b.groupId) {
      this.addTabToGroup(a.id, b.groupId);
      return;
    }

    const titleA = (this.getTabDisplayTitle(a) || 'Tab').trim().slice(0, 18);
    const titleB = (this.getTabDisplayTitle(b) || 'Tab').trim().slice(0, 18);
    const name = `Split: ${titleA} · ${titleB}`.slice(0, 38);
    const color = this._GROUP_COLORS[this._groupCounter % this._GROUP_COLORS.length];
    const gid = this.createGroup(name, color);
    this.addTabToGroup(a.id, gid);
    this.addTabToGroup(b.id, gid);
  }

  /**
   * Keep the two split tabs next to each other in strip order (Chrome-style).
   * Skipped when either tab is pinned so pinned-first order stays intact.
   */
  _moveTabsAdjacentForSplit(leftTab, rightTab) {
    if (!leftTab || !rightTab || leftTab.id === rightTab.id) return;
    if (leftTab.pinned || rightTab.pinned) return;
    const ids = new Set([leftTab.id, rightTab.id]);
    const ia = this.tabs.findIndex((t) => t.id === leftTab.id);
    const ib = this.tabs.findIndex((t) => t.id === rightTab.id);
    if (ia < 0 || ib < 0) return;
    const insertAt = Math.min(ia, ib);
    const rest = this.tabs.filter((t) => !ids.has(t.id));
    this.tabs.splice(0, this.tabs.length, ...rest.slice(0, insertAt), leftTab, rightTab, ...rest.slice(insertAt));
  }

  /**
   * Side-by-side split (Chrome-style): two http(s) tabs, same privacy mode.
   * @returns {boolean}
   */
  splitTabWith(tabIdA, tabIdB) {
    const a = this.tabs.find((t) => t.id === tabIdA);
    const b = this.tabs.find((t) => t.id === tabIdB);
    if (!a || !b || a.id === b.id) return false;
    if (this.isNavioChatTabUrl(a.url || '') || this.isNavioChatTabUrl(b.url || '')) {
      if (typeof _showAppToast === 'function') {
        _showAppToast('Split view is not available for Navio chat tabs.', 'warning');
      }
      return false;
    }
    if (!!a.incognito !== !!b.incognito) {
      if (typeof _showAppToast === 'function') {
        _showAppToast('Split only works between tabs in the same privacy mode.', 'warning');
      }
      return false;
    }
    const urlOk = (t) => {
      const u = (t.url || '').trim();
      return u.startsWith('http');
    };
    if (!urlOk(a) || !urlOk(b)) {
      if (typeof _showAppToast === 'function') {
        _showAppToast('Open a webpage (http/https) in both tabs before using split view.', 'warning');
      }
      return false;
    }

    // If either tab is currently discarded (about:blank placeholder), restore it
    // before entering split mode so both panes show real page content.
    if (a._discarded && a._discardUrl && a.webview) this._restoreDiscardedTab(a);
    if (b._discarded && b._discardUrl && b.webview) this._restoreDiscardedTab(b);

    this._assignSharedGroupForSplitPair(a, b);

    this._clearSplitPartner(a.id);
    this._clearSplitPartner(b.id);
    const ia = this.tabs.findIndex((t) => t.id === a.id);
    const ib = this.tabs.findIndex((t) => t.id === b.id);
    const leftTab = ia <= ib ? a : b;
    const rightTab = ia <= ib ? b : a;
    const leftId = leftTab.id;
    a.splitPartnerId = b.id;
    b.splitPartnerId = a.id;
    a.splitLeftPaneTabId = leftId;
    b.splitLeftPaneTabId = leftId;

    if (!a.pinned && !b.pinned) {
      this._moveTabsAdjacentForSplit(leftTab, rightTab);
    }

    this._reRenderTabList();
    this._syncWebviewSizes();
    this.switchToTab(a.id);
    return true;
  }

  /**
   * Swap which page is on the left in the active (or given) split pair — matches Chrome/Comet “arrange” behavior.
   * @param {string} [tabIdInPair] Tab belonging to the pair; defaults to active tab.
   */
  swapSplitPanes(tabIdInPair) {
    const t = tabIdInPair
      ? this.tabs.find((x) => x.id === tabIdInPair)
      : this.getActiveTab();
    if (!t?.splitPartnerId) return;
    const p = this.tabs.find((x) => x.id === t.splitPartnerId);
    if (!p) return;
    const curLeft = t.splitLeftPaneTabId || p.splitLeftPaneTabId;
    const ia = this.tabs.findIndex((x) => x.id === t.id);
    const ib = this.tabs.findIndex((x) => x.id === p.id);
    const fallback = ia <= ib ? t.id : p.id;
    const leftId = curLeft || fallback;
    const nextLeft = leftId === t.id ? p.id : t.id;
    t.splitLeftPaneTabId = nextLeft;
    p.splitLeftPaneTabId = nextLeft;
    this._syncWebviewSizes();
  }

  unsplitTab(tabId) {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t || !t.splitPartnerId) return;
    this._clearSplitPartner(tabId);
    const cur = this.activeTabId;
    if (cur) this.switchToTab(cur);
    else if (this.tabs.length) this.switchToTab(this.tabs[0].id);
    this.tabs.forEach((tab) => this.updateTabUI(tab));
  }

  unsplitActiveSplit() {
    const t = this.getActiveTab();
    if (t?.splitPartnerId) this.unsplitTab(t.id);
  }

  /**
   * Tab that should show the “AI is controlling this tab” highlight during takeover.
   * Prefers the agent-locked tab, then the browsing-context tab when the focused surface
   * is chat, Home/NTP, or about:blank — so highlights match where clicks actually go.
   */
  getTakeoverHighlightTabId() {
    const agent = this.getAgentControlledTab();
    if (agent?.id) return agent.id;

    const active = this.getActiveTab();
    const activeId = active?.id ?? null;
    if (active && this.isNavioChatTabUrl?.(active.url || '')) {
      const ctx = this.getBrowserContextTab?.();
      return ctx?.id ?? activeId;
    }
    if (!this.isHttpBrowsingSurface(active)) {
      const ctx = this.getBrowserContextTab?.();
      if (ctx?.id) return ctx.id;
    }
    return activeId;
  }

  /**
   * Show which tab is receiving automated clicks/navigation. Pass null to clear.
   * Updates tab strip + webview outline classes.
   * During takeover, does not change the focused tab — automation targets webContents by id
   * (Comet-style: user can stay on chat or another tab). Initial focus is optional in
   * `AssistantManager.enableTakeover()` when a one-time switch is desired.
   */
  setAgentControlledTab(tabId) {
    const next = tabId || null;
    const prev = this._agentControlledTabId;
    this._agentControlledTabId = next;
    this._applyAgentControlledTabClasses();
    if (next && next !== prev) {
      try {
        document.getElementById(`tabitem-${next}`)?.scrollIntoView({
          behavior: 'instant',
          block: 'nearest',
          inline: 'nearest'
        });
      } catch {
        document.getElementById(`tabitem-${next}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  /**
   * Point automation at a tab without changing the user's focused tab (strip selection / URL bar).
   * Restores memory-discarded tabs so tools can run. Syncs webview layout for background targets.
   * @param {string} tabId
   * @returns {object|null} The tab model, or null if id is unknown.
   */
  ensureAgentTargetTabReady(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    if (tab._discarded && tab._discardUrl && tab.webview) {
      this._restoreDiscardedTab(tab);
    }
    this.setAgentControlledTab(tab.id);
    this._syncWebviewSizes();
    return tab;
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
    this.refreshNavioActivityBadge();
  }

  /**
   * Whether any visible AI work is in progress (drives the tab-strip AI mark).
   * @returns {boolean}
   */
  _anyAiWorkInProgress() {
    if (this._agentControlledTabId) return true;
    try {
      const AM = typeof AssistantManager !== 'undefined' ? AssistantManager : null;
      return !!(AM && AM._busyTabs && AM._busyTabs.size > 0);
    } catch {
      return false;
    }
  }

  /**
   * Small indicator on the AI activity control when automation is running or a turn is in flight.
   */
  refreshNavioActivityBadge() {
    const mark = document.getElementById('navio-ai-activity-mark');
    const btn = document.getElementById('btn-navio-ai-activity');
    if (!mark || !btn) return;
    const on = this._anyAiWorkInProgress();
    mark.hidden = !on;
    btn.classList.toggle('tab-strip-ai--pulse', on);
  }

  _rowFromAssistantBusyKey(k, am) {
    const s = String(k);
    if (s === '__profile__') {
      return { action: 'sidebar', kind: 'sidebar', line1: 'Profile chat (sidebar)', line2: 'Reply in progress in the side panel' };
    }
    if (s === '__guest__') {
      const tid = this._findGuestOrChatTabId(am);
      if (tid) {
        const t = this.tabs.find((x) => x.id === tid);
        return {
          action: 'tab',
          kind: 'busy',
          tabId: tid,
          line1: (t && this.getTabDisplayTitle(t)) || 'Chat',
          line2: t ? this._navioContextSubtitle(t, 'Full-page / guest — reply in progress') : 'Reply in progress'
        };
      }
      return { action: 'sidebar', kind: 'sidebar', line1: 'Assistant (sidebar)', line2: 'Reply in progress' };
    }
    if (s.startsWith('sb:')) {
      return { action: 'sidebar', kind: 'sidebar', line1: 'Saved session (sidebar)', line2: 'Reply in progress' };
    }
    if (s.startsWith('g:')) {
      const t = this.tabs.find((x) => x.groupId === s.slice(2));
      if (!t) return null;
      return {
        action: 'tab',
        kind: 'busy',
        tabId: t.id,
        line1: this.getTabDisplayTitle(t) || 'Tab',
        line2: this._navioContextSubtitle(t, 'Group — reply in progress')
      };
    }
    const t = this.tabs.find((x) => String(x.id) === s);
    if (!t) return null;
    return {
      action: 'tab',
      kind: 'busy',
      tabId: t.id,
      line1: this.getTabDisplayTitle(t) || 'Tab',
      line2: this._navioContextSubtitle(t, 'Reply in progress')
    };
  }

  _navioHostnameFromUrl(url) {
    if (!url || typeof url !== 'string') return '';
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      const h = (u.hostname || '').replace(/^www\./i, '');
      return h;
    } catch {
      return '';
    }
  }

  /**
   * One readable subtitle: site / workspace / mode hints (no PII).
   * @param {object} tab
   * @param {string} [status] primary status fragment
   */
  _navioContextSubtitle(tab, status) {
    if (!tab) return status || '';
    const parts = [];
    if (status) parts.push(status);
    const host = this._navioHostnameFromUrl(tab.url || '');
    if (host) parts.push(host);
    const g = this.getTabGroupLabel(tab);
    if (g) parts.push(`Workspace “${g}”`);
    if (tab.splitPartnerId) parts.push('Split view');
    return parts.filter(Boolean).join(' · ');
  }

  _findGuestOrChatTabId(am) {
    try {
      if (am?._guestChatWebview) {
        const t = this.tabs.find((x) => x.webview === am._guestChatWebview);
        if (t) return t.id;
      }
    } catch {
      /* ignore */
    }
    const c = this.tabs.find((t) => this.isNavioChatTabUrl(t.url || ''));
    return c ? c.id : null;
  }

  _naaItemFilterKey(it) {
    return [it.line1, it.line2, it.groupName || ''].join(' ').toLowerCase();
  }

  _buildNavioAiActivityData() {
    const nowItems = [];
    const coveredTabIds = new Set();
    const ag = this.getAgentControlledTab();
    if (ag) {
      coveredTabIds.add(String(ag.id));
      nowItems.push({
        kind: 'agent',
        action: 'tab',
        tabId: ag.id,
        line1: this.getTabDisplayTitle(ag) || 'Tab',
        line2: this._navioContextSubtitle(ag, 'Navio is driving this page')
      });
    }

    const AM = typeof AssistantManager !== 'undefined' ? AssistantManager : null;
    const busies = AM && AM._busyTabs && AM._busyTabs.size ? [...AM._busyTabs] : [];
    let sidebarInProgress = false;
    for (const k of busies) {
      const row = this._rowFromAssistantBusyKey(k, AM);
      if (!row) continue;
      if (row.action === 'sidebar') {
        sidebarInProgress = true;
        continue;
      }
      if (row.tabId) {
        const id = String(row.tabId);
        if (coveredTabIds.has(id)) continue;
        coveredTabIds.add(id);
        nowItems.push({
          kind: row.kind || 'busy',
          action: 'tab',
          tabId: row.tabId,
          line1: row.line1,
          line2: row.line2
        });
      }
    }
    if (sidebarInProgress) {
      nowItems.push({
        kind: 'sidebar',
        action: 'sidebar',
        line1: 'Sidebar or saved session',
        line2: 'Open the panel to read the in-flight reply',
        openAssistant: true
      });
    }

    const chatTabObjs = [];
    for (const t of this.tabs) {
      if (!this.isNavioChatTabUrl(t.url || '')) continue;
      if (coveredTabIds.has(String(t.id))) continue;
      const title = this.getTabDisplayTitle(t) || 'Ask AI';
      chatTabObjs.push({
        kind: 'chat',
        action: 'tab',
        tabId: t.id,
        line1: title,
        line2: this._navioContextSubtitle(t, 'Full-page Ask AI'),
        groupId: t.groupId || null,
        groupName: t.groupId ? this.getTabGroupLabel(t) : null
      });
    }

    const byCluster = new Map();
    for (const it of chatTabObjs) {
      const k0 = it.groupId || '_ungrouped';
      if (!byCluster.has(k0)) {
        const gn =
          k0 === '_ungrouped'
            ? null
            : it.groupName ||
              (it.groupId && this.groups[it.groupId] && this.groups[it.groupId].name) ||
              null;
        byCluster.set(k0, { groupId: it.groupId, groupName: gn, items: [] });
      }
      byCluster.get(k0).items.push(it);
    }
    for (const c of byCluster.values()) {
      c.items.sort((a, b) => String(a.line1).localeCompare(String(b.line1), undefined, { sensitivity: 'base' }));
    }
    const clusterList = [...byCluster.entries()].sort((A, B) => {
      const aU = A[0] === '_ungrouped' ? 1 : 0;
      const bU = B[0] === '_ungrouped' ? 1 : 0;
      if (aU !== bU) return aU - bU;
      const nA = (A[1].groupName || A[0]).toLowerCase();
      const nB = (B[1].groupName || B[0]).toLowerCase();
      return nA.localeCompare(nB, undefined, { sensitivity: 'base' });
    });
    const chatClusters = clusterList.map(([, v]) => ({
      groupId: v.groupId,
      groupName: v.groupName,
      groupColor: v.groupId && this.groups[v.groupId] ? this.groups[v.groupId].color : null,
      items: v.items
    }));

    const nNow = nowItems.length;
    const nChat = chatTabObjs.length;
    let summary = '';
    if (nNow && nChat) summary = `${nNow} live · ${nChat} chat tab${nChat === 1 ? '' : 's'}`;
    else if (nNow) summary = nNow === 1 ? '1 item in progress' : `${nNow} in progress`;
    else if (nChat) summary = `${nChat} chat tab${nChat === 1 ? '' : 's'}`;

    const blocks = [];
    if (nowItems.length) {
      blocks.push({
        id: 'now',
        title: 'Happening now',
        subtitle: 'Automation, streaming replies, or sidebar work',
        items: nowItems
      });
    }
    if (chatClusters.length) {
      blocks.push({
        id: 'chats',
        title: 'Full-page Ask AI',
        subtitle: 'Grouped by tab workspace; ungrouped last',
        clusters: chatClusters
      });
    }

    return { summary, blocks };
  }

  _positionNavioAiActivityPopover() {
    const el = document.getElementById('navio-ai-activity-popover');
    const btn = document.getElementById('btn-navio-ai-activity');
    if (!el || !btn) return;
    const r = btn.getBoundingClientRect();
    const maxW = Math.min(400, window.innerWidth - 16);
    el.style.maxWidth = `${maxW}px`;
    el.style.minWidth = 'min(100vw - 16px, 360px)';
    let left = r.left;
    const estW = Math.min(400, maxW);
    if (left + estW > window.innerWidth - 8) left = window.innerWidth - 8 - estW;
    if (left < 8) left = 8;
    el.style.top = `${r.bottom + 4}px`;
    el.style.left = `${left}px`;
  }

  _onNavioAiActivityPick(item) {
    this._closeNavioAiActivityMenu();
    if (item && item.action === 'sidebar') {
      try {
        if (typeof AssistantManager !== 'undefined' && typeof AssistantManager.open === 'function') {
          void AssistantManager.open();
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (item && item.tabId) {
      this.switchToTab(item.tabId);
    }
  }

  _naaIconSvg(kind) {
    const k = String(kind || 'row');
    if (k === 'agent') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    }
    if (k === 'busy') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
    }
    if (k === 'chat') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-.9 3.8A8.5 8.5 0 0 1 12.5 21a8.3 8.3 0 0 1-3.7-.8L3 21l1.8-5.1a8.1 8.1 0 0 1-1-3.4 8.5 8.5 0 0 1 4.1-7.1 8.4 8.4 0 0 1 3.4-1.1H12a8.5 8.5 0 0 1 8.5 8.1z"/></svg>';
    }
    if (k === 'sidebar') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="8" height="18" rx="1"/><line x1="15" y1="8" x2="20" y2="8"/><line x1="15" y1="12" x2="20" y2="12"/><line x1="15" y1="16" x2="20" y2="16"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  }

  _appendNaaItem(parent, it) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `naa-item naa-item--kind-${it.kind || 'row'}`;
    b.setAttribute('role', 'menuitem');
    const key = (this._naaItemFilterKey(it) + (it._clusterLabel || '')).trim();
    b.setAttribute('data-naa-text', key);
    if (it.tabId) b.dataset.tabId = String(it.tabId);
    if (it.action) b.dataset.navioAction = it.action;
    const ico = document.createElement('span');
    ico.className = 'naa-item-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = this._naaIconSvg(it.kind);
    b.appendChild(ico);
    const text = document.createElement('span');
    text.className = 'naa-item-text';
    const t1 = document.createElement('span');
    t1.className = 'naa-line1';
    t1.textContent = it.line1;
    const t2 = document.createElement('span');
    t2.className = 'naa-line2';
    t2.textContent = it.line2;
    text.appendChild(t1);
    text.appendChild(t2);
    b.appendChild(text);
    b.addEventListener('click', () => this._onNavioAiActivityPick(it));
    parent.appendChild(b);
  }

  _applyNavioAiActivityFilter(needle, pop) {
    const n = (needle || '').trim().toLowerCase();
    const noMatch = pop.querySelector('.naa-no-filter-match');
    const body = pop.querySelector('.naa-panel-body');
    if (!body) return;
    const items = body.querySelectorAll('.naa-item');
    for (const el of items) {
      const t = el.getAttribute('data-naa-text') || '';
      if (!n || t.includes(n)) el.classList.remove('naa-item--hidden');
      else el.classList.add('naa-item--hidden');
    }
    for (const cluster of body.querySelectorAll('.naa-cluster')) {
      const seen = [...cluster.querySelectorAll('.naa-item')].some(
        (i) => !i.classList.contains('naa-item--hidden')
      );
      cluster.classList.toggle('naa-cluster--empty', n.length > 0 && !seen);
    }
    for (const block of body.querySelectorAll('.naa-block')) {
      const seen = [...block.querySelectorAll('.naa-item')].some(
        (i) => !i.classList.contains('naa-item--hidden')
      );
      block.classList.toggle('naa-block--empty', n.length > 0 && !seen);
    }
    if (noMatch) {
      const any = [...items].some((i) => !i.classList.contains('naa-item--hidden'));
      noMatch.hidden = !(n && !any);
    }
  }

  _openNavioAiActivityMenu() {
    const pop = document.getElementById('navio-ai-activity-popover');
    const btn = document.getElementById('btn-navio-ai-activity');
    if (!pop || !btn) return;
    this._navioAiActivityOpen = true;
    btn.setAttribute('aria-expanded', 'true');
    pop.textContent = '';
    const { summary, blocks } = this._buildNavioAiActivityData();

    const panel = document.createElement('div');
    panel.className = 'naa-panel';

    const head = document.createElement('div');
    head.className = 'naa-panel-head';
    const title = document.createElement('div');
    title.className = 'naa-panel-title';
    title.textContent = 'AI work map';
    head.appendChild(title);
    if (summary) {
      const sub = document.createElement('div');
      sub.className = 'naa-panel-summary';
      sub.textContent = summary;
      head.appendChild(sub);
    }
    panel.appendChild(head);

    const filter = document.createElement('input');
    filter.id = 'naa-panel-filter';
    filter.className = 'naa-panel-filter';
    filter.type = 'search';
    filter.setAttribute('autocomplete', 'off');
    filter.setAttribute('aria-label', 'Filter AI tabs and work');
    filter.placeholder = 'Filter by tab title, site, or workspace…';
    panel.appendChild(filter);

    const body = document.createElement('div');
    body.className = 'naa-panel-body';

    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'naa-empty-card';
      empty.innerHTML =
        '<p class="naa-empty-lead">Nothing to list yet</p><ul class="naa-empty-list">' +
        '<li>Use the <strong>sidebar assistant</strong> on any page, or</li>' +
        '<li>Open <strong>Ask AI</strong> from Home, or</li>' +
        '<li>Start a task — <strong>grouped tab workspaces</strong> appear here by name</li></ul>';
      body.appendChild(empty);
    } else {
      for (const block of blocks) {
        const wrap = document.createElement('section');
        wrap.className = 'naa-block';
        wrap.dataset.blockId = block.id;
        const bh = document.createElement('div');
        bh.className = 'naa-block-head';
        const btitle = document.createElement('h3');
        btitle.className = 'naa-block-title';
        btitle.textContent = block.title;
        bh.appendChild(btitle);
        if (block.subtitle) {
          const bs = document.createElement('p');
          bs.className = 'naa-block-sub';
          bs.textContent = block.subtitle;
          bh.appendChild(bs);
        }
        wrap.appendChild(bh);
        if (block.items) {
          const list = document.createElement('div');
          list.className = 'naa-block-list';
          for (const it of block.items) {
            this._appendNaaItem(list, it);
          }
          wrap.appendChild(list);
        }
        if (block.clusters) {
          for (const cl of block.clusters) {
            const sub = document.createElement('div');
            sub.className = 'naa-cluster';
            if (cl.groupId) sub.dataset.groupId = String(cl.groupId);
            const isUng = !cl.groupId;
            const ch = document.createElement('div');
            ch.className = 'naa-cluster-head';
            if (isUng) {
              ch.textContent = 'Ungrouped';
              ch.classList.add('naa-cluster-head--muted');
            } else {
              const dot = document.createElement('span');
              dot.className = 'naa-cluster-dot';
              if (cl.groupColor) dot.style.background = cl.groupColor;
              ch.appendChild(dot);
              const name = document.createElement('span');
              name.className = 'naa-cluster-name';
              name.textContent = cl.groupName || 'Workspace';
              ch.appendChild(name);
            }
            sub.appendChild(ch);
            const clist = document.createElement('div');
            clist.className = 'naa-cluster-list';
            for (const raw of cl.items) {
              const it = { ...raw };
              it._clusterLabel = (isUng ? 'ungrouped' : (cl.groupName || '')).toLowerCase();
              it.kind = it.kind || 'chat';
              this._appendNaaItem(clist, it);
            }
            sub.appendChild(clist);
            wrap.appendChild(sub);
          }
        }
        body.appendChild(wrap);
      }
    }

    const noMatch = document.createElement('div');
    noMatch.className = 'naa-no-filter-match';
    noMatch.hidden = true;
    noMatch.textContent = 'No matches — try another word or clear the filter.';
    body.appendChild(noMatch);
    panel.appendChild(body);

    const foot = document.createElement('div');
    foot.className = 'naa-panel-foot';
    const footBtn = document.createElement('button');
    footBtn.type = 'button';
    footBtn.className = 'naa-foot-btn';
    footBtn.textContent = 'Open assistant sidebar';
    footBtn.setAttribute('role', 'menuitem');
    footBtn.addEventListener('click', () => {
      this._onNavioAiActivityPick({ action: 'sidebar' });
    });
    foot.appendChild(footBtn);
    panel.appendChild(foot);

    pop.appendChild(panel);
    pop.hidden = false;
    this._positionNavioAiActivityPopover();

    const onFilter = (q) => this._applyNavioAiActivityFilter(q, pop);
    filter.addEventListener('input', () => onFilter(filter.value));
    requestAnimationFrame(() => {
      try {
        filter.focus();
      } catch {
        /* ignore */
      }
    });

    if (!this._navioAiActivityResizeBound) {
      this._navioAiActivityResizeBound = true;
      window.addEventListener('resize', () => {
        if (this._navioAiActivityOpen) this._positionNavioAiActivityPopover();
      });
    }
    if (!this._navioAiActivityOutsideBound) {
      this._navioAiActivityOutsideBound = true;
      document.addEventListener(
        'click',
        (e) => {
          if (!this._navioAiActivityOpen) return;
          if (e.target?.closest?.('#navio-ai-activity-popover') || e.target?.closest?.('#btn-navio-ai-activity')) {
            return;
          }
          this._closeNavioAiActivityMenu();
        },
        true
      );
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._navioAiActivityOpen) {
          e.preventDefault();
          this._closeNavioAiActivityMenu();
        }
      });
    }
  }

  _closeNavioAiActivityMenu() {
    const pop = document.getElementById('navio-ai-activity-popover');
    const btn = document.getElementById('btn-navio-ai-activity');
    this._navioAiActivityOpen = false;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (pop) pop.hidden = true;
  }

  _toggleNavioAiActivityMenu() {
    if (this._navioAiActivityOpen) {
      this._closeNavioAiActivityMenu();
    } else {
      this._openNavioAiActivityMenu();
    }
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

  /** Omnibox is the default input when the new-tab surface is showing (empty `tab.url`). */
  _focusUrlBarForNewTab() {
    const el = document.getElementById('url-input');
    if (!el) return;
    const run = () => {
      try {
        const ae = document.activeElement;
        if (ae && ae !== el && typeof ae.closest === 'function') {
          if (ae.closest('#tab-list') || ae.closest('#btn-new-tab') || ae.closest('#btn-new-tab-inline') || ae.closest('#btn-navio-ai-activity') || ae.closest('.tab-strip-new')) {
            ae.blur();
          }
        }
        el.focus({ preventScroll: true });
        if (typeof el.select === 'function') el.select();
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
      setTimeout(run, 0);
      setTimeout(run, 50);
    });
  }

  showNewTabPage() {
    this.newTabPage.classList.add('active');
    const apply = typeof window.__navioApplyNtpTickerReserve === 'function'
      ? window.__navioApplyNtpTickerReserve
      : null;
    if (apply) requestAnimationFrame(() => apply());
    const activeWv = this.getActiveWebview();
    if (activeWv) activeWv.classList.remove('active');
    this._focusUrlBarForNewTab();
    if (typeof window.__navioSyncNewTabSurfaceZoom === 'function') {
      requestAnimationFrame(() => window.__navioSyncNewTabSurfaceZoom());
    }
    if (typeof window.__navioUpdateZoomLabel === 'function') {
      requestAnimationFrame(() => window.__navioUpdateZoomLabel());
    }
  }

  hideNewTabPage() {
    this.newTabPage.classList.remove('active');
    if (typeof window.__navioApplyNtpTickerReserve === 'function') {
      window.__navioApplyNtpTickerReserve();
    }
    const activeWv = this.getActiveWebview();
    if (activeWv) activeWv.classList.add('active');
    if (typeof window.__navioSyncNewTabSurfaceZoom === 'function') {
      window.__navioSyncNewTabSurfaceZoom();
    }
    if (typeof window.__navioUpdateZoomLabel === 'function') {
      window.__navioUpdateZoomLabel();
    }
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

    this._attachTabDragHandlers(tab.id, el);
    this._appendNodeToTabList(el);

    requestAnimationFrame(() => {
      try {
        el.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      } catch {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
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
    el.classList.toggle('loading', tab.loading);
    // Check loading first: if loading, show spinner (CSS ::after on .loading .tab-favicon).
    // Only then show favicon or globe fallback — avoids the race where a favicon is appended
    // and then immediately cleared when loading fires after a favicon-update event.
    if (tab.loading) {
      faviconEl.innerHTML = '';
    } else if (tab.favicon) {
      // setAttribute safely quotes the URL — a crafted favicon URL containing
      // a double-quote can no longer break out and inject attributes like
      // onerror=… the way ${tab.favicon} in a raw template string could.
      while (faviconEl.firstChild) faviconEl.removeChild(faviconEl.firstChild);
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.setAttribute('src', String(tab.favicon));
      faviconEl.appendChild(img);
    } else {
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
    el.classList.toggle('tab-in-split', !!tab.splitPartnerId);
    const splitPartner = tab.splitPartnerId
      ? this.tabs.find((t) => t.id === tab.splitPartnerId)
      : null;
    const splitLeftId = tab.splitLeftPaneTabId;
    const isSplitLeft = !!(splitPartner && splitLeftId && tab.id === splitLeftId);
    el.classList.toggle('tab-split-pair-left', !!(splitPartner && isSplitLeft));
    el.classList.toggle('tab-split-pair-right', !!(splitPartner && !isSplitLeft));
    el.classList.toggle('tab-discarded', !!tab._discarded);
    if (tab.webview) {
      try {
        tab.webview.classList.toggle('tab-webview-discarded', !!tab._discarded);
      } catch {
        /* ignore */
      }
    }
  }

  _updateTabAudioUI(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    const el = document.getElementById(`tabitem-${tabId}`);
    if (!el || !tab) return;

    el.classList.toggle('tab-playing', !!tab.isPlaying);

    let audioBtn = el.querySelector('.tab-audio-btn');
    if (tab.isPlaying || tab.isMuted) {
      if (!audioBtn) {
        audioBtn = document.createElement('button');
        audioBtn.className = 'tab-audio-btn';
        audioBtn.type = 'button';
        audioBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._muteTab(tabId);
        });
        const closeBtn = el.querySelector('.tab-close');
        if (closeBtn) el.insertBefore(audioBtn, closeBtn);
        else el.appendChild(audioBtn);
      }
      audioBtn.title = tab.isMuted ? 'Unmute tab' : 'Mute tab';
      audioBtn.innerHTML = tab.isMuted
        ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
        : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/><path d="M19 12c0-3.04-1.73-5.64-4.25-6.97v13.94C17.27 17.64 19 15.04 19 12z" opacity=".5"/></svg>`;
    } else {
      audioBtn?.remove();
    }
  }

  _muteTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !tab.webview) return;
    try {
      tab.isMuted = !tab.isMuted;
      if (typeof tab.webview.setAudioMuted === 'function') {
        tab.webview.setAudioMuted(tab.isMuted);
      }
      this._updateTabAudioUI(tabId);
    } catch (e) {
      console.warn('[Navio] mute tab error', e);
    }
  }

  updateContextTitle(tab) {
    const contextEl = document.getElementById('context-page-title');
    if (contextEl) {
      const display = this.getTabDisplayTitle(tab);
      let line = tab.url ? `${display} — ${tab.url}` : NAVIO_HOME_TAB_LABEL;
      if (tab.customTitle && tab.title && tab.title !== display) {
        line = `${display} (${tab.title}) — ${tab.url}`;
      }
      if (typeof EmailAssistant !== 'undefined' && tab.url && EmailAssistant.isMailUrl(tab.url)) {
        line += ' · Mail';
      }
      contextEl.title = line;
      if (line.length > 140) {
        line = `${line.slice(0, 137)}…`;
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
    return p || NAVIO_HOME_TAB_LABEL;
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
    this._emitTabsChanged('rename-tab');
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
    const tPre = this.tabs.find((t) => t.id === tabId);
    const partnerId = tPre?.splitPartnerId || null;
    this.removeTabFromGroup(tabId, true, true);
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !this.groups[groupId]) return;
    tab.groupId = groupId;
    if (typeof AssistantManager !== 'undefined' && AssistantManager.onTabJoinedGroup) {
      AssistantManager.onTabJoinedGroup(tabId, groupId);
    }

    // Keep split pairs grouped together (Chrome-style) without breaking split mode.
    if (partnerId) {
      const partner = this.tabs.find((t) => t.id === partnerId);
      if (partner && partner.groupId !== groupId) {
        this.removeTabFromGroup(partner.id, true, true);
        partner.groupId = groupId;
        if (typeof AssistantManager !== 'undefined' && AssistantManager.onTabJoinedGroup) {
          AssistantManager.onTabJoinedGroup(partner.id, groupId);
        }
      }
    }

    this._reRenderTabList();
  }

  /**
   * Drag-drop variant of addTabToGroup: joins the group AND physically moves
   * the tab (and its split partner) to sit at the end of the group in the strip.
   */
  _dropTabIntoGroup(tabId, groupId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !this.groups[groupId]) return;

    const partnerId = tab.splitPartnerId || null;

    // Helper: physically move a tab to the end of the group block and assign groupId
    const moveAndJoin = (tid) => {
      const idx = this.tabs.findIndex(t => t.id === tid);
      if (idx < 0) return;
      const [moved] = this.tabs.splice(idx, 1);
      // Clear any old group
      if (moved.groupId && moved.groupId !== groupId) {
        if (typeof AssistantManager !== 'undefined' && AssistantManager.onTabLeftGroup) {
          AssistantManager.onTabLeftGroup(tid, moved.groupId);
        }
      }
      moved.groupId = groupId;
      // Insert after the last member of the target group (recalculate after splice)
      const lastIdx = this.tabs.reduce((last, t, i) => t.groupId === groupId ? i : last, -1);
      this.tabs.splice(lastIdx >= 0 ? lastIdx + 1 : this.tabs.length, 0, moved);
      if (typeof AssistantManager !== 'undefined' && AssistantManager.onTabJoinedGroup) {
        AssistantManager.onTabJoinedGroup(tid, groupId);
      }
    };

    moveAndJoin(tabId);
    if (partnerId) {
      const partner = this.tabs.find(t => t.id === partnerId);
      if (partner && partner.groupId !== groupId) moveAndJoin(partnerId);
    }

    this._reRenderTabList();
    this._emitTabsChanged('tab-reorder');
  }

  /**
   * @param {boolean} [skipAssistantHooks] When true (e.g. internal regroup), assistant memory is unchanged —
   *        used so moving a tab between groups does not fork/split threads.
   */
  removeTabFromGroup(tabId, skipAssistantHooks = false, skipRender = false) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !tab.groupId) return;
    const prevGid = tab.groupId;
    tab.groupId = null;
    if (
      !skipAssistantHooks &&
      typeof AssistantManager !== 'undefined' &&
      AssistantManager.onTabLeftGroup
    ) {
      AssistantManager.onTabLeftGroup(tabId, prevGid);
    }
    if (!skipRender) this._reRenderTabList();
  }

  // ── Rebuild the tab strip with group headers ───────────────────────────
  _reRenderTabList() {
    const usedGroupIds = new Set(this.tabs.map((t) => t.groupId).filter(Boolean));
    for (const gid of Object.keys(this.groups)) {
      if (!usedGroupIds.has(gid)) delete this.groups[gid];
    }
    // Remove all existing tab items and group headers from the strip
    this.tabListEl.querySelectorAll('.tab-item, .tab-group-header').forEach(el => el.remove());

    // Render tabs in their actual order, inserting a group chip when a new group starts.
    // This preserves the user's tab order rather than reordering (ungrouped-first).
    const renderedGroups = new Set();
    for (const tab of this.tabs) {
      const gid = tab.groupId || null;
      if (gid && !renderedGroups.has(gid)) {
        const group = this.groups[gid];
        if (group) {
          const groupTabCount = this.tabs.filter(t => t.groupId === gid).length;
          const header = this._buildGroupHeader(group, groupTabCount, group.collapsed || false);
          this._appendNodeToTabList(header);
          renderedGroups.add(gid);
        }
      }
      const group = gid ? this.groups[gid] : null;
      if (!group || !group.collapsed) {
        this._appendTabItem(tab);
      }
    }

    if (this._tabListTrail) this.tabListEl.appendChild(this._tabListTrail);

    // Mark the first and last tab of each group so CSS can style the edges
    this.tabListEl.querySelectorAll('.tab-item').forEach(el => el.classList.remove('group-first', 'group-last'));
    for (const gid of usedGroupIds) {
      const members = [...this.tabListEl.querySelectorAll('.tab-item.in-group')].filter(el => {
        const t = this.tabs.find(t => String(t.id) === el.id.replace('tabitem-', ''));
        return t?.groupId === gid;
      });
      if (members.length) {
        members[0].classList.add('group-first');
        members[members.length - 1].classList.add('group-last');
      }
    }

    this._applyAgentControlledTabClasses();
    this._emitTabsChanged('tab-structure');
  }

  _buildGroupHeader(group, tabCount, collapsed) {
    const el = document.createElement('div');
    el.className = `tab-group-header${collapsed ? ' collapsed' : ''}`;
    el.dataset.groupId = group.id;
    el.style.setProperty('--tg-color', group.color);
    // Horizontal: chip background IS the color, so no separate dot needed.
    // Vertical: dot is shown via CSS (.tgh-dot) which is only visible in sidebar mode.
    el.innerHTML = `
      <span class="tgh-dot"></span>
      <span class="tgh-name">${this.escapeHtml(group.name)}</span>
      <span class="tgh-count">${collapsed ? tabCount : ''}</span>
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
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._startDrag('group', group.id, el, e);
    });
    return el;
  }

  /** Highlight all elements (header chip + tab items) belonging to a group for drop feedback. */
  _highlightGroupDrop(groupId) {
    const header = this.tabListEl.querySelector(`.tab-group-header[data-group-id="${groupId}"]`);
    if (header) header.classList.add('tab-drag-over');
    for (const tabEl of this.tabListEl.querySelectorAll('.tab-item.in-group')) {
      const tid = tabEl.id.replace('tabitem-', '');
      const t   = this.tabs.find(tt => tt.id === tid);
      if (t?.groupId === groupId) tabEl.classList.add('tab-drag-over');
    }
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
    const memberCount = this.tabs.filter(t => t.groupId === groupId).length;
    const items = [
      { kind: 'item', action: '__group-header', label: group.name, disabled: true, dotColor: group.color },
      { kind: 'sep' },
      { kind: 'item', action: 'rename-group', label: 'Rename group…',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' },
      { kind: 'submenu', id: 'recolor', label: 'Change color',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="2.5"/><circle cx="8.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="12.5" r="2.5"/><path d="M12 22a10 10 0 1 1 10-10c0 2.21-1.79 4-4 4h-1a3 3 0 0 0-2 5 1 1 0 0 1-1 1z"/></svg>' },
      { kind: 'item', action: 'toggle-collapse', label: group.collapsed ? 'Expand group' : 'Collapse group',
        icon: group.collapsed
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>' },
      { kind: 'sep' },
      { kind: 'item', action: 'ungroup-all', label: `Ungroup ${memberCount} tab${memberCount === 1 ? '' : 's'}`,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>' },
      { kind: 'item', action: 'close-group', label: `Close ${memberCount} tab${memberCount === 1 ? '' : 's'}`,
        danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' }
    ];
    const menu = this._buildMenu(items);
    document.body.appendChild(menu);
    this._positionMenu(menu, x, y);

    this._wireMenuActions(menu, (act) => {
      if (act === 'ungroup-all') {
        this.tabs.filter(t => t.groupId === groupId).forEach(t => this.removeTabFromGroup(t.id, false, true));
        delete this.groups[groupId];
        this._reRenderTabList();
      } else if (act === 'close-group') {
        [...this.tabs.filter(t => t.groupId === groupId)].forEach(t => this.closeTab(t.id));
      } else if (act === 'rename-group') {
        const name = window.prompt('Group name:', group.name);
        if (name?.trim()) { group.name = name.trim(); this._reRenderTabList(); }
      } else if (act === 'toggle-collapse') {
        group.collapsed = !group.collapsed;
        this._reRenderTabList();
      }
      this._hideTabContextMenu();
    });

    // Wire the recolor submenu
    menu.querySelectorAll('[data-submenu="recolor"]').forEach(btn => {
      const open = () => {
        document.querySelectorAll('.tab-ctx-submenu').forEach(el => el.remove());
        const sub = document.createElement('div');
        sub.className = 'tab-ctx-menu tab-ctx-submenu';
        sub.innerHTML = `
          <div class="tcm-label">Group color</div>
          <div class="tcm-color-picker tcm-color-picker-grid">
            ${this._GROUP_COLORS.map(c => `<button class="tcm-color-dot${c === group.color ? ' selected' : ''}" data-color="${c}" style="background:${c};color:${c}" title="${c}" type="button"></button>`).join('')}
          </div>
        `;
        document.body.appendChild(sub);
        const r = btn.getBoundingClientRect();
        const w = sub.offsetWidth || 220;
        const h = sub.scrollHeight || 80;
        let left = r.right + 4;
        if (left + w + 8 > window.innerWidth) left = Math.max(8, r.left - w - 4);
        let top = Math.min(r.top - 4, window.innerHeight - h - 8);
        sub.style.left = `${left}px`;
        sub.style.top = `${Math.max(8, top)}px`;
        sub.querySelectorAll('.tcm-color-dot').forEach(dot => {
          dot.addEventListener('click', (e) => {
            e.stopPropagation();
            group.color = dot.dataset.color;
            this._reRenderTabList();
            this._hideTabContextMenu();
          });
        });
      };
      btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
      let t = null;
      btn.addEventListener('mouseenter', () => { clearTimeout(t); t = setTimeout(open, 120); });
      btn.addEventListener('mouseleave', () => clearTimeout(t));
    });

    this._installMenuOutsideClose(menu);
  }

  // ── Tab actions used by the context menu (kept tiny and additive) ───────

  /** Reload a specific tab by id (without changing focus). */
  reloadTabById(tabId, ignoreCache = false) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !tab.webview) return;
    try {
      if (ignoreCache && typeof tab.webview.reloadIgnoringCache === 'function') {
        tab.webview.reloadIgnoringCache();
      } else {
        tab.webview.reload();
      }
    } catch {
      try { tab.webview.reload(); } catch { /* ignore */ }
    }
  }

  /** Open a duplicate of a tab next to the original (Chrome-style "Duplicate"). */
  duplicateTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const url = (tab.url || '').trim();
    if (!url || !url.startsWith('http')) {
      if (typeof _showAppToast === 'function') _showAppToast('Nothing to duplicate.', 'warning');
      return;
    }
    try {
      this.createTab(url, { incognito: !!tab.incognito, switchTo: true });
    } catch (e) {
      console.warn('[Navio] duplicateTab error', e);
    }
  }

  /** Copy a tab's URL to the clipboard with a small confirmation toast. */
  async copyTabUrl(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const url = (tab.url || '').trim();
    if (!url) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (typeof _showAppToast === 'function') _showAppToast('Link copied', 'success');
    } catch {
      if (typeof _showAppToast === 'function') _showAppToast('Could not copy link', 'error');
    }
  }

  /** Bookmark a tab to the bookmarks bar (mirrors the URL-bar star). */
  async bookmarkTabAction(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab || !tab.url || !tab.url.startsWith('http')) {
      if (typeof _showAppToast === 'function') _showAppToast('Only http(s) pages can be bookmarked.', 'warning');
      return;
    }
    try {
      await window.navio.bookmarksAdd({
        title: this.getTabDisplayTitle(tab),
        url: tab.url,
        favicon: tab.favicon,
        toBar: true
      });
      window.dispatchEvent(new Event('bookmarks-changed'));
      if (typeof _showAppToast === 'function') _showAppToast('Bookmark added', 'success');
    } catch {
      if (typeof _showAppToast === 'function') _showAppToast('Could not add bookmark', 'error');
    }
  }

  /** Close every tab except the given one (skip pinned tabs to match Chrome). */
  closeOtherTabs(tabId) {
    const ids = this.tabs.filter(t => t.id !== tabId && !t.pinned).map(t => t.id);
    for (const id of ids) {
      try { this.closeTab(id); } catch { /* ignore */ }
    }
  }

  /** Close every tab to the right of the given one in the strip (skip pinned). */
  closeTabsToTheRight(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    const ids = this.tabs.slice(idx + 1).filter(t => !t.pinned).map(t => t.id);
    for (const id of ids) {
      try { this.closeTab(id); } catch { /* ignore */ }
    }
  }

  /** True if there are tabs to the right of `tabId` that aren't pinned. */
  hasUnpinnedTabsToRight(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return false;
    return this.tabs.slice(idx + 1).some(t => !t.pinned);
  }

  // ── Tab Context Menu ───────────────────────────────────────────────────

  _showTabContextMenu(tabId, x, y) {
    this._hideTabContextMenu();
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    const existingGroups = Object.values(this.groups);
    const currentGroupId = tab.groupId || null;
    const otherTabs = this.tabs.filter(t => t.id !== tabId);
    const splitOk = (ot) => {
      if (this.isNavioChatTabUrl(ot.url || '')) return false;
      const u = (ot.url || '').trim();
      if (!u.startsWith('http')) return false;
      return !!tab.incognito === !!ot.incognito;
    };
    const splitCandidates = otherTabs.filter(splitOk);

    const isHttp = (tab.url || '').trim().startsWith('http');
    const canCloseRight = this.hasUnpinnedTabsToRight(tabId);
    const canCloseOther = otherTabs.some(t => !t.pinned);
    const canDuplicate = isHttp;
    const canBookmark = isHttp;
    const canCopyLink = !!(tab.url || '').trim();

    const splitDisabled = !tab.splitPartnerId && splitCandidates.length === 0;

    // Top-level menu — flat, Comet-style. Submenus open from items with data-submenu.
    const items = [
      { kind: 'item', action: 'rename-tab', label: 'Rename tab…',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' },
      ...(tab.customTitle ? [{ kind: 'item', action: 'clear-tab-name', label: 'Use page title' }] : []),
      { kind: 'item', action: 'toggle-pin', label: tab.pinned ? 'Unpin tab' : 'Pin tab',
        icon: tab.pinned
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M12 17v5"/><path d="M9 9l-3 3 4 4"/><path d="M14.5 4.5l5 5L17 12l-3-3"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h-.5a1 1 0 0 1 0-2h7a1 1 0 0 1 0 2H15v4.76l3 2.84V16H6v-2.4z"/></svg>' },
      { kind: 'sep' },
      { kind: 'submenu', id: 'split', label: tab.splitPartnerId ? 'Split view' : 'Open in split view',
        disabled: splitDisabled,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>' },
      { kind: 'submenu', id: 'group', label: 'Add tab to group',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
      ...(currentGroupId ? [{ kind: 'item', action: 'remove-from-group', label: 'Remove from group',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>' }] : []),
      { kind: 'item', action: 'bookmark-tab', label: 'Bookmark tab', disabled: !canBookmark,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>' },
      { kind: 'sep' },
      { kind: 'item', action: 'copy-link', label: 'Copy link', disabled: !canCopyLink,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
      { kind: 'item', action: 'reload', label: 'Reload', shortcut: 'Ctrl+R', disabled: !isHttp,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18 5.51L23 10"/></svg>' },
      { kind: 'item', action: 'duplicate', label: 'Duplicate', disabled: !canDuplicate,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' },
      { kind: 'item', action: 'mute-toggle', label: tab.isMuted ? 'Unmute site' : 'Mute site',
        icon: tab.isMuted
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>' },
      { kind: 'sep' },
      { kind: 'item', action: 'close-tab', label: 'Close', shortcut: 'Ctrl+W', danger: true,
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' },
      { kind: 'item', action: 'close-others', label: 'Close other tabs', disabled: !canCloseOther },
      { kind: 'item', action: 'close-right', label: 'Close tabs to the right', disabled: !canCloseRight }
    ];

    const menu = this._buildMenu(items, { anchorX: x, anchorY: y, parent: null });
    document.body.appendChild(menu);
    this._positionMenu(menu, x, y);

    const handleAction = (act, btn) => {
      if (act === 'close-tab') this.closeTab(tabId);
      else if (act === 'close-others') this.closeOtherTabs(tabId);
      else if (act === 'close-right') this.closeTabsToTheRight(tabId);
      else if (act === 'rename-tab') this._promptRenameTab(tabId);
      else if (act === 'clear-tab-name') this.setTabCustomTitle(tabId, null);
      else if (act === 'toggle-pin') {
        const t = this.tabs.find((x) => x.id === tabId);
        if (t) {
          t.pinned = !t.pinned;
          this._reorderPinnedTabs();
          this.updateTabUI(t);
        }
      }
      else if (act === 'remove-from-group') this.removeTabFromGroup(tabId);
      else if (act === 'bookmark-tab') this.bookmarkTabAction(tabId);
      else if (act === 'copy-link') this.copyTabUrl(tabId);
      else if (act === 'reload') this.reloadTabById(tabId, false);
      else if (act === 'duplicate') this.duplicateTab(tabId);
      else if (act === 'mute-toggle') this._muteTab(tabId);
      this._hideTabContextMenu();
    };

    this._wireMenuActions(menu, handleAction);

    // Submenu openers
    menu.querySelectorAll('[data-submenu]').forEach(btn => {
      const onOpen = () => this._openSubmenu(btn, btn.dataset.submenu, { tabId, splitCandidates, existingGroups, currentGroupId, tab });
      btn.addEventListener('click', (e) => {
        if (btn.classList.contains('tcm-disabled')) return;
        e.stopPropagation();
        onOpen();
      });
      let hoverTimer = null;
      btn.addEventListener('mouseenter', () => {
        if (btn.classList.contains('tcm-disabled')) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(onOpen, 120);
      });
      btn.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
    });

    this._installMenuOutsideClose(menu);
  }

  /** Build a menu DOM from a flat item list. Items: {kind, action|id, label, icon, shortcut, danger, disabled}. */
  _buildMenu(items) {
    const menu = document.createElement('div');
    menu.className = 'tab-ctx-menu';
    const html = items.map((it) => {
      if (it.kind === 'sep') return '<div class="tcm-sep"></div>';
      if (it.kind === 'label') return `<div class="tcm-label">${this.escapeHtml(it.label)}</div>`;
      const cls = ['tcm-item'];
      if (it.danger) cls.push('tcm-danger');
      if (it.active) cls.push('tcm-active');
      if (it.disabled) cls.push('tcm-disabled');
      const dataAttrs = [];
      if (it.kind === 'submenu') {
        cls.push('tcm-submenu-trigger');
        dataAttrs.push(`data-submenu="${it.id}"`);
      } else if (it.action) {
        dataAttrs.push(`data-action="${it.action}"`);
      }
      if (it.gid) dataAttrs.push(`data-gid="${it.gid}"`);
      if (it.otherId) dataAttrs.push(`data-other-id="${it.otherId}"`);
      const iconHtml = it.icon ? `<span class="tcm-icon">${it.icon}</span>` : (it.dotColor ? `<span class="tcm-dot" style="background:${it.dotColor}"></span>` : '<span class="tcm-icon"></span>');
      const shortcut = it.shortcut ? `<span class="tcm-shortcut">${this.escapeHtml(it.shortcut)}</span>` : '';
      const chevron = it.kind === 'submenu' ? '<span class="tcm-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' : '';
      return `<button class="${cls.join(' ')}" ${dataAttrs.join(' ')} ${it.disabled ? 'disabled' : ''}>${iconHtml}<span class="tcm-text">${this.escapeHtml(it.label)}</span>${shortcut}${chevron}</button>`;
    }).join('');
    menu.innerHTML = html;
    return menu;
  }

  /** Wire any [data-action] buttons in `menu` to a handler(action, button). */
  _wireMenuActions(menu, handler) {
    menu.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (btn.classList.contains('tcm-disabled')) return;
        e.stopPropagation();
        handler(btn.dataset.action, btn);
      });
    });
  }

  /** Place a menu near (x,y) keeping it inside the viewport. */
  _positionMenu(menu, x, y) {
    menu.style.visibility = 'hidden';
    const w = menu.offsetWidth || 260;
    const h = menu.scrollHeight || 280;
    const left = Math.min(Math.max(8, x), window.innerWidth - w - 8);
    const top  = Math.min(Math.max(8, y), window.innerHeight - h - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
  }

  /** Open a submenu next to a parent item (auto-flips if it would clip). */
  _openSubmenu(parentBtn, kind, ctx) {
    document.querySelectorAll('.tab-ctx-submenu').forEach(el => el.remove());
    parentBtn.parentElement.querySelectorAll('.tcm-submenu-trigger.tcm-open').forEach(b => b.classList.remove('tcm-open'));
    parentBtn.classList.add('tcm-open');

    let items = [];
    if (kind === 'split') {
      items = this._buildSplitSubmenuItems(ctx);
    } else if (kind === 'group') {
      items = this._buildGroupSubmenuItems(ctx);
    }

    const sub = this._buildMenu(items);
    sub.classList.add('tab-ctx-submenu');
    document.body.appendChild(sub);

    const r = parentBtn.getBoundingClientRect();
    const w = sub.offsetWidth || 260;
    const h = sub.scrollHeight || 240;
    let left = r.right + 4;
    if (left + w + 8 > window.innerWidth) left = Math.max(8, r.left - w - 4);
    let top = r.top - 4;
    if (top + h + 8 > window.innerHeight) top = Math.max(8, window.innerHeight - h - 8);
    sub.style.left = `${left}px`;
    sub.style.top = `${top}px`;

    // Wire submenu actions
    this._wireSubmenuActions(sub, kind, ctx);
  }

  _buildSplitSubmenuItems(ctx) {
    const { tab, splitCandidates } = ctx;
    const items = [];
    if (tab.splitPartnerId) {
      items.push({ kind: 'item', action: 'swap-split', label: 'Swap left / right',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>' });
      items.push({ kind: 'item', action: 'unsplit-tab', label: 'Exit split view',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' });
      return items;
    }
    if (!splitCandidates.length) {
      items.push({ kind: 'label', label: 'No eligible tabs' });
      items.push({ kind: 'item', action: '__nothing', label: 'Open another http(s) tab to split with', disabled: true });
      return items;
    }
    items.push({ kind: 'label', label: 'Open with…' });
    const max = 16;
    splitCandidates.slice(0, max).forEach(ot => {
      items.push({ kind: 'item', action: 'split-with', otherId: ot.id,
        label: this.getTabDisplayTitle(ot),
        dotColor: ot.groupId && this.groups[ot.groupId] ? this.groups[ot.groupId].color : '#64748b' });
    });
    if (splitCandidates.length > max) {
      items.push({ kind: 'label', label: `${splitCandidates.length - max} more eligible…` });
    }
    return items;
  }

  _buildGroupSubmenuItems(ctx) {
    const { existingGroups, currentGroupId } = ctx;
    const items = [];
    if (existingGroups.length) {
      items.push({ kind: 'label', label: 'Existing groups' });
      existingGroups.forEach(g => {
        items.push({ kind: 'item', action: 'add-to-group', gid: g.id,
          label: g.name, dotColor: g.color, active: currentGroupId === g.id });
      });
      items.push({ kind: 'sep' });
    }
    items.push({ kind: 'item', action: '__new-group', label: 'New group…',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' });
    return items;
  }

  _wireSubmenuActions(sub, kind, ctx) {
    const { tabId } = ctx;
    sub.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (btn.classList.contains('tcm-disabled')) return;
        e.stopPropagation();
        const act = btn.dataset.action;
        if (act === '__nothing') return;
        if (act === 'split-with') {
          this.splitTabWith(tabId, btn.dataset.otherId);
        } else if (act === 'swap-split') {
          this.swapSplitPanes(tabId);
        } else if (act === 'unsplit-tab') {
          this.unsplitTab(tabId);
        } else if (act === 'add-to-group') {
          this.addTabToGroup(tabId, btn.dataset.gid);
        } else if (act === '__new-group') {
          // Replace the submenu with the new-group composer (color + name + Create)
          this._showNewGroupComposer(sub, tabId);
          return;
        }
        this._hideTabContextMenu();
      });
    });
  }

  /** Tiny inline composer: color dots + name + Create, replaces the submenu contents. */
  _showNewGroupComposer(sub, tabId) {
    const colorDots = this._GROUP_COLORS.map((c, i) =>
      `<button class="tcm-color-dot${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c};color:${c}" title="${c}" type="button"></button>`
    ).join('');
    sub.innerHTML = `
      <div class="tcm-label">New group</div>
      <div class="tcm-ng-row">
        <div class="tcm-color-picker">${colorDots}</div>
        <input class="tcm-ng-input" id="tcm-ng-name" placeholder="Group name" value="Group ${Object.keys(this.groups).length + 1}" maxlength="24" autofocus>
        <button class="tcm-ng-btn" id="tcm-ng-create" type="button">Create group</button>
      </div>
    `;
    let selectedColor = this._GROUP_COLORS[0];
    sub.querySelectorAll('.tcm-color-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        sub.querySelectorAll('.tcm-color-dot').forEach(d => d.classList.remove('selected'));
        dot.classList.add('selected');
        selectedColor = dot.dataset.color;
      });
    });
    const create = () => {
      const inputEl = sub.querySelector('#tcm-ng-name');
      const name = (inputEl?.value || '').trim() || `Group ${Object.keys(this.groups).length + 1}`;
      const gid = this.createGroup(name, selectedColor);
      this.addTabToGroup(tabId, gid);
      this._hideTabContextMenu();
    };
    sub.querySelector('#tcm-ng-create')?.addEventListener('click', (e) => { e.stopPropagation(); create(); });
    const inputEl = sub.querySelector('#tcm-ng-name');
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); create(); }
    });
    setTimeout(() => { try { inputEl?.focus(); inputEl?.select(); } catch {} }, 0);
  }

  _installMenuOutsideClose(menu) {
    const closeOutside = (e) => {
      const sub = document.querySelector('.tab-ctx-submenu');
      if (menu.contains(e.target)) return;
      if (sub && sub.contains(e.target)) return;
      this._hideTabContextMenu();
      document.removeEventListener('mousedown', closeOutside);
    };
    setTimeout(() => document.addEventListener('mousedown', closeOutside), 10);
  }

  _hideTabContextMenu() {
    document.querySelectorAll('.tab-ctx-submenu').forEach(el => el.remove());
    document.getElementById('tab-ctx-menu')?.remove();
    document.querySelectorAll('.tab-ctx-menu').forEach(el => el.remove());
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

  // ── Split Divider ──────────────────────────────────────────────────────

  _initSplitDivider() {
    this._splitDivider = document.createElement('div');
    this._splitDivider.className = 'split-divider';
    this._splitDivider.style.display = 'none';
    this.browserContainer.appendChild(this._splitDivider);

    let _dividerDragging = false;

    this._splitDivider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      _dividerDragging = true;
      this._splitDivider.setPointerCapture(e.pointerId);
      this._splitDivider.classList.add('dragging');

      const onMove = (me) => {
        if (!_dividerDragging) return;
        const rect = this.browserContainer.getBoundingClientRect();
        const ratio = (me.clientX - rect.left) / rect.width;
        this._splitRatio = Math.max(0.2, Math.min(0.8, ratio));
        this._syncWebviewSizes();
      };

      const onUp = () => {
        _dividerDragging = false;
        this._splitDivider.classList.remove('dragging');
        this._splitDivider.removeEventListener('pointermove', onMove);
        this._splitDivider.removeEventListener('pointerup', onUp);
        this._splitDivider.removeEventListener('pointercancel', onUp);
      };

      this._splitDivider.addEventListener('pointermove', onMove);
      this._splitDivider.addEventListener('pointerup', onUp);
      this._splitDivider.addEventListener('pointercancel', onUp);
    });
  }

  // ── Tab & Group Drag-to-Reorder ────────────────────────────────────────

  _attachTabDragHandlers(tabId, el) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.tab-close')) return;
      this._startDrag('tab', tabId, el, e);
    });
  }

  _startDrag(type, id, el, e) {
    if (this._dragState) return;
    const rect = el.getBoundingClientRect();

    // Full-screen overlay prevents -webkit-app-region:drag from stealing events
    const overlay = document.createElement('div');
    overlay.className = 'tab-drag-overlay';
    document.body.appendChild(overlay);

    this._dragState = {
      type,            // 'tab' | 'group'
      id,              // tabId or groupId
      el,
      overlay,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      ghost: null,
      isDragging: false,
      insertBeforeTabId: null,  // null = end of strip
      insertInGroupId: null,    // drop on group header
    };

    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', this._boundDragPointerMove);
    el.addEventListener('pointerup',   this._boundDragPointerUp);
    el.addEventListener('pointercancel', this._boundDragPointerUp);
  }

  _createDragGhost(el) {
    const ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.innerHTML = el.innerHTML;
    ghost.style.width  = `${el.offsetWidth}px`;
    ghost.style.height = `${el.offsetHeight}px`;
    // Carry over group colour if applicable
    const tgColor = el.style.getPropertyValue('--tg-color');
    if (tgColor) ghost.style.setProperty('--tg-color', tgColor);
    if (el.classList.contains('in-group')) ghost.classList.add('in-group');
    document.body.appendChild(ghost);
    return ghost;
  }

  _getOrCreateDropIndicator() {
    let ind = document.getElementById('tab-drag-indicator');
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'tab-drag-indicator';
      ind.className = 'tab-drag-indicator';
      document.body.appendChild(ind);
    }
    return ind;
  }

  _onDragPointerMove(e) {
    const ds = this._dragState;
    if (!ds) return;

    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;

    if (!ds.isDragging) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      ds.isDragging = true;
      ds.el.classList.add('tab-dragging-source');
      ds.ghost = this._createDragGhost(ds.el);
    }

    // Position ghost alongside the pointer
    const isVertical = document.body.classList.contains('navio-vertical-tabs');
    const stripRect  = this.tabListEl.getBoundingClientRect();

    if (isVertical) {
      ds.ghost.style.left = `${stripRect.left + 4}px`;
      ds.ghost.style.top  = `${e.clientY - ds.offsetY}px`;
    } else {
      ds.ghost.style.left = `${e.clientX - ds.offsetX}px`;
      ds.ghost.style.top  = `${stripRect.top + 1}px`;
    }

    this._updateDragDropTarget(e.clientX, e.clientY);
  }

  _updateDragDropTarget(x, y) {
    const ds = this._dragState;
    if (!ds) return;

    const isVertical  = document.body.classList.contains('navio-vertical-tabs');
    const indicator   = this._getOrCreateDropIndicator();
    const stripRect   = this.tabListEl.getBoundingClientRect();

    // Clear previous group highlights
    this.tabListEl.querySelectorAll('.tab-drag-over').forEach(el => el.classList.remove('tab-drag-over'));
    ds.insertInGroupId = null;

    // Check if hovering over a group header OR any tab already in a group
    // (tab-drag only — not group-drag)
    if (ds.type === 'tab') {
      const draggedTab = this.tabs.find(t => t.id === ds.id);

      // 1. Check group header chips
      for (const header of this.tabListEl.querySelectorAll('.tab-group-header')) {
        const hr = header.getBoundingClientRect();
        if (x >= hr.left && x <= hr.right && y >= hr.top && y <= hr.bottom) {
          const hoverGroupId = header.dataset.groupId;
          if (hoverGroupId && hoverGroupId !== draggedTab?.groupId) {
            this._highlightGroupDrop(hoverGroupId);
            ds.insertInGroupId    = hoverGroupId;
            ds.insertBeforeTabId  = null;
            indicator.style.display = 'none';
            return;
          }
        }
      }

      // 2. Check tabs that are already in a group — drop on any member = join
      for (const tabEl of this.tabListEl.querySelectorAll('.tab-item.in-group')) {
        const tr = tabEl.getBoundingClientRect();
        if (x >= tr.left && x <= tr.right && y >= tr.top && y <= tr.bottom) {
          const hoveredTabId = tabEl.id.replace('tabitem-', '');
          const hoveredTab   = this.tabs.find(t => t.id === hoveredTabId);
          const hoverGroupId = hoveredTab?.groupId;
          if (hoverGroupId && hoverGroupId !== draggedTab?.groupId) {
            this._highlightGroupDrop(hoverGroupId);
            ds.insertInGroupId    = hoverGroupId;
            ds.insertBeforeTabId  = null;
            indicator.style.display = 'none';
            return;
          }
        }
      }
    }

    // Find the insert position among visible (non-source) tab items
    const tabItems = [...this.tabListEl.querySelectorAll('.tab-item:not(.tab-dragging-source)')];
    let insertBeforeTabId = null;
    let indicatorBeforeEl = null;  // element we're inserting before
    let indicatorAfterEl  = null;  // element we're inserting after

    for (let i = 0; i < tabItems.length; i++) {
      const r   = tabItems[i].getBoundingClientRect();
      const mid = isVertical ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2;
      const pos = isVertical ? y : x;

      if (pos < mid) {
        insertBeforeTabId = tabItems[i].id.replace('tabitem-', '');
        indicatorBeforeEl = tabItems[i];
        indicatorAfterEl  = i > 0 ? tabItems[i - 1] : null;
        break;
      }
      indicatorAfterEl = tabItems[i];
    }

    ds.insertBeforeTabId = insertBeforeTabId;

    // Position the drop indicator
    indicator.style.display = '';

    if (isVertical) {
      indicator.style.width  = `${stripRect.width - 8}px`;
      indicator.style.height = '2px';
      if (indicatorBeforeEl) {
        const r = indicatorBeforeEl.getBoundingClientRect();
        indicator.style.left = `${r.left}px`;
        indicator.style.top  = `${r.top - 1}px`;
      } else if (indicatorAfterEl) {
        const r = indicatorAfterEl.getBoundingClientRect();
        indicator.style.left = `${r.left}px`;
        indicator.style.top  = `${r.bottom - 1}px`;
      } else {
        indicator.style.display = 'none';
      }
    } else {
      indicator.style.width  = '2px';
      indicator.style.height = `${stripRect.height - 4}px`;
      if (indicatorBeforeEl) {
        const r = indicatorBeforeEl.getBoundingClientRect();
        indicator.style.left = `${r.left - 1}px`;
        indicator.style.top  = `${stripRect.top + 2}px`;
      } else if (indicatorAfterEl) {
        const r = indicatorAfterEl.getBoundingClientRect();
        indicator.style.left = `${r.right - 1}px`;
        indicator.style.top  = `${stripRect.top + 2}px`;
      } else {
        indicator.style.display = 'none';
      }
    }
  }

  _onDragPointerUp(e) {
    const ds = this._dragState;
    if (!ds) return;

    // Remove event listeners
    ds.el.removeEventListener('pointermove', this._boundDragPointerMove);
    ds.el.removeEventListener('pointerup',   this._boundDragPointerUp);
    ds.el.removeEventListener('pointercancel', this._boundDragPointerUp);
    ds.el.classList.remove('tab-dragging-source');

    // Remove ghost, indicator, overlay
    if (ds.ghost) ds.ghost.remove();
    document.getElementById('tab-drag-indicator')?.remove();
    ds.overlay?.remove();

    // Clear group drop highlights
    this.tabListEl.querySelectorAll('.tab-drag-over').forEach(el => el.classList.remove('tab-drag-over'));

    if (ds.isDragging) {
      if (ds.insertInGroupId && ds.type === 'tab') {
        // Dropped on a group header or grouped tab → join group AND move adjacent to it
        this._dropTabIntoGroup(ds.id, ds.insertInGroupId);
      } else if (ds.type === 'tab') {
        this._moveTabToIndex(ds.id, ds.insertBeforeTabId);
      } else if (ds.type === 'group') {
        this._moveGroupToIndex(ds.id, ds.insertBeforeTabId);
      }

      // Suppress the click that would fire after pointerup
      const suppressClick = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        ds.el.removeEventListener('click', suppressClick, true);
      };
      ds.el.addEventListener('click', suppressClick, true);
    }

    this._dragState = null;
  }

  /**
   * Move a single tab to a new position. `insertBeforeTabId` is the tab whose
   * slot the dragged tab should occupy (null = append to end of strip).
   */
  _moveTabToIndex(tabId, insertBeforeTabId) {
    const currentIndex = this.tabs.findIndex(t => t.id === tabId);
    if (currentIndex < 0) return;
    const tab = this.tabs[currentIndex];
    const pinnedCount = this.tabs.filter(t => t.pinned).length;

    let targetIndex;
    if (insertBeforeTabId === null) {
      targetIndex = this.tabs.length;
    } else {
      targetIndex = this.tabs.findIndex(t => t.id === insertBeforeTabId);
      if (targetIndex < 0) targetIndex = this.tabs.length;
    }

    // Preserve pinned/unpinned boundary
    if (tab.pinned) {
      targetIndex = Math.min(targetIndex, pinnedCount);
    } else {
      targetIndex = Math.max(targetIndex, pinnedCount);
    }

    // Already in place?
    if (currentIndex === targetIndex || currentIndex + 1 === targetIndex) return;

    this.tabs.splice(currentIndex, 1);
    const adjusted = targetIndex > currentIndex ? targetIndex - 1 : targetIndex;
    this.tabs.splice(adjusted, 0, tab);

    this._reRenderTabList();
    this._emitTabsChanged('tab-reorder');
  }

  /**
   * Move an entire group (and all its tabs) so that the group block begins
   * immediately before `insertBeforeTabId` (null = end of strip).
   */
  _moveGroupToIndex(groupId, insertBeforeTabId) {
    const groupTabs    = this.tabs.filter(t => t.groupId === groupId);
    const nonGroupTabs = this.tabs.filter(t => t.groupId !== groupId);
    if (!groupTabs.length) return;

    let insertAt;
    if (insertBeforeTabId === null) {
      insertAt = nonGroupTabs.length;
    } else {
      insertAt = nonGroupTabs.findIndex(t => t.id === insertBeforeTabId);
      if (insertAt < 0) insertAt = nonGroupTabs.length;
    }

    const newTabs = [
      ...nonGroupTabs.slice(0, insertAt),
      ...groupTabs,
      ...nonGroupTabs.slice(insertAt),
    ];
    this.tabs.splice(0, this.tabs.length, ...newTabs);
    this._reRenderTabList();
    this._emitTabsChanged('tab-reorder');
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
