'use strict';

const { ipcMain, dialog, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBookmarks, saveBookmarks } = require('./bookmarks-ipc');
const { loadHistory, saveHistory } = require('./history-ipc');

const SYNC_FILENAME = 'navio-sync.navbak';
const PASSPHRASE_FILENAME = 'navio-sync-passphrase.sec';

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase || 'navio'), salt, 32);
}

function passphraseFilePath(userData) {
  return path.join(userData, PASSPHRASE_FILENAME);
}

function saveSyncPassphrase(userData, passphrase) {
  const p = passphraseFilePath(userData);
  if (!passphrase || String(passphrase).length < 4) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
    return;
  }
  const s = String(passphrase);
  let buf;
  if (safeStorage.isEncryptionAvailable()) {
    buf = safeStorage.encryptString(s);
  } else {
    buf = Buffer.from(s, 'utf8');
  }
  fs.writeFileSync(p, buf.toString('base64'), 'utf8');
}

function getSyncPassphrase(userData) {
  const p = passphraseFilePath(userData);
  if (!fs.existsSync(p)) return null;
  try {
    const b64 = fs.readFileSync(p, 'utf8');
    const buf = Buffer.from(b64, 'base64');
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch (_) {
    return null;
  }
}

function buildProfilePayload(userData, loadConfig) {
  const payload = {
    v: 1,
    exportedAt: Date.now(),
    bookmarks: loadBookmarks(userData),
    history: loadHistory(userData),
    config: loadConfig()
  };
  delete payload.config.hasApiKey;
  return payload;
}

/** @returns {{ outerExportedAt: number, json: object }} */
function parseProfileFile(raw, passphrase) {
  const outer = JSON.parse(raw);
  let outerExportedAt = Number(outer.exportedAt) || 0;
  let json;
  if (outer.enc) {
    if (!passphrase || String(passphrase).length < 4) {
      throw new Error('Passphrase required (min 4 chars).');
    }
    const salt = Buffer.from(outer.salt, 'base64');
    const iv = Buffer.from(outer.iv, 'base64');
    const tag = Buffer.from(outer.tag, 'base64');
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(Buffer.from(outer.data, 'base64')), decipher.final()]);
    json = JSON.parse(dec.toString('utf8'));
  } else if (outer.bookmarks && outer.history) {
    json = outer;
  } else {
    throw new Error('Unrecognized backup format');
  }
  if (!json.bookmarks || !json.history) throw new Error('Invalid backup format');
  if (!outerExportedAt && json.exportedAt) outerExportedAt = Number(json.exportedAt) || 0;
  return { outerExportedAt, json };
}

function serializeProfileForExport(payload, passphrase) {
  const raw = JSON.stringify(payload);
  if (!passphrase || String(passphrase).length < 4) return raw;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    syncFileVersion: 2,
    exportedAt: payload.exportedAt,
    enc: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64')
  });
}

function applyBookmarksHistory(userData, json) {
  saveBookmarks(userData, json.bookmarks);
  saveHistory(userData, json.history);
}

function readRemoteExportedAt(raw, passphrase) {
  try {
    const o = JSON.parse(raw);
    if (o.enc) {
      const t = Number(o.exportedAt) || 0;
      if (t > 0) return t;
      if (passphrase && String(passphrase).length >= 4) {
        const { outerExportedAt, json } = parseProfileFile(raw, passphrase);
        return Math.max(outerExportedAt, Number(json.exportedAt) || 0);
      }
      return 0;
    }
    return Number(o.exportedAt) || 0;
  } catch (_) {
    return 0;
  }
}

