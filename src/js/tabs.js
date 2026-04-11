/**
 * Navio Browser - Tab Management System
 * Handles tab creation, switching, closing, and webview lifecycle
 */

class TabManagerClass {
  constructor() {
    this.tabs = [];
    this.activeTabId = null;
    this.tabCounter = 0;

    // ── Tab Groups ────────────────────────────────────────────────────────
    this.groups = {};        // { [groupId]: { id, name, color } }
    this._groupCounter = 0;
    this._GROUP_COLORS = ['#06b6d4','#8b5cf6','#22c55e','#ef4444','#f97316','#eab308','#ec4899'];

    this.tabListEl = document.getElementById('tab-list');
    this.browserContainer = document.getElementById('browser-container');
    this.newTabPage = document.getElementById('new-tab-page');

    document.getElementById('btn-new-tab').addEventListener('click', () => this.createTab());

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
  }

  // ── Passive Memory Capture ────────────────────────────────────────────
  // After the user spends ≥20 s on a real http/https page, silently store a
  // one-liner memory entry so the AI can later answer "what was that page about?"
  // A session-level Set prevents duplicate entries for the same URL per session.
  _passiveMemorySeen = new Set();

  _schedulePassiveMemory(tab, wv) {
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
      if (!url || !url.startsWith('http')) return;
      window.navio.historyAdd({
        url,
        title: tab.title || url,
        favicon: tab.favicon || ''
      }).catch(() => {});
    } catch (_) {}
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

  createTab(url = null) {
    const id = `tab-${++this.tabCounter}`;
    const tab = {
      id,
      title: 'New Tab',
      url: url || '',
      favicon: null,
      loading: false,
      webview: null,
      pinned: false
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
    webview.setAttribute('partition', 'persist:navio');
    webview.setAttribute('useragent', cleanUA);
    // Always set src="about:blank" so Electron starts the guest renderer
    // immediately and fires dom-ready. Without this, dom-ready never fires
    // and any pending URL gets stuck in the queue forever (deadlock).
    webview.setAttribute('src', 'about:blank');
    webview._domReady = false;
    webview._pendingUrl = url || null;

    tab.webview = webview;
    this.browserContainer.appendChild(webview);

    // Size the new webview immediately and synchronously so Electron has the
    // correct viewport dimensions before dom-ready / loadURL fires.
    const { width, height } = this.browserContainer.getBoundingClientRect();
    if (width && height) {
      webview.style.width  = width  + 'px';
      webview.style.height = height + 'px';
    }

    this.bindWebviewEvents(tab);

    this.tabs.push(tab);
    this.renderTabItem(tab);
    this.switchToTab(id);

    if (!url) {
      this.showNewTabPage();
      setTimeout(() => {
        const ntpInput = document.getElementById('ntp-search-input');
        if (ntpInput) ntpInput.focus();
      }, 100);
    }

    return tab;
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
        wv.loadURL(url).catch(err => console.warn('Pending loadURL failed:', err));
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
      // Skip about:blank (initial webview state) and data: error pages so the
      // NTP tab's url stays '' (falsy) and showNewTabPage() keeps working.
      if (e.url && e.url !== 'about:blank' && !e.url.startsWith('data:')) {
        tab.url = e.url;
        this._historyAdd(tab, wv, e.url);
      }
      if (tab.id === this.activeTabId) {
        App.updateUrlBar(tab.url);
        App.updateNavigationButtons(wv);
        this.updateContextTitle(tab);
        // Always hide the NTP overlay when a real page navigates — covers all
        // navigation paths including IPC-driven loadURL() from the main process.
        if (tab.url && tab.url !== 'about:blank' && !tab.url.startsWith('data:')) {
          this.hideNewTabPage();
        }
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
      }
    });

