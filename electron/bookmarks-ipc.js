'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function bookmarksPath(userData) {
  return path.join(userData, 'navio-bookmarks.json');
}

function defaultBookmarks() {
  return { version: 1, bar: [], tree: [] };
}

function loadBookmarks(userData) {
  const p = bookmarksPath(userData);
  try {
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!d.bar) d.bar = [];
      if (!d.tree) d.tree = [];
      return d;
    }
  } catch (e) {
    console.error('loadBookmarks', e.message);
  }
  return defaultBookmarks();
}

function saveBookmarks(userData, data) {
  fs.writeFileSync(bookmarksPath(userData), JSON.stringify(data, null, 2), 'utf8');
}

function registerBookmarksIpc(ipcMain, { app, loadConfig }) {
  ipcMain.handle('bookmarks-get', () => loadBookmarks(app.getPath('userData')));

  ipcMain.handle('bookmarks-add', (_, { title, url, folderId, toBar, favicon }) => {
    const userData = app.getPath('userData');
    const data = loadBookmarks(userData);
    const id = crypto.randomBytes(8).toString('hex');
    let fav = typeof favicon === 'string' ? favicon.trim().slice(0, 2048) : '';
    if (fav && !/^https?:\/\//i.test(fav) && !/^data:image\//i.test(fav)) fav = '';
    const entry = { id, title: title || url, url, favicon: fav, createdAt: Date.now() };
    if (toBar) {
      data.bar.push(entry);
    } else if (folderId) {
      const folder = findFolder(data.tree, folderId);
      if (folder) {
        folder.children = folder.children || [];
        folder.children.push(entry);
      } else {
        data.tree.push(entry);
      }
    } else {
      data.tree.push(entry);
    }
    saveBookmarks(userData, data);
    return { ok: true, entry, data };
  });

  ipcMain.handle('bookmarks-update', (_, { id, patch }) => {
    const userData = app.getPath('userData');
    const data = loadBookmarks(userData);
    let hit = false;
    for (const n of data.bar) {
      if (n.id === id) {
        Object.assign(n, patch);
        hit = true;
        break;
      }
    }
    if (!hit) hit = updateEntryDeep(data.tree, id, patch);
    if (!hit) return { ok: false };
    saveBookmarks(userData, data);
    return { ok: true, data };
  });

  ipcMain.handle('bookmarks-remove', (_, { id }) => {
    const userData = app.getPath('userData');
    const data = loadBookmarks(userData);
    data.bar = data.bar.filter((x) => x.id !== id);
    removeFromTree(data.tree, id);
    saveBookmarks(userData, data);
    return { ok: true, data };
  });

  ipcMain.handle('bookmarks-reorder', (_, { bar, tree }) => {
    const userData = app.getPath('userData');
    const data = loadBookmarks(userData);
    if (Array.isArray(bar)) data.bar = bar;
    if (Array.isArray(tree)) data.tree = tree;
    saveBookmarks(userData, data);
    return { ok: true, data };
  });

  ipcMain.handle('bookmarks-migrate-imported', () => {
    const userData = app.getPath('userData');
    const cfg = loadConfig();
    const imported = cfg.importedBookmarks;
    if (!imported || !Array.isArray(imported) || imported.length === 0) {
      return { ok: true, migrated: 0 };
    }
    const data = loadBookmarks(userData);
    let n = 0;
    for (const b of imported) {
      const url = b.url || b.href;
      if (!url || typeof url !== 'string') continue;
      if (data.bar.some((x) => x.url === url) || treeHasUrl(data.tree, url)) continue;
      data.bar.push({
        id: crypto.randomBytes(8).toString('hex'),
        title: b.name || b.title || url,
        url,
        favicon: b.favicon || '',
        createdAt: Date.now()
      });
      n++;
    }
    saveBookmarks(userData, data);
    return { ok: true, migrated: n, data };
  });
}

function findFolder(tree, id) {
  for (const n of tree) {
    if (n.id === id && n.children) return n;
    if (n.children) {
      const f = findFolder(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

function updateEntryDeep(nodes, id, patch) {
  if (!nodes) return false;
  for (const n of nodes) {
    if (n.id === id) {
      Object.assign(n, patch);
      return true;
    }
    if (n.children && updateEntryDeep(n.children, id, patch)) return true;
  }
  return false;
}

function removeFromTree(tree, id) {
  for (let i = tree.length - 1; i >= 0; i--) {
    const n = tree[i];
    if (n.id === id) {
      tree.splice(i, 1);
      continue;
    }
    if (n.children) removeFromTree(n.children, id);
  }
}

function treeHasUrl(tree, url) {
  for (const n of tree) {
    if (n.url === url) return true;
    if (n.children && treeHasUrl(n.children, url)) return true;
  }
  return false;
}

module.exports = { registerBookmarksIpc, loadBookmarks, saveBookmarks };
