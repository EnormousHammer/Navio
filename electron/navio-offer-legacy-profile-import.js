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

const COPY_FILES = [
  'navio-history.json',
  'navio-bookmarks.json',
  'navio-reading-list.json',
  'navio-config.json',
  'navio-memory.json',
  'navio-context-graph.json',
  'navio-site-permissions.json',
  'navio-site-compat.json',
  'navio-assistant-chat.json',
  'navio-passwords.json',
  'navio-schedules.json',
  'navio-workflows.json'
];

function _copyIfExists(fromDir, toDir, name) {
  const from = path.join(fromDir, name);
  const to = path.join(toDir, name);
  if (!fs.existsSync(from)) return;
  fs.copyFileSync(from, to);
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

/** Canonical dev-style Roaming / Application Support folder name (safe to auto-merge from). */
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

function _importFiles(legacy, ud) {
  for (const f of COPY_FILES) {
    try {
      _copyIfExists(legacy, ud, f);
    } catch (e) {
      console.warn('[navio] legacy profile import skipped file', f, e && e.message ? e.message : e);
    }
  }
  console.log('[navio] Profile data restored from', legacy, '→', ud);
}

/**
 * If the active profile has no browsing history but another Navio data folder on disk
 * has a populated `navio-history.json`, copy core JSON stores into the active profile.
 *
 * Auto-restores (no dialog) when: (1) you use an empty sub-profile under the default
 * root but `navio-history.json` in that root still has entries, or (2) on Windows/macOS/Linux
 * the canonical `navio-browser` user-data folder has history while the active `userData`
 * path is different and empty. Other legacy locations still show a confirmation dialog.
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
          buttons: ['Restore', 'Not now'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: 'Navio — Previous data found',
          message:
            'This profile has no browsing history, but another Navio data folder on this computer has your saved pages, bookmarks, and settings.',
          detail: `Restore from:\n${legacy}\n\ninto your current profile:\n${ud}\n\nThis brings back address bar suggestions, the History panel, bookmarks, and appearance-related settings.`
        }
      );
      if (response !== 0) return;
    } else {
      console.info(
        silentSubProfile
          ? '[navio] Auto-restoring profile data from default folder into sub-profile (empty history).'
          : '[navio] Auto-restoring profile data from canonical navio-browser folder (empty profile, data found there).'
      );
    }

    _importFiles(legacy, ud);
  } catch (e) {
    console.warn('[navio] legacy profile import:', e && e.message ? e.message : e);
  }
}

module.exports = { maybeOfferLegacyProfileImport, findLegacyNavioDataDir };
