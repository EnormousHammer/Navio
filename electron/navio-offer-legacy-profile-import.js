'use strict';

const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

function _historyEntryCount(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(d.entries) ? d.entries.length : 0;
  } catch {
    return 0;
  }
}

function _currentHistoryEmpty(userData) {
  return _historyEntryCount(path.join(userData, 'navio-history.json')) === 0;
}

/**
 * Find a folder (other than `userData`) that contains a non-empty Navio `navio-history.json`.
 * @param {string} userData
 * @param {string} profilesBase — root userData before per-profile setPath (see main.js)
 */
function findLegacyNavioDataDir(userData, profilesBase) {
  const cur = path.resolve(userData);
  const candidates = [];

  if (profilesBase && typeof profilesBase === 'string') {
    const root = path.resolve(profilesBase);
    if (root !== cur) {
      candidates.push(profilesBase);
    }
  }

  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'navio-browser'));
    candidates.push(path.join(process.env.APPDATA, 'Navio Browser'));
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME || '';
    if (home) {
      candidates.push(path.join(home, 'Library', 'Application Support', 'navio-browser'));
    }
  } else {
    const home = process.env.HOME || '';
    const xdg = process.env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : '');
    if (xdg) candidates.push(path.join(xdg, 'navio-browser'));
  }

  const seen = new Set();
  for (const dir of candidates) {
    if (!dir || typeof dir !== 'string') continue;
    let abs;
    try {
      abs = path.resolve(dir);
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (abs === cur) continue;
    const hp = path.join(dir, 'navio-history.json');
    if (_historyEntryCount(hp) > 0) return dir;
  }
  return null;
}

/** Safe to merge without bringing back another user's mail login or API keys. */
const LEGACY_SAFE_FILES = [
  'navio-history.json',
  'navio-bookmarks.json',
  'navio-reading-list.json',
];

/** Optional extras when the user explicitly confirms a full restore. */
const LEGACY_OPTIONAL_FILES = [
  'navio-site-permissions.json',
  'navio-site-compat.json',
];

/** Never copied — accounts, secrets, and assistant memory stay with the user who created them. */
const LEGACY_NEVER_FILES = new Set([
  'navio-oauth-tokens.json',
  'navio-config.json',
  'navio-passwords.json',
  'navio-memory.json',
  'navio-context-graph.json',
  'navio-assistant-chat.json',
  'navio-schedules.json',
  'navio-workflows.json',
  'navio-imap-creds.json',
  'navio-api-key.bin',
  'navio-sync-passphrase.sec',
  'navio-sync.navbak',
  'oem-stremio-credentials.json',
]);

function _copyIfExists(fromDir, toDir, name) {
  if (LEGACY_NEVER_FILES.has(name)) return;
  const from = path.join(fromDir, name);
  const to = path.join(toDir, name);
  if (!fs.existsSync(from)) return;
  fs.copyFileSync(from, to);
}

function _importFiles(legacy, ud, { includeOptional = false } = {}) {
  const list = includeOptional
    ? [...LEGACY_SAFE_FILES, ...LEGACY_OPTIONAL_FILES]
    : LEGACY_SAFE_FILES;
  for (const f of list) {
    try {
      _copyIfExists(legacy, ud, f);
    } catch (e) {
      console.warn('[navio] legacy profile import skipped file', f, e && e.message ? e.message : e);
    }
  }
  console.log('[navio] Profile browsing data restored from', legacy, '→', ud);
}

/** True when `userData` is a nested folder under `profilesBase` (e.g. profiles/work). */
function _isNestedUnderProfilesBase(userData, profilesBase) {
  if (!profilesBase || typeof profilesBase !== 'string') return false;
  try {
    const u = path.resolve(userData);
    const b = path.resolve(profilesBase);
    if (u === b) return false;
    const rel = path.relative(b, u);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Canonical dev-style Roaming / Application Support folder name. */
function _trustedAutoLegacyRoots() {
  const out = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    out.push(path.resolve(path.join(process.env.APPDATA, 'navio-browser')));
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME || '';
    if (home) {
      out.push(
        path.resolve(path.join(home, 'Library', 'Application Support', 'navio-browser'))
      );
    }
  } else {
    const home = process.env.HOME || '';
    const xdg = process.env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : '');
    if (xdg) out.push(path.resolve(path.join(xdg, 'navio-browser')));
  }
  return out;
}

/**
 * If the active profile has no browsing history but another Navio data folder on disk
 * has history, optionally copy **bookmarks + history only** (never mail OAuth or config).
 *
 * Silent auto-restore only copies LEGACY_SAFE_FILES. Mail sign-in and settings from a
 * previous install are never pulled in without the user connecting again.
 */
async function maybeOfferLegacyProfileImport({ app, getMainWindow, profilesBase }) {
  try {
    const ud = app.getPath('userData');
    if (!_currentHistoryEmpty(ud)) return;

    const legacy = findLegacyNavioDataDir(ud, profilesBase);
    if (!legacy) return;

    const legacyResolved = path.resolve(legacy);
    const baseResolved = profilesBase ? path.resolve(profilesBase) : '';
    const silentSubProfile =
      !!baseResolved &&
      legacyResolved === baseResolved &&
      _isNestedUnderProfilesBase(ud, profilesBase);
    const silentFromCanonicalNavioBrowser =
      _trustedAutoLegacyRoots().includes(legacyResolved) &&
      legacyResolved !== path.resolve(ud);
    const silentAuto = silentSubProfile || silentFromCanonicalNavioBrowser;

    if (!silentAuto) {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      const { response } = await dialog.showMessageBox(
        win && !win.isDestroyed() ? win : undefined,
        {
          type: 'question',
          buttons: ['Restore bookmarks & history', 'Not now'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: 'Navio — Previous browsing data found',
          message:
            'This profile has no browsing history, but another Navio folder on this computer has saved pages and bookmarks.',
          detail: `Restore only bookmarks and history from:\n${legacy}\n\nYour email sign-in and passwords are not copied — connect Gmail again after install.`
        }
      );
      if (response !== 0) return;
    } else {
      console.info(
        silentSubProfile
          ? '[navio] Auto-restoring bookmarks/history from default folder (empty history, no mail/config).'
          : '[navio] Auto-restoring bookmarks/history from canonical navio-browser folder (no mail/config).'
      );
    }

    _importFiles(legacy, ud, { includeOptional: false });
  } catch (e) {
    console.warn('[navio] legacy profile import:', e && e.message ? e.message : e);
  }
}

module.exports = { maybeOfferLegacyProfileImport, findLegacyNavioDataDir, LEGACY_NEVER_FILES };
