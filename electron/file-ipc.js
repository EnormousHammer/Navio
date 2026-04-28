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

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** Match largest assistant attachment cap (PDF path in assistant.js). */
const READ_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;

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

  /**
   * Extract readable text from an office/document file (DOCX, XLSX, PPTX, RTF, ODT, etc.)
   * already loaded in the renderer as base64. Used by the assistant and chat-tab file
   * attachment pipeline so the AI can read document contents instead of raw bytes.
   */
  ipcMain.handle('extract-attachment-text', async (_, { base64, mimeType, fileName }) => {
    try {
      if (!base64 || typeof base64 !== 'string') return { ok: false, note: 'No data provided.' };
      const { extractDriveFileText } = require('./drive-file-text');
      const buf = Buffer.from(base64, 'base64');
      return await extractDriveFileText({ buffer: buf, mimeType: mimeType || '', fileName: fileName || '' });
    } catch (e) {
      return { ok: false, note: (e && e.message) ? e.message : String(e) };
    }
  });

  /**
   * Read a local file for assistant / chat attachments when the renderer's File
   * from drag-and-drop has size 0 (common on Windows for Explorer → Chromium drops,
   * including from Downloads) but exposes a native `path` (Electron extension).
   */
  ipcMain.handle('read-file-for-attachment', (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return { ok: false, error: 'invalid path' };
      }
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        return { ok: false, error: 'path not found' };
      }
      const st = fs.statSync(resolved);
      if (!st.isFile()) {
        return { ok: false, error: 'not a file' };
      }
      if (st.size > READ_ATTACHMENT_MAX_BYTES) {
        return {
          ok: false,
          error: `file too large (max ${Math.round(READ_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB)`
        };
      }
      const buf = fs.readFileSync(resolved);
      return { ok: true, size: buf.length, base64: buf.toString('base64') };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

module.exports = { registerFileIpc };
