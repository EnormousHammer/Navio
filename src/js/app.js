/**
 * Navio Browser - Main Application Controller
 * Orchestrates all browser components: tabs, navigation, AI assistant, settings
 */

/** Allowed `accentColorway` config values; default aurora uses built-in :root palette (no data-accent on html). */
const NAVIO_ACCENT_COLORWAYS = ['aurora', 'ocean', 'ember', 'forest', 'magenta', 'slate'];

function _navioHttpOriginFromUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    return new URL(s.split('#')[0]).origin;
  } catch {
    return '';
  }
}

/** Reload the guest tab that opened a blocked pop-up (may not be the active tab). */
function _navioReloadTabByGuestWebContentsId(wcId) {
  const id = Number(wcId);
  if (!Number.isFinite(id) || typeof TabManager === 'undefined') return false;
  try {
    const tab = TabManager.tabs.find((t) => {
      try {
        return (
          t.webview &&
          typeof t.webview.getWebContentsId === 'function' &&
          t.webview.getWebContentsId() === id
        );
      } catch {
        return false;
      }
    });
    if (tab && tab.webview && typeof tab.webview.reload === 'function') {
      tab.webview.reload();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

class NavioApp {
  constructor() {
    this.config = {};
    this._initialShellReadyScheduled = false;
    this._urlSuggest = { index: -1, items: [], debounce: null, listEl: null, _suggestRestore: null };
    this.init();
  }

  async init() {
    this.config = await window.navio.getConfig();
    if (typeof TabManager !== 'undefined' && typeof TabManager.primeWebviewPreload === 'function') {
      await TabManager.primeWebviewPreload();
    }

    this.applyTheme(this.config.theme || 'dark');
    this.applyColorway(this.config.accentColorway || 'aurora');
    this.applyLayoutFromConfig(this.config);

    const isFirstRun = await Onboarding.checkFirstRun();
    /* Returning users: open first tab immediately. First run: onboarding → onOnboardingComplete → startBrowser. */
    if (!isFirstRun) {
      await this.startBrowser();
    }
    if (this._sessionStarted) this._finishInitialShellReady();
    this.config = await window.navio.getConfig();

    this.bindThemeToggle();
    this.bindWindowControls();
    this.bindNavigation();
    this.bindShortcuts();
    this.bindNewTabPage();
    this._installDiagnosticsErrorForward();

    this._syncShellPreludeBodyClass();
  }

  async onOnboardingComplete() {
    this.config = {};
    window.navio.getConfig().then(c => {
      this.config = c;
      this.applyTheme(this.config.theme || 'dark');
      this.applyColorway(this.config.accentColorway || 'aurora');
      this.applyLayoutFromConfig(this.config);
    });
    await this.startBrowser();
    this._finishInitialShellReady();
  }

  /**
   * If the shell was loaded with `#navio-detach=…` (tab torn off into a new window),
   * parse it once and clear the hash so the address bar fragment does not linger.
   * @returns {{ url: string, incognito: boolean } | null}
   */
  _consumeNavioDetachLaunch() {
    try {
      const raw = (window.location.hash || '').replace(/^#/, '');
      if (!raw.startsWith('navio-detach=')) return null;
      const b64 = raw.slice('navio-detach='.length);
      let bin = '';
      try {
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        const std = b64.replace(/-/g, '+').replace(/_/g, '/') + pad;
        bin = atob(std);
      } catch {
        return null;
      }
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const json = new TextDecoder().decode(bytes);
      let o;
      try {
        o = JSON.parse(json);
      } catch {
        return null;
      }
      if (!o || o.v !== 1) return null;
      const url = typeof o.u === 'string' ? o.u : '';
      const incognito = !!o.i;
      try {
        history.replaceState(null, '', location.href.split('#')[0]);
      } catch {
        /* ignore */
      }
      return { url, incognito };
    } catch {
      return null;
    }
  }

  async startBrowser() {
    if (this._sessionStarted) return;
    this._sessionStarted = true;
    await new Promise((r) => setTimeout(r, 0));
    if (typeof TabManager === 'undefined') return;
    this._maybeProactiveTip();
    const detach = this._consumeNavioDetachLaunch();
    if (detach) {
      if (detach.url) TabManager.createTab(detach.url, { incognito: detach.incognito });
      else TabManager.createTab(null, { incognito: detach.incognito });
      return;
    }
    const mode = this.config.startupMode || 'new-tab';
    if (mode === 'homepage') {
      const hp = (this.config.homepage || 'https://www.google.com').trim() || 'https://www.google.com';
      const url = this.resolveNavigationInput(hp) || hp;
      TabManager.createTab(url);
    } else {
      TabManager.createTab();
    }
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

  _installDiagnosticsErrorForward() {
    window.addEventListener('error', (ev) => {
      const api = window.navio;
      if (!api || typeof api.reportDiagnosticsError !== 'function') return;
      const msg = ev.message || 'error';
      const stack = ev.error && ev.error.stack ? String(ev.error.stack) : '';
      void api.reportDiagnosticsError({ message: msg, stack });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const api = window.navio;
      if (!api || typeof api.reportDiagnosticsError !== 'function') return;
      const r = ev.reason;
      const msg = r instanceof Error ? r.message : String(r);
      const stack = r instanceof Error && r.stack ? String(r.stack) : '';
      void api.reportDiagnosticsError({ message: `unhandledrejection: ${msg}`, stack });
    });
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
  }

  /**
   * Applies accent colorway (buttons, gradients, glows). Persists via config `accentColorway`.
   * @param {string} id one of NAVIO_ACCENT_COLORWAYS
   */
  applyColorway(id) {
    const raw = typeof id === 'string' ? id.trim().toLowerCase() : '';
    const v = NAVIO_ACCENT_COLORWAYS.includes(raw) ? raw : 'aurora';
    if (v === 'aurora') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', v);
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
    await window.navio.saveConfig({ theme: next });
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

  _openAssistantSidebar(query) {
    const q = (query || '').trim();
    if (typeof AssistantManager === 'undefined') return;
    void AssistantManager.open();
    setTimeout(() => {
      if (!AssistantManager.inputEl) return;
      AssistantManager.inputEl.value = q;
      AssistantManager.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (q) void AssistantManager.sendMessage();
      else AssistantManager.inputEl.focus();
    }, 150);
  }

  /**
   * Full-page in-tab AI (same surface as New Tab → Ask AI). Falls back to the sidebar assistant
   * when the internal chat page is unavailable.
   * @param {string} val
   * @param {{ allowEmpty?: boolean }} [opts]
   */
  async openAssistantInTab(val, opts = {}) {
    const allowEmpty = !!opts.allowEmpty;
    const raw = (val || '').trim();
    if (!raw && !allowEmpty) return;
    if (typeof TabManager === 'undefined') return;

    let chatBase = '';
    try {
      if (typeof window.navio.getInternalChatPageUrl === 'function') {
        chatBase = await window.navio.getInternalChatPageUrl();
      }
    } catch {
      chatBase = '';
    }
    if (chatBase) {
      const sep = chatBase.includes('?') ? '&' : '?';
      const parts = [];
      if (raw) parts.push('initial=' + encodeURIComponent(raw));
      // Do not pass sourceTabId: full-page AI stays separate from whichever browsing tab was
      // active (no shared transcript bucket, no anchoring getBrowserContextTab to that tab).
      const qs = parts.length ? sep + parts.join('&') : '';
      TabManager.createTab(chatBase + qs);
      return;
    }

    TabManager.createTab('about:blank');
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
      const qq = raw.replace(/^ai:\s*/i, '').trim();
      this._openAssistantSidebar(qq);
      return;
    }
    this._openAssistantSidebar(raw);
  }

  _sendToAI(query) {
    void this.openAssistantInTab((query || '').trim(), { allowEmpty: false });
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
    // No query yet — skip until the user types (avoid dropdown on new tab / home / focus-only).
    if (!t) return false;
    if (/^https?:\/\//i.test(t)) return true;
    if (/^ai:/i.test(t) || t.startsWith('>>')) return false;
    if (t.includes('.') && t.split(/\s+/).length <= 4) return true;
    if (this._isAIQuery(t) && !t.includes('/') && !t.includes('.') && t.split(/\s+/).length >= 5) return false;
    return true;
  }

  /** Keep dropdown above NTP/webview — #main-content / #browser-container use overflow:hidden. */
  _layoutUrlSuggestionsLayer(list) {
    const slot = document.querySelector('.url-bar-container');
    if (!list || !slot) return;
    const r = slot.getBoundingClientRect();
    list.style.position = 'fixed';
    list.style.left = `${Math.max(4, r.left)}px`;
    list.style.top = `${r.bottom}px`;
    list.style.width = `${r.width}px`;
    list.style.right = 'auto';
    list.style.zIndex = '2147483646';
    if (list.parentElement !== document.body) {
      this._urlSuggest._suggestRestore = { parent: list.parentElement, next: list.nextSibling };
      document.body.appendChild(list);
    }
  }

  _restoreUrlSuggestionsToShell(list) {
    if (!list) return;
    const rs = this._urlSuggest._suggestRestore;
    if (rs && rs.parent && list.parentElement === document.body) {
      try {
        if (rs.next && rs.next.parentNode === rs.parent) rs.parent.insertBefore(list, rs.next);
        else rs.parent.appendChild(list);
      } catch {
        try {
          rs.parent.appendChild(list);
        } catch {
          /* ignore */
        }
      }
    }
    list.style.position = '';
    list.style.left = '';
    list.style.top = '';
    list.style.width = '';
    list.style.right = '';
    list.style.zIndex = '';
    this._urlSuggest._suggestRestore = null;
  }

  _hideUrlSuggestions() {
    const list = this._urlSuggest.listEl || document.getElementById('url-suggestions');
    if (list) {
      list.hidden = true;
      list.innerHTML = '';
      this._restoreUrlSuggestionsToShell(list);
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
   * Skip live search-engine completions only for clear URL/host typing (single token, host-like),
   * not for every string that happens to contain a dot.
   */
  _looksLikeTypedUrlForSearchSkip(q) {
    const t = (q || '').trim();
    if (!t) return false;
    if (/^https?:\/\//i.test(t)) return true;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return false;
    if (!t.includes('.')) return false;
    const core = t.replace(/^www\./i, '');
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(core);
  }

  /** DuckDuckGo ip3 icon, then Google s2 — used when no stored favicon. */
  _suggestionFaviconUrlChain(url, storedFavicon) {
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return [];
    }
    if (!host) return [];
    const ddg = `https://icons.duckduckgo.com/ip3/${host}.ico`;
    const s2 = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
    const chain = [];
    const push = (u) => {
      const s = u && String(u).trim();
      if (!s) return;
      if (!chain.includes(s)) chain.push(s);
    };
    push(storedFavicon);
    push(ddg);
    push(s2);
    return chain;
  }

  /**
   * Letter chip underlay + favicon (stored → DuckDuckGo → Google s2). Image steps through chain on error.
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
    const letterHtml = `<span class="url-suggestion-fav url-suggestion-fav--letter" style="--letter-hue:${hue}">${esc(letter)}</span>`;
    const chain = this._suggestionFaviconUrlChain(url, storedFavicon);
    if (!chain.length) return letterHtml;
    const [first, ...rest] = chain;
    const restAttr = rest.length
      ? ` data-fav-rest="${encodeURIComponent(JSON.stringify(rest))}"`
      : '';
    return `<span class="url-suggestion-fav-wrap">${letterHtml}<img class="url-suggestion-fav url-suggestion-fav--img" src="${esc(first)}" alt="" loading="lazy"${restAttr} /></span>`;
  }

  _wireUrlSuggestionImgFallbacks(listEl) {
    if (!listEl) return;
    listEl.querySelectorAll('.url-suggestion-fav--img').forEach((img) => {
      img.addEventListener('error', function onImgErr() {
        let rest = [];
        try {
          const enc = this.getAttribute('data-fav-rest');
          if (enc) rest = JSON.parse(decodeURIComponent(enc));
        } catch {
          rest = [];
        }
        if (Array.isArray(rest) && rest.length > 0) {
          const [next, ...more] = rest;
          this.setAttribute('data-fav-rest', more.length ? encodeURIComponent(JSON.stringify(more)) : '');
          this.src = next;
          return;
        }
        this.classList.add('is-hidden');
      });
    });
  }

  /** Same host + same page title → one row (different paths); keeps best-scoring URL. */
  _hostTitleCollapseKey(item) {
    let host = '';
    try {
      host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
    if (!host) return null;
    const title = String(item.title || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (!title) return null;
    return `${host}\n${title}`;
  }

  _collapseOmniboxSameHostTitle(items, ql) {
    const keyToList = new Map();
    const noKey = [];
    for (const it of items) {
      const k = this._hostTitleCollapseKey(it);
      if (k == null) {
        noKey.push(it);
        continue;
      }
      if (!keyToList.has(k)) keyToList.set(k, []);
      keyToList.get(k).push(it);
    }
    const pickBest = (arr) => {
      if (arr.length === 1) return arr[0];
      return arr.reduce((best, it) => {
        const db = this._scoreOmniboxItem(best, ql);
        const di = this._scoreOmniboxItem(it, ql);
        if (di !== db) return di > db ? it : best;
        const vb = best.visitCount || 0;
        const vi = it.visitCount || 0;
        if (vi !== vb) return vi > vb ? it : best;
        const ab = best.visitedAt || 0;
        const ai = it.visitedAt || 0;
        if (ai !== ab) return ai > ab ? it : best;
        return String(it.url).length < String(best.url).length ? it : best;
      });
    };
    const out = [...noKey];
    for (const arr of keyToList.values()) {
      out.push(arr.length === 1 ? arr[0] : pickBest(arr));
    }
    return out;
  }

  _scoreOmniboxItem(item, ql) {
    const q = (ql || '').trim().toLowerCase();
    let score = 0;
    if (item.badge === 'bookmark') score += 520;
    if (item.badge === 'search') score -= 280;

    try {
      const hostLower = new URL(item.url).hostname.toLowerCase();
      const isLocal =
        hostLower === 'localhost' ||
        hostLower.endsWith('.localhost') ||
        /^127\./.test(hostLower) ||
        hostLower === '[::1]';
      if (
        isLocal &&
        q &&
        !/\b(local|localhost|127\.|::1|lan|dev)\b/i.test(q) &&
        !/:\d{2,5}\b/.test(q)
      ) {
        score -= 170;
      }
    } catch {
      /* ignore */
    }

    if (q) {
      const title = String(item.title || '').toLowerCase();
      const urlStr = String(item.url || '').toLowerCase();
      if (title.startsWith(q)) score += 220;
      else if (title.includes(q)) score += 130 - Math.min(85, Math.max(0, title.indexOf(q)));
      if (urlStr.includes(q)) score += 110 - Math.min(75, Math.max(0, urlStr.indexOf(q)));
      try {
        const h = new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
        const parts = h.split('.');
        if (parts.some((p) => p.startsWith(q))) score += 95;
      } catch {
        /* ignore */
      }
    }

    const vc = item.visitCount || 0;
    score += Math.min(220, vc * 16);
    const va = item.visitedAt || 0;
    score += va / 86400000000;

    return score;
  }

  _sortUrlSuggestionItems(items, ql) {
    return [...items].sort((a, b) => {
      const da = this._scoreOmniboxItem(a, ql);
      const db = this._scoreOmniboxItem(b, ql);
      if (db !== da) return db - da;
      return String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' });
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
        const ql = q.toLowerCase();
        const { entries = [] } = await window.navio.historySearch(q, 100);
        if (window.navio.bookmarksGet) {
          const bdata = await window.navio.bookmarksGet();
          const flat = this._flattenBookmarksForOmnibox(bdata);
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

        // Live search-engine suggestions — skip only for obvious URL/host typing
        if (!this._looksLikeTypedUrlForSearchSkip(q) && window.navio.searchSuggestions) {
          try {
            const searchEngine = this.config?.searchEngine || 'https://www.google.com/search?q=';
            const liveSuggestions = await Promise.race([
              window.navio.searchSuggestions(q, searchEngine),
              new Promise(r => setTimeout(() => r([]), 1500))
            ]);
            for (const suggestion of (liveSuggestions || [])) {
              const url = searchEngine + encodeURIComponent(suggestion);
              add({ url, title: suggestion, badge: 'search', favicon: '' });
            }
          } catch {
            // Network error — silently skip
          }
        }

        return this._sortUrlSuggestionItems(this._collapseOmniboxSameHostTitle(out, ql), ql).slice(0, 14);
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
      return this._sortUrlSuggestionItems(this._collapseOmniboxSameHostTitle(out, ''), '').slice(0, 14);
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
      if (b === 'search') return 'Search';
      return 'Recent';
    };
    const badgeClass = (b) => {
      if (b === 'bookmark') return 'url-suggestion-badge url-suggestion-badge--bookmark';
      if (b === 'frequent') return 'url-suggestion-badge url-suggestion-badge--frequent';
      if (b === 'search') return 'url-suggestion-badge url-suggestion-badge--search';
      return 'url-suggestion-badge url-suggestion-badge--recent';
    };
    const bookmarkIcon =
      '<svg class="url-suggestion-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    const badgeHtml = (b) => {
      if (b === 'bookmark') {
        return `<span class="${badgeClass(b)}" aria-label="Saved bookmark">${bookmarkIcon}</span>`;
      }
      return `<span class="${badgeClass(b)}">${esc(badgeLabel(b))}</span>`;
    };
    list.innerHTML = items
      .map((it, i) => {
        let host = '';
        try {
          host = new URL(it.url).hostname.replace(/^www\./, '');
        } catch {
          host = it.url;
        }
        const isSearch = it.badge === 'search';
        const fav = isSearch
          ? `<span class="url-suggestion-fav url-suggestion-fav--search" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>`
          : this._suggestionIconHtml(it.url, it.favicon);
        const subtitle = isSearch ? 'Search' : esc(host);
        return `<button type="button" class="url-suggestion-row" role="option" data-i="${i}" aria-selected="false">
${fav}<span class="url-suggestion-body"><span class="url-suggestion-title">${esc(it.title)}</span><span class="url-suggestion-url">${subtitle}</span></span>
${badgeHtml(it.badge)}
</button>`;
      })
      .join('');
    this._wireUrlSuggestionImgFallbacks(list);
    this._layoutUrlSuggestionsLayer(list);
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

    window.addEventListener(
      'resize',
      () => {
        const list = this._urlSuggest.listEl;
        if (list && !list.hidden && list.parentElement === document.body) {
          this._layoutUrlSuggestionsLayer(list);
        }
      },
      { passive: true }
    );

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
      if (raw) {
        void this.openAssistantInTab(raw, { allowEmpty: false });
        urlInput.value = '';
        urlInput.blur();
        aiHint.classList.remove('visible');
      }
    });

    document.getElementById('btn-toolbar-workflows')?.addEventListener('click', () => {
      if (typeof CommandPalette !== 'undefined') CommandPalette.openWorkflowPicker();
    });

    const chatAiBtn = document.getElementById('btn-chat-with-ai');
    chatAiBtn?.addEventListener('click', () => {
      const raw = urlInput.value.trim();
      // If the URL bar just shows the current page URL (not a user-typed query),
      // don't pass it as the initial AI message — the AI already knows the page context.
      const activeTabUrl = typeof TabManager !== 'undefined' ? (TabManager.getActiveTab?.()?.url || '') : '';
      const isCurrentPageUrl = raw && activeTabUrl &&
        (raw === activeTabUrl || raw === activeTabUrl.replace(/\/$/, '') ||
         activeTabUrl === raw || activeTabUrl.replace(/\/$/, '') === raw);
      const queryToSend = isCurrentPageUrl ? '' : raw;
      void this.openAssistantInTab(queryToSend, { allowEmpty: true });
      if (queryToSend) {
        urlInput.value = '';
        if (aiHint) aiHint.classList.remove('visible');
      }
      urlInput.blur();
      this._hideUrlSuggestions();
    });

    const popupBlockedBtn = document.getElementById('url-popup-blocked');
    if (popupBlockedBtn && typeof window.navio.onPopupBlocked === 'function') {
      window.navio.onPopupBlocked((data) => {
        const openerUrl = data && data.openerUrl != null ? String(data.openerUrl) : '';
        let origin = data && data.openerOrigin != null ? String(data.openerOrigin).trim() : '';
        if (!origin) origin = _navioHttpOriginFromUrl(openerUrl);
        if (data && Number.isFinite(Number(data.openerWebContentsId))) {
          popupBlockedBtn.dataset.wcId = String(Number(data.openerWebContentsId));
        } else {
          delete popupBlockedBtn.dataset.wcId;
        }
        if (openerUrl) popupBlockedBtn.dataset.openerUrl = openerUrl;
        else delete popupBlockedBtn.dataset.openerUrl;
        if (origin) popupBlockedBtn.dataset.origin = origin;
        else delete popupBlockedBtn.dataset.origin;
        popupBlockedBtn.hidden = false;
        const tip = data && data.blockedUrl ? String(data.blockedUrl).slice(0, 72) : '';
        _showAppToast(tip ? `Pop-up blocked: ${tip}` : 'Pop-up blocked', 'warning');
      });
      popupBlockedBtn.addEventListener('click', async () => {
        const rawOrigin = (popupBlockedBtn.dataset.origin && String(popupBlockedBtn.dataset.origin).trim()) || '';
        const fromPage = _navioHttpOriginFromUrl(popupBlockedBtn.dataset.openerUrl || '');
        const o = rawOrigin || fromPage;
        if (!o || typeof window.navio.sitePopupsSet !== 'function') {
          _showAppToast('Could not determine this page’s site — navigate to an https page and try again.', 'warning');
          return;
        }
        const wcId = popupBlockedBtn.dataset.wcId;
        try {
          const r = await window.navio.sitePopupsSet(o, true);
          if (r && r.ok) {
            popupBlockedBtn.hidden = true;
            delete popupBlockedBtn.dataset.origin;
            delete popupBlockedBtn.dataset.openerUrl;
            delete popupBlockedBtn.dataset.wcId;
            _showAppToast('Pop-ups allowed — reloading tab', 'success');
            if (!_navioReloadTabByGuestWebContentsId(wcId)) {
              try {
                const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
                if (tab && tab.webview && typeof tab.webview.reload === 'function') tab.webview.reload();
              } catch {
                /* ignore */
              }
            }
          } else {
            _showAppToast('Could not save site permission', 'error');
          }
        } catch {
          _showAppToast('Could not save site permission', 'error');
        }
      });
    }

    // Popup window AI takeover — when a carrier/enterprise portal popup opens, offer
    // AI assistance via the sidebar.  The main process sends 'navio-popup-window' with
    // type 'opened' / 'closed' and the popup's webContentsId for CDP targeting.
    if (typeof window.navio.onPopupWindow === 'function') {
      // Track the most recently opened popup so the AI can target it.
      window._navioActivePopupWebContentsId = null;
      window._navioActivePopupId = null;

      window.navio.onPopupWindow((data) => {
        if (!data || !data.type) return;
        if (data.type === 'opened') {
          window._navioActivePopupWebContentsId = data.webContentsId || null;
          window._navioActivePopupId = data.popupId != null ? data.popupId : null;
          const title = (data.title || data.url || 'popup').slice(0, 60);
          // Show a toast with an "Ask AI" button so the user can quickly get help.
          _showAppToastWithAction(
            `Popup opened: ${title}`,
            'Ask AI',
            () => {
              try {
                if (typeof AssistantManager !== 'undefined') {
                  AssistantManager.open();
                  const inp = document.getElementById('assistant-input');
                  if (inp) {
                    const popupUrl = data.url || '';
                    inp.value = `Help me with the popup window that just opened${popupUrl ? ` (${popupUrl})` : ''}: `;
                    inp.focus();
                    inp.selectionStart = inp.selectionEnd = inp.value.length;
                    inp.dispatchEvent(new Event('input'));
                  }
                }
              } catch { /* ignore */ }
            }
          );
        } else if (data.type === 'closed') {
          if (window._navioActivePopupId === data.popupId) {
            window._navioActivePopupWebContentsId = null;
            window._navioActivePopupId = null;
          }
        }
      });
    }

    // Per-site Compatibility Mode badge — click to disable + reload.
    const compatBadge = document.getElementById('url-site-compat-badge');
    if (compatBadge && typeof window.navio.siteCompatSet === 'function') {
      compatBadge.addEventListener('click', async () => {
        const url = compatBadge.dataset.url || '';
        if (!url) return;
        try {
          const r = await window.navio.siteCompatSet(url, false);
          if (r && r.ok) {
            compatBadge.hidden = true;
            delete compatBadge.dataset.url;
            _showAppToast('Compatibility Mode turned off — reloading page', 'success');
            try {
              const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
              if (tab && tab.webview && typeof tab.webview.reload === 'function') tab.webview.reload();
            } catch { /* ignore */ }
          } else {
            _showAppToast('Could not change Compatibility Mode', 'error');
          }
        } catch {
          _showAppToast('Could not change Compatibility Mode', 'error');
        }
      });
    }
    if (typeof window.navio.onSiteCompatChanged === 'function') {
      window.navio.onSiteCompatChanged((data) => {
        try {
          const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
          const activeUrl = (tab && tab.url) || (urlInput && urlInput.value) || '';
          // Re-render the URL bar so the badge reflects the new state.
          this.updateUrlBar(activeUrl);
          if (data && data.enabled === true) {
            _showAppToast('Compatibility Mode enabled for this site', 'success');
          }
        } catch { /* ignore */ }
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
          urlInput.value = '';
          urlInput.blur();
          void this.openAssistantInTab(raw, { allowEmpty: false });
          return;
        }
        // Explicit AI prefix (avoid leading ? — same key as typing questions)
        if (/^ai:\s*/i.test(raw)) {
          const q = raw.replace(/^ai:\s*/i, '').trim();
          urlInput.value = '';
          urlInput.blur();
          void this.openAssistantInTab(q, { allowEmpty: true });
          return;
        }
        // Auto-detect AI question (unless Shift held = force web search)
        if (!e.shiftKey && this._isAIQuery(raw)) {
          void this.openAssistantInTab(raw, { allowEmpty: false });
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
      const rawFocus = urlInput.value.trim();
      if (aiHint) {
        const showHint = rawFocus.length > 3 && !rawFocus.startsWith('http') && this._isAIQuery(rawFocus);
        aiHint.classList.toggle('visible', showHint);
        if (showHint) this._hideUrlSuggestions();
      }
      clearTimeout(this._urlSuggest.debounce);
      this._hideUrlSuggestions();
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

    const showHistoryMenu = async (btn, direction) => {
      if (!window.navio || typeof window.navio.webviewGetNavHistory !== 'function') return;
      const wv = TabManager.getActiveWebview();
      if (!wv) return;
      let wcId;
      try { wcId = wv.getWebContentsId(); } catch (_) { return; }
      if (wcId == null) return;
      try {
        const r = await window.navio.webviewGetNavHistory(wcId, direction, 15);
        if (!r || !r.ok || !Array.isArray(r.entries) || r.entries.length === 0) return;
        this._openNavHistoryMenu(btn, wcId, r.entries);
      } catch (_) {
        /* ignore */
      }
    };

    const bindHistoryAffordance = (btn, direction) => {
      if (!btn) return;
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        void showHistoryMenu(btn, direction);
      });
      let holdTimer = null;
      btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
          holdTimer = null;
          void showHistoryMenu(btn, direction);
        }, 320);
      });
      const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
      btn.addEventListener('mouseup', clearHold);
      btn.addEventListener('mouseleave', clearHold);
    };
    bindHistoryAffordance(btnBack, 'back');
    bindHistoryAffordance(btnForward, 'forward');
  }

  _openNavHistoryMenu(anchor, webContentsId, entries) {
    this._closeNavHistoryMenu();
    // Full-window hit target: mousedown inside <webview> never reaches this document,
    // so a transparent backdrop (host DOM) is required to dismiss when clicking the page.
    const backdrop = document.createElement('div');
    backdrop.className = 'nav-history-menu-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const closeMenu = () => this._closeNavHistoryMenu();
    backdrop.addEventListener(
      'pointerdown',
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
      },
      true
    );
    document.body.appendChild(backdrop);

    const menu = document.createElement('div');
    menu.className = 'nav-history-menu';
    menu.setAttribute('role', 'menu');
    entries.forEach((entry) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nhm-item';
      let icon;
      try {
        const u = new URL(entry.url);
        icon = document.createElement('img');
        icon.className = 'nhm-icon';
        icon.alt = '';
        icon.referrerPolicy = 'no-referrer';
        icon.src = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(u.hostname)}`;
        icon.addEventListener('error', () => {
          const fb = document.createElement('span');
          fb.className = 'nhm-icon-fallback';
          icon.replaceWith(fb);
        }, { once: true });
      } catch (_) {
        icon = document.createElement('span');
        icon.className = 'nhm-icon-fallback';
      }
      const title = document.createElement('span');
      title.className = 'nhm-title';
      title.textContent = entry.title || entry.url;
      row.appendChild(icon);
      row.appendChild(title);
      row.addEventListener('click', async () => {
        this._closeNavHistoryMenu();
        try {
          await window.navio.webviewGotoNavIndex(webContentsId, entry.index);
        } catch (_) { /* ignore */ }
      });
      menu.appendChild(row);
    });

    document.body.appendChild(menu);
    try {
      window.navioEnsureShellOnTopIfWcv?.();
    } catch {
      /* ignore */
    }
    const rect = anchor.getBoundingClientRect();
    const mw = Math.min(360, menu.offsetWidth || 280);
    let left = rect.left;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${rect.bottom + 4}px`;

    const offKey = (ev) => {
      if (ev.key === 'Escape') this._closeNavHistoryMenu();
    };
    window.addEventListener('keydown', offKey, true);
    this._navHistoryMenu = { el: menu, backdrop, offKey };
  }

  _closeNavHistoryMenu() {
    const m = this._navHistoryMenu;
    if (!m) return;
    try { m.backdrop?.remove(); } catch (_) { /* ignore */ }
    try { m.el.remove(); } catch (_) { /* ignore */ }
    if (m.offKey) window.removeEventListener('keydown', m.offKey, true);
    this._navHistoryMenu = null;
  }

  resolveNavigationInput(raw) {
    const input = (raw || '').trim();
    if (!input) return null;

    if (/^about:blank$/i.test(input)) return 'about:blank';
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
    if (typeof TabManager.navigateFromShellLink === 'function') {
      TabManager.navigateFromShellLink(url);
      return;
    }
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
        switchTo: opts.background !== true,
        /** Only set from main for guest window.open — used to auto-close download-only tabs. */
        guestWindowOpen: !!opts.guestWindowOpen
      };
      if (!u) {
        TabManager.createTab(null, tabOpts);
        return;
      }
      const resolved = this.resolveNavigationInput(u);
      if (!resolved) return;
      if (!/^(https?:\/\/|file:\/\/|about:blank$)/i.test(resolved)) {
        _showAppToast('Blocked unsupported popup URL protocol.', 'warning');
        return;
      }
      TabManager.createTab(resolved, tabOpts);
    });

    if (typeof window.navio.onCloseDownloadShellTab === 'function') {
      window.navio.onCloseDownloadShellTab((data) => {
        if (typeof TabManager === 'undefined') return;
        const webContentsId = data && data.webContentsId;
        const id = Number(webContentsId);
        if (!Number.isFinite(id)) return;
        const tab = TabManager.tabs.find((t) => {
          try {
            return (
              t.webview &&
              typeof t.webview.getWebContentsId === 'function' &&
              t.webview.getWebContentsId() === id
            );
          } catch {
            return false;
          }
        });
        if (tab) TabManager.closeTab(tab.id);
      });
    }

    // ── Download toasts ───────────────────────────────────────────────────
    const _showAppToast = (msg, type = 'info') => {
      const stack = document.getElementById('live-notif-stack');
      if (!stack) return;
      const icons = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' };
      const id = Date.now();
      const el = document.createElement('div');
      el.className = `live-notification live-toast live-toast-${type}`;
      el.id = `app-toast-${id}`;
      // Use DOM APIs (textContent) instead of innerHTML so that user-controlled
      // strings like hostnames, filenames, or error messages cannot break out
      // of their span and inject script/markup.
      const iconEl = document.createElement('span');
      iconEl.className = 'live-toast-icon';
      iconEl.textContent = icons[type] || '•';
      const msgEl = document.createElement('span');
      msgEl.className = 'live-toast-msg';
      msgEl.textContent = String(msg == null ? '' : msg);
      const x = document.createElement('button');
      x.className = 'live-notif-x';
      x.textContent = '×';
      x.addEventListener('click', () => el.remove());
      el.appendChild(iconEl);
      el.appendChild(msgEl);
      el.appendChild(x);
      stack.prepend(el);
      setTimeout(() => el.remove(), 5000);
    };

    // Download start/done/progress UI is owned by the Chrome-style download
    // shelf + toolbar drawer in ui-shell-extras.js. Keeping a second
    // toast here caused two overlapping UIs at the bottom-right (toast at
    // z-index 9999 hovering over the shelf at 6500), which made the shelf's
    // "Show in folder" button effectively unclickable. Removed on purpose.

    // ── Certificate warning toasts ────────────────────────────────────────
    window.navio.onCertificateWarning(({ hostname }) => {
      _showAppToast('You proceeded on an untrusted certificate (' + hostname + ')', 'warning');
    });

    const shortcutDedupeMs = 120;
    const shortcutDedupeAt = {
      'new-tab': 0,
      'new-private-tab': 0,
      'close-tab': 0,
      'focus-url': 0,
      'reopen-last-tab': 0,
      reload: 0,
      'hard-reload': 0,
      'go-back': 0,
      'go-forward': 0,
      'next-tab': 0,
      'prev-tab': 0
    };
    const runDedupedShortcut = (id, fn) => {
      const now = Date.now();
      if (now - (shortcutDedupeAt[id] || 0) < shortcutDedupeMs) return;
      shortcutDedupeAt[id] = now;
      fn();
    };

    /** Guest <webview> forwards zoom keys via IPC — same behavior as shell keydown in ui-shell-extras. */
    let _lastNavioZoomApplyAt = 0;
    const applyNavioZoomShortcut = (kind) => {
      const now = Date.now();
      // Guest before-input + globalShortcut can both fire; avoid double-step zoom.
      if (now - _lastNavioZoomApplyAt < 100) return;
      _lastNavioZoomApplyAt = now;
      if (typeof TabManager === 'undefined') return;
      const ntp = document.getElementById('new-tab-page');
      const ntpActive = !!(ntp && ntp.classList.contains('active'));
      const step = 0.1;
      if (ntpActive && typeof window.__navioGetNtpZoom === 'function' && typeof window.__navioSetNtpZoom === 'function') {
        const cur = window.__navioGetNtpZoom();
        if (kind === 'reset') window.__navioSetNtpZoom(1);
        else if (kind === 'in') window.__navioSetNtpZoom(cur + step);
        else window.__navioSetNtpZoom(cur - step);
        if (typeof window.__navioFlashZoomPopup === 'function') window.__navioFlashZoomPopup();
        return;
      }
      if (kind === 'reset') TabManager.setActiveTabZoomFactor(null);
      else if (kind === 'in') TabManager.zoomActiveTabBy(0.1);
      else TabManager.zoomActiveTabBy(-0.1);
      if (typeof window.__navioFlashZoomPopup === 'function') window.__navioFlashZoomPopup();
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
          runDedupedShortcut('reopen-last-tab', () => TabManager.reopenLastClosedTab());
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
        case 'open-settings':
          runDedupedShortcut('open-settings', () => {
            if (typeof SettingsManager !== 'undefined' && typeof SettingsManager.open === 'function') {
              SettingsManager.open();
            }
          });
          break;
        case 'downloads-panel':
          window.__navioToggleDownloadsDrawer?.();
          break;
        case 'tab-search': {
          const overlay = document.getElementById('tab-search-overlay');
          const input = document.getElementById('tab-search-input');
          if (overlay && input) {
            overlay.hidden = false;
            try {
              window.navioEnsureShellOnTopIfWcv?.();
            } catch {
              /* ignore */
            }
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
          runDedupedShortcut('toggle-assistant', () => {
            if (typeof AssistantManager !== 'undefined' && typeof AssistantManager.toggle === 'function') {
              AssistantManager.toggle();
            }
          });
          break;
        case 'zoom-in':
          applyNavioZoomShortcut('in');
          break;
        case 'zoom-out':
          applyNavioZoomShortcut('out');
          break;
        case 'zoom-reset':
          applyNavioZoomShortcut('reset');
          break;
        case 'refresh-zoom-label':
          try {
            if (typeof window.__navioUpdateZoomLabel === 'function') window.__navioUpdateZoomLabel();
          } catch { /* ignore */ }
          break;
        case 'find-in-page':
          try {
            if (typeof window.__navioOpenFindInPage === 'function') {
              window.__navioOpenFindInPage();
            }
          } catch {
            /* ignore */
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
          runDedupedShortcut('reload', () => TabManager.reloadActive(false));
          break;
        case 'hard-reload':
          runDedupedShortcut('hard-reload', () => TabManager.reloadActive(true));
          break;
        case 'go-back': {
          runDedupedShortcut('go-back', () => {
            const wvb = TabManager.getActiveWebview();
            if (wvb && TabManager.webviewCanGoBack(wvb)) wvb.goBack();
          });
          break;
        }
        case 'go-forward': {
          runDedupedShortcut('go-forward', () => {
            const wvf = TabManager.getActiveWebview();
            if (wvf && TabManager.webviewCanGoForward(wvf)) wvf.goForward();
          });
          break;
        }
        case 'next-tab':
          runDedupedShortcut('next-tab', () => TabManager.switchToAdjacentTab(1));
          break;
        case 'prev-tab':
          runDedupedShortcut('prev-tab', () => TabManager.switchToAdjacentTab(-1));
          break;
        default:
          if (/^tab-[1-9]$/.test(action)) {
            runDedupedShortcut(action, () =>
              TabManager.switchToTabOrdinal(parseInt(action.slice(4), 10))
            );
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
        if (e.shiftKey) runDedupedShortcut('prev-tab', () => TabManager.switchToAdjacentTab(-1));
        else runDedupedShortcut('next-tab', () => TabManager.switchToAdjacentTab(1));
        return;
      }

      if (!e.shiftKey && (e.key === 'PageDown' || e.code === 'PageDown')) {
        e.preventDefault();
        runDedupedShortcut('next-tab', () => TabManager.switchToAdjacentTab(1));
        return;
      }
      if (!e.shiftKey && (e.key === 'PageUp' || e.code === 'PageUp')) {
        e.preventDefault();
        runDedupedShortcut('prev-tab', () => TabManager.switchToAdjacentTab(-1));
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
        runDedupedShortcut('reopen-last-tab', () => TabManager.reopenLastClosedTab());
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
        const id = e.shiftKey ? 'hard-reload' : 'reload';
        runDedupedShortcut(id, () => TabManager.reloadActive(!!e.shiftKey));
      }
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const action = `tab-${e.key}`;
        runDedupedShortcut(action, () => TabManager.switchToTabOrdinal(parseInt(e.key, 10)));
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
      if ((e.key === ',' || e.code === 'Comma') && !e.shiftKey) {
        e.preventDefault();
        runDedupedShortcut('open-settings', () => {
          if (typeof SettingsManager !== 'undefined' && typeof SettingsManager.open === 'function') {
            SettingsManager.open();
          }
        });
      }
      if (k === 'o' && e.shiftKey) {
        e.preventDefault();
        const overlay = document.getElementById('tab-search-overlay');
        const input = document.getElementById('tab-search-input');
        if (overlay && input) {
          overlay.hidden = false;
          try {
            window.navioEnsureShellOnTopIfWcv?.();
          } catch {
            /* ignore */
          }
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
      void this.openAssistantInTab(raw, { allowEmpty: false });
      return;
    }
    if (/^ai:\s*/i.test(raw)) {
      const q = raw.replace(/^ai:\s*/i, '').trim();
      void this.openAssistantInTab(q, { allowEmpty: true });
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
    // Keep "Pop-up blocked" visible until the user leaves that site or allows pop-ups.
    // Previously we cleared the chip on every navigation — it disappeared before you could click it.
    const popupChip = document.getElementById('url-popup-blocked');
    if (popupChip && (popupChip.dataset.origin || popupChip.dataset.openerUrl)) {
      const blockedOrigin = String(popupChip.dataset.origin || '').trim();
      const blockedPage = String(popupChip.dataset.openerUrl || '').trim();
      const blockedKey = blockedOrigin || _navioHttpOriginFromUrl(blockedPage);
      let currentOrigin = '';
      if (url && /^https?:\/\//i.test(url)) {
        try {
          currentOrigin = new URL(url).origin;
        } catch {
          /* ignore */
        }
      }
      const stillOnBlockedSite = currentOrigin && blockedKey && currentOrigin === blockedKey;
      if (!stillOnBlockedSite) {
        popupChip.hidden = true;
        delete popupChip.dataset.origin;
        delete popupChip.dataset.openerUrl;
        delete popupChip.dataset.wcId;
      }
    }
    const urlInput = document.getElementById('url-input');
    const sslIndicator = document.getElementById('url-ssl');
    const incog =
      typeof TabManager !== 'undefined' && TabManager.getActiveTab && !!TabManager.getActiveTab()?.incognito;
    const sslExtra = incog ? ' incognito-context' : '';

    // Per-site Compatibility Mode badge — updated asynchronously since it
    // requires a main-process round-trip. Hide eagerly to avoid stale state
    // flashing across tab switches.
    const compatBadge = document.getElementById('url-site-compat-badge');
    if (compatBadge) {
      compatBadge.hidden = true;
      delete compatBadge.dataset.url;
      if (url && /^https?:\/\//i.test(url) && typeof window.navio?.siteCompatGet === 'function') {
        window.navio.siteCompatGet(url).then((r) => {
          // Bail if the URL bar has navigated away while we awaited the IPC.
          if (!r || !r.ok || r.enabled !== true) return;
          if (urlInput && urlInput.value !== url) return;
          compatBadge.hidden = false;
          compatBadge.dataset.url = url;
        }).catch(() => { /* ignore — badge stays hidden */ });
      }
    }

    if (!url || url === 'about:blank') {
      urlInput.value = '';
      sslIndicator.className = 'url-ssl' + sslExtra;
      sslIndicator.title = incog ? 'Private tab' : '';
      if (typeof PasswordManager !== 'undefined') PasswordManager.updateKeyIcon('');
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

    if (!incog && typeof PasswordManager !== 'undefined') {
      PasswordManager.updateKeyIcon(url);
    } else if (typeof PasswordManager !== 'undefined') {
      PasswordManager.updateKeyIcon('');
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

// Module-level toast (used by ReadingListManager and PasswordManager).
// Uses DOM/textContent — callers often pass hostnames or titles which could
// otherwise contain HTML.
function _showAppToast(msg, type = 'info') {
  const stack = document.getElementById('live-notif-stack');
  if (!stack) return;
  const icons = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `live-notification live-toast live-toast-${type}`;
  const iconEl = document.createElement('span');
  iconEl.className = 'live-toast-icon';
  iconEl.textContent = icons[type] || '•';
  const msgEl = document.createElement('span');
  msgEl.className = 'live-toast-msg';
  msgEl.textContent = String(msg == null ? '' : msg);
  const x = document.createElement('button');
  x.className = 'live-notif-x';
  x.textContent = '×';
  x.addEventListener('click', () => el.remove());
  el.appendChild(iconEl);
  el.appendChild(msgEl);
  el.appendChild(x);
  stack.prepend(el);
  setTimeout(() => el.remove(), 5000);
}

function _showAppToastWithAction(msg, actionLabel, onAction, type = 'info') {
  const stack = document.getElementById('live-notif-stack');
  if (!stack) return;
  const icons = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `live-notification live-toast live-toast-${type}`;
  const iconEl = document.createElement('span');
  iconEl.className = 'live-toast-icon';
  iconEl.textContent = icons[type] || '•';
  const msgEl = document.createElement('span');
  msgEl.className = 'live-toast-msg';
  msgEl.textContent = String(msg == null ? '' : msg);
  const actionBtn = document.createElement('button');
  actionBtn.className = 'live-toast-action';
  actionBtn.textContent = String(actionLabel || 'Action');
  actionBtn.addEventListener('click', () => {
    try { onAction && onAction(); } catch { /* ignore */ }
    el.remove();
  });
  const x = document.createElement('button');
  x.className = 'live-notif-x';
  x.textContent = '×';
  x.addEventListener('click', () => el.remove());
  el.appendChild(iconEl);
  el.appendChild(msgEl);
  el.appendChild(actionBtn);
  el.appendChild(x);
  stack.prepend(el);
  setTimeout(() => el.remove(), 8000);
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
      el.innerHTML = '<p class="rl-empty">No saved pages yet.<br>Use the <strong>Read Later</strong> inbox button in the toolbar (next to zoom) to save the current page.</p>';
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
        if (url && typeof TabManager !== 'undefined') {
          if (typeof TabManager.navigateFromShellLink === 'function') TabManager.navigateFromShellLink(url);
          else TabManager.navigateActive(url);
        }
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
    try {
      window.navioEnsureShellOnTopIfWcv?.();
    } catch {
      /* ignore */
    }
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
    if (typeof TabManager === 'undefined') {
      _showAppToast('Browser is still starting — try again in a moment.', 'warning');
      return;
    }
    const tab = TabManager.getActiveTab();
    const url = tab?.url ? String(tab.url).trim() : '';
    const isHttp =
      url &&
      url !== 'about:blank' &&
      /^https?:\/\//i.test(url) &&
      !(typeof TabManager.isNavioChatTabUrl === 'function' && TabManager.isNavioChatTabUrl(url));

    // Home / NTP leaves `tab.url` empty — still open the list so the click clearly does something.
    if (!isHttp) {
      open();
      await refresh();
      if (!url || url === 'about:blank') {
        _showAppToast('Open a website to add it to Read Later.', 'info');
      } else if (typeof TabManager.isNavioChatTabUrl === 'function' && TabManager.isNavioChatTabUrl(url)) {
        _showAppToast('Switch to a normal web tab to save it for later.', 'info');
      } else {
        _showAppToast('Only http(s) pages can be saved for later.', 'info');
      }
      return;
    }

    const r = await window.navio.readingListAdd(
      url,
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
  let _autofillEntries = null;
  let _lastAutofillUrl = '';
  const _STREMIO_SILENT_ORIGINS = new Set([
    'https://web.stremio.com',
    'https://www.stremio.com',
    'https://app.stremio.com'
  ]);
  let _stremioSilentTimers = [];

  const saveBar       = document.getElementById('pwd-save-bar');
  const autofillBar   = document.getElementById('pwd-autofill-bar');
  const saveUserInput = document.getElementById('pwd-save-user');
  const autofillUser  = document.getElementById('pwd-autofill-user');
  const autofillAcct  = document.getElementById('pwd-autofill-account');
  const urlPwdKey     = document.getElementById('url-pwd-key');

  function _urlOriginStr(url) {
    try { return new URL(url).origin; } catch { return ''; }
  }

  function _isStremioSilentAutofillUrl(url) {
    return _STREMIO_SILENT_ORIGINS.has(_urlOriginStr(url));
  }

  function _clearStremioSilentTimers() {
    for (const t of _stremioSilentTimers) clearTimeout(t);
    _stremioSilentTimers = [];
  }

  function _silentStremioAutofill(wv, entry) {
    _clearStremioSilentTimers();
    const fire = () => {
      try {
        wv.send('navio-autofill', {
          username: entry.username,
          password: entry.password,
          autoSubmit: true
        });
      } catch {}
    };
    fire();
    _stremioSilentTimers.push(setTimeout(fire, 450));
    _stremioSilentTimers.push(setTimeout(fire, 1400));
    _stremioSilentTimers.push(setTimeout(fire, 3200));
  }

  function _originLabel(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  function _hideSave() {
    if (saveBar) saveBar.hidden = true;
    _pendingSave = null;
    const saveBtn = document.getElementById('pwd-save-btn');
    if (saveBtn) saveBtn.textContent = 'Save';
    if (saveUserInput) saveUserInput.value = '';
  }

  function _hideAutofill() {
    if (autofillBar) autofillBar.hidden = true;
    _autofillWv = null;
    _autofillPwd = null;
    _autofillEntries = null;
    if (autofillAcct) {
      autofillAcct.hidden = true;
      autofillAcct.replaceChildren();
    }
    if (autofillUser) autofillUser.hidden = false;
  }

  function _doAutofill() {
    if (_autofillWv && _autofillPwd) {
      try {
        _autofillWv.send('navio-autofill', {
          username: _autofillPwd.username,
          password: _autofillPwd.password,
        });
        _showAppToast(`Credentials filled for ${_originLabel(_lastAutofillUrl)}`, 'success');
      } catch {}
    }
    _hideAutofill();
  }

  // ── Update the key icon in the URL bar ──────────────────────────────────
  async function updateKeyIcon(url) {
    if (!urlPwdKey) return;
    if (!url || _isStremioSilentAutofillUrl(url)) {
      urlPwdKey.hidden = true;
      urlPwdKey.classList.remove('has-credentials');
      return;
    }
    try {
      const r = await window.navio.passwordsGet(url);
      if (r.ok && r.entries && r.entries.length) {
        urlPwdKey.hidden = false;
        urlPwdKey.classList.add('has-credentials');
        urlPwdKey.title = `Fill saved password for ${_originLabel(url)} (Ctrl+Shift+L)`;
      } else {
        urlPwdKey.hidden = true;
        urlPwdKey.classList.remove('has-credentials');
      }
    } catch {
      urlPwdKey.hidden = true;
      urlPwdKey.classList.remove('has-credentials');
    }
  }

  // ── Show "Save password?" / "Replace password?" after submit ─────────────
  async function showSavePrompt({ username, password, url }, wv) {
    _hideAutofill();
    if (!saveBar) return;
    if (!String(password || '').trim()) return;
    if (_isStremioSilentAutofillUrl(url)) {
      try {
        const r = await window.navio.passwordsGet(url);
        if (r.ok && r.entries && r.entries.some((e) => e.hidden)) return;
      } catch {}
    }
    try {
      const nr = await window.navio.passwordsNeverCheck(url);
      if (nr && nr.never) return;
    } catch {}
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
    } catch {}
    _pendingSave = { username, password, url };
    if (saveUserInput) {
      saveUserInput.value = (username && String(username).trim()) ? username : '';
      if (!username || !String(username).trim()) {
        saveUserInput.placeholder = 'Enter username or email';
      } else {
        saveUserInput.placeholder = 'Username';
      }
    }
    const msgEl = saveBar.querySelector('.pwd-save-msg');
    if (msgEl) {
      const host = _originLabel(url);
      msgEl.textContent = '';
      const prefix = document.createTextNode(
        mode === 'update' ? 'Password changed for ' : 'Save password for '
      );
      const strong = document.createElement('strong');
      strong.id = 'pwd-save-site';
      strong.textContent = String(host || '');
      const suffix = document.createTextNode(
        mode === 'update' ? ' — replace saved password?' : '?'
      );
      msgEl.appendChild(prefix);
      msgEl.appendChild(strong);
      msgEl.appendChild(suffix);
    }
    const saveBtn = document.getElementById('pwd-save-btn');
    if (saveBtn) saveBtn.textContent = mode === 'update' ? 'Replace' : 'Save';
    saveBar.hidden = false;
    clearTimeout(saveBar._timer);
    saveBar._timer = setTimeout(_hideSave, 45000);
  }

  // ── Check if we have credentials for the current URL ──────────────────────
  async function checkAutofill(url, wv) {
    _hideSave();
    try {
      const r = await window.navio.passwordsGet(url);
      if (!r.ok || !r.entries.length) return;
      const entries = r.entries;
      const entry = entries[0];
      _lastAutofillUrl = url;
      if (_isStremioSilentAutofillUrl(url)) {
        _silentStremioAutofill(wv, entry);
        return;
      }

      updateKeyIcon(url);

      _autofillWv  = wv;
      _autofillEntries = entries;
      _autofillPwd = entry;

      if (entries.length === 1) {
        try {
          wv.send('navio-autofill', {
            username: entry.username,
            password: entry.password,
          });
          _showAppToast(`Credentials filled for ${_originLabel(url)}`, 'success');
        } catch {}
        return;
      }

      if (!autofillBar) return;
      if (entries.length > 1 && autofillAcct) {
        autofillAcct.replaceChildren();
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = (e.username && String(e.username).trim()) ? e.username : `Account ${i + 1}`;
          autofillAcct.appendChild(opt);
        }
        autofillAcct.selectedIndex = 0;
        autofillAcct.hidden = false;
        if (autofillUser) autofillUser.hidden = true;
      } else {
        if (autofillAcct) {
          autofillAcct.hidden = true;
          autofillAcct.replaceChildren();
        }
        if (autofillUser) {
          autofillUser.hidden = false;
          autofillUser.textContent = entry.username;
        }
      }
      autofillBar.hidden = false;
      clearTimeout(autofillBar._timer);
      autofillBar._timer = setTimeout(_hideAutofill, 60000);
    } catch {}
  }

  // ── Manual autofill trigger (key icon click or Ctrl+Shift+L) ─────────────
  async function triggerAutofill() {
    const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
    if (!tab || tab.incognito) return;
    const wv = tab.webview;
    const url = tab.url || (wv && typeof wv.getURL === 'function' ? wv.getURL() : '');
    if (!url) return;
    try {
      const r = await window.navio.passwordsGet(url);
      if (!r.ok || !r.entries.length) {
        _showAppToast('No saved passwords for this site', 'info');
        return;
      }
      const entries = r.entries;
      _autofillWv = wv;
      _autofillEntries = entries;
      _autofillPwd = entries[0];
      _lastAutofillUrl = url;

      if (entries.length === 1) {
        _doAutofill();
        return;
      }

      if (!autofillBar) return;
      autofillAcct.replaceChildren();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = (e.username && String(e.username).trim()) ? e.username : `Account ${i + 1}`;
        autofillAcct.appendChild(opt);
      }
      autofillAcct.selectedIndex = 0;
      autofillAcct.hidden = false;
      if (autofillUser) autofillUser.hidden = true;
      autofillBar.hidden = false;
      clearTimeout(autofillBar._timer);
      autofillBar._timer = setTimeout(_hideAutofill, 60000);
    } catch {}
  }

  // Wire up the bar buttons
  document.getElementById('pwd-save-btn')?.addEventListener('click', async () => {
    if (!_pendingSave) return;
    const editedUsername = saveUserInput ? saveUserInput.value.trim() : _pendingSave.username;
    const usernameToSave = editedUsername || _pendingSave.username;
    try {
      const r = await window.navio.passwordsSave(
        _pendingSave.url,
        usernameToSave,
        _pendingSave.password
      );
      if (r && r.ok) {
        _showAppToast(`Password saved for ${_originLabel(_pendingSave.url)}`, 'success');
        updateKeyIcon(_pendingSave.url);
      } else {
        _showAppToast((r && r.error) || 'Could not save password', 'error');
        return;
      }
    } catch (e) {
      _showAppToast(e && e.message ? e.message : 'Could not save password', 'error');
      return;
    }
    _hideSave();
  });

  document.getElementById('pwd-never-btn')?.addEventListener('click', async () => {
    if (_pendingSave && _pendingSave.url) {
      try {
        await window.navio.passwordsNeverAdd(_pendingSave.url);
        _showAppToast(`Won't ask to save passwords for ${_originLabel(_pendingSave.url)}`, 'info');
      } catch {}
    }
    _hideSave();
  });

  document.getElementById('pwd-dismiss-btn')?.addEventListener('click', _hideSave);

  document.getElementById('pwd-autofill-btn')?.addEventListener('click', _doAutofill);

  document.getElementById('pwd-autofill-dismiss')?.addEventListener('click', _hideAutofill);

  autofillAcct?.addEventListener('change', () => {
    if (!autofillAcct || _autofillEntries == null) return;
    const idx = parseInt(autofillAcct.value, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= _autofillEntries.length) return;
    _autofillPwd = _autofillEntries[idx];
  });

  // Key icon in URL bar
  urlPwdKey?.addEventListener('click', triggerAutofill);

  // Ctrl+Shift+L keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      triggerAutofill();
    }
  });

  return { showSavePrompt, checkAutofill, triggerAutofill, updateKeyIcon };
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
  /** Rich HTML from the last streamed card (for Replace into Gmail / contenteditable). */
  let _lastAiResultHtml = '';
  let _lastAction = '';

  const LABELS = {
    explain:    'Explanation',
    define:     'Definition',
    summarize:  'Summary',
    rewrite:    'Rewrite',
    translate:  'Translation',
    'fact-check': 'Fact-check',
  };

  const PROMPTS = {
    explain:      t => `Explain this text clearly and concisely in 2-4 sentences:\n\n"${t}"`,
    define:       t => `Define this term or phrase in 1-3 sentences. If it is a proper noun or concept, include key context:\n\n"${t}"`,
    summarize:    t => `Summarize this in 1-3 sentences:\n\n"${t}"`,
    rewrite:      t => `Rewrite this to be clearer and more professional:\n\n"${t}"`,
    translate:    t => `Translate this to English (if it is already English, improve the phrasing):\n\n"${t}"`,
    'fact-check': t => `Fact-check this claim. State clearly if it is TRUE, FALSE, MISLEADING, or UNVERIFIABLE, then explain why in 2-4 sentences:\n\n"${t}"`,
  };

  /** Hide incomplete `[FOLLOWUP]…` tails while the stream is still open. */
  function _stripOpenFollowup(text) {
    return String(text || '').replace(/\[FOLLOWUP\][\s\S]*/gi, '').trim();
  }

  /** Turn refinement UI anchors into plain text so email paste does not keep navio: links. */
  function _stripRefineAnchorsForPage(html) {
    const s = String(html || '').trim();
    if (!s) return '';
    try {
      const d = document.createElement('div');
      d.innerHTML = s;
      d.querySelectorAll('a.iai-refine-link').forEach((a) => {
        a.replaceWith(document.createTextNode(a.textContent || ''));
      });
      return d.innerHTML;
    } catch {
      return s;
    }
  }

  async function _writeClipboardForReplace(plain, html) {
    const p = String(plain || '').trim();
    const h = String(html || '').trim();
    if (h && typeof ClipboardItem !== 'undefined') {
      try {
        const plainBlob = new Blob([p || h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()], {
          type: 'text/plain',
        });
        const htmlBlob = new Blob([h], { type: 'text/html' });
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': plainBlob })]);
        return;
      } catch {
        /* fall through */
      }
    }
    if (p) await navigator.clipboard.writeText(p);
  }

  function _positionCardBelowToolbar() {
    const card = _card();
    const tb = _toolbar();
    if (!card || !tb) return;
    const tbRect = tb.getBoundingClientRect();
    const cardW = 360;
    const top = tbRect.bottom + 8;
    const left = Math.max(8, Math.min(tbRect.left, window.innerWidth - cardW - 8));
    const maxTop = window.innerHeight - 200;
    if (top > maxTop) {
      card.style.top = '';
      card.style.bottom = window.innerHeight - tbRect.top + 8 + 'px';
    } else {
      card.style.top = top + 'px';
      card.style.bottom = '';
    }
    card.style.left = left + 'px';
  }

  /**
   * Stream model output into the inline AI card (toolbar actions and follow-up refinements).
   * @param {string} userPrompt
   * @param {{ enableReplace?: boolean }} [opts]
   */
  async function _streamInlineUserPrompt(userPrompt, opts) {
    const enableReplace = !!(opts && opts.enableReplace);
    const card = _card();
    const body = _body();
    const label = _label();
    const repBtn = document.getElementById('iai-card-replace');
    if (!card || !body || !label) return;
    const up = String(userPrompt || '').trim();
    if (!up) return;

    if (repBtn) {
      repBtn.hidden = !enableReplace;
      repBtn.disabled = true;
    }

    _positionCardBelowToolbar();
    card.hidden = false;

    try {
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
        _renderInlineStreamBody(body, result);
      }));
      _unsubs.push(window.navio.onAiStreamDone((payload) => {
        const tid = payload && payload.tabId != null ? String(payload.tabId) : '__default__';
        if (tid !== omniTab) return;
        _cancelStream();
        if (repBtn && enableReplace) repBtn.disabled = !_lastAiResult.trim();
      }));
      _unsubs.push(window.navio.onAiStreamError((payload) => {
        const errObj = typeof payload === 'string' ? { tabId: '__default__', message: payload } : payload || {};
        const tid = errObj.tabId != null ? String(errObj.tabId) : '__default__';
        if (tid !== omniTab) return;
        const errText = errObj.message != null ? String(errObj.message) : String(payload || '');
        if (body) body.textContent = 'Error: ' + errText;
        _cancelStream();
        if (repBtn && enableReplace) repBtn.disabled = true;
      }));

      await window.navio.aiRequestStream({
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful writing assistant. Be concise. Use professional markdown when it helps: short ## headings, **bold** labels for variants, and bullet lists for options. Do not append [FOLLOWUP] blocks, JSON metadata, or machine-readable trailing tags. When you offer optional tone or length tweaks the user can click in the same panel, use markdown links with this exact URL scheme only (not https): for example [Make it firmer](navio:inline-refine) or [Shorter for email](navio:inline-refine). Those run in place; do not suggest opening a separate assistant.',
          },
          { role: 'user', content: up },
        ],
        tabId: omniTab,
      });
    } catch (err) {
      if (body) body.textContent = 'Error: ' + err.message;
    }
  }

  /** Follow-up chip in the inline card (e.g. "Make it firmer") — refine in place, do not open the sidebar assistant. */
  function _runFollowUpChipInline(chipLabel) {
    const instruction = String(chipLabel || '').trim();
    const prev = (_lastAiResult || '').trim();
    const draft = prev || (_text || '').trim();
    if (!instruction || !draft) return;
    _cancelStream();
    _lastAiResult = '';
    _lastAiResultHtml = '';
    const body = _body();
    const label = _label();
    if (body) body.textContent = '';
    if (_lastAction === 'rewrite' && label) label.textContent = LABELS.rewrite;
    const prompt =
      `Apply this refinement: "${instruction}"\n\n` +
      `Rewrite the following text accordingly. Return ONLY the revised text. Do not add a [FOLLOWUP] block.\n\n---\n${draft}\n---`;
    void _streamInlineUserPrompt(prompt, { enableReplace: _lastAction === 'rewrite' });
  }

  /**
   * Render streamed model text as markdown (same pipeline as the main assistant)
   * and surface follow-up chips instead of raw `[FOLLOWUP]{…}[/FOLLOWUP]` JSON.
   */
  function _renderInlineStreamBody(body, rawBuffer) {
    if (!body) return;
    const raw = String(rawBuffer || '');
    if (!raw.trim()) {
      body.textContent = '';
      _lastAiResult = '';
      _lastAiResultHtml = '';
      return;
    }
    const am = typeof AssistantManager !== 'undefined' ? AssistantManager : null;
    let clean = raw;
    let chips = [];
    if (am && typeof am._extractFollowUpChips === 'function') {
      const ex = am._extractFollowUpChips(raw);
      clean = _stripOpenFollowup(ex.clean);
      chips = Array.isArray(ex.chips) ? ex.chips : [];
    } else {
      clean = _stripOpenFollowup(raw.replace(/\[FOLLOWUP\][\s\S]*?\[\/FOLLOWUP\]/gi, ''));
    }
    body.innerHTML = '';
    const md = document.createElement('div');
    md.className = 'message-content';
    if (am && typeof am.formatMessage === 'function') {
      md.innerHTML = am.formatMessage(clean, false, { inlineRefineLinks: true });
    } else {
      md.textContent = clean;
    }
    body.appendChild(md);
    if (chips.length) {
      const wrap = document.createElement('div');
      wrap.className = 'navio-followup-chips iai-inline-followup';
      chips.forEach((raw) => {
        const norm =
          am && typeof am._normalizeFollowUpChipEntry === 'function'
            ? am._normalizeFollowUpChipEntry(raw)
            : typeof raw === 'string'
              ? { label: raw.trim(), url: null }
              : null;
        if (!norm || !norm.label) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'navio-followup-chip';
        btn.textContent = norm.label;
        if (norm.url) btn.title = norm.url;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (norm.url) {
            if (typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
              try {
                TabManager.createTab(norm.url);
              } catch {
                /* ignore */
              }
            }
            return;
          }
          _runFollowUpChipInline(norm.label);
        });
        wrap.appendChild(btn);
      });
      body.appendChild(wrap);
    }
    _lastAiResult = (md.innerText || '').replace(/\r\n/g, '\n').trim();
    _lastAiResultHtml = _stripRefineAnchorsForPage(md.innerHTML);
  }

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
    const wv = _targetWv;
    try {
      if (wv && typeof wv.send === 'function') wv.send('navio-inline-clear-bookmark');
    } catch {
      /* ignore */
    }
    _text = '';
    _targetWv = null;
    _lastAiResult = '';
    _lastAiResultHtml = '';
    _lastAction = '';
    const rep = document.getElementById('iai-card-replace');
    if (rep) { rep.hidden = true; }
  }

  async function _runAction(action) {
    if (!_text) return;
    _cancelStream();
    _lastAction = action;
    _lastAiResult = '';
    _lastAiResultHtml = '';

    const body  = _body();
    const label = _label();
    if (!body || !label) return;

    label.textContent = LABELS[action] || 'Result';
    body.textContent  = ''; // empty → spinner shows via CSS :empty

    const prompt = PROMPTS[action]?.(_text);
    if (!prompt) return;
    await _streamInlineUserPrompt(prompt, { enableReplace: action === 'rewrite' });
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
    } else if (action === 'ask-ai') {
      // Send selected text to the main assistant panel as a query
      const query = _text;
      hide();
      if (typeof AssistantManager !== 'undefined' && query) {
        AssistantManager.open();
        setTimeout(() => {
          const inp = document.getElementById('assistant-input');
          if (inp) {
            inp.value = query;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
          AssistantManager.sendMessage();
        }, 80);
      }
    } else if (action) {
      // Selection-bookmark install is now lazy (the guest preload no longer
      // wraps the DOM on every mouseup — that broke many sites). For actions
      // that may end with Replace, ask the guest to install the bookmark NOW
      // while the live selection is still focused (mousedown fires before the
      // focus shifts to the host shell).
      if (action === 'rewrite' && _targetWv && typeof _targetWv.send === 'function') {
        try { _targetWv.send('navio-inline-install-bookmark'); } catch { /* ignore */ }
      }
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
    const html = (_lastAiResultHtml || '').trim();
    try {
      const wcId = _targetWv.getWebContentsId();
      let r = await window.navio.replaceSelectionInPage({
        webContentsId: wcId,
        text,
        ...(html ? { html } : {}),
      });
      if (!r.ok) {
        await _writeClipboardForReplace(text, html);
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

  // In-body refinement links from formatMessage(..., { inlineRefineLinks: true }) — same behavior as follow-up chips.
  document.getElementById('iai-card-body')?.addEventListener(
    'click',
    (e) => {
      const a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a.iai-refine-link') : null;
      if (!a || !a.getAttribute('data-inline-refine')) return;
      e.preventDefault();
      e.stopPropagation();
      const instruction = (a.getAttribute('data-inline-refine') || '').trim();
      if (!instruction) return;
      _runFollowUpChipInline(instruction);
    },
    true
  );

  // Hide toolbar+card when clicking anywhere else in the main window
  document.addEventListener('mousedown', () => hide());

  return { show, hide };
})();

// ── Watch Page ─────────────────────────────────────────────────────────────
// Lets users set a natural-language watch condition for the current page.
// Navio will check the page on a schedule and notify when the condition is met.

const PageWatcher = (() => {
  const _overlay = () => document.getElementById('watch-page-overlay');
  let _currentUrl = '';
  let _currentTitle = '';

  function open(url, title) {
    const overlay = _overlay();
    if (!overlay) return;
    _currentUrl = url || '';
    _currentTitle = title || url || '';
    const lbl = document.getElementById('watch-page-url-label');
    if (lbl) lbl.textContent = _currentTitle.length > 80 ? _currentTitle.slice(0, 77) + '…' : _currentTitle;
    const input = document.getElementById('watch-condition-input');
    if (input) input.value = '';
    overlay.hidden = false;
    setTimeout(() => { if (input) input.focus(); }, 60);
  }

  function close() {
    const overlay = _overlay();
    if (overlay) overlay.hidden = true;
  }

  document.getElementById('btn-watch-page')?.addEventListener('click', () => {
    let url = '';
    let title = '';
    try {
      const activeTab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab?.() : null;
      if (activeTab && activeTab.webview) {
        url = (typeof activeTab.webview.getURL === 'function'
          ? activeTab.webview.getURL()
          : activeTab.url) || '';
        title = (typeof activeTab.webview.getTitle === 'function'
          ? activeTab.webview.getTitle()
          : activeTab.title) || url;
      } else {
        const activeWv = document.querySelector('.tab-content:not([hidden]) webview');
        if (activeWv) {
          url = activeWv.getURL?.() || '';
          title = activeWv.getTitle?.() || url;
        }
      }
    } catch { /* ignore */ }
    if (!url || url === 'about:blank') {
      return;
    }
    open(url, title);
  });

  document.getElementById('btn-watch-page-close')?.addEventListener('click', close);
  document.getElementById('btn-watch-page-cancel')?.addEventListener('click', close);
  document.getElementById('watch-page-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('btn-watch-page-save')?.addEventListener('click', async () => {
    const condition = (document.getElementById('watch-condition-input')?.value || '').trim();
    const interval = document.getElementById('watch-interval-select')?.value || 'daily';
    if (!condition) {
      const input = document.getElementById('watch-condition-input');
      if (input) { input.focus(); input.style.borderColor = 'var(--text-danger)'; setTimeout(() => { input.style.borderColor = ''; }, 1500); }
      return;
    }
    const btn = document.getElementById('btn-watch-page-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const prompt = `Check the page at ${_currentUrl} and determine if the following condition is met: "${condition}". If the condition IS met, start your reply with [WATCH-TRIGGERED] and describe what changed. If it is NOT met, start with [WATCH-PENDING] and briefly confirm what you observed.`;
      await window.navio.schedulerAdd({
        workflowName: `Watch: ${(_currentTitle || _currentUrl).slice(0, 50)}`,
        prompt,
        interval,
        meta: { watchUrl: _currentUrl, watchCondition: condition, watchTitle: _currentTitle }
      });
      close();
      if (typeof NavioToast !== 'undefined') {
        NavioToast.show(`Watching "${_currentTitle.slice(0, 40) || _currentUrl}"`, 'success');
      }
    } catch (e) {
      if (btn) btn.textContent = 'Error — try again';
      console.error('[navio] page-watch save error:', e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Start watching'; }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const el = _overlay();
    if (!el || el.hidden) return;
    close();
  });

  return { open, close };
})();

// ── Local Model Privacy Badge ──────────────────────────────────────────────
