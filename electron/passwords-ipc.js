'use strict';

const path = require('path');
const fs = require('fs');
const { app, safeStorage, dialog, BrowserWindow } = require('electron');

// Credentials stored in <userData>/navio-passwords.json.
// Passwords are encrypted with Electron's safeStorage (OS keychain / DPAPI).

function _pwdVaultPath() {
  return path.join(app.getPath('userData'), 'navio-passwords.json');
}

function _pwdLoad() {
  try { return JSON.parse(fs.readFileSync(_pwdVaultPath(), 'utf8')); } catch { return {}; }
}

function _pwdSave(vault) {
  fs.writeFileSync(_pwdVaultPath(), JSON.stringify(vault, null, 2), 'utf8');
}

function _pwdEncrypt(val) {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(val).toString('base64');
  return Buffer.from(val, 'utf8').toString('base64');
}

function _pwdDecrypt(enc) {
  const buf = Buffer.from(enc, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8');
  } catch { return ''; }
}

function _pwdOrigin(url) {
  try { return new URL(url).origin; } catch { return url; }
}

/** Only http(s) with a real host — never persist credentials keyed as `null`, `javascript:`, etc. */
function _pwdAllowedVaultOrigin(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function _pwdParentWindow(event) {
  try {
    return BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
  } catch {
    return null;
  }
}

function _pwdSortEntriesForAutofill(rows) {
  return rows.slice().sort((a, b) => {
    const ho = Number(!!a.hidden) - Number(!!b.hidden);
    if (ho !== 0) return ho;
    return String(b.created || '').localeCompare(String(a.created || ''));
  });
}

/**
 * Same registrable site with/without `www` (e.g. `https://reddit.com` <-> `https://www.reddit.com`).
 * Skips multi-label hosts (`accounts.google.com`) so we do not invent bogus realms.
 */
function _pwdOriginSiblings(origin) {
  if (!origin || typeof origin !== 'string') return [];
  const set = new Set([origin]);
  try {
    const u = new URL(origin);
    const h = u.hostname;
    const labels = h.split('.').filter(Boolean);
    const apexPairOnly =
      labels.length === 2 || (labels.length === 3 && String(labels[1]).length <= 3); // e.g. foo.co.uk
    if (h.startsWith('www.')) {
      u.hostname = h.slice(4);
      set.add(u.origin);
    } else if (apexPairOnly) {
      u.hostname = `www.${h}`;
      set.add(u.origin);
    }
  } catch {
    /* ignore */
  }
  return [...set];
}

/** Origins where we allow managed (hidden-from-UI) vault rows and silent autofill. */
const STREMIO_MANAGED_ORIGINS = new Set([
  'https://web.stremio.com',
  'https://www.stremio.com',
  'https://app.stremio.com',
]);

function _pwdOriginAllowsHiddenManaged(origin) {
  return STREMIO_MANAGED_ORIGINS.has(origin);
}

function _pwdUpsertEntry(vault, origin, username, password, { hidden } = {}) {
  if (!vault[origin]) vault[origin] = [];
  const idx = vault[origin].findIndex((e) => e.username === username);
  const entry = {
    username,
    password: _pwdEncrypt(password),
    created: new Date().toISOString(),
    ...(hidden ? { hidden: true } : {}),
  };
  if (idx >= 0) vault[origin][idx] = entry;
  else vault[origin].push(entry);
}

/**
 * OEM / release pipeline: drop `oem-stremio-credentials.json` next to the app
 * (resources/ when packaged) or in userData once; it is deleted after a successful import.
 * Shape: { "email": "...", "password": "..." } (username also accepted).
 */
function maybeImportOemStremioCredentials() {
  const candidates = [
    path.join(process.resourcesPath || '', 'oem-stremio-credentials.json'),
    path.join(app.getPath('userData'), 'oem-stremio-credentials.json'),
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const username = String(raw.email || raw.username || raw.user || '').trim();
      const password = String(raw.password || raw.pass || '').trim();
      if (!username || !password) {
        console.warn('[navio] OEM Stremio file missing email or password:', p);
        try { fs.unlinkSync(p); } catch { /* ignore */ }
        continue;
      }
      const origin = 'https://web.stremio.com';
      const vault = _pwdLoad();
      _pwdUpsertEntry(vault, origin, username, password, { hidden: true });
      _pwdSave(vault);
      try { fs.unlinkSync(p); } catch { /* ignore */ }
      console.log('[navio] Imported managed Stremio login (OEM file removed).');
      return;
    } catch (e) {
      console.warn('[navio] OEM Stremio import failed:', p, e.message);
    }
  }
}

