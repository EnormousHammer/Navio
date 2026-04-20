'use strict';

/**
 * Filesystem / download-folder IPC registrations.
 *
 * These handlers are purely about paths: resolving the downloads directory,
 * opening it in the OS file manager, revealing a specific file, opening a
 * file in its default app, and converting a native path to a file:// URL.
 *
 * They were previously inlined in electron/main.js. Extracting them keeps
 * main.js closer to a "startup + window wiring" file and makes it easy to
 * unit-test these helpers in isolation.
 *
 * Download *item* control (cancel/pause/resume/retry) intentionally stays
 * in electron/session-setup.js because those handlers close over the live
 * DownloadItem map that `will-download` populates. Splitting them would
 * require exporting that map across modules and risk listener duplication.
 */

const { pathToFileURL } = require('url');

function registerFileIpc(ipcMain, { app, shell }) {
  if (!ipcMain || !app || !shell) {
    throw new Error('[file-ipc] ipcMain, app and shell are required');
  }

  ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));

  ipcMain.handle('open-downloads-folder', () => {
    try {
      const p = app.getPath('downloads');
      shell.openPath(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('show-in-folder', (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'invalid path' };
      }
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('open-file-path', async (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'invalid path' };
      }
      const err = await shell.openPath(filePath);
      if (err) return { ok: false, error: err };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('navio-path-to-file-url', (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'invalid path' };
      }
      return { ok: true, href: pathToFileURL(filePath).href };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

module.exports = { registerFileIpc };
