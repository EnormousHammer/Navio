/**
 * Navio Browser - Main Application Controller
 * Orchestrates all browser components: tabs, navigation, AI assistant, settings
 */

class NavioApp {
  constructor() {
    this.config = {};
    this.tabStripHidden = false;
    this.init();
  }

  async init() {
    this.config = await window.navio.getConfig();

    this.applyTheme(this.config.theme || 'dark');
    this.bindThemeToggle();
    this.bindWindowControls();
    this.bindNavigation();
    this.bindShortcuts();
    this.bindTabStrip();
    this.bindNewTabPage();

    const isFirstRun = await Onboarding.checkFirstRun();
    if (!isFirstRun) {
      this.startBrowser();
    }
  }

  onOnboardingComplete() {
    this.config = {};
    window.navio.getConfig().then(c => {
      this.config = c;
      this.applyTheme(this.config.theme || 'dark');
    });
    this.startBrowser();
  }

  startBrowser() {
    setTimeout(() => {
      if (typeof TabManager !== 'undefined') {
        TabManager.createTab();
      }
    }, 100);
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
  }

  bindThemeToggle() {
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });
  }

  async toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    this.applyTheme(next);
    this.config.theme = next;
    await window.navio.saveConfig(this.config);
  }

  bindWindowControls() {
    document.getElementById('btn-minimize').addEventListener('click', () => window.navio.minimize());
    document.getElementById('btn-maximize').addEventListener('click', () => window.navio.maximize());
    document.getElementById('btn-close').addEventListener('click', () => window.navio.close());

    window.navio.onWindowStateChanged((state) => {
      document.body.classList.toggle('maximized', state === 'maximized');
    });
  }

  bindNavigation() {
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigateTo(urlInput.value.trim());
        urlInput.blur();
      }
      if (e.key === 'Escape') {
        urlInput.blur();
        const activeTab = TabManager.getActiveTab();
        if (activeTab) {
          urlInput.value = activeTab.url || '';
        }
      }
    });

    urlInput.addEventListener('focus', () => {
      urlInput.select();
    });

    btnBack.addEventListener('click', () => {
      const wv = TabManager.getActiveWebview();
      if (wv && wv.canGoBack()) wv.goBack();
    });

    btnForward.addEventListener('click', () => {
      const wv = TabManager.getActiveWebview();
      if (wv && wv.canGoForward()) wv.goForward();
    });

    btnReload.addEventListener('click', () => {
      const wv = TabManager.getActiveWebview();
      if (wv) wv.reload();
    });
  }

  navigateTo(input) {
    if (!input) return;

    let url;
    if (input.match(/^https?:\/\//)) {
      url = input;
    } else if (input.match(/^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}/)) {
      url = 'https://' + input;
    } else {
      const searchEngine = this.config.searchEngine || 'https://www.google.com/search?q=';
      url = searchEngine + encodeURIComponent(input);
    }

    const wv = TabManager.getActiveWebview();
    if (wv) {
      wv.loadURL(url);
      TabManager.hideNewTabPage();
    }
  }

  bindShortcuts() {
    window.navio.onShortcut((action) => {
      switch (action) {
        case 'new-tab':
          TabManager.createTab();
          break;
        case 'close-tab':
          TabManager.closeActiveTab();
          break;
        case 'focus-url':
          document.getElementById('url-input').focus();
          break;
        case 'toggle-assistant':
          AssistantManager.toggle();
          break;
        case 'toggle-connectors':
          if (typeof ConnectorsManager !== 'undefined') {
            ConnectorsManager.toggleHub();
          }
          break;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        TabManager.createTab();
      }
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        TabManager.closeActiveTab();
      }
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        document.getElementById('url-input').focus();
      }
    });
  }

  bindTabStrip() {
    document.getElementById('btn-tabstrip-toggle').addEventListener('click', () => {
      this.toggleTabStrip();
    });
    document.getElementById('btn-tabstrip-show').addEventListener('click', () => {
      this.toggleTabStrip();
    });
  }

  toggleTabStrip() {
    this.tabStripHidden = !this.tabStripHidden;
    document.body.classList.toggle('tabstrip-hidden', this.tabStripHidden);
  }

  bindNewTabPage() {
    const ntpSearchInput = document.getElementById('ntp-search-input');
    ntpSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigateTo(ntpSearchInput.value.trim());
        ntpSearchInput.value = '';
      }
    });

    document.querySelectorAll('.ntp-shortcut').forEach((shortcut) => {
      shortcut.addEventListener('click', (e) => {
        e.preventDefault();
        const url = shortcut.getAttribute('data-url');
        if (url) this.navigateTo(url);
      });
    });
  }

  updateUrlBar(url) {
    const urlInput = document.getElementById('url-input');
    const sslIndicator = document.getElementById('url-ssl');

    if (!url || url === 'about:blank') {
      urlInput.value = '';
      sslIndicator.className = 'url-ssl';
      return;
    }

    urlInput.value = url;

    if (url.startsWith('https://')) {
      sslIndicator.className = 'url-ssl secure';
      sslIndicator.title = 'Secure connection (HTTPS)';
    } else if (url.startsWith('http://')) {
      sslIndicator.className = 'url-ssl insecure';
      sslIndicator.title = 'Not secure (HTTP)';
    } else {
      sslIndicator.className = 'url-ssl';
    }
  }

  updateNavigationButtons(webview) {
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');

    if (webview) {
      btnBack.disabled = !webview.canGoBack();
      btnForward.disabled = !webview.canGoForward();
    } else {
      btnBack.disabled = true;
      btnForward.disabled = true;
    }
  }

  showLoading(show) {
    document.getElementById('loading-indicator').classList.toggle('visible', show);
  }
}

const App = new NavioApp();