    wv.addEventListener('new-window', (e) => {
      if (!e.url) return;
      // External protocols clicked inside a page — open in OS, don't load in a tab
      if (/^(mailto|tel|sms|callto):/i.test(e.url)) {
        window.navio.openExternal(e.url).catch(() => {});
        return;
      }
      this.createTab(e.url);
    });

    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // Aborted/cancelled, ignore
      tab.loading = false;
      tab.title = 'Error';
      this.updateTabUI(tab);
      App.showLoading(false);
      // Show an inline error page inside the webview
      if (tab.id === this.activeTabId) {
        const errHtml = this._buildErrorPage(e.errorDescription || 'Failed to load', tab.url);
        wv.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errHtml)}`).catch(() => {});
      }
    });

    wv.addEventListener('did-finish-load', async () => {
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
          if (typeof PasswordManager !== 'undefined') {
            PasswordManager.showSavePrompt(data, wv);
          }
        } else if (e.channel === 'navio-login-form' && data) {
          // Login form detected — check if we have saved credentials to autofill
          if (typeof PasswordManager !== 'undefined') {
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
        }
      } catch {}
    });
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
    tab.url = resolvedUrl;
    tab.favicon = null;
    tab.title = 'Loading…';
    this.updateTabUI(tab);
    this.hideNewTabPage();
    const wv = tab.webview;
    if (wv._domReady) {
      wv.loadURL(resolvedUrl).catch(err => console.warn('navigateActive loadURL failed:', err));
    } else {
      // dom-ready hasn't fired yet (very fast user action); queue it
      wv._pendingUrl = resolvedUrl;
    }
    return true;
  }

  switchToTab(id) {
    const prevId = this.activeTabId;
    this.activeTabId = id;

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
    }
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

    // Remove webview from DOM
    if (tab.webview && tab.webview.parentNode) {
      tab.webview.parentNode.removeChild(tab.webview);
    }

    // Remove tab item from sidebar
    const tabEl = document.getElementById(`tabitem-${id}`);
    if (tabEl) tabEl.remove();

    const hadGroup = tab.groupId;
    this.tabs.splice(index, 1);

    // If the closed tab was in a group, rebuild the strip to update counts/remove empty headers
    if (hadGroup) this._reRenderTabList();

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
    if (typeof window.__navioNtpLiveSportsResync === 'function') {
      try {
        window.__navioNtpLiveSportsResync();
      } catch (_) {
        /* ignore */
      }
    }
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
    el.className = 'tab-item';
    el.id = `tabitem-${tab.id}`;

    el.innerHTML = `
      <div class="tab-favicon">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
      </div>
      <span class="tab-title">${this.escapeHtml(tab.title)}</span>
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

    this.tabListEl.appendChild(el);

    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
  }

  updateTabUI(tab) {
    const el = document.getElementById(`tabitem-${tab.id}`);
    if (!el) return;

    const titleEl = el.querySelector('.tab-title');
    titleEl.textContent = tab.title;

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
  }

  updateContextTitle(tab) {
    const contextEl = document.getElementById('context-page-title');
    if (contextEl) {
      let line = tab.url ? `${tab.title} - ${tab.url}` : 'New Tab';
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

  async getActivePageContent() {
    const wv = this.getActiveWebview();
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
      this.tabListEl.appendChild(header);
      if (!collapsed) groupTabs.forEach(t => this._appendTabItem(t));
    }
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
      this.tabListEl.appendChild(existing);
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

    const pinLabel = tab.pinned ? 'Unpin tab' : 'Pin tab';

    const menu = document.createElement('div');
    menu.id = 'tab-ctx-menu';
    menu.className = 'tab-ctx-menu';
    menu.innerHTML = `
      <button class="tcm-item" data-action="toggle-pin">${pinLabel}</button>
      <div class="tcm-sep"></div>
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
        else if (act === 'toggle-pin') {
          const t = this.tabs.find((x) => x.id === tabId);
          if (t) {
            t.pinned = !t.pinned;
            this._reorderPinnedTabs();
            this.updateTabUI(t);
          }
        } else if (act === 'remove-from-group') this.removeTabFromGroup(tabId);
        else if (act === 'add-to-group') this.addTabToGroup(tabId, btn.dataset.gid);
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
    const lines = this.tabs.map((t, i) => `${i}: ${t.title} — ${t.url}`).join('\n');
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
    const lines = this.tabs.map((t, i) => `${i}: ${t.title} — ${t.url}`).join('\n');
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
