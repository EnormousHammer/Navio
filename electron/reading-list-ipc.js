'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Entries: [ { url, title, favicon, added, read } ] stored in <userData>/navio-reading-list.json

function _rlPath() {
  return path.join(app.getPath('userData'), 'navio-reading-list.json');
}
function _rlLoad() {
  try { return JSON.parse(fs.readFileSync(_rlPath(), 'utf8')); } catch { return []; }
}
function _rlSave(list) {
  fs.writeFileSync(_rlPath(), JSON.stringify(list, null, 2), 'utf8');
}

function registerReadingListIpc(ipcMain) {
  ipcMain.handle('reading-list-add', (_, { url, title, favicon }) => {
    try {
      const list = _rlLoad();
      if (list.some(e => e.url === url)) return { ok: true, added: false };
      list.unshift({ url, title: title || url, favicon: favicon || null, added: new Date().toISOString(), read: false });
      if (list.length > 1000) list.splice(1000);
      _rlSave(list);
      return { ok: true, added: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('reading-list-get', () => {
    try { return { ok: true, list: _rlLoad() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('reading-list-remove', (_, { url }) => {
    try {
      _rlSave(_rlLoad().filter(e => e.url !== url));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('reading-list-mark-read', (_, { url }) => {
    try {
      const list = _rlLoad();
      const item = list.find(e => e.url === url);
      if (item) { item.read = true; _rlSave(list); }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerReadingListIpc };
