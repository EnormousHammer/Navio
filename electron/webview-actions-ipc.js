'use strict';

const { webContents: electronWebContents } = require('electron');

function registerWebviewActionsIpc(ipcMain, { getMainWindow } = {}) {
  const gw = typeof getMainWindow === 'function' ? getMainWindow : () => null;

  ipcMain.handle('webview-find-in-page', async (event, { webContentsId, text, options = {} }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { ok: false, error: 'WebContents not found' };
      if (!text) {
        wc.stopFindInPage('clearSelection');
        return { ok: true, action: 'clear' };
      }
      wc.removeAllListeners('found-in-page');
      wc.on('found-in-page', (ev, result) => {
        gw()?.webContents.send('found-in-page-result', { webContentsId, result });
      });
      const requestId = wc.findInPage(text, {
        forward: options.forward !== false,
        findNext: !!options.findNext
      });
      return { ok: true, requestId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webview-stop-find-in-page', async (event, { webContentsId, action }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { ok: false };
      wc.stopFindInPage(action || 'clearSelection');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webview-print', async (event, { webContentsId }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { ok: false, error: 'WebContents not found' };
      return new Promise((resolve) => {
        wc.print({ silent: false, printBackground: true }, (success, failureReason) => {
          resolve({ ok: success, error: success ? undefined : failureReason });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webview-set-zoom', async (event, { webContentsId, factor }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { ok: false };
      const f = Math.min(3, Math.max(0.25, Number(factor) || 1));
      wc.setZoomFactor(f);
      return { ok: true, factor: f };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webview-get-zoom', async (event, { webContentsId }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { factor: 1 };
      return { factor: wc.getZoomFactor() };
    } catch {
      return { factor: 1 };
    }
  });

  ipcMain.handle('window-set-fullscreen', async (event, { fullscreen }) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    win.setFullScreen(!!fullscreen);
    return { ok: true, fullscreen: win.isFullScreen() };
  });

  ipcMain.handle('window-is-fullscreen', async (event) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { fullscreen: false };
    return { fullscreen: win.isFullScreen() };
  });
}

module.exports = { registerWebviewActionsIpc };
