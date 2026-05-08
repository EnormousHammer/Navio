/**
 * Hostname list for Settings → Privacy → "Open in default browser".
 * Used by TabManager before guest loadURL; no build step — global on window.
 */
(function (g) {
  'use strict';

  /** @param {unknown} lines */
  function parseDefaultBrowserHostLines(lines) {
    const out = [];
    if (!Array.isArray(lines)) return out;
    for (const line of lines) {
      let s = String(line || '').trim().toLowerCase();
      if (!s || s.startsWith('#')) continue;
      s = s.replace(/^https?:\/\//, '');
      s = s.split('/')[0].split('?')[0].split(':')[0].trim();
      if (s && /^[a-z0-9.-]+$/.test(s)) out.push(s);
    }
    return out;
  }

  /** @param {string} hostname */
  function hostnameMatchesDefaultBrowserHosts(hostname, roots) {
    const h = String(hostname || '').toLowerCase().trim();
    if (!h) return false;
    const list = Array.isArray(roots) ? roots : [];
    for (const root of list) {
      const r = String(root || '').toLowerCase().trim();
      if (!r) continue;
      if (h === r || (h.length > r.length && h.endsWith('.' + r))) return true;
    }
    return false;
  }

  g.navioExternalBrowserHosts = { parseDefaultBrowserHostLines, hostnameMatchesDefaultBrowserHosts };
})(typeof window !== 'undefined' ? window : globalThis);
