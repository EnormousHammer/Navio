/**
 * Navio Browser - Main Application Controller
 * Orchestrates all browser components: tabs, navigation, AI assistant, settings
 */

class NavioApp {
  constructor() {
    this.config = {};
    this._initialShellReadyScheduled = false;
    this._urlSuggest = { index: -1, items: [], debounce: null, listEl: null };
    this.init();
  }

  async init() {
    this.config = await window.navio.getConfig();

    this.applyTheme(this.config.theme || 'dark');
    this.applyLayoutFromConfig(this.config);

    const isFirstRun = await Onboarding.checkFirstRun();

    if (typeof LaunchIntro !== 'undefined') {
      try {
        await LaunchIntro.playIfAvailable({
          /* Returning users only — first run finishes onboarding first, then onOnboardingComplete → startBrowser */
          preloadBrowser: !isFirstRun ? () => this.startBrowser() : null
        });
      } catch (e) {
        console.warn('[Navio] Launch intro failed:', e);
        LaunchIntro._stripPrelude();
      } finally {
        if (this._sessionStarted) this._finishInitialShellReady();
      }
      this.config = await window.navio.getConfig();
    } else {
      /* launch-intro.js missing — body still has shell-prelude-active from HTML; that sets #app to pointer-events:none */
      const sp = document.getElementById('shell-prelude');
      document.body.classList.remove(
        'shell-prelude-active',
        'shell-prelude-in',
        'shell-browser-reveal',
        'shell-prelude-fading',
        'launch-intro-active'
      );
      if (sp) {
        sp.classList.remove('shell-prelude-exiting');
        sp.setAttribute('aria-hidden', 'true');
        sp.style.removeProperty('pointer-events');
      }
      if (this._sessionStarted) this._finishInitialShellReady();
    }

    this.bindThemeToggle();
    this.bindWindowControls();
    this.bindNavigation();
    this.bindShortcuts();
    this.bindNewTabPage();

    // If prelude was dismissed (aria-hidden) but body classes were left behind, unblock the shell.
    this._syncShellPreludeBodyClass();

    // If LaunchIntro did not run startBrowser (e.g. intro error, or no LaunchIntro), still open a tab for returning users.
    // First-run: onboarding → onOnboardingComplete() → startBrowser().
    if (!isFirstRun && !this._sessionStarted) {
      void this.startBrowser();
    }
    if (typeof LaunchIntro === 'undefined' && this._sessionStarted) {
      this._finishInitialShellReady();
    }
  }

  async onOnboardingComplete() {
    this.config = {};
    window.navio.getConfig().then(c => {
      this.config = c;
      this.applyTheme(this.config.theme || 'dark');
      this.applyLayoutFromConfig(this.config);
    });
    await this.startBrowser();
    this._finishInitialShellReady();
  }

  async startBrowser() {
    if (this._sessionStarted) return;
    this._sessionStarted = true;
    await new Promise((r) => setTimeout(r, 100));
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
    /* waitForInitialShellReady deferred until after prelude fade — avoids layout work competing with the transition */
  }

  /** Drop stale shell-prelude-active / shell-prelude-in when #shell-prelude is already dismissed. */
  _syncShellPreludeBodyClass() {
    requestAnimationFrame(() => {
      const sp = document.getElementById('shell-prelude');
      if (sp && sp.getAttribute('aria-hidden') === 'true') {
        document.body.classList.remove(
          'shell-prelude-active',
          'shell-prelude-in',
          'shell-browser-reveal',
          'shell-prelude-fading'
        );
      }
    });
  }

