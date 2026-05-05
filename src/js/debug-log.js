/**
 * Navio Debug Log Panel
 *
 * Displays live log entries (errors, warnings, browser-action failures, page
 * console errors, navigation failures) from the main process in a collapsible
 * panel at the bottom of the shell.
 *
 * Toggle:  Ctrl+Shift+L  (or click the badge that appears on new errors)
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _entries = [];       // all entries in memory (capped)
  let _errorsOnly = false; // filter toggle
  let _open = false;
  let _unread = 0;
  const MAX_ENTRIES = 400;

  // ── DOM refs (populated in init) ──────────────────────────────────────────
  let _panel, _list, _badge, _badgeCount;

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    _panel      = document.getElementById('debug-log-panel');
    _list       = document.getElementById('debug-log-list');
    _badge      = document.getElementById('debug-log-badge');
    _badgeCount = document.getElementById('debug-log-badge-count');

    if (!_panel || !_list || !_badge) return;

    // Buttons
    document.getElementById('debug-log-close').addEventListener('click', () => close());
    document.getElementById('debug-log-clear').addEventListener('click', () => {
      _entries = [];
      _unread = 0;
      _render();
      _updateBadge();
    });
    document.getElementById('debug-log-errors-only').addEventListener('click', (e) => {
      _errorsOnly = !_errorsOnly;
      e.currentTarget.classList.toggle('active', _errorsOnly);
      e.currentTarget.textContent = _errorsOnly ? 'All levels' : 'Errors only';
      _render();
    });
    document.getElementById('debug-log-open-file').addEventListener('click', async () => {
      try {
        const p = await window.navio.getLogPath();
        if (p) {
          // Open the containing folder in Explorer
          window.navio.showInFolder(p);
        }
      } catch { /* ignore */ }
    });
    _badge.addEventListener('click', () => toggle());

    // Keyboard shortcut Ctrl+Shift+L
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        toggle();
      }
    });

    // Load recent entries from disk
    try {
      const recent = await window.navio.getRecentLogs(200);
      if (Array.isArray(recent)) {
        recent.forEach((entry) => _addEntry(entry, false));
        _render();
        _updateBadge();
      }
    } catch { /* ignore */ }

    // Subscribe to live entries
    window.navio.onLogEntry((entry) => {
      _addEntry(entry, true);
    });
  }

  // ── Entry management ──────────────────────────────────────────────────────
  function _addEntry(entry, live) {
    if (!entry || typeof entry !== 'object') return;
    _entries.push(entry);
    if (_entries.length > MAX_ENTRIES) _entries.shift();

    if (live) {
      if (!_open && entry.level === 'error') {
        _unread++;
        _updateBadge();
        _badge.hidden = false;
      }
      // If panel is open, append the row directly instead of full re-render
      if (_open && _list) {
        const visible = !_errorsOnly || entry.level === 'error';
        if (visible) {
          const row = _buildRow(entry);
          _list.appendChild(row);
          _list.scrollTop = _list.scrollHeight;
        }
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function _render() {
    if (!_list) return;
    _list.innerHTML = '';
    const visible = _errorsOnly
      ? _entries.filter((e) => e.level === 'error')
      : _entries;

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'debug-log-empty';
      empty.textContent = _errorsOnly ? 'No errors recorded.' : 'No log entries yet.';
      _list.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    visible.forEach((entry) => frag.appendChild(_buildRow(entry)));
    _list.appendChild(frag);
    _list.scrollTop = _list.scrollHeight;
  }

  function _buildRow(entry) {
    const row = document.createElement('div');
    row.className = `debug-log-row debug-log-${entry.level || 'info'}`;

    const ts = document.createElement('span');
    ts.className = 'debug-log-ts';
    ts.textContent = _shortTs(entry.ts);

    const lvl = document.createElement('span');
    lvl.className = 'debug-log-level';
    lvl.textContent = (entry.level || 'info').toUpperCase();

    const src = document.createElement('span');
    src.className = 'debug-log-source';
    src.textContent = entry.source || '';

    const msg = document.createElement('span');
    msg.className = 'debug-log-msg';
    msg.textContent = entry.message || '';

    row.appendChild(ts);
    row.appendChild(lvl);
    row.appendChild(src);
    row.appendChild(msg);

    if (entry.detail) {
      const detail = document.createElement('details');
      detail.className = 'debug-log-detail';
      const summary = document.createElement('summary');
      summary.textContent = 'details';
      const pre = document.createElement('pre');
      pre.textContent = entry.detail;
      detail.appendChild(summary);
      detail.appendChild(pre);
      row.appendChild(detail);
    }

    return row;
  }

  function _shortTs(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour12: false });
    } catch {
      return iso.slice(11, 19);
    }
  }

  // ── Panel open / close ────────────────────────────────────────────────────
  function open() {
    if (!_panel) return;
    _open = true;
    _unread = 0;
    _panel.hidden = false;
    _updateBadge();
    _render();
  }

  function close() {
    if (!_panel) return;
    _open = false;
    _panel.hidden = true;
  }

  function toggle() {
    _open ? close() : open();
  }

  // ── Badge ─────────────────────────────────────────────────────────────────
  function _updateBadge() {
    if (!_badge || !_badgeCount) return;
    const errCount = _entries.filter((e) => e.level === 'error').length;
    if (_open || errCount === 0) {
      _badge.hidden = true;
    } else {
      _badgeCount.textContent = _unread > 99 ? '99+' : String(_unread);
      _badge.hidden = _unread === 0;
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose minimal API for external callers (e.g. shortcuts wired in app.js)
  window.NavioDebugLog = { open, close, toggle };
})();
