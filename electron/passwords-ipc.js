'use strict';

const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');

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

function registerPasswordsIpc(ipcMain) {
  ipcMain.handle('passwords-save', (_, { url, username, password, hidden }) => {
    try {
      const vault = _pwdLoad();
      const origin = _pwdOrigin(url);
      if (hidden === true && !_pwdOriginAllowsHiddenManaged(origin)) {
        return { ok: false, error: 'Managed hidden passwords are only supported for Stremio.' };
      }
      _pwdUpsertEntry(vault, origin, username, password, { hidden: hidden === true });
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
          if (e.hidden) continue;
          entries.push({ origin, username: e.username, created: e.created });
        }
      }
      return { ok: true, entries };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('passwords-get', (_, { url }) => {
    try {
      const vault = _pwdLoad();
      const origin = _pwdOrigin(url);
      const list = vault[origin] || [];
      const rows = list.map((e) => ({
        username: e.username,
        password: _pwdDecrypt(e.password),
        created: e.created,
        hidden: !!e.hidden,
      }));
      rows.sort((a, b) => Number(!!b.hidden) - Number(!!a.hidden));
      return { ok: true, entries: rows };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('passwords-delete', (_, { origin, username }) => {
    try {
      const vault = _pwdLoad();
      if (vault[origin]) {
        vault[origin] = vault[origin].filter(e => e.username !== username);
        if (!vault[origin].length) delete vault[origin];
      }
      _pwdSave(vault);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('passwords-export-csv', () => {
    try {
      const vault = _pwdLoad();
      const rows = ['name,url,username,password'];
      for (const [origin, list] of Object.entries(vault)) {
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
          const origin = _pwdOrigin(rawUrl);
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
