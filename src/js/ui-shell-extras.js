/**
 * Bookmark bar, find-in-page, history panel, downloads drawer, tab search, layout, migration.
 */
(function () {
  let findUnsub;

  async function fillHistoryOverlayList(query) {
    const list = document.getElementById('history-overlay-list');
    if (!list || !window.navio.historySearch) return;
    const res = await window.navio.historySearch(query || '', 300);
    list.innerHTML = '';
    (res.entries || []).forEach((e) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'history-overlay-row';
      row.innerHTML = `<div class="h-title"></div><div class="h-url"></div>`;
      row.querySelector('.h-title').textContent = e.title || e.url;
      row.querySelector('.h-url').textContent = e.url;
      row.addEventListener('click', () => {
        if (typeof TabManager !== 'undefined') TabManager.navigateActive(e.url);
        const overlay = document.getElementById('history-overlay');
        if (overlay) overlay.hidden = true;
      });
      list.appendChild(row);
    });
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

  async function updateUrlZoomLabel() {
    const el = document.getElementById('url-zoom-label');
    if (!el) return;
    const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    if (!wv || typeof wv.getWebContentsId !== 'function') {
      el.textContent = '';
      return;
    }
    try {
      const z = await window.navio.webviewGetZoom(wv.getWebContentsId());
      const pct = Math.round((z.factor || 1) * 100);
      el.textContent = pct === 100 ? '' : `${pct}%`;
    } catch {
      el.textContent = '';
    }
  }
  window.__navioUpdateZoomLabel = updateUrlZoomLabel;

  window.__navioOpenHistoryOverlay = function () {
    const overlay = document.getElementById('history-overlay');
    if (overlay) {
      overlay.hidden = false;
      fillHistoryOverlayList('');
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
    async function render() {
      const data = await window.navio.bookmarksGet();
      bar.innerHTML = '';
      (data.bar || []).forEach((b) => {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'bookmark-bar-item';
        a.textContent = b.title || b.url;
        a.title = b.url;
        a.addEventListener('click', () => {
          if (typeof TabManager !== 'undefined') TabManager.navigateActive(b.url);
        });
        bar.appendChild(a);
      });
    }
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
      if (e.ctrlKey && e.key === 'f') {
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
      if (!wv || !wv.getWebContentsId) return;
      const id = wv.getWebContentsId();
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        window.navio.webviewPrint(id).catch(() => {});
      }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const z = await window.navio.webviewGetZoom(id);
        window.navio.webviewSetZoom(id, (z.factor || 1) + 0.1).catch(() => {});
        updateUrlZoomLabel();
      }
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        const z = await window.navio.webviewGetZoom(id);
        window.navio.webviewSetZoom(id, Math.max(0.25, (z.factor || 1) - 0.1)).catch(() => {});
        updateUrlZoomLabel();
      }
      if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        window.navio.webviewSetZoom(id, 1).catch(() => {});
        updateUrlZoomLabel();
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
    if (!panel || !list) return;
    const rowsByPath = new Map();
    const order = [];

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
        row.innerHTML = `<span class="dd-name"></span><div class="dd-progress-wrap"><div class="dd-progress-bar"></div></div><span class="dd-state"></span><span class="dd-actions"></span>`;
        list.appendChild(row);
        rowsByPath.set(savePath, row);
        order.push(savePath);
        trim();
      }
      const nameEl = row.querySelector('.dd-name');
      if (nameEl) nameEl.textContent = filename || savePath;
      return row;
    }

    window.navio.onDownloadStarted((d) => {
      const row = ensureRow(d.savePath, d.filename);
      if (!row) return;
      row.querySelector('.dd-state').textContent = 'Starting…';
      const bar = row.querySelector('.dd-progress-bar');
      if (bar) bar.style.width = '0%';
      row.querySelector('.dd-actions').innerHTML = '';
    });
    window.navio.onDownloadProgress((d) => {
      if (!d.savePath) return;
      const row = rowsByPath.get(d.savePath);
      if (!row) return;
      const total = d.total || 0;
      const rec = d.received || 0;
      const pct = total > 0 ? Math.min(100, Math.round((rec / total) * 100)) : 0;
      const bar = row.querySelector('.dd-progress-bar');
      if (bar) bar.style.width = `${pct}%`;
      row.querySelector('.dd-state').textContent = total ? `${pct}%` : 'Downloading…';
    });
    window.navio.onDownloadDone((d) => {
      let row = d.savePath ? rowsByPath.get(d.savePath) : null;
      if (!row && d.savePath) {
        row = ensureRow(d.savePath, d.filename);
      }
      if (row) {
        const bar = row.querySelector('.dd-progress-bar');
        if (bar) bar.style.width = '100%';
        row.querySelector('.dd-state').textContent = d.state === 'completed' ? 'Completed' : String(d.state || '');
        const actions = row.querySelector('.dd-actions');
        actions.innerHTML = '';
        if (d.state === 'completed' && d.savePath) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = 'Folder';
          b.addEventListener('click', () => window.navio.showInFolder(d.savePath));
          actions.appendChild(b);
        }
      }
    });
    toggle &&
      toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
      });
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
        const line = `${t.title} ${t.url}`;
        if (!fuzzy(line, q)) return;
        const wrap = document.createElement('div');
        wrap.className = 'tab-search-row-wrap';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tab-search-row';
        row.textContent = t.title || t.url || 'Tab';
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
  }

  function bindGlobalShortcuts() {
    if (!window.navio.onShortcut) return;
    window.navio.onShortcut((action) => {
      if (action === 'history-panel') {
        const overlay = document.getElementById('history-overlay');
        if (overlay) {
          overlay.hidden = false;
          fillHistoryOverlayList('');
        }
      }
      if (action === 'tab-search') {
        const overlay = document.getElementById('tab-search-overlay');
        const input = document.getElementById('tab-search-input');
        if (overlay && input) {
          overlay.hidden = false;
          input.value = '';
          input.dispatchEvent(new Event('input'));
          input.focus();
        }
      }
      if (action === 'bookmarks-panel') {
        const overlay = document.getElementById('bookmarks-overlay');
        if (overlay) {
          overlay.hidden = false;
          const inp = document.getElementById('bookmarks-overlay-search');
          if (inp) inp.value = '';
          fillBookmarksOverlayList('');
          inp && inp.focus();
        }
      }
    });
  }

  function bindBookmarkStar() {
    const star = document.getElementById('btn-bookmark-page');
    if (!star) return;
    star.addEventListener('click', async () => {
      const tab = TabManager.getActiveTab();
      if (!tab || !tab.url || !tab.url.startsWith('http')) return;
      await window.navio.bookmarksAdd({
        title: tab.title,
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
        b.style.backgroundImage = '';
        b.textContent = (ex.name && ex.name[0]) || '?';
        b.style.fontSize = '11px';
        b.style.color = 'var(--text-secondary)';
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
    initBookmarkBar();
    bindBookmarkBarToggle();
    bindFindInPage();
    bindPrintZoomFullscreen();
    bindDownloadsDrawer();
    bindHistoryPanel();
    bindBookmarksOverlay();
    bindTabSearch();
    bindGlobalShortcuts();
    bindBookmarkStar();
    bindTabStripResize();
    refreshExtensionToolbar();
    window.navio.getConfig().then(applyTabLayoutFromConfig);
  });
})();
