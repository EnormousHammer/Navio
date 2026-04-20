/**
 * Bookmark bar, find-in-page, history panel, downloads drawer, tab search, layout, migration.
 */
(function () {
  let findUnsub;

  /** Paths we prefer to open inside Navio (new tab) instead of the OS default app. */
  const NAVIO_BROWSER_VIEWABLE_DOWNLOAD_RE =
    /\.(pdf|html?|xhtml|svg|png|jpe?g|gif|webp|bmp|ico|txt|md)$/i;

  function navioIsBrowserViewableDownloadPath(p) {
    return !!(p && typeof p === 'string' && NAVIO_BROWSER_VIEWABLE_DOWNLOAD_RE.test(p));
  }

  /**
   * PDFs, pages, images: open in a new browser tab. Other types: OS default app.
   */
  async function navioOpenDownloadSmart(filePath) {
    if (!filePath) return;
    if (navioIsBrowserViewableDownloadPath(filePath)) {
      try {
        const r = await window.navio.pathToFileUrl?.(filePath);
        if (r && r.ok && r.href && typeof TabManager !== 'undefined') {
          TabManager.createTab(r.href);
          return;
        }
      } catch {
        /* fall through */
      }
    }
    try {
      await window.navio.openFilePath?.(filePath);
    } catch {
      /* ignore */
    }
  }

  window.__navioOpenDownloadSmart = navioOpenDownloadSmart;

  function historyDayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function historyDayHeading(ts) {
    const now = new Date();
    const td = historyDayKey(now.getTime());
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const yd = historyDayKey(y.getTime());
    const d = new Date(ts);
    const dk = historyDayKey(ts);
    if (dk === td) return 'Today';
    if (dk === yd) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
  }

  function formatVisitTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function historyHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  function historyDisplayUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      let s = u.hostname.replace(/^www\./i, '') + u.pathname;
      if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
      return s || url;
    } catch {
      return url;
    }
  }

  function historySafeFavicon(url) {
    if (!url || typeof url !== 'string') return '';
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') return url;
    } catch {
      /* ignore */
    }
    return '';
  }

  function historyHostHue(host) {
    let h = 0;
    const s = String(host || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function historyFaviconPlaceholder(url) {
    const span = document.createElement('span');
    span.className = 'history-favicon history-favicon--ph';
    const host = historyHostname(url);
    span.textContent = (host[0] || '?').toUpperCase();
    span.style.setProperty('--letter-hue', String(historyHostHue(host || 'x')));
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  /** Letter underlay + favicon (tries Google s2 if stored favicon fails). */
  function historyFaviconForUrl(url, storedFavicon) {
    const host = historyHostname(url);
    const s2 = host ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64` : '';
    const favSrc = historySafeFavicon(storedFavicon);
    const wrap = document.createElement('span');
    wrap.className = 'history-favicon-wrap';
    const ph = historyFaviconPlaceholder(url);
    const primary = favSrc || s2;
    if (!primary) {
      wrap.classList.add('history-favicon-wrap--letter-only');
      wrap.appendChild(ph);
      return wrap;
    }
    const img = document.createElement('img');
    img.className = 'history-favicon history-favicon--img';
    img.alt = '';
    img.src = primary;
    img.addEventListener('error', function onErr() {
      if (favSrc && s2 && img.dataset.step !== '1') {
        img.dataset.step = '1';
        img.src = s2;
        return;
      }
      img.classList.add('is-hidden');
    });
    wrap.appendChild(ph);
    wrap.appendChild(img);
    return wrap;
  }

  async function fillHistoryOverlayList(query) {
    const list = document.getElementById('history-overlay-list');
    if (!list || !window.navio.historySearch) return;
    const q = (query || '').trim();
    const res = await window.navio.historySearch(q, 500);
    const entries = res.entries || [];
    list.innerHTML = '';

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty-msg';
      empty.textContent = q
        ? 'No history matches your search.'
        : 'Pages you open will appear here.';
      list.appendChild(empty);
      return;
    }

    let lastDayKey = null;
    for (const e of entries) {
      const ts = e.visitedAt || 0;
      const dk = historyDayKey(ts);
      if (dk !== lastDayKey) {
        lastDayKey = dk;
        const h = document.createElement('h3');
        h.className = 'history-date-heading';
        h.textContent = historyDayHeading(ts);
        list.appendChild(h);
      }

      const wrap = document.createElement('div');
      wrap.className = 'history-overlay-row-wrap';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-overlay-row';

      btn.appendChild(historyFaviconForUrl(e.url, e.favicon));

      const body = document.createElement('span');
      body.className = 'history-body';
      const titleEl = document.createElement('span');
      titleEl.className = 'h-title';
      titleEl.textContent = e.title || historyHostname(e.url) || e.url || 'Untitled';
      const urlEl = document.createElement('span');
      urlEl.className = 'h-url';
      urlEl.textContent = historyDisplayUrl(e.url);
      body.appendChild(titleEl);
      body.appendChild(urlEl);
      btn.appendChild(body);

      const timeEl = document.createElement('span');
      timeEl.className = 'h-time';
      let timeStr = formatVisitTime(ts);
      if (e.visitCount > 1) timeStr += ` · ${e.visitCount}×`;
      timeEl.textContent = timeStr;

      btn.appendChild(timeEl);

      btn.addEventListener('click', () => {
        if (typeof TabManager !== 'undefined' && e.url) TabManager.navigateActive(e.url);
        const overlay = document.getElementById('history-overlay');
        if (overlay) overlay.hidden = true;
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'history-overlay-del';
      del.title = 'Remove from history';
      del.setAttribute('aria-label', 'Remove from history');
      del.textContent = '×';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!e.id) return;
        await window.navio.historyRemove(e.id);
        const inp = document.getElementById('history-overlay-search');
        await fillHistoryOverlayList(inp ? inp.value : '');
      });

      wrap.appendChild(btn);
      wrap.appendChild(del);
      list.appendChild(wrap);
    }
  }

  function flattenBookmarksData(data) {
    const out = [];
    for (const b of data.bar || []) {
      if (b.url) out.push({ ...b, _section: 'Bookmark bar' });
    }
    function walk(nodes, sectionLabel) {
      for (const n of nodes || []) {
        if (n.url) out.push({ ...n, _section: sectionLabel });
        if (n.children && n.children.length) walk(n.children, n.title || sectionLabel || 'Folder');
      }
    }
    walk(data.tree || [], 'Other bookmarks');
    return out;
  }

  async function fillBookmarksOverlayList(filterText) {
    const list = document.getElementById('bookmarks-overlay-list');
    if (!list || !window.navio.bookmarksGet) return;
    const data = await window.navio.bookmarksGet();
    const flat = flattenBookmarksData(data);
    const q = (filterText || '').toLowerCase().trim();
    list.innerHTML = '';
    flat.forEach((b) => {
      const hay = `${b.title || ''} ${b.url || ''} ${b._section || ''}`.toLowerCase();
      if (q && !hay.includes(q)) return;
      const row = document.createElement('div');
      row.className = 'bookmark-overlay-row';
      row.innerHTML = `<button type="button" class="bookmark-overlay-main"></button><span class="bookmark-overlay-section"></span><button type="button" class="bookmark-overlay-del" title="Remove">×</button>`;
      const main = row.querySelector('.bookmark-overlay-main');
      main.textContent = b.title || b.url || 'Untitled';
      row.querySelector('.bookmark-overlay-section').textContent = b._section || '';
      main.addEventListener('click', () => {
        if (typeof TabManager !== 'undefined' && b.url) TabManager.navigateActive(b.url);
        const overlay = document.getElementById('bookmarks-overlay');
        if (overlay) overlay.hidden = true;
      });
      row.querySelector('.bookmark-overlay-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!b.id) return;
        await window.navio.bookmarksRemove(b.id);
        window.dispatchEvent(new Event('bookmarks-changed'));
        const inp = document.getElementById('bookmarks-overlay-search');
        await fillBookmarksOverlayList(inp && inp.value);
      });
      list.appendChild(row);
    });
    if (!list.children.length) {
      list.innerHTML = '<p class="settings-inline-hint" style="margin:8px">No bookmarks match.</p>';
    }
  }

  function bindBookmarksOverlay() {
    const overlay = document.getElementById('bookmarks-overlay');
    const q = document.getElementById('bookmarks-overlay-search');
    const close = document.getElementById('bookmarks-overlay-close');
    const btn = document.getElementById('btn-bookmarks-manager');
    async function open() {
      if (!overlay) return;
      overlay.hidden = false;
      if (q) q.value = '';
      await fillBookmarksOverlayList('');
      if (q) q.focus();
    }
    close && close.addEventListener('click', () => (overlay.hidden = true));
    btn && btn.addEventListener('click', () => open());
    q &&
      q.addEventListener('input', () => {
        fillBookmarksOverlayList(q.value);
      });
  }

  /**
   * Home (NTP) has its OWN zoom factor, independent from the active web page's zoom.
   * Rationale: the user's "Default page zoom" and per-page Ctrl +/− are for web
   * content; Home is chrome UI and should stay readable regardless. Persisted in
   * localStorage so it survives restart.
   */
  const NTP_ZOOM_KEY = 'navio.ntpZoom';
  const NTP_ZOOM_MIN = 0.5;
  const NTP_ZOOM_MAX = 2.5;
  const NTP_ZOOM_STEP = 0.1;
  const NTP_ZOOM_DEFAULT = 1.0;

  function clampNtpZoom(v) {
    return Math.min(NTP_ZOOM_MAX, Math.max(NTP_ZOOM_MIN, v));
  }
  function getNtpZoom() {
    try {
      const raw = localStorage.getItem(NTP_ZOOM_KEY);
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v > 0) return clampNtpZoom(v);
    } catch { /* storage unavailable — fall through to default */ }
    return NTP_ZOOM_DEFAULT;
  }
  function setNtpZoom(f) {
    const next = Number.isFinite(f) ? clampNtpZoom(f) : NTP_ZOOM_DEFAULT;
    try {
      if (next === NTP_ZOOM_DEFAULT) localStorage.removeItem(NTP_ZOOM_KEY);
      else localStorage.setItem(NTP_ZOOM_KEY, String(next));
    } catch { /* storage write may fail — zoom still applies for this session */ }
    return next;
  }
  function isNtpActive() {
    const ntp = document.getElementById('new-tab-page');
    return !!(ntp && ntp.classList.contains('active'));
  }

  /**
   * While Home (NTP) is visible, apply the independent NTP zoom on the shell element
   * (the guest <webview> is hidden). Clear when returning to a page so CSS zoom does
   * not affect web content.
   */
  function syncNewTabSurfaceZoom() {
    const ntp = document.getElementById('new-tab-page');
    if (!ntp) return;
    if (!ntp.classList.contains('active')) {
      ntp.style.zoom = '';
      return;
    }
    const f = getNtpZoom();
    ntp.style.zoom = !f || f === 1 ? '' : String(f);
  }
  window.__navioSyncNewTabSurfaceZoom = syncNewTabSurfaceZoom;
  window.__navioGetNtpZoom = getNtpZoom;
  window.__navioSetNtpZoom = (f) => {
    const applied = setNtpZoom(f);
    syncNewTabSurfaceZoom();
    if (typeof window.__navioUpdateZoomLabel === 'function') window.__navioUpdateZoomLabel();
    return applied;
  };

  async function updateUrlZoomLabel() {
    const el = document.getElementById('url-zoom-label');
    if (!el) return;
    if (isNtpActive()) {
      const pct = Math.round((getNtpZoom() || 1) * 100);
      el.textContent = pct === 100 ? '' : `${pct}%`;
      return;
    }
    const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    if (!wv) {
      el.textContent = '';
      return;
    }
    let factor = 1;
    try {
      if (typeof wv.getZoomFactor === 'function') {
        factor = wv.getZoomFactor();
      } else if (typeof wv.getWebContentsId === 'function' && window.navio?.webviewGetZoom) {
        const z = await window.navio.webviewGetZoom(wv.getWebContentsId());
        factor = z.factor || 1;
      } else {
        el.textContent = '';
        return;
      }
    } catch {
      el.textContent = '';
      return;
    }
    const pct = Math.round((factor || 1) * 100);
    el.textContent = pct === 100 ? '' : `${pct}%`;
  }
  window.__navioUpdateZoomLabel = updateUrlZoomLabel;

  window.__navioOpenHistoryOverlay = function () {
    const overlay = document.getElementById('history-overlay');
    const q = document.getElementById('history-overlay-search');
    if (overlay) {
      overlay.hidden = false;
      if (q) q.value = '';
      fillHistoryOverlayList('');
      if (q) q.focus();
    }
  };

  window.__navioOpenBookmarksOverlay = async function () {
    const overlay = document.getElementById('bookmarks-overlay');
    const q = document.getElementById('bookmarks-overlay-search');
    if (!overlay) return;
    overlay.hidden = false;
    if (q) q.value = '';
    await fillBookmarksOverlayList('');
    if (q) q.focus();
  };

  function syncBookmarkBarToggleButton() {
    const btn = document.getElementById('btn-toggle-bookmark-bar');
    const bar = document.getElementById('bookmark-bar');
    if (!btn || !bar) return;
    const on = !bar.hidden;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Hide bookmark bar (saved)' : 'Show bookmark bar (saved)';
  }
  window.__navioSyncBookmarkBarToggleButton = syncBookmarkBarToggleButton;

  async function setBookmarkBarVisible(show) {
    const bar = document.getElementById('bookmark-bar');
    if (bar) bar.hidden = !show;
    await window.navio.saveConfig({ showBookmarkBar: !!show });
    if (typeof App !== 'undefined' && App.config) {
      App.config.showBookmarkBar = !!show;
    }
    if (typeof SettingsManager !== 'undefined' && SettingsManager.config) {
      SettingsManager.config.showBookmarkBar = !!show;
      if (SettingsManager.elements && SettingsManager.elements.bookmarkBar) {
        SettingsManager.elements.bookmarkBar.checked = !!show;
      }
    }
    syncBookmarkBarToggleButton();
  }

  async function toggleBookmarkBar() {
    const bar = document.getElementById('bookmark-bar');
    const currentlyOn = bar && !bar.hidden;
    await setBookmarkBarVisible(!currentlyOn);
  }
  window.__navioToggleBookmarkBar = toggleBookmarkBar;

  async function initBookmarkBar() {
    const bar = document.getElementById('bookmark-bar');
    if (!bar || !window.navio.bookmarksGet) return;
    try {
      await window.navio.bookmarksMigrateImported();
    } catch (_) {}
    const cfg = await window.navio.getConfig();
    const show = cfg.showBookmarkBar !== false;
    bar.hidden = !show;
    function _faviconUrl(b) {
      if (b && b.favicon) return b.favicon;
      try {
        const u = new URL(b.url);
        return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(u.hostname)}`;
      } catch (_) {
        return '';
      }
    }
    function _letterFallback(b) {
      const t = (b.title || b.url || '?').trim();
      try {
        const h = new URL(b.url).hostname.replace(/^www\./, '');
        return (h[0] || t[0] || '?').toUpperCase();
      } catch (_) {
        return (t[0] || '?').toUpperCase();
      }
    }
    function _hashColor(str) {
      let h = 0;
      for (let i = 0; i < (str || '').length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
      const palette = ['#60a5fa','#a78bfa','#34d399','#f87171','#fb923c','#fbbf24','#f472b6','#5eead4','#94a3b8'];
      return palette[Math.abs(h) % palette.length];
    }
    async function render() {
      const data = await window.navio.bookmarksGet();
      bar.innerHTML = '';
      (data.bar || []).forEach((b) => {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'bookmark-bar-item';
        a.title = b.url;
        const isFolder = Array.isArray(b.children) && b.children.length > 0;
        if (isFolder) a.classList.add('is-folder');

        const iconUrl = !isFolder ? _faviconUrl(b) : '';
        if (iconUrl) {
          const img = document.createElement('img');
          img.className = 'bm-favicon';
          img.alt = '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          img.src = iconUrl;
          img.addEventListener('error', () => {
            const fb = document.createElement('span');
            fb.className = 'bm-favicon-fallback';
            fb.style.background = _hashColor(b.url || b.title || '');
            fb.textContent = _letterFallback(b);
            img.replaceWith(fb);
          }, { once: true });
          a.appendChild(img);
        } else {
          const fb = document.createElement('span');
          fb.className = 'bm-favicon-fallback';
          if (isFolder) {
            fb.style.background = 'transparent';
            fb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
          } else {
            fb.style.background = _hashColor(b.url || b.title || '');
            fb.textContent = _letterFallback(b);
          }
          a.appendChild(fb);
        }

        const label = document.createElement('span');
        label.className = 'bm-label';
        label.textContent = b.title || b.url;
        a.appendChild(label);

        a.addEventListener('click', () => {
          if (typeof TabManager !== 'undefined') TabManager.navigateActive(b.url);
        });
        bar.appendChild(a);
      });
      _updateBookmarkBarScrollShadows(bar);
    }
    function _updateBookmarkBarScrollShadows(el) {
      if (!el) return;
      const { scrollLeft, scrollWidth, clientWidth } = el;
      el.classList.remove('bm-scroll-start', 'bm-scroll-mid', 'bm-scroll-end');
      const overflow = scrollWidth - clientWidth > 2;
      if (!overflow) return;
      if (scrollLeft <= 2) el.classList.add('bm-scroll-start');
      else if (scrollLeft + clientWidth >= scrollWidth - 2) el.classList.add('bm-scroll-end');
      else el.classList.add('bm-scroll-mid');
    }
    bar.addEventListener('scroll', () => _updateBookmarkBarScrollShadows(bar), { passive: true });
    await render();
    window.addEventListener('bookmarks-changed', render);
    syncBookmarkBarToggleButton();
  }

  function bindBookmarkBarToggle() {
    const btn = document.getElementById('btn-toggle-bookmark-bar');
    if (!btn || btn._navioBound) return;
    btn._navioBound = true;
    btn.addEventListener('click', () => toggleBookmarkBar());
  }

  function bindFindInPage() {
    const bar = document.getElementById('find-in-page-bar');
    const input = document.getElementById('find-in-page-input');
    const status = document.getElementById('find-in-page-status');
    const btnPrev = document.getElementById('find-in-page-prev');
    const btnNext = document.getElementById('find-in-page-next');
    const btnClose = document.getElementById('find-in-page-close');
    if (!bar || !input) return;

    let lastWc = null;
    let lastQ = '';

    function activeWv() {
      return typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    }

    function openFind() {
      const wv = activeWv();
      if (!wv || !wv.getWebContentsId) return;
      lastWc = wv.getWebContentsId();
      bar.hidden = false;
      input.focus();
      input.select();
    }

    function closeFind() {
      bar.hidden = true;
      if (lastWc && window.navio.webviewStopFindInPage) {
        window.navio.webviewStopFindInPage(lastWc, 'clearSelection').catch(() => {});
      }
      lastQ = '';
      status.textContent = '';
    }

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFind();
      }
      if (!bar.hidden && e.key === 'Escape') closeFind();
    });

    input.addEventListener('input', () => {
      const q = input.value;
      const wv = activeWv();
      if (!wv) return;
      lastWc = wv.getWebContentsId();
      if (!q) {
        window.navio.webviewStopFindInPage(lastWc, 'clearSelection').catch(() => {});
        status.textContent = '';
        return;
      }
      lastQ = q;
      window.navio.webviewFindInPage(lastWc, q, { forward: true, findNext: false }).catch(() => {});
    });

    btnPrev &&
      btnPrev.addEventListener('click', () => {
        if (!lastWc || !lastQ) return;
        window.navio.webviewFindInPage(lastWc, lastQ, { forward: false, findNext: true }).catch(() => {});
      });
    btnNext &&
      btnNext.addEventListener('click', () => {
        if (!lastWc || !lastQ) return;
        window.navio.webviewFindInPage(lastWc, lastQ, { forward: true, findNext: true }).catch(() => {});
      });
    btnClose && btnClose.addEventListener('click', closeFind);

    if (window.navio.onFoundInPageResult) {
      findUnsub = window.navio.onFoundInPageResult((d) => {
        if (!d || !d.result) return;
        const r = d.result;
        if (r.requestId !== undefined && r.matches !== undefined) {
          status.textContent =
            r.matches === 0 ? 'No matches' : `${r.activeMatchOrdinal || 1} / ${r.matches}`;
        }
      });
    }
  }

  function bindPrintZoomFullscreen() {
    document.addEventListener('keydown', async (e) => {
      const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'p' && wv && wv.getWebContentsId) {
        e.preventDefault();
        window.navio.webviewPrint(wv.getWebContentsId()).catch(() => {});
      }
      const zoomIn =
        mod &&
        (e.key === '=' ||
          e.key === '+' ||
          e.code === 'NumpadAdd' ||
          (e.code === 'Equal' && e.shiftKey));
      const zoomOut = mod && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract');
      const zoomReset = mod && e.key === '0';
      if (zoomIn || zoomOut || zoomReset) {
        const t = e.target;
        const zoomOkInputs = new Set(['url-input', 'ntp-search-input']);
        if (
          t &&
          !zoomOkInputs.has(t.id) &&
          (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
        ) {
          return;
        }
        if (isNtpActive()) {
          e.preventDefault();
          let nextZoom;
          if (zoomReset) nextZoom = NTP_ZOOM_DEFAULT;
          else if (zoomIn) nextZoom = getNtpZoom() + NTP_ZOOM_STEP;
          else nextZoom = getNtpZoom() - NTP_ZOOM_STEP;
          setNtpZoom(nextZoom);
          syncNewTabSurfaceZoom();
          updateUrlZoomLabel();
          return;
        }
        if (!wv || typeof TabManager === 'undefined' || !TabManager.zoomActiveTabBy) return;
        e.preventDefault();
        if (zoomReset) TabManager.setActiveTabZoomFactor(null);
        else if (zoomIn) TabManager.zoomActiveTabBy(0.1);
        else TabManager.zoomActiveTabBy(-0.1);
        return;
      }
      if (e.key === 'F11') {
        e.preventDefault();
        const fs = await window.navio.windowIsFullscreen();
        window.navio.windowSetFullscreen(!fs.fullscreen).catch(() => {});
      }
    });
  }

  function bindDownloadsDrawer() {
    const panel = document.getElementById('downloads-drawer');
    const list = document.getElementById('downloads-drawer-list');
    const toggle = document.getElementById('btn-downloads-drawer');
    const wrap = document.querySelector('.nav-downloads-wrap');
    if (!panel || !list) return;

    /** Chrome-like speed line (MB/s when fast). */
    function formatDownloadSpeed(bps) {
      if (bps == null || !Number.isFinite(bps) || bps <= 0) return '';
      if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
      if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
      return `${Math.round(bps)} B/s`;
    }

    function downloadStateLabel(state) {
      if (state === 'completed') return 'Completed';
      if (state === 'cancelled') return 'Cancelled';
      if (state === 'interrupted') return 'Interrupted';
      return String(state || '');
    }

    /** Anchor the drawer under the toolbar Downloads control (not bottom-right of the window). */
    function positionDownloadsDrawer() {
      if (!panel || panel.hidden) return;
      const anchor = wrap || toggle;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const panelWidth = Math.min(360, window.innerWidth - margin * 2);
      panel.style.width = `${panelWidth}px`;
      let left = rect.right - panelWidth;
      if (left < margin) left = margin;
      if (left + panelWidth > window.innerWidth - margin) {
        left = window.innerWidth - margin - panelWidth;
      }
      const maxH = Math.min(320, window.innerHeight - margin * 2);
      panel.style.maxHeight = `${maxH}px`;
      let top = rect.bottom + gap;
      if (top + maxH > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - maxH - gap);
      }
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function onDownloadsReposition() {
      positionDownloadsDrawer();
    }
    window.addEventListener('resize', onDownloadsReposition);
    const rowsByPath = new Map();
    const order = [];

    const DD_ICON_SVG =
      '<svg class="dd-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>';

    function setRowOpenable(row, { savePath, filename, openable }) {
      if (!row) return;
      row.dataset.savePath = savePath || '';
      row.dataset.openable = openable ? '1' : '0';
      if (openable) {
        row.classList.add('dd-openable');
        row.setAttribute('tabindex', '0');
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `Open ${filename || savePath || 'file'} in Navio`);
      } else {
        row.classList.remove('dd-openable');
        row.removeAttribute('tabindex');
        row.removeAttribute('role');
        row.removeAttribute('aria-label');
      }
    }

    list.addEventListener('click', (e) => {
      const row = e.target.closest('.downloads-drawer-row');
      if (!row || !list.contains(row)) return;
      if (e.target.closest('button')) return;
      if (row.dataset.openable !== '1') return;
      const p = row.dataset.savePath;
      if (!p) return;
      e.preventDefault();
      void navioOpenDownloadSmart(p);
    });

    list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.downloads-drawer-row');
      if (!row || !list.contains(row)) return;
      if (row.dataset.openable !== '1') return;
      e.preventDefault();
      const p = row.dataset.savePath;
      if (!p) return;
      void navioOpenDownloadSmart(p);
    });

    function trim() {
      while (order.length > 30) {
        const k = order.shift();
        const row = rowsByPath.get(k);
        rowsByPath.delete(k);
        row?.remove();
      }
    }

    function ensureRow(savePath, filename) {
      if (!savePath) return null;
      let row = rowsByPath.get(savePath);
      if (!row) {
        row = document.createElement('div');
        row.className = 'downloads-drawer-row';
        row.innerHTML = `<div class="dd-inner">
          <div class="dd-icon">${DD_ICON_SVG}</div>
          <div class="dd-main">
            <div class="dd-top">
              <span class="dd-name"></span>
              <span class="dd-state"></span>
            </div>
            <div class="dd-progress-wrap"><div class="dd-progress-bar"></div></div>
            <div class="dd-bottom">
              <span class="dd-meta"></span>
              <span class="dd-actions"></span>
            </div>
          </div>
        </div>`;
        list.appendChild(row);
        rowsByPath.set(savePath, row);
        order.push(savePath);
        trim();
      }
      row.dataset.savePath = savePath;
      const nameEl = row.querySelector('.dd-name');
      if (nameEl) nameEl.textContent = filename || savePath;
      return row;
    }

    const shelf = document.getElementById('download-shelf');
    const shelfList = document.getElementById('download-shelf-list');
    const shelfRowsByPath = new Map();
    let shelfHideTimer = null;
    let activeDownloadCount = 0;

    function clearShelfHideTimer() {
      if (shelfHideTimer) {
        clearTimeout(shelfHideTimer);
        shelfHideTimer = null;
      }
    }

    function scheduleShelfHide() {
      clearShelfHideTimer();
      shelfHideTimer = setTimeout(() => {
        shelfHideTimer = null;
        if (shelf && activeDownloadCount === 0) {
          shelf.hidden = true;
          if (shelfList) shelfList.innerHTML = '';
          shelfRowsByPath.clear();
        }
      }, 4500);
    }

    function dismissShelfRow(savePath) {
      if (!savePath) return;
      const srow = shelfRowsByPath.get(savePath);
      if (srow) {
        try {
          srow.remove();
        } catch {
          /* ignore */
        }
        shelfRowsByPath.delete(savePath);
      }
      if (shelfList && shelfList.children.length === 0 && activeDownloadCount === 0 && shelf) {
        shelf.hidden = true;
        clearShelfHideTimer();
      }
    }

    const dismissAllBtn = document.getElementById('download-shelf-dismiss-all');
    dismissAllBtn &&
      dismissAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearShelfHideTimer();
        if (shelfList) shelfList.innerHTML = '';
        shelfRowsByPath.clear();
        if (shelf && activeDownloadCount === 0) shelf.hidden = true;
      });

    // Track the origin URL for each download so we can retry on failure.
    // Populated on download-started; cleared on drawer row remove / clear.
    const downloadUrlByPath = new Map();
    const downloadPausedByPath = new Map();

    /** Safely call an IPC method that may be undefined on older builds. */
    function _invokeIpcSafe(fnName, arg) {
      try {
        const fn = window.navio && window.navio[fnName];
        if (typeof fn === 'function') return fn(arg);
      } catch { /* swallow — UI should never crash on a missing IPC */ }
      return null;
    }

    /**
     * Build the per-row action buttons shown while a download is active
     * (progressing or paused). Called once on download-started and again
     * on download-progress when the pause flag flips.
     *   target    = 'drawer' | 'shelf'
     *   actionsEl = the container element to (re)fill
     *   savePath  = download id (also the destination path)
     */
    function renderActiveActions(target, actionsEl, savePath) {
      if (!actionsEl) return;
      actionsEl.innerHTML = '';
      const paused = downloadPausedByPath.get(savePath) === true;

      const btnPause = document.createElement('button');
      btnPause.type = 'button';
      btnPause.className =
        target === 'shelf' ? 'download-shelf-btn-cancel' : 'dd-btn-cancel';
      btnPause.textContent = paused ? 'Resume' : 'Pause';
      btnPause.title = paused ? 'Resume this download' : 'Pause this download';
      btnPause.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (downloadPausedByPath.get(savePath) === true) {
          _invokeIpcSafe('resumeDownload', savePath);
        } else {
          _invokeIpcSafe('pauseDownload', savePath);
        }
      });
      actionsEl.appendChild(btnPause);

      const btnCancel = document.createElement('button');
      btnCancel.type = 'button';
      btnCancel.className =
        target === 'shelf' ? 'download-shelf-btn-cancel' : 'dd-btn-cancel';
      btnCancel.textContent = 'Cancel';
      btnCancel.title = 'Cancel this download';
      btnCancel.addEventListener('click', (ev) => {
        ev.stopPropagation();
        _invokeIpcSafe('cancelDownload', savePath);
      });
      actionsEl.appendChild(btnCancel);

      if (target === 'shelf') {
        const dismissShelf = document.createElement('button');
        dismissShelf.type = 'button';
        dismissShelf.className = 'download-shelf-btn-dismiss';
        dismissShelf.textContent = '×';
        dismissShelf.title = 'Hide in bar (download continues)';
        dismissShelf.setAttribute('aria-label', 'Hide in download bar');
        dismissShelf.addEventListener('click', (ev) => {
          ev.stopPropagation();
          dismissShelfRow(savePath);
        });
        actionsEl.appendChild(dismissShelf);
      }
    }

    function ensureShelfRow(savePath, filename) {
      if (!shelfList || !savePath) return null;
      let row = shelfRowsByPath.get(savePath);
      if (!row) {
        row = document.createElement('div');
        row.className = 'download-shelf-row';
        row.innerHTML = `
          <div class="download-shelf-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="download-shelf-main">
            <div class="download-shelf-name"></div>
            <div class="download-shelf-meta"></div>
          </div>
          <div class="download-shelf-actions"></div>
          <div class="download-shelf-progress"><div class="download-shelf-progress-bar"></div></div>`;
        shelfList.appendChild(row);
        shelfRowsByPath.set(savePath, row);
      }
      const n = row.querySelector('.download-shelf-name');
      if (n) n.textContent = filename || savePath;
      return row;
    }

    const orb = document.getElementById('download-activity-orb');
    const dlBadge = document.getElementById('download-activity-badge');
    const DOWNLOADS_BTN_TITLE_DEFAULT = 'Downloads (Ctrl+J) — open list';

    function setDownloadChrome(active) {
      const w = document.querySelector('.nav-downloads-wrap');
      if (w) w.classList.toggle('download-active', !!active);
      if (orb) orb.classList.toggle('download-pulse', !!active);
      if (dlBadge) {
        if (activeDownloadCount > 0) {
          dlBadge.hidden = false;
          dlBadge.textContent = String(activeDownloadCount);
        } else {
          dlBadge.hidden = true;
        }
      }
      if (toggle) {
        toggle.setAttribute('aria-busy', activeDownloadCount > 0 ? 'true' : 'false');
        if (activeDownloadCount > 0) {
          toggle.title =
            activeDownloadCount === 1
              ? 'Downloading 1 file… — open list (Ctrl+J)'
              : `Downloading ${activeDownloadCount} files… — open list (Ctrl+J)`;
        } else {
          toggle.title = DOWNLOADS_BTN_TITLE_DEFAULT;
        }
      }
    }

    window.navio.onDownloadStarted((d) => {
      clearShelfHideTimer();
      // Remember retry info and pause state.
      if (d.savePath) {
        if (d.url) downloadUrlByPath.set(d.savePath, d.url);
        downloadPausedByPath.set(d.savePath, false);
      }

      const row = ensureRow(d.savePath, d.filename);
      if (!row) return;
      activeDownloadCount++;
      setDownloadChrome(true);
      row.classList.remove('dd-row-done', 'dd-row-failed');
      setRowOpenable(row, { savePath: d.savePath, filename: d.filename, openable: false });
      const wrapEl = row.querySelector('.dd-progress-wrap');
      // Flip to indeterminate immediately for size-unknown servers, otherwise
      // the bar would sit at 0% until the first 'updated' event.
      if (wrapEl) wrapEl.classList.toggle('dd-progress-indeterminate', !!d.indeterminate);
      const meta = row.querySelector('.dd-meta');
      if (meta) meta.textContent = d.totalStr || (d.total > 0 ? '' : '');
      row.querySelector('.dd-state').textContent = 'Starting…';
      const bar = row.querySelector('.dd-progress-bar');
      if (bar) bar.style.width = '0%';
      renderActiveActions('drawer', row.querySelector('.dd-actions'), d.savePath);

      if (shelf && shelfList) {
        shelf.hidden = false;
        const srow = ensureShelfRow(d.savePath, d.filename);
        if (srow) {
          const sm = srow.querySelector('.download-shelf-meta');
          if (sm) sm.textContent = d.totalStr ? `Starting… · ${d.totalStr}` : 'Starting…';
          const sb = srow.querySelector('.download-shelf-progress-bar');
          if (sb) sb.style.width = '0%';
          renderActiveActions('shelf', srow.querySelector('.download-shelf-actions'), d.savePath);
        }
      }
    });
    window.navio.onDownloadProgress((d) => {
      if (!d.savePath) return;

      // Detect pause-state change. If it flipped, re-render the action row
      // so the Pause button becomes Resume (or vice versa).
      const wasPaused = downloadPausedByPath.get(d.savePath) === true;
      const nowPaused = d.paused === true;
      if (wasPaused !== nowPaused) {
        downloadPausedByPath.set(d.savePath, nowPaused);
      }

      const row = rowsByPath.get(d.savePath);
      if (!row) return;
      const total = d.total || 0;
      const rec = d.received || 0;
      const pct = total > 0 ? Math.min(100, Math.round((rec / total) * 100)) : 0;
      const bar = row.querySelector('.dd-progress-bar');
      if (bar) bar.style.width = `${pct}%`;
      const wrapEl = row.querySelector('.dd-progress-wrap');
      if (wrapEl) wrapEl.classList.toggle('dd-progress-indeterminate', total === 0);
      const meta = row.querySelector('.dd-meta');
      if (meta) {
        const parts = [];
        if (d.receivedStr && d.totalStr) parts.push(`${d.receivedStr} / ${d.totalStr}`);
        else if (d.receivedStr) parts.push(d.receivedStr);
        const spd = formatDownloadSpeed(d.bytesPerSec);
        if (spd) parts.push(spd);
        if (d.etaStr) parts.push(d.etaStr);
        meta.textContent = parts.join(' · ');
      }
      const st = row.querySelector('.dd-state');
      if (st) {
        if (nowPaused) st.textContent = 'Paused';
        else st.textContent = total ? `${pct}%` : 'Downloading…';
      }

      if (wasPaused !== nowPaused) {
        renderActiveActions('drawer', row.querySelector('.dd-actions'), d.savePath);
      }

      if (shelf && shelfList && !shelfRowsByPath.get(d.savePath)) {
        shelf.hidden = false;
        ensureShelfRow(d.savePath, d.filename);
        const srowNew = shelfRowsByPath.get(d.savePath);
        if (srowNew) {
          renderActiveActions('shelf', srowNew.querySelector('.download-shelf-actions'), d.savePath);
        }
      }

      const srow = shelfRowsByPath.get(d.savePath);
      if (srow) {
        const sb = srow.querySelector('.download-shelf-progress-bar');
        if (sb) sb.style.width = `${pct}%`;
        const sm = srow.querySelector('.download-shelf-meta');
        if (sm) {
          if (nowPaused) {
            sm.textContent = d.totalStr ? `Paused · ${d.receivedStr || '0 B'} of ${d.totalStr}` : 'Paused';
          } else {
            const parts = [];
            if (d.receivedStr && d.totalStr) parts.push(`${d.receivedStr} of ${d.totalStr}`);
            else if (d.receivedStr) parts.push(d.receivedStr);
            const spd = formatDownloadSpeed(d.bytesPerSec);
            if (spd) parts.push(spd);
            if (d.etaStr) parts.push(d.etaStr);
            sm.textContent = parts.length ? parts.join(' · ') : total ? `${pct}%` : 'Downloading…';
          }
        }
        if (wasPaused !== nowPaused) {
          renderActiveActions('shelf', srow.querySelector('.download-shelf-actions'), d.savePath);
        }
      }
    });
    window.navio.onDownloadDone((d) => {
      if (activeDownloadCount > 0) activeDownloadCount--;
      const retryUrl = d.url || (d.savePath ? downloadUrlByPath.get(d.savePath) || '' : '');
      // Clean up transient maps — but keep retryUrl local for the button below.
      if (d.savePath) {
        downloadPausedByPath.delete(d.savePath);
        if (d.state === 'completed') downloadUrlByPath.delete(d.savePath);
      }

      let row = d.savePath ? rowsByPath.get(d.savePath) : null;
      if (!row && d.savePath) {
        row = ensureRow(d.savePath, d.filename);
      }
      if (row) {
        const bar = row.querySelector('.dd-progress-bar');
        if (bar) bar.style.width = '100%';
        const wrapEl = row.querySelector('.dd-progress-wrap');
        if (wrapEl) wrapEl.classList.remove('dd-progress-indeterminate');
        row.classList.toggle('dd-row-done', d.state === 'completed');
        row.classList.toggle('dd-row-failed', d.state !== 'completed');
        const stEl = row.querySelector('.dd-state');
        if (stEl) stEl.textContent = downloadStateLabel(d.state);
        const meta = row.querySelector('.dd-meta');
        if (meta && d.state === 'completed' && d.totalStr) {
          meta.textContent = d.totalStr;
        } else if (meta && d.state === 'completed' && !d.totalStr) {
          meta.textContent = '';
        } else if (meta && d.state !== 'completed') {
          meta.textContent = '';
        }
        const actions = row.querySelector('.dd-actions');
        if (actions) actions.innerHTML = '';
        if (d.state === 'completed' && d.savePath && actions) {
          setRowOpenable(row, { savePath: d.savePath, filename: d.filename, openable: true });
          const openB = document.createElement('button');
          openB.type = 'button';
          openB.className = 'dd-btn-folder dd-btn-open';
          openB.textContent = 'Open';
          openB.title = navioIsBrowserViewableDownloadPath(d.savePath)
            ? 'Open in Navio (new tab) — PDFs and web files open in the browser'
            : 'Open with default app';
          openB.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void navioOpenDownloadSmart(d.savePath);
          });
          actions.appendChild(openB);
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'dd-btn-folder';
          b.textContent = 'Show in folder';
          b.title = 'Reveal in File Explorer';
          b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            window.navio.showInFolder(d.savePath);
          });
          actions.appendChild(b);
        } else {
          setRowOpenable(row, { savePath: d.savePath || '', filename: d.filename, openable: false });
          if (actions && /^https?:\/\//i.test(retryUrl)) {
            const retryB = document.createElement('button');
            retryB.type = 'button';
            retryB.className = 'dd-btn-folder dd-btn-open';
            retryB.textContent = 'Retry';
            retryB.title = 'Re-download this file';
            retryB.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const incognito = !!(
                typeof TabManager !== 'undefined' &&
                TabManager.getActiveTab &&
                TabManager.getActiveTab()?.incognito
              );
              _invokeIpcSafe('retryDownload', { url: retryUrl, incognito });
            });
            actions.appendChild(retryB);
          }
        }
      }

      const srow = d.savePath ? shelfRowsByPath.get(d.savePath) : null;
      if (srow && d.savePath) {
        const sb = srow.querySelector('.download-shelf-progress-bar');
        if (sb) sb.style.width = '100%';
        const sm = srow.querySelector('.download-shelf-meta');
        if (sm) {
          if (d.state === 'completed') {
            sm.textContent = d.totalStr ? `Done · ${d.totalStr}` : 'Done';
          } else {
            sm.textContent = downloadStateLabel(d.state);
          }
        }
        const act = srow.querySelector('.download-shelf-actions');
        if (act && d.savePath) {
          act.innerHTML = '';
          if (d.state === 'completed' && d.savePath) {
            const openB = document.createElement('button');
            openB.type = 'button';
            openB.className = 'download-shelf-btn-open';
            openB.textContent = 'Open';
            openB.title = navioIsBrowserViewableDownloadPath(d.savePath)
              ? 'Open in Navio (new tab)'
              : 'Open with default app';
            openB.addEventListener('click', () => {
              void navioOpenDownloadSmart(d.savePath);
            });
            act.appendChild(openB);
            const foldB = document.createElement('button');
            foldB.type = 'button';
            foldB.className = 'download-shelf-btn-folder';
            foldB.textContent = 'Show in folder';
            foldB.title = 'Reveal in File Explorer';
            foldB.addEventListener('click', () => window.navio.showInFolder(d.savePath));
            act.appendChild(foldB);
          } else if (/^https?:\/\//i.test(retryUrl)) {
            const retryB = document.createElement('button');
            retryB.type = 'button';
            retryB.className = 'download-shelf-btn-open';
            retryB.textContent = 'Retry';
            retryB.title = 'Re-download this file';
            retryB.addEventListener('click', () => {
              const incognito = !!(
                typeof TabManager !== 'undefined' &&
                TabManager.getActiveTab &&
                TabManager.getActiveTab()?.incognito
              );
              _invokeIpcSafe('retryDownload', { url: retryUrl, incognito });
            });
            act.appendChild(retryB);
          }
          const dismissB = document.createElement('button');
          dismissB.type = 'button';
          dismissB.className = 'download-shelf-btn-dismiss';
          dismissB.textContent = '×';
          dismissB.title = 'Dismiss';
          dismissB.setAttribute('aria-label', 'Dismiss');
          dismissB.addEventListener('click', (ev) => {
            ev.stopPropagation();
            dismissShelfRow(d.savePath);
          });
          act.appendChild(dismissB);
        }
      }

      if (activeDownloadCount === 0) {
        setDownloadChrome(false);
        if (orb && d.state === 'completed') {
          orb.classList.add('download-done-pulse');
          setTimeout(() => {
            try {
              orb.classList.remove('download-done-pulse');
            } catch {
              /* ignore */
            }
          }, 1400);
        }
        scheduleShelfHide();
      } else {
        setDownloadChrome(true);
      }
    });
    function closeIfOutside(e) {
      if (panel.hidden) return;
      const t = e.target;
      if (wrap && wrap.contains(t)) return;
      if (panel.contains(t)) return;
      panel.hidden = true;
    }
    /** Dismiss on shell UI pointerdown (Chrome-style; faster than waiting for click). */
    document.addEventListener('pointerdown', closeIfOutside, true);

    function closeDownloadsDrawer() {
      panel.hidden = true;
    }

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || panel.hidden) return;
        closeDownloadsDrawer();
      },
      true
    );

    toggle &&
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.hidden = !panel.hidden;
        if (!panel.hidden) positionDownloadsDrawer();
      });

    const folderBtn = document.getElementById('btn-downloads-open-folder');
    folderBtn &&
      folderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          window.navio.openDownloadsFolder?.();
        } catch {
          /* ignore */
        }
      });

    const clearCompletedBtn = document.getElementById('btn-downloads-clear-completed');
    clearCompletedBtn &&
      clearCompletedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Remove all .dd-row-done rows (completed only). Failed/cancelled rows
        // stay visible so users can still retry. Files on disk are not touched.
        const toRemove = [];
        for (const [p, r] of rowsByPath.entries()) {
          if (r.classList.contains('dd-row-done')) toRemove.push(p);
        }
        for (const p of toRemove) {
          const r = rowsByPath.get(p);
          rowsByPath.delete(p);
          const idx = order.indexOf(p);
          if (idx >= 0) order.splice(idx, 1);
          try { r?.remove(); } catch { /* ignore */ }
        }
      });

    window.__navioToggleDownloadsDrawer = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) positionDownloadsDrawer();
    };
    window.__navioCloseDownloadsDrawer = closeDownloadsDrawer;
  }

  function bindHistoryPanel() {
    const overlay = document.getElementById('history-overlay');
    const list = document.getElementById('history-overlay-list');
    const q = document.getElementById('history-overlay-search');
    const close = document.getElementById('history-overlay-close');
    const clear = document.getElementById('history-overlay-clear');
    if (!overlay || !list) return;

    async function render(query) {
      await fillHistoryOverlayList(query !== undefined ? query : q && q.value);
    }

    close && close.addEventListener('click', () => (overlay.hidden = true));
    clear &&
      clear.addEventListener('click', async () => {
        if (confirm('Clear all history?')) {
          await window.navio.historyClear();
          render('');
        }
      });
    q &&
      q.addEventListener('input', () => {
        render(q.value);
      });

  }

  function bindTabSearch() {
    const overlay = document.getElementById('tab-search-overlay');
    const input = document.getElementById('tab-search-input');
    const list = document.getElementById('tab-search-list');
    const close = document.getElementById('tab-search-close');
    if (!overlay || !input || !list) return;

    function fuzzy(hay, needle) {
      if (!needle) return true;
      hay = (hay || '').toLowerCase();
      needle = needle.toLowerCase();
      let i = 0;
      for (const c of needle) {
        i = hay.indexOf(c, i);
        if (i === -1) return false;
        i++;
      }
      return true;
    }

    function render() {
      const q = input.value;
      list.innerHTML = '';
      if (typeof TabManager === 'undefined') return;
      TabManager.tabs.forEach((t) => {
        const disp = TabManager.getTabDisplayTitle(t);
        const line = `${disp} ${t.title || ''} ${t.url}`;
        if (!fuzzy(line, q)) return;
        const wrap = document.createElement('div');
        wrap.className = 'tab-search-row-wrap';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tab-search-row';
        row.textContent = disp || t.url || 'Tab';
        row.addEventListener('click', () => {
          TabManager.switchToTab(t.id);
          overlay.hidden = true;
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'tab-search-close-tab';
        del.title = t.pinned ? 'Pinned — unpin to close' : 'Close tab';
        del.textContent = '×';
        del.disabled = !!t.pinned;
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (t.pinned) return;
          TabManager.closeTab(t.id);
          render();
        });
        wrap.appendChild(row);
        wrap.appendChild(del);
        list.appendChild(wrap);
      });
    }

    input.addEventListener('input', render);
    close && close.addEventListener('click', () => (overlay.hidden = true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        overlay.hidden = true;
      }
    });
    window.addEventListener('navio-tabs-changed', () => {
      if (!overlay.hidden) render();
    });
  }

  function bindBookmarkStar() {
    const star = document.getElementById('btn-bookmark-page');
    if (!star) return;
    star.addEventListener('click', async () => {
      const tab = TabManager.getActiveTab();
      if (!tab || !tab.url || !tab.url.startsWith('http')) return;
      await window.navio.bookmarksAdd({
        title: TabManager.getTabDisplayTitle(tab),
        url: tab.url,
        favicon: tab.favicon,
        toBar: true
      });
      window.dispatchEvent(new Event('bookmarks-changed'));
      if (typeof _showAppToast === 'function') _showAppToast('Bookmark added', 'success');
    });
  }

  function applyTabLayoutFromConfig(cfg) {
    document.body.classList.toggle('navio-vertical-tabs', cfg.tabLayout === 'vertical');
    try {
      const w = localStorage.getItem('navio-tabstrip-side-width');
      if (w && !Number.isNaN(parseInt(w, 10))) {
        document.documentElement.style.setProperty('--tabstrip-side-width', `${parseInt(w, 10)}px`);
      }
    } catch (_) {}
  }

  window.applyTabLayoutFromConfig = applyTabLayoutFromConfig;

  async function refreshExtensionToolbar() {
    const bar = document.getElementById('extension-toolbar');
    if (!bar || !window.navio.extensionsList) return;
    try {
      const r = await window.navio.extensionsList();
      const loaded = r.loaded || [];
      bar.innerHTML = '';
      loaded.forEach((ex) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'extension-toolbar-btn';
        b.title = ex.name || ex.id;
        b.addEventListener('click', async () => {
          const res = await window.navio.extensionsOpenPopup(ex.id);
          if (res && !res.ok && res.error && typeof _showAppToast === 'function') {
            _showAppToast(res.error, 'warning');
          }
        });
        b.classList.add('extension-toolbar-btn-fallback');
        b.textContent = (ex.name && ex.name[0]) || '?';
        bar.appendChild(b);
      });
    } catch (_) {}
  }
  window.refreshNavioExtensionToolbar = refreshExtensionToolbar;

  function bindTabStripResize() {
    const handle = document.getElementById('tab-strip-resize');
    const strip = document.getElementById('tab-strip');
    if (!handle || !strip) return;
    let startX = 0;
    let startW = 240;
    handle.addEventListener('mousedown', (e) => {
      if (!document.body.classList.contains('navio-vertical-tabs')) return;
      e.preventDefault();
      startX = e.clientX;
      const cur = getComputedStyle(document.documentElement).getPropertyValue('--tabstrip-side-width').trim();
      startW = parseInt(cur, 10) || 240;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next = Math.min(400, Math.max(160, startW + dx));
        document.documentElement.style.setProperty('--tabstrip-side-width', `${next}px`);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try {
          const v = getComputedStyle(document.documentElement).getPropertyValue('--tabstrip-side-width');
          localStorage.setItem('navio-tabstrip-side-width', String(parseInt(v, 10) || 240));
        } catch (_) {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.navio.onSyncEvent) {
      window.navio.onSyncEvent((payload) => {
        if (payload && payload.type === 'sync-pulled') {
          window.dispatchEvent(new Event('bookmarks-changed'));
        }
      });
    }
    initBookmarkBar();
    bindBookmarkBarToggle();
    bindFindInPage();
    bindPrintZoomFullscreen();
    bindDownloadsDrawer();
    bindHistoryPanel();
    bindBookmarksOverlay();
    bindTabSearch();
    bindBookmarkStar();
    bindTabStripResize();
    refreshExtensionToolbar();
    window.navio.getConfig().then(applyTabLayoutFromConfig);
  });
})();
