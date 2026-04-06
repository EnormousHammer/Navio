/**
 * Navio Browser - Tab Management System
 * Handles tab creation, switching, closing, and webview lifecycle
 */

class TabManagerClass {
  constructor() {
    this.tabs = [];
    this.activeTabId = null;
    this.tabCounter = 0;

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
  }

  createTab(url = null) {
    const id = `tab-${++this.tabCounter}`;
    const tab = {
      id,
      title: 'New Tab',
      url: url || '',
      favicon: null,
      loading: false,
      webview: null
    };

    // Create webview element
    const webview = document.createElement('webview');
    webview.setAttribute('id', `wv-${id}`);
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('partition', 'persist:navio');
    webview.setAttribute('useragent', navigator.userAgent.replace(/Electron\/\S+\s/, ''));

    if (url) {
      webview.setAttribute('src', url);
    }

    tab.webview = webview;
    this.browserContainer.appendChild(webview);

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
      tab.url = e.url;
      if (tab.id === this.activeTabId) {
        App.updateUrlBar(e.url);
        App.updateNavigationButtons(wv);
        this.updateContextTitle(tab);
      }
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) {
        tab.url = e.url;
        if (tab.id === this.activeTabId) {
          App.updateUrlBar(e.url);
        }
      }
    });

    wv.addEventListener('new-window', (e) => {
      this.createTab(e.url);
    });

    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // Aborted, ignore
      tab.loading = false;
      this.updateTabUI(tab);
      App.showLoading(false);
    });

    wv.addEventListener('did-finish-load', () => {
      this.applyZoomToWebview(wv);
    });
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
    this.hideNewTabPage();
    try {
      tab.webview.loadURL(resolvedUrl);
    } catch (err) {
      console.error('navigateActive:', err);
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
    }
  }

  closeTab(id) {
    const index = this.tabs.findIndex(t => t.id === id);
    if (index === -1) return;

    const tab = this.tabs[index];

    // Remove webview from DOM
    if (tab.webview && tab.webview.parentNode) {
      tab.webview.parentNode.removeChild(tab.webview);
    }

    // Remove tab item from sidebar
    const tabEl = document.getElementById(`tabitem-${id}`);
    if (tabEl) tabEl.remove();

    this.tabs.splice(index, 1);

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
    const activeWv = this.getActiveWebview();
    if (activeWv) activeWv.classList.remove('active');
  }

  hideNewTabPage() {
    this.newTabPage.classList.remove('active');
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
      this.closeTab(tab.id);
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
}

const TabManager = new TabManagerClass();
