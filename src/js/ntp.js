/**
 * Navio Browser — New Tab Page controller
 *
 * Dashboard features:
 *  • Greeting + live clock
 *  • Connected services status bar (IMAP email counts)
 *  • World News (Reddit r/worldnews — free, CORS-enabled JSON API)
 *  • Stock quotes (IPC) — cached for smart row / AI context
 *  • Inbox widget — unread emails from IMAP Gmail/Outlook
 *  • "Draft All" button — triggers batch email drafting
 */

const NTP = (() => {
  let _mode = 'search'; // 'search' | 'ai' | 'task'
  let _ntpVisible = false;
  let _newsHeadlines  = [];   // cached for AI brief
  let _stockData      = [];   // cached for AI brief
  let _inboxMessages  = [];   // cached from _loadInbox() for AI brief

  // ── NTP Chat state ────────────────────────────────────────────────────────
  let _ntpChatMessages  = [];   // current in-memory thread: [{role,content}]
  let _ntpChatStreaming  = false;
  let _ntpChatStreamUnsubs = []; // cleanup fns for stream listeners
  const _ntpChatStreamKey = 'ntp-chat-' + Date.now();
  const DEFAULT_NTP_SHORTCUTS = [
    { title: 'Google', url: 'https://www.google.com' },
    { title: 'Gmail', url: 'https://mail.google.com' },
    { title: 'Drive', url: 'https://drive.google.com' },
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'Live Sports', url: 'https://predicta-bet.vercel.app/' },
    { title: 'Movies & Shows', url: 'https://web.stremio.com/' }
  ];
  let _shortcuts = DEFAULT_NTP_SHORTCUTS.slice();
  let _shortcutDraft = null;
  let _shortcutEditorBound = false;
  let _shortcutDndBound = false;

  // Brand colours for popular sites — gradient background + hover glow
  const _SHORTCUT_BRANDS = {
    'google.com': {
      bg: 'linear-gradient(145deg,#ffffff 0%,#f1f3f4 100%)', glow: 'rgba(66,133,244,0.50)',
      svg: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <clipPath id="gg"><path d="M37 24.5H25v5.5h6.8C30.5 33.7 27.6 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l4-4C33 8.5 28.7 6.5 24 6.5 13.8 6.5 5.5 14.8 5.5 25S13.8 43.5 24 43.5c10.7 0 17-7.5 17-18 0-1-.1-2-.1-2L37 24.5z"/></clipPath>
        <rect x="0"  y="0"  width="48" height="24" fill="#4285F4" clip-path="url(#gg)"/>
        <rect x="0"  y="24" width="24" height="24" fill="#34A853" clip-path="url(#gg)"/>
        <rect x="24" y="24" width="24" height="24" fill="#FBBC05" clip-path="url(#gg)"/>
        <rect x="24" y="0"  width="24" height="24" fill="#EA4335" clip-path="url(#gg)"/>
      </svg>`
    },
    'mail.google.com': {
      bg: 'linear-gradient(145deg,#ffffff 0%,#fce8e6 100%)', glow: 'rgba(234,67,53,0.50)',
      svg: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="5" y="13" width="38" height="26" rx="3" fill="white"/>
        <path d="M5 17 L24 30 L43 17 L43 13 Q43 13 40 13 H8 Q5 13 5 17Z" fill="#EA4335"/>
        <line x1="5"  y1="39" x2="17" y2="28" stroke="rgba(160,16,16,0.18)" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="43" y1="39" x2="31" y2="28" stroke="rgba(160,16,16,0.18)" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`
    },
    'drive.google.com': {
      bg: 'linear-gradient(145deg,#ffffff 0%,#e8f0fe 100%)', glow: 'rgba(26,115,232,0.50)',
      svg: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 7 L10 33 L18.5 33 L27 18.5 Z" fill="#34A853"/>
        <path d="M24 7 L38 33 L29.5 33 L21 18.5 Z" fill="#4285F4"/>
        <rect x="10" y="33" width="28" height="8" rx="4" fill="#FBBC05"/>
      </svg>`
    },
    'docs.google.com':   { bg: 'linear-gradient(145deg,#4285f4 0%,#669df6 100%)',            glow: 'rgba(66,133,244,0.55)'   },
    'sheets.google.com': { bg: 'linear-gradient(145deg,#0f9d58 0%,#137333 100%)',            glow: 'rgba(15,157,88,0.55)'    },
    'slides.google.com': { bg: 'linear-gradient(145deg,#f29900 0%,#ea8000 100%)',            glow: 'rgba(242,153,0,0.55)'    },
    'youtube.com':       { bg: 'linear-gradient(145deg,#ff0000 0%,#aa0000 100%)',            glow: 'rgba(255,0,0,0.55)'      },
    'reddit.com':        { bg: 'linear-gradient(145deg,#ff4500 0%,#cc3700 100%)',            glow: 'rgba(255,69,0,0.55)'     },
    'twitter.com':       { bg: 'linear-gradient(145deg,#1da1f2 0%,#0d7bbf 100%)',            glow: 'rgba(29,161,242,0.55)'   },
    'x.com':             { bg: 'linear-gradient(145deg,#111111 0%,#333333 100%)',            glow: 'rgba(220,220,220,0.22)'  },
    'github.com':        { bg: 'linear-gradient(145deg,#24292e 0%,#444d56 100%)',            glow: 'rgba(210,210,210,0.20)'  },
    'netflix.com':       { bg: 'linear-gradient(145deg,#e50914 0%,#8c0000 100%)',            glow: 'rgba(229,9,20,0.55)'     },
    'spotify.com':       { bg: 'linear-gradient(145deg,#1db954 0%,#158a3e 100%)',            glow: 'rgba(29,185,84,0.55)'    },
    'linkedin.com':      { bg: 'linear-gradient(145deg,#0077b5 0%,#00497a 100%)',            glow: 'rgba(0,119,181,0.55)'    },
    'instagram.com':     { bg: 'linear-gradient(145deg,#833ab4 0%,#e1306c 55%,#fcb045 100%)', glow: 'rgba(131,58,180,0.55)' },
    'facebook.com':      { bg: 'linear-gradient(145deg,#1877f2 0%,#0d5db8 100%)',            glow: 'rgba(24,119,242,0.55)'   },
    'amazon.com':        { bg: 'linear-gradient(145deg,#ff9900 0%,#c97500 100%)',            glow: 'rgba(255,153,0,0.55)'    },
    'twitch.tv':         { bg: 'linear-gradient(145deg,#9146ff 0%,#5f2ea6 100%)',            glow: 'rgba(145,70,255,0.55)'   },
    'discord.com':       { bg: 'linear-gradient(145deg,#5865f2 0%,#3a45c4 100%)',            glow: 'rgba(88,101,242,0.55)'   },
    'notion.so':         { bg: 'linear-gradient(145deg,#f7f6f3 0%,#e0deda 100%)',            glow: 'rgba(0,0,0,0.18)'        },
    'figma.com':         { bg: 'linear-gradient(145deg,#0acf83 0%,#1abcfe 50%,#ff7262 100%)', glow: 'rgba(10,207,131,0.55)' },
    'canva.com':         { bg: 'linear-gradient(145deg,#00c4cc 0%,#7d2ae8 100%)',            glow: 'rgba(0,196,204,0.55)'    },
    'slack.com':         { bg: 'linear-gradient(145deg,#4a154b 0%,#7c3085 100%)',            glow: 'rgba(122,48,133,0.55)'   },
    'microsoft.com':     { bg: 'linear-gradient(145deg,#00a4ef 0%,#7fba00 50%,#f25022 100%)', glow: 'rgba(0,164,239,0.50)'  },
    'office.com':        { bg: 'linear-gradient(145deg,#d83b01 0%,#ea4300 100%)',            glow: 'rgba(216,59,1,0.55)'     },
    'outlook.live.com':  { bg: 'linear-gradient(145deg,#0078d4 0%,#004e8c 100%)',            glow: 'rgba(0,120,212,0.55)'    },
    'onedrive.live.com': { bg: 'linear-gradient(145deg,#0078d4 0%,#50abf1 100%)',            glow: 'rgba(0,120,212,0.55)'    },
    'web.stremio.com':   { bg: 'linear-gradient(145deg,#7a5af8 0%,#5c35d4 100%)',            glow: 'rgba(122,90,248,0.55)'   },
    'stremio.com':       { bg: 'linear-gradient(145deg,#7a5af8 0%,#5c35d4 100%)',            glow: 'rgba(122,90,248,0.55)'   },
    'predicta-bet.vercel.app': {
      bg:   'linear-gradient(145deg,#0f4c2a 0%,#1a7a40 55%,#0d3d22 100%)',
      glow: 'rgba(26,180,80,0.60)',
      svg: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="18" stroke="rgba(255,255,255,0.80)" stroke-width="2" fill="rgba(255,255,255,0.06)"/>
        <path d="M6.5 24 Q24 12 41.5 24" stroke="rgba(255,255,255,0.70)" stroke-width="1.8" fill="none" stroke-linecap="round"/>
        <path d="M6.5 24 Q24 36 41.5 24" stroke="rgba(255,255,255,0.70)" stroke-width="1.8" fill="none" stroke-linecap="round"/>
        <line x1="24" y1="6" x2="24" y2="42" stroke="rgba(255,255,255,0.55)" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="37" cy="11" r="6.5" fill="#ff3b30"/>
        <circle cx="37" cy="11" r="6.5" fill="url(#lg)" opacity="0.4"/>
        <circle cx="37" cy="11" r="3.2" fill="rgba(255,255,255,0.92)"/>
        <defs><radialGradient id="lg" cx="40%" cy="35%"><stop offset="0%" stop-color="white" stop-opacity="0.6"/><stop offset="100%" stop-color="transparent"/></radialGradient></defs>
      </svg>`
    },
  };

  // ── Init ──────────────────────────────────────────────────────────────────

  /** Bottom ticker removed — keep reserve at 0 so webviews / NTP use full height. */
  function _applyTickerBottomReserve() {
    if (document.documentElement) {
      document.documentElement.style.setProperty('--ntp-ticker-reserve', '0px');
    }
  }

  if (typeof window !== 'undefined') {
    window.__navioApplyNtpTickerReserve = _applyTickerBottomReserve;
  }

  function init() {
    _startClock();
    _bindModeTabs();
    _bindSearchInput();
    _bindShortcuts();
    _bindWidgetPopouts();
    _bindResultsPanel();
    _bindNtpSlashFocus();
    _bindNtpVoiceMode();
    _bindNtpModelSelector();
    _bindNtpChatPanel();
    _bindDimSlider();

    _applyTickerBottomReserve();

    const observer = new MutationObserver(() => {
      const isActive = document.getElementById('new-tab-page')?.classList.contains('active');
      if (isActive && !_ntpVisible) {
        _ntpVisible = true;
        requestAnimationFrame(() => _applyTickerBottomReserve());
        _applyNewTabMode();
        _onShow();
      } else if (!isActive) {
        _ntpVisible = false;
        _applyTickerBottomReserve();
      }
    });
    const ntp = document.getElementById('new-tab-page');
    if (ntp) observer.observe(ntp, { attributes: true, attributeFilter: ['class'] });
    if (ntp?.classList.contains('active')) {
      _ntpVisible = true;
      requestAnimationFrame(() => _applyTickerBottomReserve());
      _applyNewTabMode();
      _onShow();
    }

    // Hydrate config-driven NTP preferences (shortcuts)
    void _hydrateNtpPreferences();

    _syncNtpNoEmailLayout();
  }

  /**
   * Apply user's New Tab mode (Settings → General):
   *   'home'  — full dashboard (default)
   *   'chat'  — chat-first: keep shortcuts, hide widgets, search defaults to AI
   *   'blank' — hide hero + shortcuts + widgets; just background
   *
   * Resilient: reads config async but reapplies every time the NTP shows, so
   * the user sees the change immediately after saving Settings.
   */
  async function _applyNewTabMode() {
    try {
      const cfg = await window.navio.getConfig();
      const mode = String(cfg?.newTabMode || 'home');
      const body = document.body;
      if (!body) return;
      body.classList.toggle('ntp-chat-mode', mode === 'chat');
      body.classList.toggle('ntp-blank-mode', mode === 'blank');

      const input = document.getElementById('ntp-search-input');
      if (mode === 'chat') {
        _mode = 'ai';
        if (input) {
          input.placeholder = 'Ask Navio anything…';
        }
        document.querySelectorAll('.ntp-mode-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.mode === 'ai');
        });
      } else {
        _mode = 'search';
        if (input) {
          input.placeholder = 'Search or ask anything…';
        }
        document.querySelectorAll('.ntp-mode-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.mode === 'search');
        });
      }
    } catch {
      /* config unavailable → fall back to default home */
    }
  }

  if (typeof window !== 'undefined') {
    window.__navioApplyNewTabMode = _applyNewTabMode;
  }

  /** When inbox shows the connect prompt (.ntp-email-empty), hide the inbox tile and widen news. */
  function _syncNtpNoEmailLayout() {
    const list = document.getElementById('ntp-email-list');
    const noEmail = !!(list && list.querySelector('.ntp-email-empty'));
    document.querySelector('.ntp-widgets')?.classList.toggle('ntp-widgets--no-email', noEmail);
  }

  function _onShow() {
    _updateGreeting();
    (async () => {
      await Promise.all([
        _loadWorldNews().catch(() => {}),
        _loadServicesBar().catch(() => {}),
        _loadInbox().catch(() => {}),
        _prefetchStockDataForNtp().catch(() => {})
      ]);
      await _updateSmartRow();
    })();
  }

  function _bindNtpSlashFocus() {
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.isComposing) return;
        // Only plain "/" (no Shift). Shift+/ is "?" — some OSes still report key "/" + shiftKey;
        // stealing that breaks typing ? with either Shift key.
        if (e.code !== 'Slash' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        const ntp = document.getElementById('new-tab-page');
        if (!ntp?.classList.contains('active')) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (t && typeof t.closest === 'function' && t.closest('webview')) return;
        e.preventDefault();
        document.getElementById('ntp-search-input')?.focus();
      },
      true
    );
  }

  async function _updateSmartRow() {
    const el = document.getElementById('ntp-smart-row');
    if (!el) return;
    const parts = [];
    try {
      const cfg = await window.navio.getConfig();
      if (cfg.hasApiKey) parts.push('AI connected');
      const keys = await window.navio.connectorGetKeys().catch(() => ({}));
      if (keys && keys.perplexity) parts.push('Perplexity · cited answers');
    } catch {
      /* ignore */
    }
    if (_newsHeadlines.length) parts.push(`${_newsHeadlines.length} headlines`);
    if (_inboxMessages.length) {
      const u = _inboxMessages.filter((m) => m.unread).length;
      parts.push(u ? `${u} unread` : 'Inbox checked');
    }
    if (_stockData.length) {
      const sp = _stockData.find((s) => s.symbol === 'GSPC');
      if (sp && typeof sp.pct === 'number') {
        const a = sp.pct >= 0 ? 'up' : 'down';
        parts.push(`S&P ${a} ${Math.abs(sp.pct).toFixed(1)}%`);
      }
    }
    el.textContent =
      parts.length > 0
        ? parts.join(' · ')
        : 'Tip: connect email for inbox · Perplexity connector adds citations in Ask AI';
  }

  // ── Clock + Greeting ──────────────────────────────────────────────────────

  function _startClock() {
    const tick = () => {
      const now = new Date();

      // Big clock — 12-hour format with small AM/PM tag
      const clockEl = document.getElementById('ntp-clock');
      if (clockEl) {
        let h = now.getHours();
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        const m = String(now.getMinutes()).padStart(2, '0');
        clockEl.innerHTML = `${h}:${m}<span class="ntp-clock-ampm">${ampm}</span>`;
      }

      // Date line
      const dateEl = document.getElementById('ntp-date');
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString(undefined, {
          weekday: 'long', month: 'short', day: 'numeric'
        });
      }

      // Greeting
      _updateGreeting();
    };
    tick();
    const _clockInterval = setInterval(tick, 1000);
    // Expose for cleanup if the NTP page is ever torn down
    if (typeof window !== 'undefined') window._ntpClockInterval = _clockInterval;
  }

  function _updateGreeting() {
    const hour = new Date().getHours();
    const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const el = document.getElementById('ntp-greeting');
    if (el) el.textContent = greet;
  }

  // ── World News (Reddit r/worldnews — free, CORS-open JSON API) ─────────────

  async function _loadWorldNews() {
    const list = document.getElementById('ntp-news-list');
    if (!list) return;

    // Try Reddit worldnews first, fallback to HackerNews
    try {
      const r = await fetch('https://www.reddit.com/r/worldnews/hot.json?limit=20', {
        headers: { 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`Reddit ${r.status}`);
      const data = await r.json();
      const rawPosts = (data?.data?.children || [])
        .map((c) => c.data)
        .filter(
          (p) =>
            p &&
            p.title &&
            !p.stickied &&
            !/^\[removed\]/i.test(p.title.trim()) &&
            !/megathread/i.test(p.title)
        );
      const seen = new Set();
      const posts = [];
      for (const p of rawPosts) {
        const key = p.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 96);
        if (seen.has(key)) continue;
        seen.add(key);
        posts.push(p);
        if (posts.length >= 16) break;
      }

      if (posts.length === 0) throw new Error('No posts');

      _newsHeadlines = posts.map(p => p.title);

      // Update source label
      const src = document.getElementById('ntp-news-source');
      if (src) src.textContent = 'Reddit · r/worldnews';

      list.innerHTML = posts.map(p => `
        <div class="ntp-news-item" data-url="${_esc(p.url || `https://reddit.com${p.permalink}`)}">
          <div class="ntp-news-category">${_esc(p.link_flair_text || 'World')}</div>
          <div class="ntp-news-title">${_esc(p.title)}</div>
          <div class="ntp-news-meta">
            <span>▲ ${(p.score || 0).toLocaleString()}</span>
            <span>${p.num_comments || 0} comments</span>
            <span>${_domain(p.url)}</span>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.ntp-news-item').forEach(item => {
        item.addEventListener('click', () => {
          const url = item.dataset.url;
          if (url && typeof TabManager !== 'undefined') TabManager.createTab(url);
        });
      });

    } catch {
      // Fallback: HackerNews
      try {
        const src = document.getElementById('ntp-news-source');
        if (src) src.textContent = 'HackerNews';

        const ids = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json').then(r => r.json());
        const stories = await Promise.all(
          ids.slice(0, 14).map(id =>
            fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
              .then(r => r.json()).catch(() => null)
          )
        );
        const valid = stories.filter(s => s && s.title);
        _newsHeadlines = valid.map(s => s.title);

        if (valid.length === 0) {
          list.innerHTML = '<p class="ntp-widget-empty">Could not load news.</p>';
          return;
        }

        list.innerHTML = valid.map(s => `
          <div class="ntp-news-item" data-url="${s.url || `https://news.ycombinator.com/item?id=${s.id}`}">
            <div class="ntp-news-category">Tech</div>
            <div class="ntp-news-title">${_esc(s.title)}</div>
            <div class="ntp-news-meta">
              <span>${s.score || 0} pts</span>
              <span>${s.descendants || 0} comments</span>
              <span>${_domain(s.url)}</span>
            </div>
          </div>
        `).join('');

        list.querySelectorAll('.ntp-news-item').forEach(item => {
          item.addEventListener('click', () => {
            const url = item.dataset.url;
            if (url && typeof TabManager !== 'undefined') TabManager.createTab(url);
          });
        });
      } catch {
        list.innerHTML = '<p class="ntp-widget-empty">Could not load news. Check your connection.</p>';
      }
    }
  }

  // ── Widget Pop-out — open any widget as a full new tab ────────────────────

  function _bindWidgetPopouts() {
    document.querySelectorAll('.ntp-widget-popout').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _popoutWidget(btn.dataset.widget);
      });
    });
  }

  function _popoutWidget(widgetKey) {
    const configs = {
      news:    { bodyId: 'ntp-news-list',   title: 'World News' },
      inbox:   { bodyId: 'ntp-email-list',  title: 'Inbox' }
    };
    const cfg = configs[widgetKey];
    if (!cfg) return;

    const bodyEl = document.getElementById(cfg.bodyId);
    if (!bodyEl) return;

    // Grab relevant CSS from the page's stylesheets for the widget classes
    const styles = Array.from(document.styleSheets)
      .flatMap(s => { try { return Array.from(s.cssRules); } catch { return []; } })
      .filter(r => r.cssText && /ntp-email|ntp-news|ntp-brief|ntp-widget-body|ntp-wx/.test(r.cssText))
      .map(r => r.cssText)
      .join('\n');

    const baseCSS = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, 'Segoe UI', sans-serif;
        background: #0f1117;
        color: #e2e8f0;
        padding: 32px;
        min-height: 100vh;
      }
      h1 {
        font-size: 18px;
        font-weight: 600;
        color: rgba(226,232,248,0.6);
        letter-spacing: 0.4px;
        margin-bottom: 20px;
        padding-bottom: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .content { max-width: 760px; margin: 0 auto; }
      a { color: #00d8ff; text-decoration: none; }
      a:hover { text-decoration: underline; }
    `;

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${cfg.title} — Navio</title>
  <style>
    ${baseCSS}
    :root {
      --text-primary: #e2e8f0;
      --text-secondary: rgba(226,232,248,0.65);
      --text-tertiary: rgba(226,232,248,0.35);
      --glass-border: rgba(255,255,255,0.07);
    }
    ${styles}
    /* Override fixed height for full-page view */
    .ntp-widget-body { height: auto; overflow: visible; padding: 0; }
    .ntp-brief-content { height: auto; overflow: visible; }
    .ntp-email-item { cursor: default; }
  </style>
</head>
<body>
  <div class="content">
    <h1>${cfg.title}</h1>
    <div class="ntp-widget-body">
      ${bodyEl.innerHTML}
    </div>
  </div>
</body>
</html>`;

    try {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      if (typeof TabManager !== 'undefined') TabManager.createTab(url);
    } catch {}
  }

  // Stock quotes for smart row / AI context (bottom ticker removed)
  async function _prefetchStockDataForNtp() {
    try {
      const result = await window.navio.ntpFetchStocks();
      if (result && !result.error && Array.isArray(result) && result.length) {
        _stockData = result;
      }
    } catch {
      /* ignore */
    }
  }

  // ── NTP Inline Results Panel (legacy stub — panel replaced by #ntp-chat-panel) ──

  function _bindResultsPanel() {
    // Old #ntp-results panel removed; binding is now a no-op kept for safety.
  }

  function _closeResults() {
    _ntpCloseChat();
  }

  /** True when the user is likely asking about their mail (inline NTP AI adds inbox text only; no actions). */
  function _ntpEmailQueryLooksInboxRelated(q) {
    const s = (q || '').trim().toLowerCase();
    if (s.length < 3) return false;
    return (
      /\b(email|e-?mail|emails|inbox|unread|gmail|outlook|mailbox|mail from|messages from|any new mail|what'?s in my inbox)\b/.test(
        s
      ) ||
      /\b(check|see|show|read|peek)\s+(at\s+)?(my\s+)?(inbox|mail|gmail)\b/.test(s) ||
      /\b(what|whats|what's|any)('?s|s| is)?\s+(new|in\s+my\s+inbox|up)\b/.test(s) ||
      (/\b(did|have)\s+i\s+(get|miss|receive)\b/.test(s) && /\b(mail|e-?mail|message)\b/.test(s)) ||
      /\bmy\s+(e-?mails?|mail|inbox)\b/.test(s)
    );
  }

  function _formatInboxLinesForInlineAI(rows) {
    return rows.slice(0, 18).map((m, i) => {
      const sub = m.subject || '(no subject)';
      const from = m.senderName || m.sender || '';
      const snip = (m.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const u = m.unread ? ' [unread]' : '';
      return `${i + 1}. ${sub}${u} — From: ${from}${snip ? `\n   Preview: ${snip}` : ''}`;
    });
  }

  /**
   * Prefix for New Tab "Ask AI" only: real inbox rows so the answer can reference messages.
   * Does not run tools — sidebar Assistant handles navigation and drafts.
   */
  async function _buildNtpInlineEmailContext(query) {
    if (!_ntpEmailQueryLooksInboxRelated(query)) return { text: '', usedInbox: false };
    let rows = [];
    try {
      if (_inboxMessages.length > 0) {
        rows = _inboxMessages;
      } else {
        let googleConnected = false;
        try {
          const oauthSt = await window.navio.oauthStatus();
          googleConnected = !!(oauthSt && oauthSt.google && oauthSt.google.connected);
        } catch {
          /* ignore */
        }
        if (googleConnected) {
          const r = await window.navio.ntpGmailInbox().catch(() => ({}));
          if (r && r.messages && r.messages.length) rows = r.messages;
        }
        if (rows.length === 0) {
          const imapSt = await window.navio.imapStatus().catch(() => ({}));
          for (const svcId of Object.keys(imapSt || {})) {
            if (!imapSt[svcId] || !imapSt[svcId].connected) continue;
            const r = await window.navio.imapGetUnread(svcId, 12).catch(() => ({}));
            if (r && r.messages && r.messages.length) {
              rows = r.messages.map((m) => ({
                subject: m.subject,
                senderName: m.fromName || m.from,
                sender: m.from,
                snippet: m.snippet || '',
                unread: true,
                date: m.date
              }));
              break;
            }
          }
        }
      }
    } catch {
      return { text: '', usedInbox: false };
    }
    if (!rows.length) {
      return {
        text:
          '[The user asked about email. No inbox messages could be loaded yet — they may need to connect Gmail/Outlook in Connectors or wait for the inbox widget to finish loading. Answer generally and mention connecting email.]\n\n',
        usedInbox: false
      };
    }
    const lines = _formatInboxLinesForInlineAI(rows);
    const text =
      '[Read-only inbox snapshot for this New Tab answer — to open a thread, draft a reply, or automate steps, use the sidebar Navio AI Assistant.]\n' +
      lines.join('\n') +
      '\n\n';
    return { text, usedInbox: true };
  }

  async function _showInlineAIResults(query) {
    const panel = document.getElementById('ntp-results');
    const aiContent = document.getElementById('ntp-rt-ai-content');
    const newsContent = document.getElementById('ntp-rt-news-content');
    if (!panel || !aiContent) return;

    panel.style.display = 'block';
    document.querySelectorAll('.ntp-rt-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.ntp-rt-tab[data-tab="ai"]')?.classList.add('active');
    document.getElementById('ntp-rt-ai').style.display = '';
    document.getElementById('ntp-rt-news').style.display = 'none';

    aiContent.innerHTML = '<div class="ntp-brief-generating"><div class="ntp-brief-spinner"></div><p>Asking AI...</p></div>';

    if (newsContent && _newsHeadlines.length > 0) {
      const related = _rankHeadlinesForQuery(query, 6);
      const label = related.fromQuery ? 'Related headlines' : 'Trending now';
      newsContent.innerHTML =
        related.list.length > 0
          ? `<p class="ntp-related-label">${_esc(label)}</p>` +
            related.list
              .map(
                (h) =>
                  '<div class="ntp-news-item ntp-news-item-compact"><div class="ntp-news-title">' + _esc(h) + '</div></div>'
              )
              .join('')
          : '<p class="ntp-widget-empty">No headlines loaded yet.</p>';
    }

    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        aiContent.innerHTML = '<div class="ntp-brief-error">No AI key configured. Add one in <strong>Settings - AI</strong>.</div>';
        return;
      }
      const emailCtx = await _buildNtpInlineEmailContext(query);
      const promptForModel = emailCtx.text + query;
      const keys = await window.navio.connectorGetKeys().catch(() => ({}));
      let answer = '';
      let citations = [];
      if (keys && keys.perplexity) {
        const pq = await window.navio.connectorQuery('perplexity', promptForModel, {});
        if (pq.error) throw new Error(pq.error);
        answer = pq.answer || '';
        citations = Array.isArray(pq.citations) ? pq.citations : [];
      } else {
        const result = await window.navio.aiRequest({ messages: [{ role: 'user', content: promptForModel }] });
        if (result.error) throw new Error(result.error);
        answer = result.content || '';
      }
      const html = _esc(answer)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
      let chips = '';
      if (citations.length) {
        chips =
          '<div class="ntp-ai-citations">' +
          citations
            .map((u, i) => {
              const url = typeof u === 'string' ? u : u.url || '';
              if (!url) return '';
              const safeU = _esc(url);
              const label = _esc(`[${i + 1}] ${url.replace(/^https?:\/\//, '').split('/')[0] || 'source'}`);
              return `<a class="email-ref-chip ntp-cite-chip" href="${safeU}" target="_blank" rel="noopener">${label}</a>`;
            })
            .join('') +
          '</div>';
      } else if (!keys?.perplexity) {
        chips =
          '<p class="ntp-ai-citations-note">Connect <strong>Perplexity</strong> in Connectors for cited web answers.</p>';
      }
      if (emailCtx.usedInbox) {
        chips +=
          '<p class="ntp-ai-citations-note">Inbox lines above were included for this answer. Use the <strong>Navio AI</strong> sidebar to open messages, draft replies, or run tasks.</p>';
      }
      aiContent.innerHTML = '<div class="ntp-brief-content"><p>' + html + '</p></div>' + chips;
    } catch (e) {
      aiContent.innerHTML = '<div class="ntp-brief-error">Error: ' + _esc(e.message) + '</div>';
    }
  }

  // ── Mode tabs (Search / Ask AI / Task) ───────────────────────────────────

  function _bindModeTabs() {
    document.querySelectorAll('.ntp-mode-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _mode = btn.dataset.mode;
        document.querySelectorAll('.ntp-mode-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const input = document.getElementById('ntp-search-input');
        if (input) {
          const placeholders = {
            search: 'Search the web or paste a URL…',
            ai: 'Ask anything — Perplexity adds sources when connected…',
            task: 'Describe a multi-step task for the assistant…'
          };
          input.placeholder = placeholders[_mode] || 'Search…';
          input.focus();
        }
      });
    });
  }

  // ── Search input ──────────────────────────────────────────────────────────

  /**
   * New Tab search → full-page in-tab AI chat (ChatGPT / Perplexity–style), not the sidebar.
   * Task mode keeps the sidebar assistant so browser tools still work.
   */
  async function _openAssistantInNewTab(val, opts = {}) {
    if (!val || typeof TabManager === 'undefined') return;
    if (typeof App !== 'undefined' && typeof App.openAssistantInTab === 'function') {
      await App.openAssistantInTab(val, opts);
    }
  }

  function _bindSearchInput() {
    const input = document.getElementById('ntp-search-input');
    const sendBtn = document.getElementById('ntp-search-send');
    if (!input) return;

    const submit = async () => {
      const val = input.value.trim();
      if (!val) return;
      if (_mode === 'task') {
        await _openAssistantInNewTab(val, { taskMode: true });
      } else if (_mode === 'ai') {
        _ntpStartChat(val);
      } else {
        const raw = val;
        if (raw.startsWith('>>') || /^ai:\s*/i.test(raw)) {
          _ntpStartChat(val.replace(/^ai:\s*/i, '').replace(/^>>/, '').trim() || val);
        } else if (typeof App !== 'undefined' && App._isAIQuery && App._isAIQuery(val)) {
          _ntpStartChat(val);
        } else {
          if (typeof App !== 'undefined') App.handleSearch(val);
        }
      }
      input.value = '';
    };

    input.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });
    sendBtn?.addEventListener('click', () => void submit());
  }

  function _oauthGoogleSlotActive(entry) {
    return !!(entry && entry.connected && !entry.expired);
  }

  /**
   * When primary Google and "2nd account" are both connected, open one tab per
   * signed-in profile (u/0 vs u/1 for Gmail/Drive; authuser=0/1 elsewhere).
   * Matches Navio's mapping from OAuth slots to Gmail web paths (see assistant.js).
   */
  async function _ntpShortcutMultiGoogleTargets(url) {
    const raw = (url || '').trim();
    if (!raw) return null;
    if (typeof TabManager !== 'undefined' && TabManager.getActiveTab?.()?.incognito) {
      return null;
    }
    let host = '';
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
    const hostNoWww = host.replace(/^www\./, '');
    let oauthSt = {};
    try {
      oauthSt = (await window.navio.oauthStatus()) || {};
    } catch {
      return null;
    }
    if (!_oauthGoogleSlotActive(oauthSt.google) || !_oauthGoogleSlotActive(oauthSt.google_2)) {
      return null;
    }

    // ── Use actual connected-account emails for all Google URLs ──────────────
    // Never open u/0 and u/1 blindly — the browser's Gmail session order may
    // not match Navio's OAuth slot order. A non-connector account (e.g. a
    // personal Gmail the user happened to open in the browser) could be at u/0
    // while the real connected work account is at u/1 or u/2.
    const pri = oauthSt.google?.email  || '';
    const sec = oauthSt.google_2?.email || '';

    if (host === 'mail.google.com' || host.endsWith('.mail.google.com')) {
      const urls = [];
      if (pri) urls.push(`https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(pri)}`);
      if (sec) urls.push(`https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(sec)}`);
      return urls.length >= 2 ? urls : null;
    }
    if (host === 'drive.google.com' || host.endsWith('.drive.google.com')) {
      const urls = [];
      if (pri) urls.push(`https://drive.google.com/drive/u/0/?authuser=${encodeURIComponent(pri)}`);
      if (sec) urls.push(`https://drive.google.com/drive/u/0/?authuser=${encodeURIComponent(sec)}`);
      return urls.length >= 2 ? urls : null;
    }
    if (hostNoWww === 'youtube.com' || hostNoWww === 'google.com') {
      let o;
      try { o = new URL(raw); } catch { return null; }
      const urls = [];
      if (pri) { const u = new URL(o.href); u.searchParams.set('authuser', pri); urls.push(u.href); }
      if (sec) { const u = new URL(o.href); u.searchParams.set('authuser', sec); urls.push(u.href); }
      return urls.length >= 2 ? urls : null;
    }
    return null;
  }

  // ── Quick links shortcuts (configurable) ──────────────────────────────────

  function _sanitizeShortcuts(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((row) => {
        if (!row) return null;
        const title = String(row.title || row.name || '').trim();
        const url = String(row.url || '').trim();
        if (!title || !url) return null;
        try { new URL(url); } catch { return null; }
        return { title, url };
      })
      .filter(Boolean)
      .slice(0, 12);
  }

  async function _hydrateNtpPreferences() {
    try {
      const cfg = await window.navio.getConfig();
      const sc = _sanitizeShortcuts(cfg?.ntpShortcuts);
      _shortcuts = sc.length ? sc : DEFAULT_NTP_SHORTCUTS.slice();
    } catch {
      _shortcuts = DEFAULT_NTP_SHORTCUTS.slice();
    }
    _renderShortcuts();
    _bindShortcutEditor();
  }

  function _renderShortcuts() {
    const left = document.getElementById('ntp-shortcuts-left');
    const right = document.getElementById('ntp-shortcuts-right');
    if (!left || !right) return;
    const slots = _shortcuts.slice(0, 6);
    const leftItems = slots.slice(0, 3);
    const rightItems = slots.slice(3, 6);
    const editor = document.getElementById('ntp-shortcuts-editor');
    const editing = !!(editor && !editor.hidden);
    const buildBtn = (item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ntp-shortcut';
      btn.dataset.url = item.url;
      btn.dataset.shortcutIndex = String(idx);
      btn.draggable = !editing;
      btn.title = editing ? '' : `${_esc(item.title)} — drag to reorder`;
      let favicon = '';
      let brandBg = '';
      let brandGlow = '';
      let brandSvg = '';
      try {
        const u = new URL(item.url);
        favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=256`;
        const host = u.hostname.replace(/^www\./, '');
        const brand = _SHORTCUT_BRANDS[host] || _SHORTCUT_BRANDS[u.hostname];
        if (brand) { brandBg = brand.bg; brandGlow = brand.glow; brandSvg = brand.svg || ''; }
      } catch {
        favicon = '';
      }
      const hasBrand  = !!brandBg;
      const hasCustom = hasBrand && !!brandSvg;
      const iconClass = hasBrand
        ? `shortcut-icon shortcut-icon--branded${hasCustom ? ' shortcut-icon--custom-svg' : ''}`
        : 'shortcut-icon';
      const iconStyle = hasBrand
        ? `style="background:${brandBg};--shortcut-glow:${brandGlow}"`
        : `style="--shortcut-glow:rgba(0,216,255,0.35)"`;
      const iconContent = hasCustom
        ? brandSvg
        : `<img src="${favicon}" alt="${_esc(item.title)}" loading="lazy">`;
      btn.innerHTML = `
        <div class="${iconClass}" ${iconStyle}>${iconContent}</div>
        <span>${_esc(item.title)}</span>
      `;
      btn.addEventListener('click', () => _handleShortcutClick(item.url));
      return btn;
    };
    left.innerHTML = '';
    right.innerHTML = '';
    leftItems.forEach((item, i) => left.appendChild(buildBtn(item, i)));
    rightItems.forEach((item, i) => right.appendChild(buildBtn(item, i + 3)));
    _bindShortcutDragDrop();
  }

  async function _persistNtpShortcutsToConfig() {
    try {
      const cfg = await window.navio.getConfig();
      cfg.ntpShortcuts = _shortcuts;
      await window.navio.saveConfig(cfg);
      if (typeof App !== 'undefined') App.config = cfg;
    } catch {
      /* ignore */
    }
  }

  function _reorderShortcuts(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const arr = _shortcuts.slice();
    const n = arr.length;
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= n || toIdx >= n) return;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    _shortcuts = arr;
    void _persistNtpShortcutsToConfig();
    _renderShortcuts();
  }

  function _bindShortcutDragDrop() {
    const panel = document.querySelector('.ntp-shortcuts-panel');
    if (!panel || _shortcutDndBound) return;
    _shortcutDndBound = true;

    const clearDropHover = () => {
      panel.querySelectorAll('.ntp-shortcut--drop-hover').forEach((el) => el.classList.remove('ntp-shortcut--drop-hover'));
    };

    panel.addEventListener('dragstart', (e) => {
      const editor = document.getElementById('ntp-shortcuts-editor');
      if (editor && !editor.hidden) {
        e.preventDefault();
        return;
      }
      const btn = e.target.closest?.('.ntp-shortcut');
      if (!btn || !panel.contains(btn)) return;
      dragFrom = parseInt(btn.dataset.shortcutIndex, 10);
      if (Number.isNaN(dragFrom)) return;
      e.dataTransfer.setData('application/x-navio-shortcut-index', String(dragFrom));
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setDragImage(btn, btn.offsetWidth / 2, btn.offsetHeight / 2);
      } catch {
        /* ignore */
      }
      btn.classList.add('ntp-shortcut--dragging');
    });

    panel.addEventListener('dragend', () => {
      panel.querySelectorAll('.ntp-shortcut--dragging').forEach((el) => el.classList.remove('ntp-shortcut--dragging'));
      clearDropHover();
    });

    panel.addEventListener('dragover', (e) => {
      const editor = document.getElementById('ntp-shortcuts-editor');
      if (editor && !editor.hidden) return;
      const btn = e.target.closest?.('.ntp-shortcut');
      if (!btn || !panel.contains(btn)) {
        clearDropHover();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropHover();
      btn.classList.add('ntp-shortcut--drop-hover');
    });

    panel.addEventListener('dragleave', (e) => {
      const related = e.relatedTarget;
      if (related && panel.contains(related)) return;
      clearDropHover();
    });

    panel.addEventListener('drop', (e) => {
      const editor = document.getElementById('ntp-shortcuts-editor');
      if (editor && !editor.hidden) return;
      e.preventDefault();
      const btn = e.target.closest?.('.ntp-shortcut');
      if (!btn || !panel.contains(btn)) return;
      const from = parseInt(e.dataTransfer.getData('application/x-navio-shortcut-index'), 10);
      const to = parseInt(btn.dataset.shortcutIndex, 10);
      clearDropHover();
      if (Number.isNaN(from) || Number.isNaN(to)) return;
      _reorderShortcuts(from, to);
    });
  }

  function _handleShortcutClick(url) {
    if (!url) return;
    void (async () => {
      const multi = await _ntpShortcutMultiGoogleTargets(url);
      if (
        multi &&
        multi.length > 1 &&
        typeof App !== 'undefined' &&
        typeof TabManager !== 'undefined'
      ) {
        App.handleSearch(multi[0]);
        for (let i = 1; i < multi.length; i++) {
          TabManager.createTab(multi[i], { switchTo: false });
        }
        return;
      }
      if (typeof App !== 'undefined') App.handleSearch(url);
    })();
  }

  function _bindShortcuts() {
    _renderShortcuts();
    const editBtn = document.getElementById('ntp-shortcuts-edit');
    const resetBtn = document.getElementById('ntp-shortcuts-reset');
    if (editBtn) editBtn.addEventListener('click', () => _toggleShortcutEditor(true));
    if (resetBtn) resetBtn.addEventListener('click', () => _resetShortcutsToDefault());
  }

  function _bindShortcutEditor() {
    if (_shortcutEditorBound) return;
    _shortcutEditorBound = true;
    const addBtn = document.getElementById('ntp-shortcuts-add-row');
    const saveBtn = document.getElementById('ntp-shortcuts-save');
    const cancelBtn = document.getElementById('ntp-shortcuts-cancel');
    const closeBtn = document.getElementById('ntp-shortcuts-editor-close');
    if (addBtn) addBtn.addEventListener('click', () => _appendShortcutRow());
    if (saveBtn) saveBtn.addEventListener('click', () => _persistShortcuts());
    if (cancelBtn) cancelBtn.addEventListener('click', () => _toggleShortcutEditor(false));
    if (closeBtn) closeBtn.addEventListener('click', () => _toggleShortcutEditor(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const editor = document.getElementById('ntp-shortcuts-editor');
      if (!editor || editor.hidden) return;
      e.preventDefault();
      _toggleShortcutEditor(false);
    });
  }

  function _toggleShortcutEditor(show) {
    const editor = document.getElementById('ntp-shortcuts-editor');
    const head = document.querySelector('.ntp-shortcuts-head');
    if (!editor) return;
    editor.hidden = !show;
    if (head) head.classList.toggle('editing', show);
    if (show) {
      _shortcutDraft = _shortcuts.slice();
      _renderShortcutEditorRows();
    } else {
      _shortcutDraft = null;
    }
    _renderShortcuts();
  }

  function _renderShortcutEditorRows() {
    const host = document.getElementById('ntp-shortcuts-editor-list');
    if (!host) return;
    host.innerHTML = '';
    const rows = (_shortcutDraft || _shortcuts).slice(0, 12);
    if (rows.length === 0) rows.push({ title: '', url: '' });
    rows.forEach((row, idx) => {
      const el = document.createElement('div');
      el.className = 'ntp-shortcuts-editor-row';
      el.innerHTML = `
        <input type="text" class="ntp-shortcut-input ntp-shortcut-input-title" value="${_esc(row.title)}" placeholder="Title" autocomplete="off" spellcheck="false">
        <input type="url" class="ntp-shortcut-input" value="${_esc(row.url)}" placeholder="https://example.com" autocomplete="off" spellcheck="false">
        <div class="ntp-shortcuts-editor-row-actions">
          <button type="button" class="ntp-shortcuts-btn ghost" data-move="up" title="Move up">↑</button>
          <button type="button" class="ntp-shortcuts-btn ghost" data-move="down" title="Move down">↓</button>
          <button type="button" class="ntp-shortcuts-btn ghost" data-remove="1" title="Remove">✕</button>
        </div>
      `;
      const moveUp = el.querySelector('[data-move="up"]');
      const moveDown = el.querySelector('[data-move="down"]');
      const remove = el.querySelector('[data-remove]');
      if (moveUp) moveUp.addEventListener('click', () => _moveShortcutRow(idx, -1));
      if (moveDown) moveDown.addEventListener('click', () => _moveShortcutRow(idx, 1));
      if (remove) remove.addEventListener('click', () => _removeShortcutRow(idx));
      host.appendChild(el);
    });
  }

  function _appendShortcutRow() {
    if (!_shortcutDraft) _shortcutDraft = _shortcuts.slice();
    _shortcutDraft.push({ title: '', url: '' });
    _renderShortcutEditorRows();
  }

  function _moveShortcutRow(idx, delta) {
    const working = _shortcutDraft || _shortcuts.slice();
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= working.length) return;
    const copy = working.slice();
    const [moved] = copy.splice(idx, 1);
    copy.splice(nextIdx, 0, moved);
    _shortcutDraft = copy;
    _renderShortcutEditorRows();
  }

  function _removeShortcutRow(idx) {
    const working = _shortcutDraft || _shortcuts.slice();
    if (working.length <= 1) {
      _shortcutDraft = [{ title: '', url: '' }];
    } else {
      working.splice(idx, 1);
      _shortcutDraft = working;
    }
    _renderShortcutEditorRows();
  }

  async function _persistShortcuts() {
    const host = document.getElementById('ntp-shortcuts-editor-list');
    if (!host) return;
    const rows = Array.from(host.querySelectorAll('.ntp-shortcuts-editor-row'));
    const next = [];
    rows.forEach((row) => {
      const inputs = row.querySelectorAll('.ntp-shortcut-input');
      const title = String(inputs[0]?.value || '').trim();
      const url = String(inputs[1]?.value || '').trim();
      if (!title || !url) return;
      try { new URL(url); } catch { return; }
      next.push({ title, url });
    });
    _shortcuts = next.length ? next.slice(0, 12) : DEFAULT_NTP_SHORTCUTS.slice();
    _shortcutDraft = null;
    await _persistNtpShortcutsToConfig();
    _renderShortcuts();
    _toggleShortcutEditor(false);
  }

  async function _resetShortcutsToDefault() {
    _shortcuts = DEFAULT_NTP_SHORTCUTS.slice();
    _shortcutDraft = null;
    await _persistNtpShortcutsToConfig();
    _renderShortcuts();
    _toggleShortcutEditor(false);
  }

  // ── Connected Services Status Bar ─────────────────────────────────────────

  async function _loadServicesBar() {
    const bar = document.getElementById('ntp-services-bar');
    if (!bar) return;
    bar.innerHTML = '';

    try {
      const imapSt = await window.navio.imapStatus();
      const pills = [];

      const SVC_FAVICON = {
        gmail:   'https://www.gstatic.com/images/icons/material/product/2x/gmail_48dp.png',
        outlook: 'https://www.google.com/s2/favicons?domain=outlook.live.com&sz=64',
      };

      for (const [svcId, info] of Object.entries(imapSt || {})) {
        if (!info.connected) continue;
        const label = svcId === 'gmail' ? 'Gmail' : 'Outlook';
        pills.push({ id: svcId, label, email: info.email, favicon: SVC_FAVICON[svcId] || '' });
      }

      if (pills.length === 0) { bar.style.display = 'none'; return; }

      bar.style.display = 'flex';
      for (const pill of pills) {
        const el = document.createElement('div');
        el.className = 'ntp-service-pill';
        el.dataset.id = pill.id;
        el.innerHTML = `
          ${pill.favicon ? `<img class="ntp-svc-logo" src="${pill.favicon}" alt="${pill.label}">` : `<span class="ntp-svc-dot"></span>`}
          <span class="ntp-svc-label">${pill.label}</span>
          <span class="ntp-svc-email">${pill.email}</span>
          <span class="ntp-svc-count" id="ntp-svc-count-${pill.id}" style="display:none"></span>
        `;
        bar.appendChild(el);
      }

      for (const svcId of Object.keys(imapSt || {})) {
        window.navio.imapGetUnread(svcId, 1).then(r => {
          const countEl = document.getElementById(`ntp-svc-count-${svcId}`);
          if (countEl && r?.unreadCount > 0) {
            countEl.textContent = r.unreadCount;
            countEl.style.display = 'inline-flex';
          }
        }).catch(() => {});
      }
    } catch {}
  }

  // ── Inbox widget ──────────────────────────────────────────────────────────

  async function _loadInbox() {
    const emailList      = document.getElementById('ntp-email-list');
    const unreadBadge    = document.getElementById('ntp-unread-badge');
    const draftAllBtn    = document.getElementById('ntp-draft-all-btn');
    const analyzeBtn     = document.getElementById('ntp-inbox-analyze-btn');
    if (!emailList) return;

    if (analyzeBtn && !analyzeBtn._wired) {
      analyzeBtn._wired = true;
      analyzeBtn.addEventListener('click', () => _analyzeInbox(analyzeBtn));
    }

    try {
      const imapSt = await window.navio.imapStatus();
      const connectedServices = Object.keys(imapSt || {});

      // ── Check OAuth Google connection first ───────────────────────────────
      let googleAlreadyConnected = false;
      // Keep oauthSt in wider scope so click/context handlers can use the
      // connected account's email instead of hardcoded u/0 (which may be
      // a non-connector account the user is just signed into in the browser).
      let _ntpOauthSt = {};
      try {
        _ntpOauthSt = (await window.navio.oauthStatus()) || {};
        googleAlreadyConnected = !!(_ntpOauthSt?.google?.connected);
      } catch {}

      if (googleAlreadyConnected) {
        // Signed in via Google OAuth — read inbox from Gmail API
        emailList.innerHTML = '<div class="ntp-widget-loading"><span></span><span></span><span></span></div>';
        const gmailResult = await window.navio.ntpGmailInbox();
        if (gmailResult?.error && String(gmailResult.error).startsWith('not_signed_in')) {
          // Token was invalidated, fall through to sign-in prompt
          googleAlreadyConnected = false;
        } else if (gmailResult?.error) {
          emailList.innerHTML = `<p class="ntp-widget-empty">Gmail error: ${_esc(gmailResult.error)}</p>`;
          return;
        } else {
          const messages  = gmailResult?.messages || [];
          _inboxMessages  = messages; // cache for AI brief
          const unreadCount = gmailResult?.unreadCount || 0;
          if (unreadBadge) {
            unreadBadge.textContent = unreadCount;
            unreadBadge.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
          }
          if (messages.length === 0) {
            emailList.innerHTML = '<p class="ntp-widget-empty">Inbox is empty.</p>';
            return;
          }
          emailList.innerHTML = messages.map(msg => `
            <div class="ntp-email-item ${msg.unread ? 'unread' : ''}" data-msgid="${_esc(msg.id || '')}"
                 data-sender="${_esc(msg.sender || '')}" data-sendername="${_esc(msg.senderName || '')}">
              <div class="ntp-email-header">
                <span class="ntp-email-sender">${_esc(msg.senderName || msg.sender || '')}</span>
                <span class="ntp-email-date">${_esc(_formatEmailDate(msg.date))}</span>
              </div>
              <div class="ntp-email-subject">${_esc(msg.subject)}</div>
              <div class="ntp-email-preview">${_esc(msg.snippet || '')}</div>
              <button class="ntp-email-draft-btn" data-msgid="${_esc(msg.id || '')}" title="Draft a reply">
                ✦ Draft reply
              </button>
            </div>
          `).join('');
          // Click email row (not the draft button) → open in Gmail
          // Use the real connected account email so we land in the right inbox.
          const _ntpPriEmail = _ntpOauthSt.google?.email || '';
          emailList.querySelectorAll('.ntp-email-item[data-msgid]').forEach(el => {
            const msgData = messages.find(m => m.id === el.dataset.msgid) || { id: el.dataset.msgid };
            el.addEventListener('click', (e) => {
              if (e.target.closest('.ntp-email-draft-btn')) return; // handled separately
              const id = el.dataset.msgid;
              const base = _ntpPriEmail
                ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(_ntpPriEmail)}`
                : 'https://mail.google.com/mail/u/0/';
              const url = id ? `${base}#inbox/${id}` : base;
              if (typeof TabManager !== 'undefined') TabManager.createTab(url);
              else window.open(url, '_blank');
            });
            _attachGmailCtxMenu(el, msgData, _ntpPriEmail);
          });
          // Draft reply button for Gmail OAuth emails
          emailList.querySelectorAll('.ntp-email-draft-btn[data-msgid]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const item = btn.closest('.ntp-email-item');
              const msgid    = btn.dataset.msgid;
              const subject  = item.querySelector('.ntp-email-subject')?.textContent || '';
              const fromName = item.dataset.sendername || item.dataset.sender || '';
              const sender   = item.dataset.sender || '';
              await _draftGmailEmail(msgid, subject, fromName, sender, btn);
            });
          });
          return;
        }
      }

      if (connectedServices.length === 0) {
        // ── No IMAP and no OAuth — show setup prompt ──────────────────────
        let hasGoogleClientId = false;
        let hasGoogleSecret   = false;
        try {
          const cfg = await window.navio.getConfig();
          hasGoogleClientId = !!(cfg.oauthGoogleClientId || '').trim();
          hasGoogleSecret   = !!(cfg.oauthGoogleClientSecret || '').trim();
        } catch {}

        if (hasGoogleClientId) {
          // Credentials configured but not yet signed in
          const missingSecret = !hasGoogleSecret;
          const statusMsg = missingSecret
            ? 'Client ID saved. Also add your <strong>Client Secret</strong> in Settings → Integrations, then sign in.'
            : 'Your Google credentials are ready. Sign in to connect Gmail.';
          emailList.innerHTML = `
            <div class="ntp-email-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <p>${statusMsg}</p>
              <button class="ntp-connect-email-btn" id="ntp-connect-email" ${missingSecret ? 'disabled style="opacity:0.5"' : ''}>Sign in with Google</button>
            </div>`;
          document.getElementById('ntp-connect-email')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.textContent = 'Signing in…';
            btn.disabled = true;
            try {
              const result = await window.navio.oauthConnect('google');
              if (result?.ok) {
                btn.textContent = '✓ Connected!';
                setTimeout(() => _loadInbox(), 1000);
              } else {
                const errMsg = (result?.error || '').toLowerCase().includes('client_secret')
                  ? 'Add Client Secret in Settings → Integrations'
                  : (result?.error || 'Sign-in failed');
                btn.textContent = errMsg;
                btn.disabled = false;
                setTimeout(() => { btn.textContent = 'Sign in with Google'; }, 4000);
              }
            } catch {
              btn.textContent = 'Sign-in failed';
              setTimeout(() => { btn.textContent = 'Sign in with Google'; btn.disabled = false; }, 3000);
            }
          });
        } else {
          // No credentials at all — open the Connectors Hub
          emailList.innerHTML = `
            <div class="ntp-email-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <p>Connect Gmail or Outlook to see your inbox here.</p>
              <button class="ntp-connect-email-btn" id="ntp-connect-email">Connect email</button>
            </div>`;
          document.getElementById('ntp-connect-email')?.addEventListener('click', () => {
            document.getElementById('btn-connectors-full')?.click();
          });
        }
        return;
      }

      // ── IMAP fallback ─────────────────────────────────────────────────────
      emailList.innerHTML = '<div class="ntp-widget-loading"><span></span><span></span><span></span></div>';

      const svcId = connectedServices[0];
      const result = await window.navio.imapGetUnread(svcId, 10);

      if (result?.error) {
        emailList.innerHTML = `<p class="ntp-widget-empty">Could not load inbox: ${_esc(result.error)}</p>`;
        return;
      }

      const messages = result?.messages || [];
      const unreadCount = result?.unreadCount || 0;

      if (unreadBadge && unreadCount > 0) {
        unreadBadge.textContent = unreadCount;
        unreadBadge.style.display = 'inline-flex';
      }

      if (draftAllBtn && messages.length > 0) {
        draftAllBtn.style.display = 'inline-flex';
        if (!draftAllBtn._navioWired) {
          draftAllBtn._navioWired = true;
          draftAllBtn.addEventListener('click', () => {
            if (typeof LiveConnectorManager !== 'undefined') {
              const tab = TabManager?.tabs?.find(t => {
                const url = t.webview?.src || t.url || '';
                return url.includes(svcId === 'gmail' ? 'mail.google.com' : 'outlook.live.com');
              });
              if (tab) {
                LiveConnectorManager._startBatchDraft(svcId, tab.id);
              } else {
                _imapBatchDraft(svcId, messages);
              }
            }
          });
        }
      }

      if (messages.length === 0) {
        emailList.innerHTML = '<p class="ntp-widget-empty">All caught up — no unread emails.</p>';
        return;
      }

      // Normalise IMAP shape to match Gmail shape for AI brief
      _inboxMessages = messages.map(m => ({
        unread: true, subject: m.subject,
        senderName: m.fromName || m.from, date: m.date, snippet: '',
      }));

      emailList.innerHTML = messages.map(m => `
        <div class="ntp-email-item" data-uid="${m.uid}" data-svc="${svcId}">
          <div class="ntp-email-from">${_esc(m.fromName || m.from)}</div>
          <div class="ntp-email-subject">${_esc(m.subject)}</div>
          <div class="ntp-email-meta">${_timeAgo(m.date)}</div>
          <button class="ntp-email-draft-btn" data-uid="${m.uid}" data-svc="${svcId}" title="Draft a reply">
            ✦ Draft reply
          </button>
        </div>
      `).join('');

      emailList.querySelectorAll('.ntp-email-draft-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { uid, svc } = btn.dataset;
          const emailItem = btn.closest('.ntp-email-item');
          const subject = emailItem.querySelector('.ntp-email-subject')?.textContent || '';
          const from = emailItem.querySelector('.ntp-email-from')?.textContent || '';
          await _draftSingleEmail(svc, parseInt(uid), from, subject, btn);
        });
      });

      // Right-click context menus for IMAP emails
      emailList.querySelectorAll('.ntp-email-item[data-uid]').forEach(el => {
        _attachImapCtxMenu(el, parseInt(el.dataset.uid), el.dataset.svc);
      });

    } catch (e) {
      emailList.innerHTML = `<p class="ntp-widget-empty">Error: ${_esc(e.message)}</p>`;
    } finally {
      _syncNtpNoEmailLayout();
    }
  }

  // ── Email right-click context menu ───────────────────────────────────────

  function _buildEmailCtxMenu(items) {
    // Remove any existing menu
    document.getElementById('navio-email-ctx')?.remove();
    const menu = document.createElement('div');
    menu.id = 'navio-email-ctx';
    menu.className = 'navio-email-ctx';
    items.forEach(item => {
      if (item === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'navio-email-ctx-sep';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'navio-email-ctx-item' + (item.danger ? ' danger' : '');
      btn.innerHTML = `<span class="ctx-icon">${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); item.action(); _closeEmailCtxMenu(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    return menu;
  }

  function _closeEmailCtxMenu() {
    document.getElementById('navio-email-ctx')?.remove();
  }

  function _positionEmailCtxMenu(menu, e) {
    const mw = 200, mh = menu.offsetHeight || 180;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 6;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 6;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
  }

  function _attachGmailCtxMenu(el, msg, authEmail) {
    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isUnread = el.classList.contains('unread');
      const menu = _buildEmailCtxMenu([
        {
          icon: '↗',
          label: 'Open in Gmail',
          action: () => {
            // Use the connected account's email — not raw u/0 which may show
            // a non-connector account the user happens to be signed into.
            const _ae = authEmail || '';
            const base = _ae
              ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(_ae)}`
              : 'https://mail.google.com/mail/u/0/';
            const url = msg.id ? `${base}#inbox/${msg.id}` : base;
            if (typeof TabManager !== 'undefined') TabManager.createTab(url);
            else window.open(url, '_blank');
          }
        },
        isUnread ? {
          icon: '✓',
          label: 'Mark as read',
          action: async () => {
            const r = await window.navio.gmailModifyMessage(msg.id, [], ['UNREAD']);
            if (r?.ok) { el.classList.remove('unread'); }
          }
        } : {
          icon: '○',
          label: 'Mark as unread',
          action: async () => {
            const r = await window.navio.gmailModifyMessage(msg.id, ['UNREAD'], []);
            if (r?.ok) { el.classList.add('unread'); }
          }
        },
        {
          icon: '★',
          label: 'Star',
          action: async () => { await window.navio.gmailModifyMessage(msg.id, ['STARRED'], []); }
        },
        {
          icon: '⬇',
          label: 'Archive',
          action: async () => {
            const r = await window.navio.gmailModifyMessage(msg.id, [], ['INBOX']);
            if (r?.ok) { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }
          }
        },
        'sep',
        {
          icon: '✉',
          label: 'Draft reply',
          action: () => {
            const draftBtn = el.querySelector('.ntp-email-draft-btn');
            if (draftBtn) draftBtn.click();
          }
        },
        'sep',
        {
          icon: '🗑',
          label: 'Move to Trash',
          danger: true,
          action: async () => {
            const r = await window.navio.gmailTrashMessage(msg.id);
            if (r?.ok) { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }
          }
        }
      ]);
      _positionEmailCtxMenu(menu, e);
    });
  }

  function _attachImapCtxMenu(el, uid, svcId) {
    el.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = _buildEmailCtxMenu([
        {
          icon: '✓',
          label: 'Mark as read',
          action: async () => {
            const r = await window.navio.imapMarkRead(svcId, uid);
            if (r?.ok) { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }
          }
        },
        {
          icon: '✉',
          label: 'Draft reply',
          action: () => {
            const draftBtn = el.querySelector('.ntp-email-draft-btn');
            if (draftBtn) draftBtn.click();
          }
        },
        'sep',
        {
          icon: '🗑',
          label: 'Delete',
          danger: true,
          action: async () => {
            const r = await window.navio.imapTrashMessage(svcId, uid);
            if (r?.ok) { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }
          }
        }
      ]);
      _positionEmailCtxMenu(menu, e);
    });
  }

  // Close ctx menu on any outside click or Escape
  document.addEventListener('click', _closeEmailCtxMenu, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeEmailCtxMenu(); });

  // ── AI draft for a single email (via IMAP, no tab needed) ────────────────

  async function _draftSingleEmail(svcId, uid, fromName, subject, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        alert('No AI API key configured. Open Settings → AI to add one.');
        return;
      }

      const bodyResult = await window.navio.imapGetEmailBody(svcId, uid);
      const body = bodyResult?.body || '';

      const messages = [
        { role: 'system', content: 'You are drafting an email reply on behalf of the user. Write ONLY the reply text — no preamble, no "Here is a draft" prefix. Be professional and concise.' },
        { role: 'user', content: `Draft a reply to this email:\n\nFrom: ${fromName}\nSubject: ${subject}\n\nBody:\n${body.slice(0, 3000)}` }
      ];

      const result = await window.navio.aiRequest({ messages });
      if (result.error) throw new Error(result.error);

      if (typeof LiveConnectorManager !== 'undefined') {
        LiveConnectorManager._showDraftModal({
          draft: result.content,
          context: { subject, sender: fromName },
          serviceId: svcId,
          tabId: null,
          providerLabel: config.aiModel || config.aiProvider || 'AI'
        });
      }

      setTimeout(() => {
        const injectBtn = document.getElementById('lm-inject');
        if (injectBtn) {
          injectBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
            Save as Draft
          `;
          injectBtn.replaceWith(injectBtn.cloneNode(true));
          document.getElementById('lm-inject')?.addEventListener('click', async () => {
            const draftText = document.getElementById('lm-draft-text')?.value || '';
            const draft = await window.navio.imapCreateDraft(svcId, {
              to: fromName,
              subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
              body: draftText
            });
            if (draft?.ok) {
              document.getElementById('live-draft-modal')?.classList.remove('active');
              if (typeof LiveConnectorManager !== 'undefined') {
                LiveConnectorManager._showToast('Draft saved to your Drafts folder.', 'success');
              }
            } else {
              alert(`Could not save draft: ${draft?.error}`);
            }
          });
        }
      }, 100);

    } catch (e) {
      alert(`Could not generate draft: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✦ Draft reply'; }
    }
  }

  // ── AI draft for a Gmail OAuth email (no tab needed) ─────────────────────

  async function _draftGmailEmail(msgId, subject, fromName, senderEmail, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        alert('No AI API key configured. Open Settings → AI to add one.');
        return;
      }

      const msgData = await window.navio.gmailGetMessageBody(msgId);
      const body    = msgData?.body    || '';
      const snippet = msgData?.snippet || '';
      const date    = msgData?.date    || '';

      // Build style context from saved examples
      let styleCtx = '';
      if (typeof LiveConnectorManager !== 'undefined') {
        const examples = LiveConnectorManager._data?.styleMemory?.gmail?.examples || [];
        if (examples.length) {
          styleCtx = '\n\nExamples of how I typically reply:\n' +
            examples.slice(-3).map(ex => `---\nSubject: ${ex.subject}\nMy reply: ${ex.reply}`).join('\n');
        }
      }

      const systemPrompt =
        'You are a professional email assistant drafting a reply on behalf of the user. ' +
        'Write ONLY the reply body — no preamble, no subject line, no "Here is a draft" intro. ' +
        'Match the tone of the original email (professional if formal, friendly if casual). ' +
        'Be concise and clear.' + styleCtx;

      const emailCtx =
        `Draft a reply to this email:\n\nFrom: ${fromName} <${senderEmail}>\nDate: ${date}\nSubject: ${subject}\n\n` +
        `Body:\n${(body || snippet).slice(0, 3500)}`;

      const result = await window.navio.aiRequest({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: emailCtx }
        ]
      });
      if (result.error) throw new Error(result.error);

      if (typeof LiveConnectorManager !== 'undefined') {
        LiveConnectorManager._showDraftModal({
          draft: result.content,
          context: { subject, sender: fromName },
          serviceId: 'gmail',
          tabId: null,
          providerLabel: config.aiModel || config.aiProvider || 'AI'
        });
      }

      // Replace "Send to Gmail" button with a "Open reply in Gmail" button
      // (uses Gmail compose URL — works without an open Gmail tab)
      setTimeout(() => {
        const injectBtn = document.getElementById('lm-inject');
        if (injectBtn) {
          injectBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.37 2 2 0 0 1 3.58 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9c1.91 3.28 4.85 6.22 8.13 8.13l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
            Reply in Gmail
          `;
          injectBtn.replaceWith(injectBtn.cloneNode(true));
          document.getElementById('lm-inject')?.addEventListener('click', () => {
            const draftText = document.getElementById('lm-draft-text')?.value || '';
            const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
            // Try inject into open Gmail tab first; fall back to compose URL
            const gmailTab = typeof TabManager !== 'undefined'
              ? TabManager.tabs?.find(t => (t.webview?.src || t.url || '').includes('mail.google.com'))
              : null;
            if (gmailTab && typeof LiveConnectorManager !== 'undefined') {
              LiveConnectorManager._injectDraft('gmail', gmailTab.id, draftText);
            } else {
              const composeUrl = `https://mail.google.com/mail/?view=cm` +
                `&to=${encodeURIComponent(senderEmail)}` +
                `&su=${encodeURIComponent(replySubject)}` +
                `&body=${encodeURIComponent(draftText)}`;
              if (typeof TabManager !== 'undefined') TabManager.createTab(composeUrl);
              else window.open(composeUrl, '_blank');
              document.getElementById('live-draft-modal')?.classList.remove('active');
            }
          });
        }
      }, 100);

    } catch (e) {
      alert(`Could not generate draft: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✦ Draft reply'; }
    }
  }

  // ── AI inbox analysis (unanswered emails + action items) ─────────────────

  /**
   * Converts a markdown-style AI analysis response into clean structured HTML.
   * Produces section headers, bullet lists, and paragraphs — no flat wall of text.
   */
  function _markdownToHtml(text) {
    const fmt = (s) =>
      _esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');

    const lines = text.split('\n');
    const parts = [];
    let listItems = [];

    const flushList = () => {
      if (listItems.length) {
        parts.push('<ul class="ntp-brief-bullets">' + listItems.map(i => `<li>${i}</li>`).join('') + '</ul>');
        listItems = [];
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { flushList(); continue; }

      // Section header: ### Header, **Header:**, or 1. **Header:**
      const h =
        line.match(/^#{1,3}\s+(.+)/) ||
        line.match(/^\*\*([^*]+)\*\*\s*:?\s*$/) ||
        line.match(/^\d+\.\s+\*\*([^*]+)\*\*\s*:?\s*$/);
      if (h) {
        flushList();
        const title = h[1].replace(/\*\*/g, '').replace(/:$/, '').trim();
        parts.push(`<div class="ntp-brief-section-head">${_esc(title)}</div>`);
        continue;
      }

      // Bullet / numbered list item
      const b = line.match(/^[-*•]\s+(.+)/) || line.match(/^\d+\.\s+(.+)/);
      if (b) { listItems.push(fmt(b[1])); continue; }

      // Plain paragraph
      flushList();
      parts.push(`<p>${fmt(line)}</p>`);
    }

    flushList();
    return parts.join('');
  }

  async function _analyzeInbox(btn) {
    if (!_inboxMessages.length) {
      alert('No emails loaded yet. Please wait for the inbox to load first.');
      return;
    }
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';

    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        alert('No AI API key configured. Open Settings → AI to add one.');
        return;
      }

      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const emailSummary = _inboxMessages.slice(0, 15).map((m, i) => {
        const d    = m.date ? new Date(m.date) : null;
        const when = d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown date';
        const read = m.unread === false ? 'read' : 'unread';
        return `${i + 1}. [${read}] ${when} — From: ${m.senderName || m.sender || 'unknown'} — Subject: ${m.subject}${m.snippet ? '\n   Preview: ' + m.snippet : ''}`;
      }).join('\n');

      const prompt =
        `Today is ${today}.\n\nHere are the emails in my inbox:\n\n${emailSummary}\n\n` +
        `Please analyze this inbox and tell me:\n` +
        `1. Which emails from today likely still need a reply from me?\n` +
        `2. Any urgent action items or deadlines I should know about?\n` +
        `3. Which emails are informational (no action needed)?\n\n` +
        `Be concise. Format with clear sections.`;

      const result = await window.navio.aiRequest({
        messages: [
          { role: 'system', content: 'You are a smart email assistant helping the user triage their inbox. Be concise, practical, and list the most important items first. No fluff.' },
          { role: 'user',   content: prompt }
        ],
        ntpBrief: true
      });
      if (result.error) throw new Error(result.error);

      const list = document.getElementById('ntp-email-list');
      if (list) {
        list.querySelector('#ntp-inbox-analysis-slot')?.remove();
        const html = _markdownToHtml(result.content || '');
        const stamp = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const slot = document.createElement('div');
        slot.id = 'ntp-inbox-analysis-slot';
        slot.className = 'ntp-inbox-analysis-slot';
        slot.innerHTML = `<div class="ntp-brief-content">
          <div class="ntp-brief-datestamp">Inbox analysis <span class="ntp-brief-time">· ${_esc(stamp)}</span></div>
          <div class="ntp-brief-analysis">${html}</div>
        </div>`;
        list.insertBefore(slot, list.firstChild);
        document.getElementById('ntp-widget-email')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        // Fallback: show in a simple modal-style overlay on the NTP
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-surface,#1e1e2e);color:var(--text-primary,#cdd6f4);border-radius:12px;padding:24px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto;font-size:13px;line-height:1.6;box-shadow:0 20px 60px rgba(0,0,0,.5)';
        card.innerHTML = `<div style="font-weight:700;font-size:15px;margin-bottom:12px">Inbox Analysis</div>` +
          result.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>') +
          `<div style="margin-top:16px;text-align:right"><button style="padding:6px 16px;border-radius:6px;border:none;background:var(--accent,#89b4fa);color:#1e1e2e;cursor:pointer;font-size:12px">Close</button></div>`;
        overlay.appendChild(card);
        card.querySelector('button').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
      }
    } catch (e) {
      alert(`Inbox analysis failed: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  // ── IMAP-based batch draft (when no email tab is open) ───────────────────

  async function _imapBatchDraft(svcId, messages) {
    if (typeof LiveConnectorManager === 'undefined') return;
    const def = LiveConnectorManager.LIVE_CAPABLE?.[svcId] || { name: svcId, gradient: '#333', icon: '✉' };
    LiveConnectorManager._showBatchDraftModal({
      phase: 'draft', serviceId: svcId, def,
      email: messages[0], idx: 0, total: messages.length,
      draft: '', emails: messages, tabId: null
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _esc(t) {
    return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _domain(url) {
    if (!url) return '';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  const _HEADLINE_STOP = new Set([
    'what', 'when', 'where', 'which', 'about', 'that', 'this', 'with', 'from', 'have', 'does', 'your',
    'how', 'why', 'they', 'them', 'their', 'been', 'will', 'would', 'could', 'should', 'just', 'like',
    'into', 'than', 'then', 'some', 'also', 'very', 'make', 'know', 'take', 'each'
  ]);

  /** Rank headlines by token overlap with query; fall back to top stories. */
  function _rankHeadlinesForQuery(query, limit) {
    const lim = Math.min(12, Math.max(3, limit || 6));
    const q = (query || '').toLowerCase().trim();
    const qw = q.split(/\W+/).filter((w) => w.length > 2 && !_HEADLINE_STOP.has(w));
    if (qw.length === 0 || !_newsHeadlines.length) {
      return { list: _newsHeadlines.slice(0, lim), fromQuery: false };
    }
    const scored = _newsHeadlines.map((h) => {
      const hl = h.toLowerCase();
      let s = 0;
      for (const w of qw) {
        if (hl.includes(w)) s += w.length + 2;
      }
      return { h, s };
    });
    const hit = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (hit.length === 0) {
      return { list: _newsHeadlines.slice(0, lim), fromQuery: false };
    }
    return { list: hit.slice(0, lim).map((x) => x.h), fromQuery: true };
  }

  function _timeAgo(iso) {
    if (!iso) return '';
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
    return `${Math.round(d / 86400000)}d ago`;
  }

  function _formatEmailDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      const diff = Date.now() - d.getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.round(diff / 60000)}m`;
      if (diff < 86400000) return `${Math.round(diff / 3600000)}h`;
      if (diff < 604800000) return `${Math.round(diff / 86400000)}d`;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch { return dateStr; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  NTP CHAT — Comet-style inline streaming conversation
  // ══════════════════════════════════════════════════════════════════════════

  /** Escape HTML for safe insertion */
  function _ntpEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Minimal markdown → HTML for chat bubbles (bold, italic, code, newlines) */
  function _ntpMd(text) {
    let t = String(text);
    t = t.replace(/\[FOLLOWUP\][\s\S]*?\[\/FOLLOWUP\]/gi, '');
    t = t.replace(/\[FOLLOWUP\][\s\S]*/gi, '');
    return _ntpEsc(t)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
  }

  /** Show the chat panel, hide hero/shortcuts/widgets */
  function _ntpShowChatPanel() {
    const panel = document.getElementById('ntp-chat-panel');
    if (!panel) return;
    panel.hidden = false;
    document.body.classList.add('ntp-chat-active');
  }

  /** Hide chat panel, restore home view */
  function _ntpCloseChat() {
    const panel = document.getElementById('ntp-chat-panel');
    if (panel) panel.hidden = true;
    document.body.classList.remove('ntp-chat-active');
  }

  /** Cancel any in-flight stream subscriptions */
  function _ntpCancelStream() {
    _ntpChatStreamUnsubs.forEach(fn => { try { fn(); } catch {} });
    _ntpChatStreamUnsubs = [];
    _ntpChatStreaming = false;
  }

  /**
   * Main entry: start or continue a chat on the NTP.
   * Creates bubbles, subscribes to stream, then fires aiRequestStream.
   */
  async function _ntpStartChat(query) {
    if (!query || !query.trim()) return;
    const q = query.trim();

    _ntpShowChatPanel();

    const messagesEl = document.getElementById('ntp-chat-messages');
    if (!messagesEl) return;

    // Guard: don't start a second stream while one is active
    if (_ntpChatStreaming) {
      _ntpCancelStream();
    }

    // Append user bubble
    const userBubble = document.createElement('div');
    userBubble.className = 'ntp-chat-bubble ntp-chat-bubble-user';
    userBubble.textContent = q;
    messagesEl.appendChild(userBubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Append assistant streaming bubble
    const aiBubble = document.createElement('div');
    aiBubble.className = 'ntp-chat-bubble ntp-chat-bubble-ai ntp-chat-bubble-streaming';
    aiBubble.innerHTML = '<span class="ntp-streaming-cursor"></span>';
    messagesEl.appendChild(aiBubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Build messages array for the API
    _ntpChatMessages.push({ role: 'user', content: q });
    const messages = [{ role: 'user', content: q }];
    if (_ntpChatMessages.length > 2) {
      // Include prior context (last 10 turns)
      const history = _ntpChatMessages.slice(0, -1).slice(-10);
      messages.unshift(...history);
    }

    _ntpChatStreaming = true;
    let buffer = '';

    const unChunk = window.navio.onAiStreamChunk((payload) => {
      let tid, text;
      if (typeof payload === 'string') { tid = '__default__'; text = payload; }
      else { tid = payload?.tabId != null ? String(payload.tabId) : '__default__'; text = payload?.text ?? ''; }
      if (tid !== _ntpChatStreamKey && tid !== '__default__') return;
      if (!text) return;
      buffer += text;
      aiBubble.innerHTML = '<p>' + _ntpMd(buffer) + '</p>';
      aiBubble.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });

    const finalize = (content) => {
      _ntpCancelStream();
      aiBubble.classList.remove('ntp-chat-bubble-streaming');
      aiBubble.innerHTML = '<p>' + _ntpMd(content || buffer) + '</p>' + _ntpMakeTTSBtn(content || buffer);
      _ntpChatMessages.push({ role: 'assistant', content: content || buffer });
      _ntpSaveThread();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    };

    const unDone = window.navio.onAiStreamDone((payload) => {
      const tid = payload?.tabId != null ? String(payload.tabId) : '__default__';
      if (tid !== _ntpChatStreamKey && tid !== '__default__') return;
      finalize(buffer);
    });

    const unErr = window.navio.onAiStreamError((msg) => {
      const errObj = typeof msg === 'string' ? { tabId: '__default__', message: msg } : (msg || {});
      const tid = errObj.tabId != null ? String(errObj.tabId) : '__default__';
      if (tid !== _ntpChatStreamKey && tid !== '__default__') return;
      if (!buffer) {
        aiBubble.innerHTML = '<span class="ntp-chat-error">Error: ' + _ntpEsc(errObj.message || 'Unknown error') + '</span>';
        _ntpChatStreaming = false;
        _ntpCancelStream();
      } else {
        finalize(buffer);
      }
    });

    _ntpChatStreamUnsubs = [unChunk, unDone, unErr];

    try {
      const cfg = await window.navio.getConfig();
      if (!cfg.hasApiKey) {
        aiBubble.innerHTML = '<span class="ntp-chat-error">No AI key configured. Add one in <strong>Settings → AI</strong>.</span>';
        _ntpCancelStream();
        return;
      }
      await window.navio.aiRequestStream({ messages, tabId: _ntpChatStreamKey });
    } catch (e) {
      aiBubble.innerHTML = '<span class="ntp-chat-error">Error: ' + _ntpEsc(e.message) + '</span>';
      _ntpCancelStream();
    }
  }

  /** Build a small speaker button HTML for TTS */
  function _ntpMakeTTSBtn(text) {
    const safe = _ntpEsc(text).replace(/'/g, '&#39;');
    return `<button class="ntp-chat-tts-btn" type="button" title="Read aloud" data-text="${safe}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
    </button>`;
  }

  /** Bind follow-up input in the chat panel */
  function _bindNtpChatPanel() {
    const followInput = document.getElementById('ntp-chat-followup-input');
    const followSend  = document.getElementById('ntp-chat-followup-send');
    const newBtn      = document.getElementById('ntp-chat-new');

    const submitFollowUp = () => {
      const val = followInput?.value.trim();
      if (!val) return;
      if (followInput) followInput.value = '';
      _ntpStartChat(val);
    };

    followInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFollowUp(); }
    });
    followSend?.addEventListener('click', submitFollowUp);

    newBtn?.addEventListener('click', () => {
      _ntpChatMessages = [];
      const messagesEl = document.getElementById('ntp-chat-messages');
      if (messagesEl) messagesEl.innerHTML = '';
      _ntpCloseChat();
      document.getElementById('ntp-search-input')?.focus();
    });

    // Delegate TTS button clicks in the chat panel
    document.getElementById('ntp-chat-messages')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.ntp-chat-tts-btn');
      if (!btn) return;
      const text = btn.dataset.text || '';
      _ntpSpeak(text);
    });

    // Load and render history list
    _ntpRenderHistoryList();
  }

  // ── NTP Chat History ──────────────────────────────────────────────────────

  const _NTP_STORAGE_KEY = 'navio-ntp-chat-threads';

  function _ntpLoadSessions() {
    try {
      return JSON.parse(localStorage.getItem(_NTP_STORAGE_KEY) || '[]');
    } catch { return []; }
  }

  function _ntpSaveThread() {
    if (_ntpChatMessages.length < 2) return;
    const sessions = _ntpLoadSessions();
    const title = (_ntpChatMessages[0]?.content || 'Chat').slice(0, 60);
    const id = _ntpChatStreamKey;
    const existing = sessions.findIndex(s => s.id === id);
    const entry = { id, title, ts: Date.now(), messages: _ntpChatMessages.slice() };
    if (existing >= 0) sessions[existing] = entry;
    else sessions.unshift(entry);
    // Keep last 50 sessions
    localStorage.setItem(_NTP_STORAGE_KEY, JSON.stringify(sessions.slice(0, 50)));
    _ntpRenderHistoryList();
  }

  function _ntpRenderHistoryList() {
    const list = document.getElementById('ntp-chat-history-list');
    if (!list) return;
    const sessions = _ntpLoadSessions();
    if (sessions.length === 0) {
      list.innerHTML = '<p class="ntp-history-empty">No history yet</p>';
      return;
    }
    list.innerHTML = sessions.map(s => `
      <div class="ntp-history-item" data-id="${_ntpEsc(s.id)}">
        <span class="ntp-history-title">${_ntpEsc(s.title)}</span>
        <button class="ntp-history-del" type="button" data-id="${_ntpEsc(s.id)}" title="Delete">×</button>
      </div>`).join('');

    list.querySelectorAll('.ntp-history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.ntp-history-del')) return;
        const id = item.dataset.id;
        const session = sessions.find(s => s.id === id);
        if (!session) return;
        _ntpChatMessages = session.messages.slice();
        const messagesEl = document.getElementById('ntp-chat-messages');
        if (!messagesEl) return;
        messagesEl.innerHTML = '';
        _ntpChatMessages.forEach(msg => {
          const bubble = document.createElement('div');
          bubble.className = 'ntp-chat-bubble ' + (msg.role === 'user' ? 'ntp-chat-bubble-user' : 'ntp-chat-bubble-ai');
          if (msg.role === 'assistant') {
            bubble.innerHTML = '<p>' + _ntpMd(msg.content) + '</p>' + _ntpMakeTTSBtn(msg.content);
          } else {
            bubble.textContent = msg.content;
          }
          messagesEl.appendChild(bubble);
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
        _ntpShowChatPanel();
      });
    });

    list.querySelectorAll('.ntp-history-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const updated = sessions.filter(s => s.id !== id);
        localStorage.setItem(_NTP_STORAGE_KEY, JSON.stringify(updated));
        _ntpRenderHistoryList();
      });
    });
  }

  // ── NTP Voice Mode ────────────────────────────────────────────────────────

  function _bindNtpVoiceMode() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    let recognition = null;
    let listening = false;

    const startListening = (targetInput, onFinal) => {
      if (listening) { stopListening(); return; }
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => { listening = true; };
      recognition.onresult = (e) => {
        const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
        if (targetInput) targetInput.value = transcript;
        if (e.results[e.results.length - 1].isFinal) {
          stopListening();
          if (transcript.trim()) onFinal(transcript.trim());
        }
      };
      recognition.onerror = () => stopListening();
      recognition.onend   = () => stopListening();
      recognition.start();
    };

    const stopListening = () => {
      listening = false;
      if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
      document.getElementById('ntp-search-mic')?.classList.remove('listening');
      document.getElementById('ntp-chat-voice')?.classList.remove('listening');
    };

    // Search bar mic
    const searchMic = document.getElementById('ntp-search-mic');
    const searchInput = document.getElementById('ntp-search-input');
    searchMic?.addEventListener('click', () => {
      searchMic.classList.toggle('listening');
      startListening(searchInput, (text) => { _ntpStartChat(text); });
    });

    // Follow-up mic inside chat panel
    const chatMic = document.getElementById('ntp-chat-voice');
    const followInput = document.getElementById('ntp-chat-followup-input');
    chatMic?.addEventListener('click', () => {
      chatMic.classList.toggle('listening');
      startListening(followInput, (text) => { _ntpStartChat(text); });
    });
  }

  // ── NTP TTS ───────────────────────────────────────────────────────────────

  function _ntpSpeak(text) {
    if (!window.speechSynthesis) return;
    const plain = text.replace(/<[^>]+>/g, '').replace(/[#*`_~]/g, '').trim();
    if (!plain) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
  }

  // ── NTP Model Selector ────────────────────────────────────────────────────

  const _NTP_KNOWN_MODELS = [
    { label: 'GPT-4o',         value: 'gpt-4o',            provider: 'openai' },
    { label: 'GPT-4o mini',    value: 'gpt-4o-mini',       provider: 'openai' },
    { label: 'o3',             value: 'o3',                 provider: 'openai' },
    { label: 'Claude Opus 4',  value: 'claude-opus-4-5',   provider: 'anthropic' },
    { label: 'Claude Sonnet 4',value: 'claude-sonnet-4-5', provider: 'anthropic' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro',    provider: 'google' },
    { label: 'Gemini 2.5 Flash',value:'gemini-2.5-flash',  provider: 'google' },
  ];

  async function _bindNtpModelSelector() {
    const btn      = document.getElementById('ntp-model-btn');
    const label    = document.getElementById('ntp-model-label');
    const dropdown = document.getElementById('ntp-model-dropdown');
    if (!btn || !dropdown) return;

    // Load current model from config
    let currentModel = '';
    try {
      const cfg = await window.navio.getConfig();
      currentModel = cfg.model || '';
    } catch {}

    const updateLabel = (val) => {
      const m = _NTP_KNOWN_MODELS.find(m => m.value === val);
      if (label) label.textContent = m ? m.label : (val || 'AI');
    };
    updateLabel(currentModel);

    // Build dropdown items
    const renderDropdown = (current) => {
      dropdown.innerHTML = _NTP_KNOWN_MODELS.map(m => `
        <button class="ntp-model-option${m.value === current ? ' active' : ''}" type="button" data-value="${m.value}">
          ${_ntpEsc(m.label)}
        </button>`).join('');
      dropdown.querySelectorAll('.ntp-model-option').forEach(opt => {
        opt.addEventListener('click', async () => {
          const val = opt.dataset.value;
          try { await window.navio.setConfig({ model: val }); } catch {}
          currentModel = val;
          updateLabel(val);
          renderDropdown(val);
          dropdown.hidden = true;
        });
      });
    };
    renderDropdown(currentModel);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.hidden = !dropdown.hidden;
    });
    document.addEventListener('click', () => { dropdown.hidden = true; });
  }

  // ── Background dim slider ─────────────────────────────────────────────────

  function _applyDim(value) {
    const clamped = Math.max(0, Math.min(100, Number(value)));
    // 0 = black, 100 = original photo (brightness 1.0)
    const brightness = (clamped / 100).toFixed(2);
    const bgLayer = document.querySelector('.ntp-bg-layer');
    if (bgLayer) bgLayer.style.filter = `brightness(${brightness})`;
    const slider = document.getElementById('ntp-dim-slider');
    if (slider) slider.style.setProperty('--slider-pct', clamped.toFixed(1) + '%');
  }

  function _bindDimSlider() {
    const slider = document.getElementById('ntp-dim-slider');
    if (!slider) return;

    // Load saved value — key ntpBgBrightness, default 100 = fully bright
    (async () => {
      try {
        const cfg = await window.navio.getConfig();
        const saved = typeof cfg.ntpBgBrightness === 'number' ? cfg.ntpBgBrightness : 100;
        slider.value = String(saved);
        _applyDim(saved);
      } catch {
        _applyDim(100);
      }
    })();

    // Live update while dragging
    slider.addEventListener('input', () => _applyDim(Number(slider.value)));

    // Persist on release
    slider.addEventListener('change', async () => {
      const val = Number(slider.value);
      _applyDim(val);
      try {
        const cfg = await window.navio.getConfig();
        cfg.ntpBgBrightness = val;
        await window.navio.saveConfig(cfg);
      } catch { /* ignore */ }
    });
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  NTP.init();
});
