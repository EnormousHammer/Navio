'use strict';

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const { loadBookmarks } = require('./bookmarks-ipc');
const { loadHistory } = require('./history-ipc');

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase || 'navio'), salt, 32);
}

function registerSyncIpc(ipcMain, { app, loadConfig }) {
  ipcMain.handle('sync-export-profile', async (event, { passphrase } = {}) => {
    const userData = app.getPath('userData');
    const payload = {
      v: 1,
      exportedAt: Date.now(),
      bookmarks: loadBookmarks(userData),
      history: loadHistory(userData),
      config: loadConfig()
    };
    delete payload.config.hasApiKey;
    const raw = JSON.stringify(payload);
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showSaveDialog(win || undefined, {
      title: 'Export Navio profile',
      defaultPath: 'navio-profile.navbak',
      filters: [{ name: 'Navio backup', extensions: ['navbak'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    let out = raw;
    if (passphrase && String(passphrase).length >= 4) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = deriveKey(passphrase, salt);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      out = JSON.stringify({
        enc: true,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: enc.toString('base64')
      });
    }
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
      const outer = JSON.parse(raw);
      if (outer.enc) {
        if (!passphrase || String(passphrase).length < 4) {
          return { ok: false, error: 'Passphrase required (min 4 chars).' };
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
        return { ok: false, error: 'Unrecognized backup format' };
      }
    } catch (e) {
      return { ok: false, error: e.message || 'Invalid backup file' };
    }
    if (!json.bookmarks || !json.history) return { ok: false, error: 'Invalid backup format' };
    const userData = app.getPath('userData');
    const { saveBookmarks } = require('./bookmarks-ipc');
    const { saveHistory } = require('./history-ipc');
    saveBookmarks(userData, json.bookmarks);
    saveHistory(userData, json.history);
    return { ok: true, message: 'Bookmarks and history restored. Restart recommended.' };
  });
}

module.exports = { registerSyncIpc };
