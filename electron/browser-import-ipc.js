'use strict';

const path = require('path');
const fs = require('fs');

function countBookmarks(roots) {
  let count = 0;
  function walk(node) {
    if (!node) return;
    if (node.type === 'url') { count++; return; }
    if (node.children) node.children.forEach(walk);
    if (typeof node === 'object' && !node.type && !node.children) {
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') walk(v); });
    }
  }
  walk(roots);
  return count;
}

function registerBrowserImportIpc(ipcMain) {
  ipcMain.handle('detect-browsers', async () => {
    const browsers = [];
    const localAppData = process.env.LOCALAPPDATA || '';
    const appData = process.env.APPDATA || '';
    const home = process.env.HOME || process.env.USERPROFILE || '';

    const candidates = [
      // Windows
      { id: 'chrome',   name: 'Google Chrome',   bookmarks: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks') },
      { id: 'edge',     name: 'Microsoft Edge',   bookmarks: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks') },
      { id: 'brave',    name: 'Brave',            bookmarks: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks') },
      { id: 'opera',    name: 'Opera',            bookmarks: path.join(appData, 'Opera Software', 'Opera Stable', 'Bookmarks') },
      { id: 'vivaldi',  name: 'Vivaldi',          bookmarks: path.join(localAppData, 'Vivaldi', 'User Data', 'Default', 'Bookmarks') },
      // macOS
      { id: 'chrome',   name: 'Google Chrome',   bookmarks: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Bookmarks') },
      { id: 'edge',     name: 'Microsoft Edge',   bookmarks: path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Bookmarks') },
      { id: 'brave',    name: 'Brave',            bookmarks: path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'Default', 'Bookmarks') },
      { id: 'safari',   name: 'Safari',           bookmarks: path.join(home, 'Library', 'Safari', 'Bookmarks.plist') },
      { id: 'vivaldi',  name: 'Vivaldi',          bookmarks: path.join(home, 'Library', 'Application Support', 'Vivaldi', 'Default', 'Bookmarks') },
    ];

    const seen = new Set();
    for (const b of candidates) {
      if (b.id === 'safari') continue; // plist format — not supported yet
      try {
        if (fs.existsSync(b.bookmarks)) {
          if (seen.has(b.id)) continue; // first match wins (e.g. Windows path found, skip mac path)
          seen.add(b.id);
          const data = JSON.parse(fs.readFileSync(b.bookmarks, 'utf-8'));
          const count = countBookmarks(data.roots);
          browsers.push({ id: b.id, name: b.name, path: b.bookmarks, bookmarkCount: count });
        }
      } catch { /* skip */ }
    }
    return browsers;
  });

  ipcMain.handle('import-bookmarks', async (event, browserPath) => {
    try {
      const data = JSON.parse(fs.readFileSync(browserPath, 'utf-8'));
      const bookmarks = [];
      function extract(node, folder) {
        if (!node) return;
        if (node.type === 'url') { bookmarks.push({ title: node.name, url: node.url, folder }); return; }
        const folderName = node.name || folder;
        if (node.children) node.children.forEach((c) => extract(c, folderName));
        if (typeof node === 'object' && !node.type && !node.children) {
          Object.values(node).forEach((v) => { if (v && typeof v === 'object') extract(v, folder); });
        }
      }
      extract(data.roots, 'root');
      return { bookmarks };
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { registerBrowserImportIpc };
