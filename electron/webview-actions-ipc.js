'use strict';

const { webContents: electronWebContents, desktopCapturer, nativeImage, clipboard, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

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

  /**
   * Return nav history entries surrounding the active index for a webContents.
   * Used by right-click on back/forward buttons to show a Chrome-style history list.
   */
  ipcMain.handle('webview-get-nav-history', async (_event, { webContentsId, direction = 'back', max = 15 }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { ok: false, error: 'WebContents not found', entries: [] };
      const nh = wc.navigationHistory;
      if (!nh || typeof nh.getAllEntries !== 'function') {
        return { ok: false, error: 'navigationHistory unavailable', entries: [] };
      }
      const all = nh.getAllEntries() || [];
      const active = typeof nh.getActiveIndex === 'function' ? nh.getActiveIndex() : 0;
      let slice;
      if (direction === 'forward') {
        slice = all.slice(active + 1, active + 1 + max).map((e, i) => ({
          title: e.title || e.url, url: e.url, index: active + 1 + i
        }));
      } else {
        slice = all.slice(Math.max(0, active - max), active).reverse().map((e, i) => ({
          title: e.title || e.url, url: e.url, index: active - 1 - i
        }));
      }
      return { ok: true, activeIndex: active, entries: slice };
    } catch (e) {
      return { ok: false, error: e.message, entries: [] };
    }
  });

  /**
   * Jump to a specific entry in a webContents navigation history.
   */
  ipcMain.handle('webview-goto-nav-index', async (_event, { webContentsId, index }) => {
    try {
      const wc = electronWebContents.fromId(webContentsId);
      if (!wc) return { ok: false };
      const nh = wc.navigationHistory;
      if (nh && typeof nh.goToIndex === 'function') {
        nh.goToIndex(index);
        return { ok: true };
      }
      return { ok: false, error: 'goToIndex unavailable' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Capture a full desktop screen (or specific source) via desktopCapturer.
   * Returns a data URL PNG and also writes to clipboard + optionally file.
   */
  ipcMain.handle('capture-screen', async (_event, opts = {}) => {
    try {
      const thumbW = Math.max(640, Math.min(4096, Number(opts.width) || 1920));
      const thumbH = Math.max(360, Math.min(4096, Number(opts.height) || 1080));
      const sources = await desktopCapturer.getSources({
        types: opts.window ? ['window'] : ['screen'],
        thumbnailSize: { width: thumbW, height: thumbH }
      });
      if (!sources || !sources.length) return { ok: false, error: 'No screen source available' };

      let src = sources[0];
      if (opts.sourceId) {
        src = sources.find((s) => s.id === opts.sourceId) || sources[0];
      }

      const img = src.thumbnail;
      if (!img || img.isEmpty()) return { ok: false, error: 'Empty screen capture' };

      const dataURL = img.toDataURL();
      try { clipboard.writeImage(img); } catch (_) { /* ignore */ }

      let savedPath = null;
      if (opts.save) {
        try {
          const { BrowserWindow } = require('electron');
          const win = BrowserWindow.fromWebContents(_event.sender) || null;
          const defaultName = `navio-screenshot-${new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .replace(/Z$/, '')}.png`;
          const res = await dialog.showSaveDialog(win, {
            title: 'Save screenshot',
            defaultPath: defaultName,
            filters: [{ name: 'PNG image', extensions: ['png'] }]
          });
          if (!res.canceled && res.filePath) {
            fs.writeFileSync(res.filePath, img.toPNG());
            savedPath = res.filePath;
          }
        } catch (e) {
          return { ok: true, dataURL, savedPath: null, saveError: e.message };
        }
      }

      return { ok: true, dataURL, savedPath, sourceName: src.name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * List available desktop-capturer sources (screens + windows) for a picker UI.
   */
  ipcMain.handle('capture-screen-sources', async (_event, opts = {}) => {
    try {
      const types = [];
      if (opts.screens !== false) types.push('screen');
      if (opts.windows !== false) types.push('window');
      const sources = await desktopCapturer.getSources({
        types,
        thumbnailSize: { width: 320, height: 180 }
      });
      return {
        ok: true,
        sources: (sources || []).map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null
        }))
      };
    } catch (e) {
      return { ok: false, error: e.message, sources: [] };
    }
  });
}

void nativeImage; // reserved for future inline composition

module.exports = { registerWebviewActionsIpc };
