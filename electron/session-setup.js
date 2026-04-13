'use strict';

const { ipcMain, session, shell, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { AD_BLOCK_PATTERNS, shouldBlockWebPopup } = require('./ad-block-patterns');

/**
 * Webview session, downloads, certs, ad blocker, permissions, global shortcuts.
 * Call after createStore + createMainWindow from main.js.
 */
function setupSessionInfrastructure({ app, getMainWindow, loadConfig, saveConfig }) {
  const navioSession = session.fromPartition('persist:navio');

  const webviewPreloadAbs = path.resolve(__dirname, 'webview-preload.js');
  try {
    navioSession.registerPreloadScript({
      id: 'navio-webview-preload',
      type: 'frame',
      filePath: webviewPreloadAbs
    });
  } catch (e) {
    console.error('[navio] registerPreloadScript failed:', e.message);
  }

  function applySessionFixes(ses) {
    const ua = ses
      .getUserAgent()
      .replace(/\s*Electron\/[\d.]+/g, '')
      .replace(/\s*NavioBrowser\/[\d.]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    ses.setUserAgent(ua);

    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      const headers = details.responseHeaders || {};
      const drop = [
        'x-frame-options',
        'cross-origin-opener-policy',
        'cross-origin-opener-policy-report-only',
        'cross-origin-embedder-policy',
        'cross-origin-embedder-policy-report-only',
        'cross-origin-resource-policy'
      ];
      for (const key of Object.keys(headers)) {
        if (drop.includes(key.toLowerCase())) delete headers[key];
        if (key.toLowerCase() === 'content-security-policy') {
          headers[key] = headers[key].map((v) => v.replace(/frame-ancestors[^;]*(;|$)/gi, '').trim());
        }
      }
      callback({ responseHeaders: headers });
    });
  }

  applySessionFixes(navioSession);
  applySessionFixes(session.defaultSession);

  function handleDownloads(ses) {
    ses.on('will-download', (event, item) => {
      try {
        let filename = item.getFilename() || 'download';
        filename = filename
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
          .replace(/\.{2,}/g, '.')
          .replace(/^[\s.]+|[\s.]+$/g, '')
          .slice(0, 200)
          .trim();
        if (!filename) filename = 'download';

        const cfg = loadConfig();
        const downloadsDir = app.getPath('downloads');
        try {
          fs.mkdirSync(downloadsDir, { recursive: true });
        } catch (e) {
          console.warn('[navio] Could not ensure Downloads folder:', e.message);
        }

        const ext = path.extname(filename);
        const base = path.basename(filename, ext) || 'download';

        let savePath;
        if (cfg.downloadAskWhere === true) {
          const win = getMainWindow();
          const defaultPath = path.join(downloadsDir, filename);
          const picked = dialog.showSaveDialogSync(win && !win.isDestroyed() ? win : undefined, {
            title: 'Save file',
            defaultPath
          });
          if (!picked) {
            item.cancel();
            return;
          }
          savePath = picked;
        } else {
          savePath = path.join(downloadsDir, filename);
          let counter = 1;
          while (fs.existsSync(savePath) && counter <= 99) {
            savePath = path.join(downloadsDir, `${base} (${counter})${ext}`);
            counter++;
          }
        }

        try {
          item.setSavePath(savePath);
        } catch (e) {
          console.error('[navio] setSavePath failed:', e.message);
          item.cancel();
          return;
        }

        const displayName = path.basename(savePath);
        console.log(`[navio] Download started: ${displayName} → ${savePath}`);

        getMainWindow()?.webContents.send('download-started', {
          filename: displayName,
          savePath,
          total: item.getTotalBytes()
        });

        item.on('updated', (_, state) => {
          getMainWindow()?.webContents.send('download-progress', {
            filename: displayName,
            savePath,
            state,
            received: item.getReceivedBytes(),
            total: item.getTotalBytes()
          });
        });

        item.once('done', (_, state) => {
          console.log(`[navio] Download ${state}: ${displayName}`);
          getMainWindow()?.webContents.send('download-done', { filename: displayName, savePath, state });
          if (state === 'completed' && cfg.downloadRevealInFolder === true) {
            try {
              if (fs.existsSync(savePath)) {
                shell.showItemInFolder(savePath);
              } else {
                console.warn('[navio] Download completed but file not found:', savePath);
              }
            } catch (e) {
              console.warn('[navio] showItemInFolder:', e.message);
            }
          }
        });
      } catch (err) {
        console.error('[navio] Download handler error:', err.message, err.stack);
      }
    });
  }
  handleDownloads(navioSession);
  handleDownloads(session.defaultSession);

  function handleCertErrors(ses) {
    ses.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
      event.preventDefault();
      callback(true);
      try {
        const hostname = new URL(url).hostname;
        getMainWindow()?.webContents.send('certificate-warning', { hostname, error });
      } catch (_) {}
    });
  }
  handleCertErrors(navioSession);
  handleCertErrors(session.defaultSession);

  ipcMain.handle('open-external', async (_, url) => {
    try {
      if (/^(mailto|tel|sms|callto|wtai|market|ms-windows-store):/i.test(url)) {
        await shell.openExternal(url);
        return { ok: true };
      }
      return { error: 'Protocol not permitted for external opening.' };
    } catch (e) {
      return { error: e.message };
    }
  });

  navioSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  if (typeof navioSession.setPermissionCheckHandler === 'function') {
    navioSession.setPermissionCheckHandler(() => true);
  }

  const cfg0 = loadConfig();
  let adBlockEnabled = cfg0.adBlockEnabled !== false;
  let adBlockCount = 0;
  let adBlockBytes = 0;
  let adPopupBlockedCount = 0;
  const AD_AVG_BYTES = 40 * 1024;

  navioSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (adBlockEnabled) {
      const url = details.url;
      if (AD_BLOCK_PATTERNS.some((p) => url.includes(p))) {
        adBlockCount++;
        adBlockBytes += AD_AVG_BYTES;
        callback({ cancel: true });
        return;
      }
    }
    callback({});
  });

  /**
   * Sync IPC for <webview> new-window — must decide before the event handler returns.
   * Uses current config (blocklist + optional strict sizing / blank-pop-up rules).
   */
  ipcMain.on('navio-eval-popup-block', (event, payload) => {
    const cfg = loadConfig();
    const block = shouldBlockWebPopup({
      url: (payload && payload.url) || '',
      disposition: (payload && payload.disposition) || 'default',
      optionsWidth: payload && payload.optionsWidth,
      optionsHeight: payload && payload.optionsHeight,
      cfg: {
        adBlockEnabled: cfg.adBlockEnabled !== false,
        adStrictPopupBlock: cfg.adStrictPopupBlock !== false
      }
    });
    if (block) adPopupBlockedCount++;
    event.returnValue = block;
  });

  ipcMain.handle('set-ad-blocker', async (_, { enabled }) => {
    adBlockEnabled = !!enabled;
    saveConfig({ adBlockEnabled });
    return { ok: true, enabled: adBlockEnabled };
  });

  ipcMain.handle('get-ad-block-stats', () => ({
    enabled: adBlockEnabled,
    blocked: adBlockCount,
    bytesSaved: adBlockBytes,
    domains: AD_BLOCK_PATTERNS.length,
    popupsBlocked: adPopupBlockedCount
  }));

  try {
    if (
      !globalShortcut.register('F12', () => {
        getMainWindow()?.webContents.openDevTools({ mode: 'detach' });
      })
    ) {
      console.warn('[navio] globalShortcut register failed: F12');
    }
  } catch (e) {
    console.warn('[navio] globalShortcut register error: F12', e.message);
  }

  function regShortcut(accelerator, action) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        getMainWindow()?.webContents.send('shortcut', action);
      });
      if (!ok) {
        console.warn(`[navio] globalShortcut register failed: ${accelerator} → ${action}`);
      }
    } catch (e) {
      console.warn(`[navio] globalShortcut register error: ${accelerator}`, e.message);
    }
  }

  regShortcut('CommandOrControl+T', 'new-tab');
  regShortcut('CommandOrControl+W', 'close-tab');
  regShortcut('CommandOrControl+L', 'focus-url');
  regShortcut('CommandOrControl+Shift+A', 'toggle-assistant');
  regShortcut('CommandOrControl+Shift+C', 'toggle-connectors');
  regShortcut('CommandOrControl+K', 'command-palette');
  regShortcut('CommandOrControl+H', 'history-panel');
  regShortcut('CommandOrControl+Shift+H', 'history-panel');
  regShortcut('CommandOrControl+Shift+O', 'tab-search');
  regShortcut('CommandOrControl+Shift+E', 'tab-search');
  regShortcut('CommandOrControl+Shift+B', 'bookmarks-panel');
}

module.exports = { setupSessionInfrastructure };
