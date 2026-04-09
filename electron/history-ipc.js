'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const MAX_ENTRIES = 10000;

function historyPath(userData) {
  return path.join(userData, 'navio-history.json');
}

function loadHistory(userData) {
  try {
    const p = historyPath(userData);
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!d.entries) d.entries = [];
      return d;
    }
  } catch (e) {
    console.error('loadHistory', e.message);
  }
  return { version: 1, entries: [] };
}

function saveHistory(userData, data) {
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }
  fs.writeFileSync(historyPath(userData), JSON.stringify(data, null, 2), 'utf8');
}

function registerHistoryIpc(ipcMain, { app }) {
  ipcMain.handle('history-get', () => loadHistory(app.getPath('userData')));

  ipcMain.handle('history-add', (_, { url, title, favicon }) => {
    if (!url || typeof url !== 'string') return { ok: false };
    try {
      const u = new URL(url);
      if (!u.protocol.startsWith('http')) return { ok: false };
    } catch {
      return { ok: false };
    }
    const userData = app.getPath('userData');
    const data = loadHistory(userData);
    const norm = normalizeUrl(url);
    const existing = data.entries.find((e) => normalizeUrl(e.url) === norm);
    if (existing) {
      existing.visitCount = (existing.visitCount || 1) + 1;
      existing.visitedAt = Date.now();
      if (title) existing.title = title;
      if (favicon) existing.favicon = favicon;
    } else {
      data.entries.push({
        id: crypto.randomBytes(8).toString('hex'),
        url,
        title: title || url,
        favicon: favicon || '',
        visitedAt: Date.now(),
        visitCount: 1
      });
    }
    saveHistory(userData, data);
    return { ok: true };
  });

  ipcMain.handle('history-search', (_, { query, limit = 200 }) => {
    const data = loadHistory(app.getPath('userData'));
    const q = (query || '').toLowerCase().trim();
    if (!q) return { entries: data.entries.slice(-limit).reverse() };
    const filtered = data.entries.filter(
      (e) =>
        (e.title && e.title.toLowerCase().includes(q)) ||
        (e.url && e.url.toLowerCase().includes(q))
    );
    return { entries: filtered.slice(-limit).reverse() };
  });

  ipcMain.handle('history-remove', (_, { id }) => {
    const userData = app.getPath('userData');
    const data = loadHistory(userData);
    data.entries = data.entries.filter((e) => e.id !== id);
    saveHistory(userData, data);
    return { ok: true };
  });

  ipcMain.handle('history-clear', () => {
    saveHistory(app.getPath('userData'), { version: 1, entries: [] });
    return { ok: true };
  });
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

module.exports = { registerHistoryIpc, loadHistory, saveHistory };
