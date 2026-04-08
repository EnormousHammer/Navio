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

    // External OS protocols — open in the default OS app, never load in a webview tab
    if (/^(mailto|tel|sms|callto|wtai|market|ms-windows-store):/i.test(input)) {
      window.navio.openExternal(input).catch(() => {});
      return null;
    }

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

    // ── Download toasts ───────────────────────────────────────────────────
    const _showAppToast = (msg, type = 'info') => {
      const stack = document.getElementById('live-notif-stack');
      if (!stack) return;
      const icons = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' };
      const id = Date.now();
      const el = document.createElement('div');
      el.className = `live-notification live-toast live-toast-${type}`;
      el.id = `app-toast-${id}`;
      el.innerHTML = `<span class="live-toast-icon">${icons[type] || '•'}</span><span class="live-toast-msg">${msg}</span><button class="live-notif-x">×</button>`;
      el.querySelector('.live-notif-x').addEventListener('click', () => el.remove());
      stack.prepend(el);
      setTimeout(() => el.remove(), 5000);
    };

    window.navio.onDownloadStarted(({ filename }) => {
      _showAppToast(`⬇ Downloading: ${filename}`, 'info');
    });

    window.navio.onDownloadDone(({ filename, savePath, state }) => {
      if (state === 'completed') {
        // Show a richer toast with a "Show" button so the user can find the file.
        const stack = document.getElementById('live-notif-stack');
        if (stack) {
          const id = Date.now();
          const el = document.createElement('div');
          el.className = 'live-notification live-toast live-toast-success';
          el.id = `app-toast-${id}`;
          el.innerHTML = `
            <span class="live-toast-icon">✓</span>
            <span class="live-toast-msg">Saved: ${filename}</span>
            <button class="live-toast-show-btn" title="Show in folder" style="background:none;border:1px solid rgba(0,216,255,0.4);color:#00d8ff;cursor:pointer;font-size:10.5px;padding:2px 8px;border-radius:5px;margin-left:6px;font-family:inherit;flex-shrink:0;">Show</button>
            <button class="live-notif-x">×</button>`;
          el.querySelector('.live-notif-x').addEventListener('click', () => el.remove());
          el.querySelector('.live-toast-show-btn').addEventListener('click', () => {
            window.navio.showInFolder(savePath);
          });
          stack.prepend(el);
          setTimeout(() => el.remove(), 10000);
        } else {
          _showAppToast(`✓ Saved: ${filename}`, 'success');
        }
      } else {
        _showAppToast(`✗ Download failed: ${filename}`, 'error');
      }
    });

    // ── Certificate warning toasts ────────────────────────────────────────
    window.navio.onCertificateWarning(({ hostname }) => {
      _showAppToast(`⚠ Untrusted certificate on ${hostname} — proceeding anyway`, 'warning');
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

// Module-level toast (used by ReadingListManager and PasswordManager)
function _showAppToast(msg, type = 'info') {
  const stack = document.getElementById('live-notif-stack');
  if (!stack) return;
  const icons = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `live-notification live-toast live-toast-${type}`;
  el.innerHTML = `<span class="live-toast-icon">${icons[type] || '•'}</span><span class="live-toast-msg">${msg}</span><button class="live-notif-x">×</button>`;
  el.querySelector('.live-notif-x').addEventListener('click', () => el.remove());
  stack.prepend(el);
  setTimeout(() => el.remove(), 5000);
}

// ── Reading List Manager ───────────────────────────────────────────────────
const ReadingListManager = (() => {
  const _panel  = () => document.getElementById('reading-list-panel');
  const _list   = () => document.getElementById('rl-list');
  const _count  = () => document.getElementById('rl-count');
  const _badge  = () => document.getElementById('rl-badge');

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  async function refresh() {
    const r = await window.navio.readingListGet().catch(() => null);
    if (!r?.ok) return;
    const unread = r.list.filter(e => !e.read).length;
    const badge = _badge();
    if (badge) { badge.textContent = unread; badge.hidden = unread === 0; }
    const count = _count();
    if (count) count.textContent = r.list.length;
    _render(r.list);
  }

  function _render(list) {
    const el = _list();
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="rl-empty">No saved pages yet.<br>Click the bookmark icon while browsing to save a page.</p>';
      return;
    }
    el.innerHTML = list.map(e => `
      <div class="rl-item${e.read ? ' rl-read' : ''}" data-url="${_esc(e.url)}">
        ${e.favicon
          ? `<img class="rl-favicon" src="${_esc(e.favicon)}" alt="" onerror="this.style.display='none'">`
          : `<div class="rl-favicon-ph"></div>`}
        <div class="rl-item-body">
          <div class="rl-item-title">${_esc(e.title || e.url)}</div>
          <div class="rl-item-host">${_esc(_host(e.url))}</div>
        </div>
        <div class="rl-item-btns">
          ${!e.read ? `<button class="rl-btn rl-btn-read" data-url="${_esc(e.url)}" title="Mark as read">✓</button>` : ''}
          <button class="rl-btn rl-btn-del" data-url="${_esc(e.url)}" title="Remove">×</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.rl-item-title').forEach(titleEl => {
      titleEl.addEventListener('click', async () => {
        const url = titleEl.closest('.rl-item').dataset.url;
        if (url && typeof TabManager !== 'undefined') TabManager.navigateActive(url);
        await window.navio.readingListMarkRead(url);
        close();
        refresh();
      });
    });
    el.querySelectorAll('.rl-btn-read').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.navio.readingListMarkRead(btn.dataset.url);
        refresh();
      });
    });
    el.querySelectorAll('.rl-btn-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.navio.readingListRemove(btn.dataset.url);
        refresh();
      });
    });
  }

  function open() {
    const p = _panel();
    if (p) { p.hidden = false; p.classList.add('rl-open'); }
    refresh();
  }

  function close() {
    const p = _panel();
    if (p) { p.hidden = true; p.classList.remove('rl-open'); }
  }

  function toggle() {
    const p = _panel();
    p && !p.hidden ? close() : open();
  }

  async function saveCurrent() {
    if (typeof TabManager === 'undefined') return;
    const tab = TabManager.getActiveTab();
    if (!tab?.url || tab.url === 'about:blank') {
      _showAppToast('No page to save', 'error'); return;
    }
    const r = await window.navio.readingListAdd(tab.url, tab.title, tab.favicon);
    if (r.ok && r.added) {
      _showAppToast('Saved for later', 'success');
      refresh();
    } else if (r.ok && !r.added) {
      _showAppToast('Already in reading list', 'info');
    }
  }

  // Wire buttons once DOM is ready
  document.getElementById('btn-read-later')?.addEventListener('click', toggle);
  document.getElementById('btn-close-reading-list')?.addEventListener('click', close);
  refresh();

  return { open, close, toggle, saveCurrent, refresh };
})();

// ── Password Manager ───────────────────────────────────────────────────────
// Handles the save-password prompt bar, autofill offer bar, and the secure
// credential vault (persisted in main via safeStorage).

const PasswordManager = (() => {
  let _pendingSave = null;  // { username, password, url }
  let _autofillWv  = null;  // active webview for autofill
  let _autofillPwd = null;  // { username, password }

  const saveBar       = document.getElementById('pwd-save-bar');
  const autofillBar   = document.getElementById('pwd-autofill-bar');
  const saveUser      = document.getElementById('pwd-save-user');
  const saveSite      = document.getElementById('pwd-save-site');
  const autofillUser  = document.getElementById('pwd-autofill-user');

  function _originLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  function _hideSave() {
    if (saveBar) saveBar.hidden = true;
    _pendingSave = null;
  }

  function _hideAutofill() {
    if (autofillBar) autofillBar.hidden = true;
    _autofillWv = null;
    _autofillPwd = null;
  }

  // ── Show "Save password?" prompt ──────────────────────────────────────────
  function showSavePrompt({ username, password, url }, wv) {
    if (!saveBar) return;
    _pendingSave = { username, password, url };
    if (saveSite) saveSite.textContent = _originLabel(url);
    if (saveUser) saveUser.textContent = username;
    saveBar.hidden = false;
    // Auto-dismiss after 30 s
    clearTimeout(saveBar._timer);
    saveBar._timer = setTimeout(_hideSave, 30000);
  }

  // ── Check if we have credentials for the current URL ──────────────────────
  async function checkAutofill(url, wv) {
    if (!autofillBar) return;
    try {
      const r = await window.navio.passwordsGet(url);
      if (!r.ok || !r.entries.length) return;
      const entry = r.entries[0];
      _autofillWv  = wv;
      _autofillPwd = entry;
      if (autofillUser) autofillUser.textContent = entry.username;
      autofillBar.hidden = false;
      clearTimeout(autofillBar._timer);
      autofillBar._timer = setTimeout(_hideAutofill, 20000);
    } catch {}
  }

  // Wire up the bar buttons
  document.getElementById('pwd-save-btn')?.addEventListener('click', async () => {
    if (!_pendingSave) return;
    try {
      await window.navio.passwordsSave(_pendingSave.url, _pendingSave.username, _pendingSave.password);
    } catch {}
    _hideSave();
  });

  document.getElementById('pwd-never-btn')?.addEventListener('click', _hideSave);
  document.getElementById('pwd-dismiss-btn')?.addEventListener('click', _hideSave);

  document.getElementById('pwd-autofill-btn')?.addEventListener('click', () => {
    if (_autofillWv && _autofillPwd) {
      try {
        _autofillWv.send('navio-autofill', {
          username: _autofillPwd.username,
          password: _autofillPwd.password,
        });
      } catch {}
    }
    _hideAutofill();
  });

  document.getElementById('pwd-autofill-dismiss')?.addEventListener('click', _hideAutofill);

  return { showSavePrompt, checkAutofill };
})();
