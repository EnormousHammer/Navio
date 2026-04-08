/**
 * Navio Browser — New Tab Page controller
 *
 * Dashboard features:
 *  • Greeting + live clock + weather (Open-Meteo, no API key)
 *  • Connected services status bar (IMAP email counts)
 *  • World News (Reddit r/worldnews — free, CORS-enabled JSON API)
 *  • Stock market ticker (Yahoo Finance via main-process IPC — bypasses CORS)
 *  • Inbox widget — unread emails from IMAP Gmail/Outlook
 *  • AI Brief — generates personalized daily brief via AI
 *  • "Draft All" button — triggers batch email drafting
 */

const NTP = (() => {
  let _mode = 'search'; // 'search' | 'ai' | 'task'
  let _ntpVisible = false;
  let _weatherData = null; // cached for AI brief
  let _newsHeadlines = []; // cached for AI brief
  let _stockData = [];     // cached for AI brief
  let _tickerMode = 'markets'; // 'markets' | 'sports' | 'news'

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    _startClock();
    _bindModeTabs();
    _bindSearchInput();
    _bindShortcuts();
    _bindAIBrief();
    _bindTickerTabs();

    const observer = new MutationObserver(() => {
      const isActive = document.getElementById('new-tab-page')?.classList.contains('active');
      const ticker = document.getElementById('ntp-stock-ticker');
      if (isActive && !_ntpVisible) {
        _ntpVisible = true;
        if (ticker) ticker.classList.add('visible');
        _onShow();
      } else if (!isActive) {
        _ntpVisible = false;
        if (ticker) ticker.classList.remove('visible');
      }
    });
    const ntp = document.getElementById('new-tab-page');
    if (ntp) observer.observe(ntp, { attributes: true, attributeFilter: ['class'] });
    if (ntp?.classList.contains('active')) {
      _ntpVisible = true;
      document.getElementById('ntp-stock-ticker')?.classList.add('visible');
      _onShow();
    }
  }

  function _onShow() {
    _updateGreeting();
    _loadWeather();
    _loadWorldNews();
    _loadServicesBar();
    _loadInbox();
    _loadTickerForMode();
    _bindResultsPanel();
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
    setInterval(tick, 1000);
  }

  function _updateGreeting() {
    const hour = new Date().getHours();
    const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const el = document.getElementById('ntp-greeting');
    if (el) el.textContent = greet;
  }

  // ── Weather (Open-Meteo — free, no API key) ───────────────────────────────

  async function _loadWeather() {
    const block = document.getElementById('ntp-weather-block');
    if (!block) return;
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
      );
      const { latitude, longitude } = pos.coords;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=celsius`;
      const data = await fetch(url).then(r => r.json());
      const cw = data.current_weather;
      if (!cw) return;

      const wmoInfo = (code) => {
        if (code === 0)  return { icon: '☀', desc: 'Clear' };
        if (code <= 3)   return { icon: '⛅', desc: 'Partly cloudy' };
        if (code <= 48)  return { icon: '🌫', desc: 'Foggy' };
        if (code <= 67)  return { icon: '🌧', desc: 'Rain' };
        if (code <= 77)  return { icon: '❄', desc: 'Snow' };
        if (code <= 99)  return { icon: '⛈', desc: 'Thunderstorm' };
        return { icon: '🌤', desc: 'Cloudy' };
      };

      const info = wmoInfo(cw.weathercode);
      _weatherData = { temp: Math.round(cw.temperature), ...info };

      const iconEl = document.getElementById('ntp-weather-icon');
      const tempEl = document.getElementById('ntp-weather-temp');
      const descEl = document.getElementById('ntp-weather-desc');
      if (iconEl) iconEl.textContent = info.icon;
      if (tempEl) tempEl.textContent = `${Math.round(cw.temperature)}°`;
      if (descEl) descEl.textContent = info.desc;
      block.style.visibility = 'visible';
    } catch { /* geolocation denied or offline */ }
  }

  // ── World News (Reddit r/worldnews — free, CORS-open JSON API) ─────────────

  async function _loadWorldNews() {
    const list = document.getElementById('ntp-news-list');
    if (!list) return;

    // Try Reddit worldnews first, fallback to HackerNews
    try {
      const r = await fetch('https://www.reddit.com/r/worldnews/hot.json?limit=12', {
        headers: { 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`Reddit ${r.status}`);
      const data = await r.json();
      const posts = (data?.data?.children || [])
        .map(c => c.data)
        .filter(p => p && p.title && !p.stickied)
        .slice(0, 10);

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
          ids.slice(0, 8).map(id =>
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

  // ── Sports Ticker (ESPN free API via main process) ─────────────────────────

  async function _loadSportsTicker(retried = false) {
    const track = document.getElementById('ntp-ticker-track');
    if (!track) return;

    try {
      const result = await window.navio.ntpFetchSports();
      if (!result || result.error || !Array.isArray(result) || result.length === 0) {
        if (!retried && result?.error) { setTimeout(() => _loadSportsTicker(true), 3000); return; }
        track.innerHTML = '<span class="ntp-ticker-loading">No games scheduled today</span>';
        return;
      }

      const html = result.map(g => {
        const hasScore = g.homeScore !== '' && g.awayScore !== '';
        const matchup = hasScore
          ? `${g.away} <span class="ts-score">${g.awayScore}</span> · ${g.home} <span class="ts-score">${g.homeScore}</span>`
          : `${g.away} vs ${g.home}`;
        return `
          <div class="ntp-ticker-sport">
            <span class="ts-league">${g.league}</span>
            <span class="ts-matchup">${matchup}</span>
            ${g.live ? '<span class="ts-live">● LIVE</span>' : `<span class="ts-status">${_esc(g.status)}</span>`}
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

  // ── AI Brief ──────────────────────────────────────────────────────────────

  function _bindAIBrief() {
    document.getElementById('ntp-brief-gen-btn')?.addEventListener('click', _generateAIBrief);
  }

  async function _generateAIBrief() {
    const body = document.getElementById('ntp-brief-body');
    const btn = document.getElementById('ntp-brief-gen-btn');
    if (!body || !btn) return;

    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        body.innerHTML = `<div class="ntp-brief-error">No AI API key configured.<br><small>Add one in <strong>Settings → AI</strong></small></div>`;
        return;
      }

      btn.disabled = true;
      btn.textContent = '…';
      body.innerHTML = `<div class="ntp-brief-generating">
        <div class="ntp-brief-spinner"></div>
        <p>Generating your brief…</p>
      </div>`;

      // Gather context
      const sections = [];
      const hour = new Date().getHours();
      const greet = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
      sections.push(`${greet} brief for ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}.`);

      if (_weatherData) {
        sections.push(`Weather: ${_weatherData.icon} ${_weatherData.temp}°C, ${_weatherData.desc}.`);
      }

      // Unread emails
      try {
        const imapSt = await window.navio.imapStatus();
        const connected = Object.keys(imapSt || {});
        if (connected.length > 0) {
          const unreadResults = await Promise.all(
            connected.map(svc => window.navio.imapGetUnread(svc, 1).catch(() => null))
          );
          const totalUnread = unreadResults.reduce((sum, r) => sum + (r?.unreadCount || 0), 0);
          if (totalUnread > 0) {
            sections.push(`Unread emails: ${totalUnread} unread across ${connected.map(s => s === 'gmail' ? 'Gmail' : 'Outlook').join(', ')}.`);
          } else {
            sections.push('Inbox: all caught up, no unread emails.');
          }
        }
      } catch {}

      if (_newsHeadlines.length > 0) {
        sections.push(`Top world news headlines:\n${_newsHeadlines.slice(0, 5).map((h, i) => `${i + 1}. ${h}`).join('\n')}`);
      }

      if (_stockData.length > 0) {
        const marketSummary = _stockData
          .filter(s => ['GSPC', 'DJI', 'IXIC'].includes(s.symbol))
          .map(s => `${s.symbol === 'GSPC' ? 'S&P 500' : s.symbol === 'DJI' ? 'DOW' : 'NASDAQ'}: ${(s.pct || 0) >= 0 ? '+' : ''}${(s.pct || 0).toFixed(2)}%`)
          .join(', ');
        if (marketSummary) sections.push(`Markets: ${marketSummary}.`);

        const btc = _stockData.find(s => s.symbol === 'BTC-USD');
        if (btc) sections.push(`BTC: $${btc.price?.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${(btc.pct || 0) >= 0 ? '+' : ''}${(btc.pct || 0).toFixed(2)}%).`);
      }

      const messages = [
        {
          role: 'system',
          content: 'You are a personalized AI briefing assistant. Write a concise, friendly daily brief in 3-5 short paragraphs. Use natural language, no bullet points, no headers. Keep it under 150 words. Make it feel intelligent, warm, and actionable.'
        },
        {
          role: 'user',
          content: `Here is today's context data:\n\n${sections.join('\n\n')}\n\nWrite my daily brief.`
        }
      ];

      const result = await window.navio.aiRequest({ messages });
      if (result.error) throw new Error(result.error);

      body.innerHTML = `<div class="ntp-brief-content">${_esc(result.content || '').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</div>`;

    } catch (e) {
      body.innerHTML = `<div class="ntp-brief-error">Could not generate brief: ${_esc(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↺ Refresh'; }
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
      const q = query.toLowerCase();
      const words = q.split(/\s+/).filter(w => w.length > 3);
      const related = _newsHeadlines
        .filter(h => words.some(w => h.toLowerCase().includes(w)))
        .slice(0, 6);
      newsContent.innerHTML = related.length
        ? related.map(h => '<div class="ntp-news-item"><div class="ntp-news-title">' + _esc(h) + '</div></div>').join('')
        : '<p class="ntp-widget-empty">No related headlines found.</p>';
    }

    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        aiContent.innerHTML = '<div class="ntp-brief-error">No AI key configured. Add one in <strong>Settings - AI</strong>.</div>';
        return;
      }
      const result = await window.navio.aiRequest({ messages: [{ role: 'user', content: query }] });
      if (result.error) throw new Error(result.error);
      const html = _esc(result.content || '')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
      aiContent.innerHTML = '<div class="ntp-brief-content"><p>' + html + '</p></div>';
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
            search: 'Search the web…',
            ai: 'Ask Navio AI anything…',
            task: 'Give Navio a task to complete…'
          };
          input.placeholder = placeholders[_mode] || 'Search…';
          input.focus();
        }
      });
    });
  }

  // ── Search input ──────────────────────────────────────────────────────────

  function _bindSearchInput() {
    const input = document.getElementById('ntp-search-input');
    const sendBtn = document.getElementById('ntp-search-send');
    if (!input) return;

    const submit = () => {
      const val = input.value.trim();
      if (!val) return;
      if (_mode === 'ai') {
        // Show inline results panel on the NTP
        _showInlineAIResults(val);
      } else if (_mode === 'task') {
        // Open assistant panel for tasks
        const assistantBtn = document.getElementById('btn-toggle-assistant');
        if (assistantBtn) assistantBtn.click();
        setTimeout(() => {
          const aiInput = document.getElementById('assistant-input');
          if (aiInput) {
            aiInput.value = val;
            aiInput.dispatchEvent(new Event('input', { bubbles: true }));
            aiInput.focus();
          }
        }, 150);
      } else {
        // Auto-detect: question-like goes to inline results, otherwise web search
        if (typeof App !== 'undefined' && App._isAIQuery && App._isAIQuery(val)) {
          _showInlineAIResults(val);
        } else {
          if (typeof App !== 'undefined') App.handleSearch(val);
        }
      }
      input.value = '';
    };

    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    sendBtn?.addEventListener('click', submit);
  }

  // ── Quick links shortcuts ─────────────────────────────────────────────────

  function _bindShortcuts() {
    document.querySelectorAll('#ntp-shortcuts .ntp-shortcut').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        if (url && typeof TabManager !== 'undefined') {
          const activeTab = TabManager.getActiveTab();
          if (activeTab && !activeTab.url) {
            if (typeof App !== 'undefined') App.handleSearch(url);
          } else {
            TabManager.createTab(url);
          }
        }
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
    const emailList = document.getElementById('ntp-email-list');
    const unreadBadge = document.getElementById('ntp-unread-badge');
    const draftAllBtn = document.getElementById('ntp-draft-all-btn');
    if (!emailList) return;

    try {
      const imapSt = await window.navio.imapStatus();
      const connectedServices = Object.keys(imapSt || {});

      if (connectedServices.length === 0) {
        // Check if a Google OAuth Client ID is already saved — if so, offer
        // a direct "Sign in with Google" button instead of sending the user
        // to the Connectors Hub to hunt for the right button themselves.
        let hasGoogleClientId = false;
        let hasGoogleSecret   = false;
        try {
          const cfg = await window.navio.getConfig();
          hasGoogleClientId = !!(cfg.oauthGoogleClientId || '').trim();
          hasGoogleSecret   = !!(cfg.oauthGoogleClientSecret || '').trim();
        } catch {}

        // Check if Google OAuth is already connected (tokens exist)
        let googleAlreadyConnected = false;
        try {
          const oauthSt = await window.navio.oauthStatus();
          googleAlreadyConnected = !!(oauthSt?.google?.connected);
        } catch {}

        if (hasGoogleClientId && !googleAlreadyConnected) {
          // Client ID is configured but not yet signed in
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
                // Show friendly error, not the raw Google API message
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
          // No Client ID configured — open the Connectors Hub for full setup
          emailList.innerHTML = `
            <div class="ntp-email-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <p>Connect Gmail or Outlook in the Connectors Hub to see your inbox here.</p>
              <button class="ntp-connect-email-btn" id="ntp-connect-email">Connect email</button>
            </div>`;
          document.getElementById('ntp-connect-email')?.addEventListener('click', () => {
            document.getElementById('btn-connectors-full')?.click();
          });
        }
        return;
      }

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

      if (messages.length === 0) {
        emailList.innerHTML = '<p class="ntp-widget-empty">All caught up — no unread emails.</p>';
        return;
      }

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

  function _timeAgo(iso) {
    if (!iso) return '';
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
    return `${Math.round(d / 86400000)}d ago`;
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => NTP.init(), 500);
});
