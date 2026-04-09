'use strict';

const { ipcMain, session, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Webview session, downloads, certs, ad blocker, permissions, global shortcuts.
 * Call after createStore + createMainWindow from main.js.
 */
function setupSessionInfrastructure({ app, getMainWindow, loadConfig, saveConfig }) {
  const navioSession = session.fromPartition('persist:navio');

  navioSession.setPreloads([path.join(__dirname, 'webview-preload.js')]);

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

        const downloadsDir = app.getPath('downloads');
        const ext = path.extname(filename);
        const base = path.basename(filename, ext) || 'download';

        let savePath = path.join(downloadsDir, filename);
        let counter = 1;
        while (fs.existsSync(savePath) && counter <= 99) {
          savePath = path.join(downloadsDir, `${base} (${counter})${ext}`);
          counter++;
        }

        item.setSavePath(savePath);

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
          if (state === 'completed') {
            shell.showItemInFolder(savePath);
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

  const AD_BLOCK_PATTERNS = [
    'doubleclick.net',
    'googlesyndication.com',
    'adservice.google',
    'googleadservices.com',
    'googletagservices.com',
    'tpc.googlesyndication.com',
    'pagead2.googlesyndication.com',
    'fundingchoicesmessages.google.com',
    'amazon-adsystem.com',
    'assoc-amazon.com',
    'ads.yahoo.com',
    'gemini.yahoo.com',
    'advertising.yahoo.com',
    'syndication.twitter.com',
    'ads.twitter.com',
    'ads.linkedin.com',
    'snap.licdn.com',
    'facebook.com/tr',
    'connect.facebook.net',
    'analytics.facebook.com',
    'scorecardresearch.com',
    'quantserve.com',
    'quantcast.com',
    'adnxs.com',
    'rubiconproject.com',
    'pubmatic.com',
    'openx.net',
    'openx.com',
    'casalemedia.com',
    'criteo.com',
    'criteo.net',
    'bidswitch.net',
    'sharethrough.com',
    'triplelift.com',
    'smartadserver.com',
    'smaato.net',
    'spotxchange.com',
    'spotx.tv',
    'teads.tv',
    'teads.com',
    'yieldmo.com',
    'zedo.com',
    'undertone.com',
    'unrulymedia.com',
    'media.net',
    'outbrain.com',
    'outbrainimg.com',
    'taboola.com',
    'revcontent.com',
    'mgid.com',
    'propellerads.com',
    'propellerclick.com',
    'adzerk.net',
    'adzerk.com',
    'advertising.com',
    'adtech.de',
    'adform.net',
    'moatads.com',
    'adsafeprotected.com',
    'adcolony.com',
    'appsflyer.com',
    'adjust.com',
    'adjust.io',
    'mopub.com',
    'chartboost.com',
    'adrollapp.com',
    'buysellads.com',
    'buysellads.net',
    'pagefair.com',
    'hotjar.com',
    'fullstory.com',
    'mouseflow.com',
    'crazyegg.com',
    'mixpanel.com',
    'amplitude.com',
    'heap.com',
    'heapanalytics.com',
    'popads.net',
    'popcash.net',
    'exoclick.com',
    'trafficjunky.net',
    'trafficholder.com',
    'cdnwidget.com',
    'adnium.com',
    'justpremium.com'
  ];

  const cfg0 = loadConfig();
  let adBlockEnabled = cfg0.adBlockEnabled !== false;
  let adBlockCount = 0;
  let adBlockBytes = 0;
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

  ipcMain.handle('set-ad-blocker', async (_, { enabled }) => {
    adBlockEnabled = !!enabled;
    saveConfig({ adBlockEnabled });
    return { ok: true, enabled: adBlockEnabled };
  });

  ipcMain.handle('get-ad-block-stats', () => ({
    enabled: adBlockEnabled,
    blocked: adBlockCount,
    bytesSaved: adBlockBytes,
    domains: AD_BLOCK_PATTERNS.length
  }));

  globalShortcut.register('F12', () => {
    getMainWindow()?.webContents.openDevTools({ mode: 'detach' });
  });

  globalShortcut.register('CommandOrControl+T', () => {
    getMainWindow()?.webContents.send('shortcut', 'new-tab');
  });
  globalShortcut.register('CommandOrControl+W', () => {
    getMainWindow()?.webContents.send('shortcut', 'close-tab');
  });
  globalShortcut.register('CommandOrControl+L', () => {
    getMainWindow()?.webContents.send('shortcut', 'focus-url');
  });
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    getMainWindow()?.webContents.send('shortcut', 'toggle-assistant');
  });
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    getMainWindow()?.webContents.send('shortcut', 'toggle-connectors');
  });
  globalShortcut.register('CommandOrControl+K', () => {
    getMainWindow()?.webContents.send('shortcut', 'command-palette');
  });
  globalShortcut.register('CommandOrControl+H', () => {
    getMainWindow()?.webContents.send('shortcut', 'history-panel');
  });
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    getMainWindow()?.webContents.send('shortcut', 'history-panel');
  });
  globalShortcut.register('CommandOrControl+Shift+O', () => {
    getMainWindow()?.webContents.send('shortcut', 'tab-search');
  });
  globalShortcut.register('CommandOrControl+Shift+E', () => {
    getMainWindow()?.webContents.send('shortcut', 'tab-search');
  });
  globalShortcut.register('CommandOrControl+Shift+B', () => {
    getMainWindow()?.webContents.send('shortcut', 'bookmarks-panel');
  });
}

module.exports = { setupSessionInfrastructure };