function runSyncCycle(app, loadConfig, saveConfig, { notifyRenderer } = {}) {
  const cfg = loadConfig();
  if (!cfg.syncEnabled || !cfg.syncFolderPath) return;
  const folder = String(cfg.syncFolderPath).trim();
  if (!folder || !fs.existsSync(folder)) return;

  const userData = app.getPath('userData');
  const pass = getSyncPassphrase(userData);
  if (!pass || pass.length < 4) return;

  const syncPath = path.join(folder, SYNC_FILENAME);
  const lastSeen = Number(cfg.syncLastSeenExportedAt) || 0;

  try {
    if (fs.existsSync(syncPath)) {
      const raw = fs.readFileSync(syncPath, 'utf8');
      const remoteAt = readRemoteExportedAt(raw, pass);
      if (remoteAt > lastSeen) {
        const { outerExportedAt, json } = parseProfileFile(raw, pass);
        applyBookmarksHistory(userData, json);
        const appliedAt = Math.max(remoteAt, outerExportedAt, Number(json.exportedAt) || 0);
        saveConfig({ syncLastSeenExportedAt: appliedAt });
        if (notifyRenderer) notifyRenderer({ type: 'sync-pulled', exportedAt: appliedAt });
      }
    }

    const payload = buildProfilePayload(userData, loadConfig);
    const out = serializeProfileForExport(payload, pass);
    fs.writeFileSync(syncPath, out, 'utf8');
    saveConfig({ syncLastSeenExportedAt: payload.exportedAt });
    if (notifyRenderer) notifyRenderer({ type: 'sync-pushed', exportedAt: payload.exportedAt });
  } catch (e) {
    console.warn('[navio-sync]', e.message);
  }
}

function startNavioCloudSync(app, loadConfig, saveConfig, getMainWindow) {
  let timer = null;
  const tick = () => {
    try {
      const win = getMainWindow && getMainWindow();
      const notify = win && !win.isDestroyed()
        ? (payload) => {
            try {
              win.webContents.send('navio-sync-event', payload);
            } catch (_) {}
          }
        : null;
      runSyncCycle(app, loadConfig, saveConfig, { notifyRenderer: notify });
    } catch (e) {
      console.warn('[navio-sync] cycle', e.message);
    }
  };

  const arm = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 4 * 60 * 1000);
  };

  app.on('before-quit', () => {
    try {
      runSyncCycle(app, loadConfig, saveConfig);
    } catch (_) {}
  });

  setTimeout(() => {
    tick();
    arm();
  }, 8000);
}

function registerSyncIpc(ipcMain, { app, loadConfig, saveConfig }) {
  ipcMain.handle('sync-export-profile', async (event, { passphrase } = {}) => {
    const userData = app.getPath('userData');
    const payload = buildProfilePayload(userData, loadConfig);
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showSaveDialog(win || undefined, {
      title: 'Export Navio profile',
      defaultPath: 'navio-profile.navbak',
      filters: [{ name: 'Navio backup', extensions: ['navbak'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    const out = serializeProfileForExport(payload, passphrase);
    fs.writeFileSync(r.filePath, out, 'utf8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('sync-import-profile', async (event, { passphrase, filePath } = {}) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    let p = filePath;
    if (!p) {
      const r = await dialog.showOpenDialog(win || undefined, {
        properties: ['openFile'],
        filters: [{ name: 'Navio backup', extensions: ['navbak', 'json'] }]
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true };
      p = r.filePaths[0];
    }
    const raw = fs.readFileSync(p, 'utf8');
    let json;
    try {
      const { json: inner } = parseProfileFile(raw, passphrase);
      json = inner;
    } catch (e) {
      return { ok: false, error: e.message || 'Invalid backup file' };
    }
    const userData = app.getPath('userData');
    applyBookmarksHistory(userData, json);
    return { ok: true, message: 'Bookmarks and history restored. Restart recommended.' };
  });

  ipcMain.handle('sync-pick-folder', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win || undefined, {
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('sync-get-status', () => {
    const userData = app.getPath('userData');
    const cfg = loadConfig();
    return {
      hasPassphrase: !!getSyncPassphrase(userData),
      syncFolderPath: cfg.syncFolderPath || '',
      syncLastSeenExportedAt: Number(cfg.syncLastSeenExportedAt) || 0,
      syncEnabled: !!cfg.syncEnabled
    };
  });

  ipcMain.handle('sync-save-passphrase', (event, { passphrase } = {}) => {
    if (passphrase === undefined) return { ok: true };
    const userData = app.getPath('userData');
    const s = passphrase == null ? '' : String(passphrase);
    if (s.length > 0 && s.length < 4) {
      return { ok: false, error: 'Passphrase must be at least 4 characters.' };
    }
    saveSyncPassphrase(userData, s);
    return { ok: true };
  });

  ipcMain.handle('sync-run-now', () => {
    try {
      runSyncCycle(app, loadConfig, saveConfig);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerSyncIpc, startNavioCloudSync };
