'use strict';

/**
 * Per-site "Compatibility Mode" kill switch.
 *
 * When an origin is marked as compatible, the guest webview preload does NOT
 * inject any of its behaviors (selection toolbar, password autofill detection,
 * inline-AI bookmark, login form observer, YouTube ad-skipper, etc.). The
 * page renders as plain Chromium with only the session-level UA / Sec-CH-UA
 * alignment in effect.
 *
 * Use this when a site (Purolator, FedEx, Cloudflare-protected portals, banking
 * forms, gov sites with strict anti-tampering, etc.) misbehaves because Navio's
 * page-level instrumentation gets in the way. Toggleable from the page context
 * menu.
 *
 * Storage: a dedicated JSON file `navio-site-compat.json` in userData (so it
 * survives sync without conflating with site-permissions). Only origins that
 * are explicitly enabled are persisted; removing an origin returns the site to
 * default (instrumented) behavior immediately on next navigation.
 */

const fs = require('fs');
const path = require('path');

function _storePath(userData) {
  return path.join(userData, 'navio-site-compat.json');
}

function _readRaw(userData) {
  try {
    const p = _storePath(userData);
    if (!fs.existsSync(p)) return { version: 1, origins: [] };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return { version: 1, origins: [] };
    const arr = Array.isArray(j.origins) ? j.origins : [];
    return { version: 1, origins: arr.filter((s) => typeof s === 'string' && s) };
  } catch (e) {
    console.warn('[navio] site-compat read:', e && e.message ? e.message : String(e));
    return { version: 1, origins: [] };
  }
}

function _writeRaw(userData, data) {
  try {
    fs.writeFileSync(_storePath(userData), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[navio] site-compat write:', e && e.message ? e.message : String(e));
    return false;
  }
}

/**
 * Normalize a URL or origin to a canonical `scheme://host[:port]` form.
 * Returns '' if the input is not an http(s) URL we can scope.
 */
function originFromUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    // Already an origin?
    if (/^https?:\/\/[^\s/]+$/i.test(raw)) return raw.replace(/\/+$/, '');
    return '';
  }
}

function listOrigins(userData) {
  const data = _readRaw(userData);
  return data.origins.slice();
}

function isCompat(userData, urlOrOrigin) {
  const o = originFromUrl(urlOrOrigin);
  if (!o) return false;
  const set = new Set(_readRaw(userData).origins);
  return set.has(o);
}

function setCompat(userData, urlOrOrigin, enabled) {
  const o = originFromUrl(urlOrOrigin);
  if (!o) return { ok: false, error: 'invalid_origin' };
  const data = _readRaw(userData);
  const set = new Set(data.origins);
  if (enabled) set.add(o);
  else set.delete(o);
  data.origins = Array.from(set).sort();
  _writeRaw(userData, data);
  return { ok: true, origin: o, enabled: !!enabled };
}

function toggleCompat(userData, urlOrOrigin) {
  const o = originFromUrl(urlOrOrigin);
  if (!o) return { ok: false, error: 'invalid_origin' };
  const data = _readRaw(userData);
  const set = new Set(data.origins);
  let enabled;
  if (set.has(o)) {
    set.delete(o);
    enabled = false;
  } else {
    set.add(o);
    enabled = true;
  }
  data.origins = Array.from(set).sort();
  _writeRaw(userData, data);
  return { ok: true, origin: o, enabled };
}

module.exports = {
  originFromUrl,
  listOrigins,
  isCompat,
  setCompat,
  toggleCompat
};