function _pwdNeverListPath() {
  return path.join(app.getPath('userData'), 'navio-passwords-never.json');
}

function _pwdNeverListLoad() {
  try { return JSON.parse(fs.readFileSync(_pwdNeverListPath(), 'utf8')); } catch { return []; }
}

function _pwdNeverListSave(list) {
  fs.writeFileSync(_pwdNeverListPath(), JSON.stringify(list), 'utf8');
}

function registerPasswordsIpc(ipcMain) {
  ipcMain.handle('passwords-never-add', (_, { url }) => {
    try {
      const origin = _pwdAllowedVaultOrigin(url);
      if (!origin) return { ok: false, error: 'invalid origin' };
      const list = _pwdNeverListLoad();
      if (!list.includes(origin)) { list.push(origin); _pwdNeverListSave(list); }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('passwords-never-check', (_, { url }) => {
    try {
      const origin = _pwdAllowedVaultOrigin(url);
      if (!origin) return { ok: true, never: false };
      const list = _pwdNeverListLoad();
      const origins = _pwdOriginSiblings(origin);
      const never = origins.some((o) => list.includes(o));
      return { ok: true, never };
    } catch { return { ok: true, never: false }; }
  });

  ipcMain.handle('passwords-never-remove', (_, { url }) => {
    try {
      const origin = _pwdAllowedVaultOrigin(url);
      if (!origin) return { ok: false, error: 'invalid origin' };
      const origins = new Set(_pwdOriginSiblings(origin));
      const list = _pwdNeverListLoad().filter((o) => !origins.has(o));
      _pwdNeverListSave(list);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('passwords-save', (_, { url, username, password, hidden }) => {
    try {
      const origin = _pwdAllowedVaultOrigin(url);
      if (!origin) return { ok: false, error: 'Only http(s) page URLs can store passwords.' };
      const u = String(username || '').trim();
      const p = String(password || '');
      if (!u) return { ok: false, error: 'Username is required.' };
      if (!p) return { ok: false, error: 'Password is empty.' };
      const vault = _pwdLoad();
      if (hidden === true && !_pwdOriginAllowsHiddenManaged(origin)) {
        return { ok: false, error: 'Managed hidden passwords are only supported for Stremio.' };
      }
      _pwdUpsertEntry(vault, origin, u, p, { hidden: hidden === true });
      _pwdSave(vault);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('passwords-list', () => {
    try {
      const vault = _pwdLoad();
      const entries = [];
      for (const [origin, list] of Object.entries(vault)) {
        for (const e of list) {
          // Include hidden entries too so the user can manage them from settings.
          // The `hidden` flag is forwarded so the UI can label / treat them differently.
          entries.push({
            origin,
            username: e.username,
            created: e.created,
            hidden: !!e.hidden,
          });
        }
      }
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Reveal a single password on demand from the settings UI (native confirm first).
  ipcMain.handle('passwords-reveal', async (event, { origin, username }) => {
    try {
      if (!origin || !username) return { ok: false, error: 'origin and username required' };
      const allowed = _pwdAllowedVaultOrigin(origin);
      if (!allowed) return { ok: false, error: 'invalid origin' };
      const win = _pwdParentWindow(event);
      const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'question',
        buttons: ['Cancel', 'Reveal password'],
        defaultId: 0,
        cancelId: 0,
        title: 'Reveal saved password',
        message: `Show the saved password for "${String(username)}"?`,
        detail: `Site: ${allowed}\n\nAnyone who can use this device while you are away could see it.`,
        noLink: true
      });
      if (response !== 1) return { ok: false, error: 'cancelled' };
      const vault = _pwdLoad();
      const keys = _pwdOriginSiblings(allowed);
      for (const o of keys) {
        const list = vault[o] || [];
        const hit = list.find((e) => e.username === username);
        if (hit) {
          const pwd = _pwdDecrypt(hit.password);
          return { ok: true, password: pwd };
        }
      }
      return { ok: false, error: 'entry not found' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('passwords-get', (_, { url }) => {
    try {
      const origin = _pwdAllowedVaultOrigin(url);
      if (!origin) return { ok: true, entries: [] };
      const vault = _pwdLoad();
      const origins = _pwdOriginSiblings(origin);
      const byUser = new Map();
      for (const o of origins) {
        for (const e of vault[o] || []) {
          const row = {
            username: e.username,
            password: _pwdDecrypt(e.password),
            created: e.created,
            hidden: !!e.hidden,
          };
          const prev = byUser.get(e.username);
          if (!prev || String(row.created || '') > String(prev.created || '')) {
            byUser.set(e.username, row);
          }
        }
      }
      const rows = _pwdSortEntriesForAutofill([...byUser.values()]);
      return { ok: true, entries: rows };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('passwords-delete', (_, { origin, username }) => {
    try {
      const allowed = _pwdAllowedVaultOrigin(origin);
      if (!allowed) return { ok: false, error: 'invalid origin' };
      const vault = _pwdLoad();
      const keys = _pwdOriginSiblings(allowed);
      for (const o of keys) {
        if (vault[o]) {
          vault[o] = vault[o].filter((e) => e.username !== username);
          if (!vault[o].length) delete vault[o];
        }
      }
      _pwdSave(vault);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('passwords-export-csv', async (event) => {
    try {
      const win = _pwdParentWindow(event);
      const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'warning',
        buttons: ['Cancel', 'Export'],
        defaultId: 0,
        cancelId: 0,
        title: 'Export passwords',
        message: 'Export all saved passwords as a plaintext CSV file?',
        detail: 'The file will contain readable passwords. Store it safely or delete it after use.',
        noLink: true
      });
      if (response !== 1) return { ok: false, error: 'cancelled' };
      const vault = _pwdLoad();
      const rows = ['name,url,username,password'];
      for (const [origin, list] of Object.entries(vault)) {
        if (!_pwdAllowedVaultOrigin(origin)) continue;
        const site = origin.replace(/^https?:\/\//, '');
        for (const e of list) {
          if (e.hidden) continue;
          const pwd = _pwdDecrypt(e.password);
          rows.push(`"${site}","${origin}","${e.username.replace(/"/g, '""')}","${pwd.replace(/"/g, '""')}"`);
        }
      }
      return { ok: true, csv: rows.join('\n') };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('passwords-import-csv', (_, { csv }) => {
    try {
      const vault = _pwdLoad();
      const lines = csv.split('\n');
      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        // Minimal RFC-4180 CSV parse
        const parts = [];
        let cur = '', inQ = false;
        for (const ch of line + ',') {
          if (ch === '"') { inQ = !inQ; continue; }
          if (ch === ',' && !inQ) { parts.push(cur); cur = ''; continue; }
          cur += ch;
        }
        if (parts.length < 4) continue;
        // Chrome format: name, url, username, password
        const [, rawUrl, username, password] = parts;
        if (!rawUrl || !username || !password) continue;
        try {
          const origin = _pwdAllowedVaultOrigin(rawUrl);
          if (!origin) continue;
          if (!vault[origin]) vault[origin] = [];
          const idx = vault[origin].findIndex(e => e.username === username);
          const entry = { username, password: _pwdEncrypt(password), created: new Date().toISOString() };
          if (idx >= 0) vault[origin][idx] = entry; else vault[origin].push(entry);
          imported++;
        } catch { /* skip malformed row */ }
      }
      _pwdSave(vault);
      return { ok: true, imported };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerPasswordsIpc, maybeImportOemStremioCredentials };