  /** Run after launch prelude finishes so NTP “ready” checks don’t block or overlap the crossfade. */
  _finishInitialShellReady() {
    if (this._initialShellReadyScheduled) return;
    if (typeof TabManager === 'undefined' || typeof TabManager.waitForInitialShellReady !== 'function') return;
    this._initialShellReadyScheduled = true;
    requestAnimationFrame(() => {
      void TabManager.waitForInitialShellReady();
    });
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
    if (typeof window.applyTabLayoutFromConfig === 'function') {
      window.applyTabLayoutFromConfig(config || {});
    }
    const bb = document.getElementById('bookmark-bar');
    if (bb) bb.hidden = config && config.showBookmarkBar === false;
    if (typeof window.__navioSyncBookmarkBarToggleButton === 'function') {
      window.__navioSyncBookmarkBarToggleButton();
    }
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
    let q = (input || '').trim().toLowerCase();
    q = q.replace(/^\?+/, '');
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

  _normalizeOmniboxUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href;
    } catch {
      return (url || '').trim();
    }
  }

  _flattenBookmarksForOmnibox(data) {
    const out = [];
    for (const b of data.bar || []) {
      if (b.url) out.push(b);
    }
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.url) out.push(n);
        if (n.children && n.children.length) walk(n.children);
      }
    };
    walk(data.tree || []);
    return out;
  }

  /** When true, show history/bookmark rows; when false (long AI-style question), skip to avoid noise. */
  _shouldOfferUrlSuggestions(raw) {
    const t = (raw || '').trim();
    if (!t) return true;
    if (/^https?:\/\//i.test(t)) return true;
    if (/^ai:/i.test(t) || t.startsWith('>>')) return false;
    if (t.includes('.') && t.split(/\s+/).length <= 4) return true;
    if (this._isAIQuery(t) && !t.includes('/') && !t.includes('.') && t.split(/\s+/).length >= 5) return false;
    return true;
  }

  _hideUrlSuggestions() {
    const list = this._urlSuggest.listEl || document.getElementById('url-suggestions');
    if (list) {
      list.hidden = true;
      list.innerHTML = '';
    }
    this._urlSuggest.index = -1;
    this._urlSuggest.items = [];
  }

  _highlightUrlSuggestionRows() {
    const list = this._urlSuggest.listEl;
    if (!list) return;
    list.querySelectorAll('.url-suggestion-row').forEach((row, i) => {
      const on = i === this._urlSuggest.index;
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  _hostHue(host) {
    let h = 0;
    const s = String(host || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  /**
   * Letter chip underlay + favicon image (Google s2 or stored). Image hides on error so letter shows.
   */
  _suggestionIconHtml(url, storedFavicon) {
    const esc = (s) => {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    };
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    const letter = (host[0] || '?').toUpperCase();
    const hue = this._hostHue(host || '?');
    const s2 = host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : '';
    const letterHtml = `<span class="url-suggestion-fav url-suggestion-fav--letter" style="--letter-hue:${hue}">${esc(letter)}</span>`;
    const primary = storedFavicon || s2;
    if (!primary) return letterHtml;
    const needFallback = !!(storedFavicon && s2 && String(storedFavicon).trim() !== String(s2).trim());
    const fallbackAttr = needFallback ? ` data-fallback-s2="${esc(s2)}"` : '';
    return `<span class="url-suggestion-fav-wrap">${letterHtml}<img class="url-suggestion-fav url-suggestion-fav--img" src="${esc(primary)}" alt="" loading="lazy"${fallbackAttr} /></span>`;
  }

  _wireUrlSuggestionImgFallbacks(listEl) {
    if (!listEl) return;
    listEl.querySelectorAll('.url-suggestion-fav--img').forEach((img) => {
      img.addEventListener('error', function onImgErr() {
        const s2 = this.getAttribute('data-fallback-s2');
        if (s2 && !this.dataset.triedS2) {
          this.dataset.triedS2 = '1';
          this.src = s2;
          return;
        }
        this.classList.add('is-hidden');
      });
    });
  }

  async _collectUrlSuggestions(query) {
    const q = (query || '').trim();
    const out = [];
    const seen = new Set();
    const add = (item) => {
      const key = this._normalizeOmniboxUrl(item.url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    try {
      if (!window.navio.historySearch) return [];

      if (q) {
        const { entries = [] } = await window.navio.historySearch(q, 50);
        if (window.navio.bookmarksGet) {
          const bdata = await window.navio.bookmarksGet();
          const flat = this._flattenBookmarksForOmnibox(bdata);
          const ql = q.toLowerCase();
          for (const b of flat) {
            const hay = `${b.title || ''} ${b.url || ''}`.toLowerCase();
            if (hay.includes(ql)) {
              add({
                url: b.url,
                title: b.title || b.url,
                badge: 'bookmark',
                favicon: b.favicon || ''
              });
            }
          }
        }
        for (const e of entries) {
          add({
            url: e.url,
            title: e.title || e.url,
            badge: 'history',
            visitCount: e.visitCount,
            visitedAt: e.visitedAt,
            favicon: e.favicon || ''
          });
        }
        return out.slice(0, 14);
      }

      const { entries = [] } = await window.navio.historySearch('', 250);
      if (entries.length) {
        const byFreq = [...entries].sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0));
        for (const e of byFreq.slice(0, 6)) {
          const vc = e.visitCount || 0;
          add({
            url: e.url,
            title: e.title || e.url,
            badge: vc >= 3 ? 'frequent' : 'recent',
            visitCount: vc,
            visitedAt: e.visitedAt,
            favicon: e.favicon || ''
          });
        }
        const byTime = [...entries].sort((a, b) => (b.visitedAt || 0) - (a.visitedAt || 0));
        for (const e of byTime.slice(0, 10)) {
          add({
            url: e.url,
            title: e.title || e.url,
            badge: 'recent',
            visitCount: e.visitCount,
            visitedAt: e.visitedAt,
            favicon: e.favicon || ''
          });
        }
      }
      if (window.navio.bookmarksGet) {
        const bdata = await window.navio.bookmarksGet();
        const flat = this._flattenBookmarksForOmnibox(bdata);
        for (const b of flat.slice(0, 8)) {
          add({
            url: b.url,
            title: b.title || b.url,
            badge: 'bookmark',
            favicon: b.favicon || ''
          });
        }
      }
      return out.slice(0, 14);
    } catch (e) {
      console.warn('[Navio] url suggestions', e);
      return [];
    }
  }

  async _refreshUrlSuggestions(urlInput, aiHint) {
    if (!urlInput || !this._urlSuggest.listEl) return;
    const raw = urlInput.value;
    if (aiHint && aiHint.classList.contains('visible')) {
      this._hideUrlSuggestions();
      return;
    }
    if (!this._shouldOfferUrlSuggestions(raw)) {
      this._hideUrlSuggestions();
      return;
    }
    const items = await this._collectUrlSuggestions(raw.trim());
    const list = this._urlSuggest.listEl;
    if (!items.length) {
      this._hideUrlSuggestions();
      return;
    }
    this._urlSuggest.items = items;
    this._urlSuggest.index = -1;
    const esc = (s) => {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    };
    const badgeLabel = (b) => {
      if (b === 'bookmark') return 'Saved';
      if (b === 'frequent') return 'Frequent';
      return 'Recent';
    };
    const badgeClass = (b) => {
      if (b === 'bookmark') return 'url-suggestion-badge url-suggestion-badge--bookmark';
      if (b === 'frequent') return 'url-suggestion-badge url-suggestion-badge--frequent';
      return 'url-suggestion-badge url-suggestion-badge--recent';
    };
    list.innerHTML = items
      .map((it, i) => {
        let host = '';
        try {
          host = new URL(it.url).hostname.replace(/^www\./, '');
        } catch {
          host = it.url;
        }
        const fav = this._suggestionIconHtml(it.url, it.favicon);
        return `<button type="button" class="url-suggestion-row" role="option" data-i="${i}" aria-selected="false">
${fav}<span class="url-suggestion-body"><span class="url-suggestion-title">${esc(it.title)}</span><span class="url-suggestion-url">${esc(host)}</span></span>
<span class="${badgeClass(it.badge)}">${esc(badgeLabel(it.badge))}</span>
</button>`;
      })
      .join('');
    this._wireUrlSuggestionImgFallbacks(list);
    list.hidden = false;
    list.querySelectorAll('.url-suggestion-row').forEach((row) => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const i = Number(row.getAttribute('data-i'));
        const it = this._urlSuggest.items[i];
        if (it && it.url) {
          this.navigateTo(it.url);
          urlInput.blur();
          this._hideUrlSuggestions();
        }
      });
    });
  }

  bindNavigation() {
    const urlInput = document.getElementById('url-input');
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');
    const btnReload = document.getElementById('btn-reload');
    this._urlSuggest.listEl = document.getElementById('url-suggestions');

    // Show AI hint badge when input looks like a question; debounce history/bookmark suggestions
    const aiHint = document.getElementById('url-ai-hint');
    urlInput.addEventListener('input', () => {
      const raw = urlInput.value.trim();
      if (aiHint) {
        const show = raw.length > 3 && !raw.startsWith('http') && this._isAIQuery(raw);
        aiHint.classList.toggle('visible', show);
        if (show) this._hideUrlSuggestions();
      }
      clearTimeout(this._urlSuggest.debounce);
      this._urlSuggest.debounce = setTimeout(() => {
        void this._refreshUrlSuggestions(urlInput, aiHint);
      }, 100);
    });
    aiHint?.addEventListener('click', () => {
      const raw = urlInput.value.trim();
      if (raw) { this._sendToAI(raw); urlInput.value = ''; urlInput.blur(); }
    });

    const popupBlockedBtn = document.getElementById('url-popup-blocked');
    if (popupBlockedBtn && typeof window.navio.onPopupBlocked === 'function') {
      window.navio.onPopupBlocked((data) => {
        const origin = (data && data.openerOrigin) || '';
        if (origin) {
          popupBlockedBtn.hidden = false;
          popupBlockedBtn.dataset.origin = origin;
        }
        const tip = data && data.blockedUrl ? String(data.blockedUrl).slice(0, 72) : '';
        _showAppToast(tip ? `Pop-up blocked: ${tip}` : 'Pop-up blocked', 'warning');
      });
      popupBlockedBtn.addEventListener('click', async () => {
        const o = popupBlockedBtn.dataset.origin || '';
        if (!o || typeof window.navio.sitePopupsSet !== 'function') return;
        try {
          const r = await window.navio.sitePopupsSet(o, true);
          if (r && r.ok) {
            popupBlockedBtn.hidden = true;
            delete popupBlockedBtn.dataset.origin;
            _showAppToast('Pop-ups allowed for this site', 'success');
          } else {
            _showAppToast('Could not save site permission', 'error');
          }
        } catch {
          _showAppToast('Could not save site permission', 'error');
        }
      });
    }

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const sug = this._urlSuggest;
        if (!sug.listEl || sug.listEl.hidden || !sug.items.length) return;
        e.preventDefault();
        if (e.key === 'ArrowDown') {
          sug.index = Math.min(sug.items.length - 1, sug.index + 1);
          if (sug.index < 0) sug.index = 0;
        } else {
          sug.index = Math.max(0, sug.index - 1);
        }
        this._highlightUrlSuggestionRows();
        return;
      }
      if (e.key === 'Enter') {
        const sug = this._urlSuggest;
        if (sug.listEl && !sug.listEl.hidden && sug.index >= 0 && sug.items[sug.index]) {
          e.preventDefault();
          this.navigateTo(sug.items[sug.index].url);
          urlInput.blur();
          this._hideUrlSuggestions();
          return;
        }
        e.preventDefault();
        const raw = urlInput.value.trim();
        if (raw.startsWith('>>')) {
          const q = raw.slice(2).trim();
          urlInput.value = '';
          urlInput.blur();
          if (q && typeof AssistantManager !== 'undefined') {
            AssistantManager.open();
            AssistantManager.addMessage('user', `>> ${q}`);
            AssistantManager.runDeepResearch(q);
          }
          return;
        }
        // Explicit AI prefix (avoid leading ? — same key as typing questions)
        if (/^ai:\s*/i.test(raw)) {
          const q = raw.replace(/^ai:\s*/i, '').trim();
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
        if (this._urlSuggest.listEl && !this._urlSuggest.listEl.hidden) {
          this._hideUrlSuggestions();
          e.preventDefault();
          return;
        }
        urlInput.blur();
        if (aiHint) aiHint.classList.remove('visible');
        const activeTab = TabManager.getActiveTab();
        if (activeTab) urlInput.value = activeTab.url || '';
      }
    });

    urlInput.addEventListener('focus', () => {
      urlInput.select();
      void this._refreshUrlSuggestions(urlInput, aiHint);
    });

    urlInput.addEventListener('blur', () => {
      setTimeout(() => this._hideUrlSuggestions(), 200);
    });

    btnBack.addEventListener('click', () => {
      const wv = TabManager.getActiveWebview();
      if (wv && TabManager.webviewCanGoBack(wv)) wv.goBack();
    });

    btnForward.addEventListener('click', () => {
      const wv = TabManager.getActiveWebview();
      if (wv && TabManager.webviewCanGoForward(wv)) wv.goForward();
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
    window.navio.onOpenUrlInNewTab((url, opts = {}) => {
      if (typeof TabManager === 'undefined') return;
      const u = url == null ? '' : String(url);
      // Popups from guest pages are routed here (main setWindowOpenHandler) — open a real tab.
      // Streaming sites: open in background so junk/ad tabs do not steal focus from the player.
      const tabOpts = {
        incognito: !!opts.incognito,
        switchTo: opts.background !== true
      };
      if (u) TabManager.createTab(u, tabOpts);
      else TabManager.createTab(null, tabOpts);
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
        const stack = document.getElementById('live-notif-stack');
        if (stack) {
          const id = Date.now();
          const el = document.createElement('div');
          el.className = 'live-notification live-toast live-toast-success';
          el.id = `app-toast-${id}`;
          el.innerHTML = `
            <span class="live-toast-icon">✓</span>
            <span class="live-toast-msg">Saved: ${filename}</span>
            <button type="button" class="live-toast-open-btn" title="Open in Navio (PDFs and web files in a new tab)" style="background:rgba(0,216,255,0.12);border:1px solid rgba(0,216,255,0.45);color:#00d8ff;cursor:pointer;font-size:10.5px;padding:2px 8px;border-radius:5px;margin-left:6px;font-family:inherit;flex-shrink:0;">Open</button>
            <button type="button" class="live-toast-show-btn" title="Show in folder" style="background:none;border:1px solid rgba(0,216,255,0.4);color:#00d8ff;cursor:pointer;font-size:10.5px;padding:2px 8px;border-radius:5px;margin-left:4px;font-family:inherit;flex-shrink:0;">Show</button>
            <button type="button" class="live-notif-x">×</button>`;
          el.querySelector('.live-notif-x').addEventListener('click', () => el.remove());
          el.querySelector('.live-toast-open-btn').addEventListener('click', () => {
            if (typeof window.__navioOpenDownloadSmart === 'function') {
              void window.__navioOpenDownloadSmart(savePath);
            } else {
              void window.navio.openFilePath?.(savePath);
            }
          });
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
      _showAppToast('You proceeded on an untrusted certificate (' + hostname + ')', 'warning');
    });

       const shortcutDedupeMs = 120;
    const shortcutDedupeAt = { 'new-tab': 0, 'new-private-tab': 0, 'close-tab': 0, 'focus-url': 0 };
    const runDedupedShortcut = (id, fn) => {
      const now = Date.now();
      if (now - (shortcutDedupeAt[id] || 0) < shortcutDedupeMs) return;
      shortcutDedupeAt[id] = now;
      fn();
    };

    window.navio.onShortcut((action) => {
      switch (action) {
        case 'new-tab':
          runDedupedShortcut('new-tab', () => TabManager.createTab());
          break;
        case 'new-private-tab':
          runDedupedShortcut('new-private-tab', () => TabManager.createTab(null, { incognito: true }));
          break;
        case 'close-tab':
          runDedupedShortcut('close-tab', () => TabManager.closeActiveTab());
          break;
        case 'reopen-last-tab':
          TabManager.reopenLastClosedTab();
          break;
        case 'focus-url':
          runDedupedShortcut('focus-url', () => document.getElementById('url-input').focus());
          break;
        case 'history-panel':
          window.__navioOpenHistoryOverlay?.();
          break;
        case 'bookmarks-panel':
          window.__navioOpenBookmarksOverlay?.();
          break;
        case 'downloads-panel':
          window.__navioToggleDownloadsDrawer?.();
          break;
        case 'tab-search': {
          const overlay = document.getElementById('tab-search-overlay');
          const input = document.getElementById('tab-search-input');
          if (overlay && input) {
            overlay.hidden = false;
            input.value = '';
            input.dispatchEvent(new Event('input'));
            input.focus();
          }
          break;
        }
        case 'devtools-active-tab':
          if (typeof ScreenshotTool !== 'undefined' && ScreenshotTool.openDevtools) {
            ScreenshotTool.openDevtools();
          }
          break;
        case 'toggle-assistant':
          try {
            window.navio?.shellLog?.('[navio-assistant] main shortcut IPC → toggle-assistant');
          } catch {
            /* ignore */
          }
          if (typeof AssistantManager !== 'undefined' && typeof AssistantManager.toggle === 'function') {
            AssistantManager.toggle();
          }
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
        case 'reload':
          TabManager.reloadActive(false);
          break;
        case 'hard-reload':
          TabManager.reloadActive(true);
          break;
        case 'go-back': {
          const wvb = TabManager.getActiveWebview();
          if (wvb && TabManager.webviewCanGoBack(wvb)) wvb.goBack();
          break;
        }
        case 'go-forward': {
          const wvf = TabManager.getActiveWebview();
          if (wvf && TabManager.webviewCanGoForward(wvf)) wvf.goForward();
          break;
        }
        case 'next-tab':
          TabManager.switchToAdjacentTab(1);
          break;
        case 'prev-tab':
          TabManager.switchToAdjacentTab(-1);
          break;
        default:
          if (/^tab-[1-9]$/.test(action)) {
            TabManager.switchToTabOrdinal(parseInt(action.slice(4), 10));
          }
          break;
      }
    });

    // Fallback when the shell has focus (and to support Cmd on macOS in the UI process).
    // Deduped with onShortcut because globalShortcut and keydown can both fire.
    document.addEventListener('keydown', (e) => {
      // F12: page DevTools (matches globalShortcut; dedupe rapid double-fire).
      if ((e.key || '') === 'F12') {
        e.preventDefault();
        runDedupedShortcut('devtools-active-tab', () => {
          if (typeof ScreenshotTool !== 'undefined' && ScreenshotTool.openDevtools) {
            ScreenshotTool.openDevtools();
          }
        });
        return;
      }

      if ((e.key || '') === 'F5') {
        e.preventDefault();
        TabManager.reloadActive(false);
        return;
      }

      // Alt+Left / Alt+Right: history navigation (same as Chrome).
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const ak = e.key;
        if (ak === 'ArrowLeft' || ak === 'Left') {
          e.preventDefault();
          const wv = TabManager.getActiveWebview();
          if (wv && TabManager.webviewCanGoBack(wv)) wv.goBack();
          return;
        }
        if (ak === 'ArrowRight' || ak === 'Right') {
          e.preventDefault();
          const wv = TabManager.getActiveWebview();
          if (wv && TabManager.webviewCanGoForward(wv)) wv.goForward();
          return;
        }
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) TabManager.switchToAdjacentTab(-1);
        else TabManager.switchToAdjacentTab(1);
        return;
      }

      if (!e.shiftKey && (e.key === 'PageDown' || e.code === 'PageDown')) {
        e.preventDefault();
        TabManager.switchToAdjacentTab(1);
        return;
      }
      if (!e.shiftKey && (e.key === 'PageUp' || e.code === 'PageUp')) {
        e.preventDefault();
        TabManager.switchToAdjacentTab(-1);
        return;
      }

      if (e.altKey) return;
      const k = (e.key || '').toLowerCase();
      if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('new-tab', () => TabManager.createTab());
      }
      if (k === 'n' && e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('new-private-tab', () => TabManager.createTab(null, { incognito: true }));
      }
      if (k === 't' && e.shiftKey) {
        e.preventDefault();
        TabManager.reopenLastClosedTab();
      }
      if (k === 'w' && !e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('close-tab', () => TabManager.closeActiveTab());
      }
      if (k === 'l' && !e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('focus-url', () => document.getElementById('url-input').focus());
      }
      if (k === 'r') {
        e.preventDefault();
        TabManager.reloadActive(!!e.shiftKey);
      }
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        TabManager.switchToTabOrdinal(parseInt(e.key, 10));
      }
      if (k === 'h' && !e.shiftKey) {
        e.preventDefault();
        window.__navioOpenHistoryOverlay?.();
      }
      if (k === 'i' && e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('devtools-active-tab', () => {
          if (typeof ScreenshotTool !== 'undefined' && ScreenshotTool.openDevtools) {
            ScreenshotTool.openDevtools();
          }
        });
      }
      if (k === 'b' && e.shiftKey) {
        e.preventDefault();
        window.__navioOpenBookmarksOverlay?.();
      }
      if (k === 'o' && e.shiftKey) {
        e.preventDefault();
        const overlay = document.getElementById('tab-search-overlay');
        const input = document.getElementById('tab-search-input');
        if (overlay && input) {
          overlay.hidden = false;
          input.value = '';
          input.dispatchEvent(new Event('input'));
          input.focus();
        }
      }
      // Same as globalShortcut Ctrl+Shift+A — works when OS registration fails or is taken by another app.
      if (k === 'a' && e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('toggle-assistant', () => {
          if (typeof AssistantManager !== 'undefined' && typeof AssistantManager.toggle === 'function') {
            AssistantManager.toggle();
          }
        });
      }
    });
  }

  // Used by NTP.js submit — public so ntp.js can call it
  handleSearch(input) {
    const raw = (input || '').trim();
    if (!raw) return;
    if (raw.startsWith('>>')) {
      const q = raw.slice(2).trim();
      if (q && typeof AssistantManager !== 'undefined') {
        AssistantManager.open();
        AssistantManager.addMessage('user', `>> ${q}`);
        AssistantManager.runDeepResearch(q);
      }
      return;
    }
    if (/^ai:\s*/i.test(raw)) {
      this._sendToAI(raw.replace(/^ai:\s*/i, '').trim());
      return;
    }
    this.navigateTo(raw);
  }

  bindNewTabPage() {
    // Intentionally empty — ntp.js owns all NTP input/shortcut handlers.
    // Duplicate handlers here caused a race: app.js set tab.url before
    // ntp.js ran its check, making ntp.js open a second tab instead of
    // navigating the current one (the "ghost NTP tab" bug).
  }

  updateUrlBar(url) {
    const popupChip = document.getElementById('url-popup-blocked');
    if (popupChip) {
      popupChip.hidden = true;
      delete popupChip.dataset.origin;
    }
    const urlInput = document.getElementById('url-input');
    const sslIndicator = document.getElementById('url-ssl');
    const incog =
      typeof TabManager !== 'undefined' && TabManager.getActiveTab && !!TabManager.getActiveTab()?.incognito;
    const sslExtra = incog ? ' incognito-context' : '';

    if (!url || url === 'about:blank') {
      urlInput.value = '';
      sslIndicator.className = 'url-ssl' + sslExtra;
      sslIndicator.title = incog ? 'Private tab' : '';
      return;
    }

    urlInput.value = url;

    if (url.startsWith('https://')) {
      sslIndicator.className = 'url-ssl secure' + sslExtra;
      sslIndicator.title = incog ? 'Private tab — HTTPS' : 'Secure connection (HTTPS)';
    } else if (url.startsWith('http://')) {
      sslIndicator.className = 'url-ssl insecure' + sslExtra;
      sslIndicator.title = incog ? 'Private tab — not secure (HTTP)' : 'Not secure (HTTP)';
    } else {
      sslIndicator.className = 'url-ssl' + sslExtra;
      sslIndicator.title = incog ? 'Private tab' : '';
    }
  }

  updateNavigationButtons(webview) {
    const btnBack = document.getElementById('btn-back');
    const btnForward = document.getElementById('btn-forward');

    if (webview) {
      btnBack.disabled = !TabManager.webviewCanGoBack(webview);
      btnForward.disabled = !TabManager.webviewCanGoForward(webview);
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
    if (!r?.ok) {
      if (!r) _showAppToast('Could not load reading list.', 'error');
      return;
    }
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
    if (p) p.classList.add('rl-open');
    refresh();
  }

  function close() {
    const p = _panel();
    if (p) p.classList.remove('rl-open');
  }

  function toggle() {
    const p = _panel();
    p && p.classList.contains('rl-open') ? close() : open();
  }

  async function saveCurrent() {
    if (typeof TabManager === 'undefined') return;
    const tab = TabManager.getActiveTab();
    if (!tab?.url || tab.url === 'about:blank') {
      _showAppToast('No page to save', 'error'); return;
    }
    const r = await window.navio.readingListAdd(
      tab.url,
      TabManager.getTabDisplayTitle(tab),
      tab.favicon
    ).catch(() => null);
    if (!r) {
      _showAppToast('Could not save page.', 'error');
    } else if (r.ok && r.added) {
      _showAppToast('Saved for later', 'success');
      open(); // always show the panel after saving so user sees the item
      refresh();
    } else if (r.ok && !r.added) {
      _showAppToast('Already saved', 'info');
      open();
    } else {
      _showAppToast('Could not save page.', 'error');
    }
  }

  // Wire buttons once DOM is ready
  // Clicking the navbar icon: if panel is open → close; otherwise save + open
  document.getElementById('btn-read-later')?.addEventListener('click', () => {
    const p = _panel();
    if (p && p.classList.contains('rl-open')) { close(); } else { saveCurrent(); }
  });
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
  const autofillUser  = document.getElementById('pwd-autofill-user');

  function _originLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  function _hideSave() {
    if (saveBar) saveBar.hidden = true;
    _pendingSave = null;
    const saveBtn = document.getElementById('pwd-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save';
  }

  function _hideAutofill() {
    if (autofillBar) autofillBar.hidden = true;
    _autofillWv = null;
    _autofillPwd = null;
  }

  // ── Show "Save password?" / "Replace password?" after submit ─────────────
  async function showSavePrompt({ username, password, url }, wv) {
    if (!saveBar) return;
    let mode = 'save';
    try {
      const r = await window.navio.passwordsGet(url);
      if (r.ok && r.entries && r.entries.length) {
        const sameUser = r.entries.find((e) => e.username === username);
        if (sameUser) {
          if (sameUser.password === password) return;
          mode = 'update';
        }
      }
    } catch {
      /* offer new save */
    }
    _pendingSave = { username, password, url };
    if (saveUser) saveUser.textContent = username;
    const msgEl = saveBar.querySelector('.pwd-save-msg');
    if (msgEl) {
      const host = _originLabel(url);
      if (mode === 'update') {
        msgEl.innerHTML = `Password changed for <strong id="pwd-save-site">${host}</strong> — replace saved password?`;
      } else {
        msgEl.innerHTML = `Save password for <strong id="pwd-save-site">${host}</strong>?`;
      }
    }
    const saveBtn = document.getElementById('pwd-save-btn');
    if (saveBtn) saveBtn.textContent = mode === 'update' ? 'Replace' : 'Save';
    saveBar.hidden = false;
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

// ── Inline AI ─────────────────────────────────────────────────────────────
// Highlights any selected text and floats a toolbar above it with quick AI
// actions (Explain, Summarize, Rewrite, Translate). Results stream into a
// small card anchored beneath the toolbar.

const InlineAI = (() => {
  const _toolbar = () => document.getElementById('inline-ai-toolbar');
  const _card    = () => document.getElementById('inline-ai-card');
  const _body    = () => document.getElementById('iai-card-body');
  const _label   = () => document.getElementById('iai-card-label');

  let _text   = '';
  let _unsubs = []; // stream unsubscribe callbacks
  let _targetWv = null;
  let _lastAiResult = '';
  let _lastAction = '';

  const LABELS = {
    explain:   'Explanation',
    summarize: 'Summary',
    rewrite:   'Rewrite',
    translate: 'Translation',
  };

  const PROMPTS = {
    explain:   t => `Explain this text clearly and concisely in 2-4 sentences:\n\n"${t}"`,
    summarize: t => `Summarize this in 1-3 sentences:\n\n"${t}"`,
    rewrite:   t => `Rewrite this to be clearer and more professional:\n\n"${t}"`,
    translate: t => `Translate this to English (if it is already English, improve the phrasing):\n\n"${t}"`,
  };

  function _cancelStream() {
    _unsubs.forEach(u => { try { u(); } catch {} });
    _unsubs = [];
  }

  function show(text, x, y, webview) {
    _text = text;
    _targetWv = webview || null;
    _cancelStream();

    const tb = _toolbar();
    if (!tb) return;

    // Position toolbar above the selection mid-point, clamped to viewport
    const tbW = tb.offsetWidth  || 320;
    const tbH = tb.offsetHeight || 38;
    const top  = Math.max(8, y - tbH - 10);
    const left = Math.max(8, Math.min(x - tbW / 2, window.innerWidth - tbW - 8));

    tb.style.top    = top  + 'px';
    tb.style.left   = left + 'px';
    tb.style.bottom = '';
    tb.hidden = false;

    // Hide the result card when a new selection appears
    const c = _card();
    if (c) c.hidden = true;
  }

  function hide() {
    _cancelStream();
    const tb = _toolbar();
    const c  = _card();
    if (tb) tb.hidden = true;
    if (c)  c.hidden  = true;
    _text = '';
    _targetWv = null;
    _lastAiResult = '';
    _lastAction = '';
    const rep = document.getElementById('iai-card-replace');
    if (rep) { rep.hidden = true; }
  }

  async function _runAction(action) {
    if (!_text) return;
    _cancelStream();
    _lastAction = action;
    _lastAiResult = '';

    const card  = _card();
    const body  = _body();
    const label = _label();
    const tb    = _toolbar();
    const repBtn = document.getElementById('iai-card-replace');
    if (!card || !body || !label) return;

    if (repBtn) {
      repBtn.hidden = action !== 'rewrite';
      repBtn.disabled = true;
    }

    label.textContent = LABELS[action] || 'Result';
    body.textContent  = ''; // empty → spinner shows via CSS :empty

    // Anchor card just below the toolbar
    if (tb) {
      const tbRect = tb.getBoundingClientRect();
      const cardW  = 360;
      const top    = tbRect.bottom + 8;
      const left   = Math.max(8, Math.min(tbRect.left, window.innerWidth - cardW - 8));
      // Flip above toolbar if card would go off the bottom of the screen
      const maxTop = window.innerHeight - 200;
      if (top > maxTop) {
        card.style.top    = '';
        card.style.bottom = (window.innerHeight - tbRect.top + 8) + 'px';
      } else {
        card.style.top    = top + 'px';
        card.style.bottom = '';
      }
      card.style.left = left + 'px';
    }
    card.hidden = false;

    try {
      const prompt = PROMPTS[action]?.(_text);
      if (!prompt) return;

      // Register listeners BEFORE starting the stream to avoid a race
      // where fast responses deliver chunks before handlers are attached.
      let result = '';
      const omniTab = '__omnibar__';
      _unsubs.push(window.navio.onAiStreamChunk((payload) => {
        let tid = '__default__';
        let chunkText = '';
        if (typeof payload === 'string') {
          chunkText = payload;
        } else if (payload && typeof payload === 'object') {
          tid = payload.tabId != null ? String(payload.tabId) : '__default__';
          chunkText = payload.text != null ? String(payload.text) : '';
        }
        if (tid !== omniTab || !chunkText) return;
        result += chunkText;
        if (body) body.textContent = result;
        _lastAiResult = result;
      }));
      _unsubs.push(window.navio.onAiStreamDone((payload) => {
        const tid = payload && payload.tabId != null ? String(payload.tabId) : '__default__';
        if (tid !== omniTab) return;
        _cancelStream();
        if (repBtn && action === 'rewrite') repBtn.disabled = !_lastAiResult.trim();
      }));
      _unsubs.push(window.navio.onAiStreamError((payload) => {
        const errObj = typeof payload === 'string' ? { tabId: '__default__', message: payload } : payload || {};
        const tid = errObj.tabId != null ? String(errObj.tabId) : '__default__';
        if (tid !== omniTab) return;
        const errText = errObj.message != null ? String(errObj.message) : String(payload || '');
        if (body) body.textContent = 'Error: ' + errText;
        _cancelStream();
        if (repBtn && action === 'rewrite') repBtn.disabled = true;
      }));

      await window.navio.aiRequestStream({
        messages: [
          { role: 'system', content: 'You are a helpful writing assistant. Be concise. Reply in plain text only — no markdown, no bullet points.' },
          { role: 'user',   content: prompt },
        ],
        tabId: omniTab,
      });
    } catch (err) {
      if (body) body.textContent = 'Error: ' + err.message;
    }
  }

  // ── Wire toolbar buttons ──────────────────────────────────────────────────
  document.getElementById('inline-ai-toolbar')?.addEventListener('mousedown', e => {
    // Prevent the mousedown from bubbling to the outside-click handler
    e.stopPropagation();
    const btn = e.target.closest('.iai-btn');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') {
      navigator.clipboard.writeText(_text).catch(() => {});
      hide();
    } else if (action) {
      _runAction(action);
    }
  });

  document.getElementById('iai-card-close')?.addEventListener('mousedown', e => {
    e.stopPropagation();
    hide();
  });

  async function _replaceSelectionWithResult() {
    const text = (_lastAiResult || '').trim();
    if (!text || !_targetWv) return;
    try {
      const wcId = _targetWv.getWebContentsId();
      let r = await window.navio.replaceSelectionInPage({ webContentsId: wcId, text });
      if (!r.ok) {
        await navigator.clipboard.writeText(text);
        r = await window.navio.webviewPasteClipboard({ webContentsId: wcId });
      }
      if (!r.ok) {
        if (_body()) _body().textContent += '\n\n(Could not inject — try focusing the field and paste manually.)';
        return;
      }
      hide();
    } catch (err) {
      if (_body()) _body().textContent += '\n\n' + (err.message || String(err));
    }
  }

  document.getElementById('iai-card-replace')?.addEventListener('mousedown', e => {
    e.stopPropagation();
    _replaceSelectionWithResult();
  });

  document.getElementById('inline-ai-card')?.addEventListener('mousedown', e => {
    e.stopPropagation(); // keep card open while user interacts with it
  });

  // Hide toolbar+card when clicking anywhere else in the main window
  document.addEventListener('mousedown', () => hide());

  return { show, hide };
})();
