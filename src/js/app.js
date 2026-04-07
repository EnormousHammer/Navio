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
    this.applyLayoutFromConfig(this.config);

    if (typeof LaunchIntro !== 'undefined') {
      await LaunchIntro.playIfAvailable();
    }

    this.bindThemeToggle();
    this.bindWindowControls();
    this.bindNavigation();
    this.bindShortcuts();
    this.bindTabStrip();
    this.bindNewTabPage();

    const isFirstRun = await Onboarding.checkFirstRun();
    // Only call startBrowser here if dismiss() hasn't already triggered it
    // (dismiss() calls App.onOnboardingComplete() which calls startBrowser())
    if (!isFirstRun && !Onboarding.ready) {
      this.startBrowser();
    }
  }

  onOnboardingComplete() {
    this.config = {};
    window.navio.getConfig().then(c => {
      this.config = c;
      this.applyTheme(this.config.theme || 'dark');
      this.applyLayoutFromConfig(this.config);
    });
    this.startBrowser();
  }

  startBrowser() {
    setTimeout(() => {
      if (typeof TabManager === 'undefined') return;
      this._maybeProactiveTip();
      const mode = this.config.startupMode || 'new-tab';
      if (mode === 'homepage') {
        const hp = (this.config.homepage || 'https://www.google.com').trim() || 'https://www.google.com';
        const url = this.resolveNavigationInput(hp) || hp;
        TabManager.createTab(url);
      } else {
        TabManager.createTab();
      }
    }, 100);
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
  }

  applyLayoutFromConfig(config) {
    const raw = config && config.assistantWidth;
    const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
    const w = Number.isFinite(n) ? Math.min(560, Math.max(300, n)) : 420;
    document.documentElement.style.setProperty('--assistant-width', `${w}px`);
  }

  bindThemeToggle() {
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      this.toggleTheme();
    });
    // Profile pill → open Settings on AI tab
    document.getElementById('btn-profile-pill')?.addEventListener('click', () => {
      if (typeof SettingsManager !== 'undefined') {
        SettingsManager.open();
        SettingsManager.showPanel('ai');
      }
    });
    // Restore profile pill icon from config
    window.navio.getConfig().then(cfg => {
      const icons = { default: '✦', developer: '⌨', researcher: '🔬', creator: '✏' };
      const pill = document.getElementById('profile-pill-icon');
      if (pill) pill.textContent = icons[cfg.aiProfile] || '✦';
    }).catch(() => {});
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

  // ── Auto Search Mode ────────────────────────────────────────────────────
  // Detects natural-language questions and routes them to AI automatically.
  _isAIQuery(input) {
    const q = (input || '').trim().toLowerCase();
    if (q.length < 4) return false;
    // Starts with a question word or imperative
    if (/^(what|who|where|when|why|how|is |are |can |does |do |will |should |would |could |explain |tell me|summarize|compare|define|describe|help |write |create |draft |translate|analyze|list |give me|find |show me|what's|who's|where's|when's|why's|how's)\b/.test(q)) return true;
    // Ends with question mark
    if (q.endsWith('?')) return true;
    // 6+ words with no URL characters → likely a sentence
    if (q.split(/\s+/).length >= 6 && !/[./:]/.test(q)) return true;
    return false;
  }

  _sendToAI(query) {
    AssistantManager.open();
    setTimeout(() => {
      if (AssistantManager.inputEl) {
        AssistantManager.inputEl.value = query;
        AssistantManager.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        AssistantManager.sendMessage();
      }
    }, 150);
  }

  bindNavigation() {
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');

    // Show AI hint badge when input looks like a question
    const aiHint = document.getElementById('url-ai-hint');
    urlInput.addEventListener('input', () => {
      if (!aiHint) return;
      const raw = urlInput.value.trim();
      const show = raw.length > 3 && !raw.startsWith('http') && this._isAIQuery(raw);
      aiHint.classList.toggle('visible', show);
    });
    aiHint?.addEventListener('click', () => {
      const raw = urlInput.value.trim();
      if (raw) { this._sendToAI(raw); urlInput.value = ''; urlInput.blur(); }
    });

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = urlInput.value.trim();
        // Explicit AI prefix
        if (raw.startsWith('?')) {
          const q = raw.slice(1).trim();
          AssistantManager.open();
          if (q) {
            AssistantManager.inputEl.value = q;
            AssistantManager.sendMessage();
          }
          urlInput.blur();
          return;
        }
        // Auto-detect AI question (unless Shift held = force web search)
        if (!e.shiftKey && this._isAIQuery(raw)) {
          this._sendToAI(raw);
          urlInput.value = '';
          urlInput.blur();
          return;
        }
        this.navigateTo(raw);
        urlInput.blur();
      }
      if (e.key === 'Escape') {
        urlInput.blur();
        if (aiHint) aiHint.classList.remove('visible');
        const activeTab = TabManager.getActiveTab();
        if (activeTab) urlInput.value = activeTab.url || '';
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

  resolveNavigationInput(raw) {
    const input = (raw || '').trim();
    if (!input) return null;

    if (/^https?:\/\//i.test(input)) return input;

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;

    if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(input)) {
      return 'http://' + input.replace(/^\/*/, '');
    }

    if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(input)) {
      return 'http://' + input;
    }

    if (/^[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([-a-zA-Z0-9]*[a-zA-Z0-9])?)+(:\d+)?(\/.*)?$/.test(input)) {
      return 'https://' + input;
    }

    const searchEngine = this.config.searchEngine || 'https://www.google.com/search?q=';
    return searchEngine + encodeURIComponent(input);
  }

  navigateTo(input) {
    const url = this.resolveNavigationInput(input);
    if (!url || typeof TabManager === 'undefined') return;

    const wv = TabManager.getActiveWebview();
    if (!wv) {
      TabManager.createTab(url);
      return;
    }

    TabManager.navigateActive(url);
  }

  bindShortcuts() {
    // Handle "open in new tab" requests from the context menu
    window.navio.onOpenUrlInNewTab((url) => {
      if (url && typeof TabManager !== 'undefined') {
        TabManager.createTab(url);
      }
    });

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
        case 'command-palette':
          if (typeof CommandPalette !== 'undefined') {
            CommandPalette.toggle();
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

  // Used by NTP.js submit — public so ntp.js can call it
  handleSearch(input) {
    const raw = (input || '').trim();
    if (!raw) return;
    if (raw.startsWith('?')) {
      this._sendToAI(raw.slice(1).trim());
      return;
    }
    this.navigateTo(raw);
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
      shortcut.addEventListener('click', () => {
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

  async _maybeProactiveTip() {
    try {
      const cfg = this.config || (await window.navio.getConfig());
      if (cfg.aiProactivity === 'off' || !cfg.hasApiKey) return;
      const r = await window.navio.proactiveTick({});
      if (!r.suggestion?.fire) return;

      const page = await TabManager.getActivePageContent();
      if (!page || page.error || !page.text || !page.url) return;

      const result = await window.navio.aiRequest({
        messages: [
          {
            role: 'system',
            content: 'You are Navio, an AI browser assistant. Give one brief, specific, actionable insight about the current page. Maximum 2 sentences. Do not start with "I" or "Based on". Be direct and helpful.'
          },
          {
            role: 'user',
            content: `Page title: ${page.title}\nURL: ${page.url}\n\nContent snippet:\n${(page.text || '').slice(0, 2000)}`
          }
        ]
      });

      if (!result.error && result.content && typeof AssistantManager !== 'undefined') {
        AssistantManager.setReceipt(`💡 ${result.content.slice(0, 180)}`);
      }
    } catch {
      /* ignore */
    }
  }
}

const App = new NavioApp();
