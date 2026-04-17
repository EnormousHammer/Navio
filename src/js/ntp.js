/**
 * Navio Browser — New Tab Page controller
 *
 * Dashboard features:
 *  • Greeting + live clock
 *  • Connected services status bar (IMAP email counts)
 *  • World News (Reddit r/worldnews — free, CORS-enabled JSON API)
 *  • Stock market ticker (Yahoo Finance via main-process IPC — bypasses CORS)
 *  • Bottom ticker SPORTS tab — streamed.pk listings (click to open stream), ESPN fallback
 *  • Inbox widget — unread emails from IMAP Gmail/Outlook
 *  • "Draft All" button — triggers batch email drafting
 */

const NTP = (() => {
  let _mode = 'search'; // 'search' | 'ai' | 'task'
  let _ntpVisible = false;
  let _newsHeadlines  = [];   // cached for AI brief
  let _stockData      = [];   // cached for AI brief
  let _inboxMessages  = [];   // cached from _loadInbox() for AI brief
  let _tickerMode = 'markets'; // 'markets' | 'sports' | 'news'
  /** Matches shown in SPORTS ticker when using streamed.pk (indexed by data-stream-match-idx). */
  let _tickerLiveMatches = [];
  let _streamedTickerCacheRows = null;
  let _streamedTickerCacheAt = 0;
  const STREAMED_TICKER_CACHE_MS = 60000;
  const DEFAULT_NTP_LIVE_SPORTS_CATALOG = [
    { id: 'football', name: 'Football' },
    { id: 'basketball', name: 'NBA' },
    { id: 'american-football', name: 'NFL' },
    { id: 'hockey', name: 'Hockey' },
    { id: 'baseball', name: 'Baseball' },
    { id: 'fight', name: 'Fight' },
    { id: 'tennis', name: 'Tennis' },
    { id: 'motor-sports', name: 'Motorsports' }
  ];

  // ── Init ──────────────────────────────────────────────────────────────────

  function _applyTickerBottomReserve() {
    const ntp = document.getElementById('new-tab-page');
    const ticker = document.getElementById('ntp-stock-ticker');
    if (!ticker || !document.documentElement) return;
    const show =
      !!ntp?.classList.contains('active') && ticker.classList.contains('visible');
    let reservePx = 0;
    if (show) {
      const h = ticker.offsetHeight || ticker.getBoundingClientRect().height || 34;
      reservePx = Math.ceil(h + 4);
    }
    document.documentElement.style.setProperty('--ntp-ticker-reserve', `${reservePx}px`);
  }

  if (typeof window !== 'undefined') {
    window.__navioApplyNtpTickerReserve = _applyTickerBottomReserve;
  }

  function init() {
    _startClock();
    _bindModeTabs();
    _bindSearchInput();
    _bindShortcuts();
    _bindTickerTabs();
    _bindSportsTickerClicks();
    _bindWidgetPopouts();
    _bindResultsPanel();
    _bindNtpSlashFocus();

    const tickerEl = document.getElementById('ntp-stock-ticker');
    if (tickerEl && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => _applyTickerBottomReserve());
      ro.observe(tickerEl);
      _applyTickerBottomReserve();
    }

    const observer = new MutationObserver(() => {
      const isActive = document.getElementById('new-tab-page')?.classList.contains('active');
      const ticker = document.getElementById('ntp-stock-ticker');
      if (isActive && !_ntpVisible) {
        _ntpVisible = true;
        if (ticker) ticker.classList.add('visible');
        requestAnimationFrame(() => _applyTickerBottomReserve());
        _onShow();
      } else if (!isActive) {
        _ntpVisible = false;
        if (ticker) ticker.classList.remove('visible');
        _applyTickerBottomReserve();
      }
    });
    const ntp = document.getElementById('new-tab-page');
    if (ntp) observer.observe(ntp, { attributes: true, attributeFilter: ['class'] });
    if (ntp?.classList.contains('active')) {
      _ntpVisible = true;
      document.getElementById('ntp-stock-ticker')?.classList.add('visible');
      requestAnimationFrame(() => _applyTickerBottomReserve());
      _onShow();
    }

    _syncNtpNoEmailLayout();
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
        _loadTickerForMode().catch(() => {})
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

  // ── Bottom Ticker — Tab Switching ─────────────────────────────────────────

  function _bindTickerTabs() {
    const tabs = document.getElementById('ntp-ticker-tabs');
    if (!tabs) return;
    tabs.addEventListener('click', e => {
      const btn = e.target.closest('.ntp-ticker-tab');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === _tickerMode) return;
      _tickerMode = tab;
      tabs.querySelectorAll('.ntp-ticker-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      _loadTickerForMode();
    });
  }

  function _loadTickerForMode() {
    if (_tickerMode === 'markets') _loadStockTicker();
    else if (_tickerMode === 'sports') _loadSportsTicker();
    else if (_tickerMode === 'news') _loadNewsTicker();
  }

  function _bindSportsTickerClicks() {
    const viewport = document.querySelector('.ntp-ticker-viewport');
    if (!viewport || viewport.dataset.streamClicksBound === '1') return;
    viewport.dataset.streamClicksBound = '1';
    viewport.addEventListener('click', (e) => {
      if (_tickerMode !== 'sports') return;
      const btn = e.target.closest('[data-stream-match-idx]');
      if (!btn) return;
      e.preventDefault();
      const idx = parseInt(btn.getAttribute('data-stream-match-idx'), 10);
      if (Number.isNaN(idx)) return;
      const match = _tickerLiveMatches[idx];
      if (match) void _openStreamedMatch(match);
    });
  }

  async function _loadLiveSportsCatalogFromConfig() {
    try {
      const cfg = await window.navio.getConfig();
      const raw = cfg?.ntpLiveSportsCatalog;
      if (!Array.isArray(raw) || raw.length === 0) {
        return DEFAULT_NTP_LIVE_SPORTS_CATALOG.slice();
      }
      const out = raw
        .map((row) => {
          if (row == null) return null;
          if (typeof row === 'string') {
            const id = row.trim();
            return id ? { id, name: id } : null;
          }
          const id = String(row.id ?? row.slug ?? '').trim();
          if (!id) return null;
          let name = String(row.name || row.title || id).trim() || id;
          if (id === 'basketball' && /^basketball$/i.test(name)) name = 'NBA';
          return { id, name };
        })
        .filter(Boolean);
      return out.length ? out : DEFAULT_NTP_LIVE_SPORTS_CATALOG.slice();
    } catch {
      return DEFAULT_NTP_LIVE_SPORTS_CATALOG.slice();
    }
  }

  async function _streamedPkRequest(apiPath) {
    if (!window.navio?.streamedPkApi) return { error: 'streamed_api_unavailable' };
    try {
      const res = await window.navio.streamedPkApi(apiPath);
      if (res?.error) return { error: res.error };
      if (res?.ok && res.data !== undefined) return { ok: true, data: res.data };
      return { error: 'bad_response' };
    } catch (e) {
      return { error: e?.message || 'ipc_failed' };
    }
  }

  function _streamedExtractPlayableUrl(entry) {
    if (entry == null) return null;
    const isHttp = (x) => typeof x === 'string' && /^https?:\/\//i.test(x.trim());
    if (typeof entry === 'string' && isHttp(entry)) return entry.trim();
    if (typeof entry !== 'object') return null;
    const o = entry;
    const keys = ['stream', 'url', 'src', 'link', 'streamUrl', 'embedUrl', 'hls', 'm3u8', 'playlist'];
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && isHttp(v)) return v.trim();
    }
    const embed = o.embed;
    if (typeof embed === 'string') {
      const m = embed.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (m && isHttp(m[1])) return m[1].trim();
      if (isHttp(embed)) return embed.trim();
    }
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && isHttp(v)) return v.trim();
    }
    return null;
  }

  function _streamedTickerTitle(m) {
    if (m?.title) return m.title;
    const h = m?.teams?.home?.name;
    const a = m?.teams?.away?.name;
    if (h && a) return `${a} vs ${h}`;
    return 'Live event';
  }

  /** Event start time is in the past but within max typical broadcast length → treat as live for the ticker. */
  const STREAMED_LIVE_MAX_PAST_MS = 6 * 60 * 60 * 1000;

  function _isStreamedMatchLiveNow(m) {
    if (!m) return false;
    if (m.live === true || m.isLive === true) return true;
    const d = m?.date;
    if (typeof d !== 'number' || Number.isNaN(d)) return false;
    const delta = d - Date.now();
    return delta <= 0 && delta > -STREAMED_LIVE_MAX_PAST_MS;
  }

  async function _openStreamedMatch(match) {
    const sources = match?.sources;
    if (!Array.isArray(sources) || sources.length === 0) return;
    for (const src of sources) {
      if (!src?.source || src.id == null) continue;
      const p = `stream/${encodeURIComponent(src.source)}/${encodeURIComponent(String(src.id))}`;
      const r = await _streamedPkRequest(p);
      if (r.error || !Array.isArray(r.data)) continue;
      for (const link of r.data) {
        const url = _streamedExtractPlayableUrl(link);
        if (url) {
          if (typeof TabManager !== 'undefined') TabManager.createTab(url);
          else if (window.navio?.openExternal) window.navio.openExternal(url);
          return;
        }
      }
    }
  }

  async function _fetchAggregatedStreamedMatches() {
    const now = Date.now();
    if (_streamedTickerCacheRows != null && now - _streamedTickerCacheAt < STREAMED_TICKER_CACHE_MS) {
      if (_streamedTickerCacheRows.length === 0) return [];
      const stillLive = _streamedTickerCacheRows.filter(_isStreamedMatchLiveNow);
      if (stillLive.length > 0) return stillLive;
    }
    const catalog = await _loadLiveSportsCatalogFromConfig();
    if (!catalog.length) return [];
    const settled = await Promise.allSettled(
      catalog.map(async (sport) => {
        const mr = await _streamedPkRequest(`matches/${encodeURIComponent(sport.id)}`);
        if (mr.error || !Array.isArray(mr.data)) return [];
        const label = sport.name || sport.id;
        return mr.data.slice(0, 24).map((m) => ({ ...m, _sportLabel: label }));
      })
    );
    const rows = [];
    for (const st of settled) {
      if (st.status === 'fulfilled') rows.push(...st.value);
    }
    const liveRows = rows.filter(_isStreamedMatchLiveNow);
    liveRows.sort((a, b) => {
      const da = typeof a?.date === 'number' ? a.date : 9e15;
      const db = typeof b?.date === 'number' ? b.date : 9e15;
      return da - db;
    });
    const trimmed = liveRows.slice(0, 40);
    _streamedTickerCacheRows = trimmed;
    _streamedTickerCacheAt = now;
    return trimmed;
  }

  // ── Sports Ticker — streamed.pk (click to watch) with ESPN fallback ─────────

  async function _loadSportsTicker(retried = false) {
    const track = document.getElementById('ntp-ticker-track');
    if (!track) return;

    _tickerLiveMatches = [];

    try {
      const streamed = await _fetchAggregatedStreamedMatches();
      if (_tickerMode !== 'sports') return;
      if (streamed.length > 0) {
        _tickerLiveMatches = streamed;
        const html = streamed
          .map((m, i) => {
            const rawTitle = _streamedTickerTitle(m);
            const title = _esc(rawTitle);
            const titleAttr = title.replace(/"/g, '&quot;');
            const league = _esc(m._sportLabel || 'LIVE');
            return `
            <button type="button" class="ntp-ticker-sport ntp-ticker-sport--stream" data-stream-match-idx="${i}" title="Open live stream — ${titleAttr}">
              <span class="ts-league">${league}</span>
              <span class="ts-matchup">${title}</span>
              <span class="ts-live">● LIVE</span>
            </button>
            <div class="ntp-ticker-sep">◆</div>`;
          })
          .join('');

        _setTickerTrack(html);
        return;
      }
    } catch {
      /* ESPN fallback */
    }

    if (_tickerMode !== 'sports') return;

    try {
      const result = await window.navio.ntpFetchSports();
      if (!result || result.error || !Array.isArray(result) || result.length === 0) {
        if (!retried && result?.error) {
          setTimeout(() => _loadSportsTicker(true), 3000);
          return;
        }
        track.innerHTML = '<span class="ntp-ticker-loading">No live games right now</span>';
        return;
      }

      const liveGames = result.filter((g) => g.live);
      if (liveGames.length === 0) {
        track.innerHTML = '<span class="ntp-ticker-loading">No live games right now</span>';
        return;
      }

      const html = liveGames.map(g => {
        const hasScore = g.homeScore !== '' && g.awayScore !== '';
        const matchup = hasScore
          ? `${g.away} <span class="ts-score">${g.awayScore}</span> · ${g.home} <span class="ts-score">${g.homeScore}</span>`
          : `${g.away} vs ${g.home}`;
        return `
          <div class="ntp-ticker-sport">
            <span class="ts-league">${g.league}</span>
            <span class="ts-matchup">${matchup}</span>
            <span class="ts-live">● LIVE</span>
          </div>
          <div class="ntp-ticker-sep">◆</div>
        `;
      }).join('');

      _setTickerTrack(html);
    } catch (e) {
      track.innerHTML = '<span class="ntp-ticker-loading">Sports data unavailable</span>';
    }
  }

  // ── News Ticker (reuses cached Reddit/HN headlines) ────────────────────────

  function _loadNewsTicker() {
    const track = document.getElementById('ntp-ticker-track');
    if (!track) return;

    const render = (headlines) => {
      if (!headlines || headlines.length === 0) {
        track.innerHTML = '<span class="ntp-ticker-loading">No headlines yet</span>';
        return;
      }
      const html = headlines.slice(0, 20).map(h => `
        <div class="ntp-ticker-news">
          <span class="tn-source">NEWS</span>
          <span class="tn-title">${_esc(h)}</span>
        </div>
        <div class="ntp-ticker-sep">◆</div>
      `).join('');
      _setTickerTrack(html);
    };

    if (_newsHeadlines.length > 0) {
      render(_newsHeadlines);
    } else {
      track.innerHTML = '<span class="ntp-ticker-loading">Loading headlines…</span>';
      // Wait briefly for _loadWorldNews to finish, then try again
      setTimeout(() => render(_newsHeadlines), 3500);
    }
  }

  // Helper: set ticker track content with seamless scroll duplication.
  // Dynamically sets animation duration so all modes scroll at the same pixels/sec.
  const TICKER_PX_PER_SEC = 120; // consistent scroll speed across markets/sports/news
  function _setTickerTrack(html) {
    const track = document.getElementById('ntp-ticker-track');
    if (!track) return;
    track.style.animation = 'none';
    track.innerHTML = html + html; // duplicate for seamless loop
    // Measure half-width (one content copy) after DOM update, then set duration
    void track.offsetWidth; // force reflow so scrollWidth is accurate
    const halfWidth = track.scrollWidth / 2;
    const duration = Math.max(10, Math.round(halfWidth / TICKER_PX_PER_SEC));
    track.style.setProperty('--ticker-duration', `${duration}s`);
    track.style.animation = ''; // re-enable (picks up the CSS var)
  }

  // ── Stock Market Ticker ────────────────────────────────────────────────────

  async function _loadStockTicker() {
    const track = document.getElementById('ntp-ticker-track');
    if (!track) return;
    if (_tickerMode !== 'markets') return; // don't overwrite another mode's content

    try {
      const result = await window.navio.ntpFetchStocks();
      if (!result || result.error || !Array.isArray(result) || result.length === 0) {
        track.innerHTML = '<span class="ntp-ticker-loading">Market data unavailable</span>';
        return;
      }

      if (_tickerMode !== 'markets') return; // mode may have changed while awaiting

      _stockData = result;

      const fmt = (n) => {
        if (n == null) return '—';
        return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      };

      const nameMap = {
        'GSPC': 'S&P 500', 'DJI': 'DOW', 'IXIC': 'NASDAQ',
        'BTC-USD': 'BTC', 'ETH-USD': 'ETH',
        'AAPL': 'AAPL', 'GOOGL': 'GOOGL', 'MSFT': 'MSFT',
        'AMZN': 'AMZN', 'TSLA': 'TSLA', 'META': 'META', 'NVDA': 'NVDA'
      };

      const html = result.map(s => {
        const up = (s.change || 0) >= 0;
        const pctStr = `${up ? '+' : ''}${(s.pct || 0).toFixed(2)}%`;
        const label = nameMap[s.symbol] || s.symbol;
        return `
          <div class="ntp-ticker-item ${up ? 'up' : 'down'}">
            <span class="ti-symbol">${label}</span>
            <span class="ti-price">${fmt(s.price)}</span>
            <span class="ti-change">${up ? '▲' : '▼'} ${pctStr}</span>
          </div>
          <div class="ntp-ticker-sep">◆</div>
        `;
      }).join('');

      _setTickerTrack(html);

    } catch (e) {
      track.innerHTML = '<span class="ntp-ticker-loading">Market data unavailable</span>';
    }
  }

  // ── NTP Inline Results Panel ──────────────────────────────────────────────

  function _bindResultsPanel() {
    document.getElementById('ntp-results-close')?.addEventListener('click', _closeResults);
    document.querySelectorAll('.ntp-rt-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.ntp-rt-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.tab;
        document.getElementById('ntp-rt-ai').style.display = which === 'ai' ? '' : 'none';
        document.getElementById('ntp-rt-news').style.display = which === 'news' ? '' : 'none';
      });
    });
  }

  function _closeResults() {
    const panel = document.getElementById('ntp-results');
    if (panel) panel.style.display = 'none';
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
    const taskMode = !!opts.taskMode;
    if (!val || typeof TabManager === 'undefined') return;
    const raw = val.trim();

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
      TabManager.createTab(`${chatBase}${sep}initial=${encodeURIComponent(raw)}`);
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
      if (typeof App !== 'undefined' && App._sendToAI) App._sendToAI(qq);
      return;
    }
    if (typeof App !== 'undefined' && App._sendToAI) App._sendToAI(raw);
    else if (typeof AssistantManager !== 'undefined') {
      AssistantManager.open();
      setTimeout(() => {
        if (AssistantManager.inputEl) {
          AssistantManager.inputEl.value = raw;
          AssistantManager.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          AssistantManager.sendMessage();
        }
      }, 150);
    }
  }

  function _bindSearchInput() {
    const input = document.getElementById('ntp-search-input');
    const sendBtn = document.getElementById('ntp-search-send');
    if (!input) return;

    const submit = async () => {
      const val = input.value.trim();
      if (!val) return;
      if (_mode === 'ai') {
        await _openAssistantInNewTab(val, { taskMode: false });
      } else if (_mode === 'task') {
        await _openAssistantInNewTab(val, { taskMode: true });
      } else {
        const raw = val;
        if (raw.startsWith('>>') || /^ai:\s*/i.test(raw)) {
          await _openAssistantInNewTab(val, { taskMode: false });
        } else if (typeof App !== 'undefined' && App._isAIQuery && App._isAIQuery(val)) {
          await _openAssistantInNewTab(val, { taskMode: false });
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

    if (host === 'mail.google.com' || host.endsWith('.mail.google.com')) {
      return ['https://mail.google.com/mail/u/0/', 'https://mail.google.com/mail/u/1/'];
    }
    if (host === 'drive.google.com' || host.endsWith('.drive.google.com')) {
      return ['https://drive.google.com/drive/u/0/', 'https://drive.google.com/drive/u/1/'];
    }
    if (hostNoWww === 'youtube.com') {
      let o;
      try {
        o = new URL(raw);
      } catch {
        return null;
      }
      const u0 = new URL(o.href);
      u0.searchParams.set('authuser', '0');
      const u1 = new URL(o.href);
      u1.searchParams.set('authuser', '1');
      return [u0.href, u1.href];
    }
    if (hostNoWww === 'google.com') {
      let o;
      try {
        o = new URL(raw);
      } catch {
        return null;
      }
      const u0 = new URL(o.href);
      u0.searchParams.set('authuser', '0');
      const u1 = new URL(o.href);
      u1.searchParams.set('authuser', '1');
      return [u0.href, u1.href];
    }
    return null;
  }

  // ── Quick links shortcuts ─────────────────────────────────────────────────

  function _bindShortcuts() {
    document.querySelectorAll('#ntp-shortcuts .ntp-shortcut').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
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
          // Shortcuts are only visible when NTP is active, meaning the current
          // tab has no URL — navigate in-place rather than replacing with a new tab.
          if (typeof App !== 'undefined') App.handleSearch(url);
        })();
      });
    });
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
      try {
        const oauthSt = await window.navio.oauthStatus();
        googleAlreadyConnected = !!(oauthSt?.google?.connected);
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
          emailList.querySelectorAll('.ntp-email-item[data-msgid]').forEach(el => {
            el.addEventListener('click', (e) => {
              if (e.target.closest('.ntp-email-draft-btn')) return; // handled separately
              const id = el.dataset.msgid;
              const url = id
                ? `https://mail.google.com/mail/u/0/#inbox/${id}`
                : 'https://mail.google.com/mail/u/0/#inbox';
              if (typeof TabManager !== 'undefined') TabManager.createTab(url);
              else window.open(url, '_blank');
            });
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

    } catch (e) {
      emailList.innerHTML = `<p class="ntp-widget-empty">Error: ${_esc(e.message)}</p>`;
    } finally {
      _syncNtpNoEmailLayout();
    }
  }

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

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  NTP.init();
});
