'use strict';

const { ipcMain, session, shell, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { AD_BLOCK_PATTERNS, shouldBlockWebPopup } = require('./ad-block-patterns');
const sitePerms = require('./site-permissions');
const { NAVIO_PARTITION_MAIN, NAVIO_PARTITION_INCOGNITO } = require('./navio-partitions');

const PERMISSION_LABELS = {
  media: 'Use your camera and/or microphone',
  geolocation: 'See your location',
  notifications: 'Show notifications',
  midiSysex: 'Use MIDI devices',
  pointerLock: 'Lock the mouse pointer',
  fullscreen: 'Enter full screen',
  openExternal: 'Open external applications',
  displayCapture: 'Record your screen',
  speakerSelection: 'Choose audio output devices',
  localFonts: 'Access local fonts',
  windowManagement: 'Manage windows on your screen',
  'clipboard-read': 'Read from the clipboard',
  'clipboard-sanitized-write': 'Write to the clipboard',
  keyboardLock: 'Use keyboard lock',
  storage: 'Use persistent storage',
  fileSystem: 'Access files on this device'
};

function permissionHumanLabel(permission) {
  return PERMISSION_LABELS[permission] || permission.replace(/-/g, ' ');
}

/**
 * Main-window UI loads from file:// — Chromium has no https origin, so our old handler
 * treated origin as empty and denied geolocation without a prompt. Map file pages to a
 * stable synthetic origin for storage + show "Navio Browser" in the dialog.
 */
const NAVIO_LOCAL_UI_ORIGIN = 'https://navio.local-ui';

function permissionOriginFromUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return { origin: '', isNavioLocal: false };
  const u = pageUrl.trim();
  if (/^file:/i.test(u)) return { origin: NAVIO_LOCAL_UI_ORIGIN, isNavioLocal: true };
  if (/^https?:/i.test(u)) {
    try {
      return { origin: new URL(u).origin, isNavioLocal: false };
    } catch {
      return { origin: '', isNavioLocal: false };
    }
  }
  return { origin: '', isNavioLocal: false };
}

function originHostname(origin) {
  try {
    return new URL(origin).hostname || origin;
  } catch {
    return origin;
  }
}

/** Count of pop-ups denied by shouldBlockWebPopup (main + sync IPC). */
let adPopupBlockedCount = 0;

function recordNavioPopupBlocked() {
  adPopupBlockedCount++;
}

/**
 * Webview session, downloads, certs, ad blocker, permissions, global shortcuts.
 * Call after createStore + createMainWindow from main.js.
 */
function setupSessionInfrastructure({ app, getMainWindow, loadConfig, saveConfig }) {
  const userData = () => app.getPath('userData');
  const navioSession = session.fromPartition(NAVIO_PARTITION_MAIN);
  const incognitoSession = session.fromPartition(NAVIO_PARTITION_INCOGNITO);

  const webviewPreloadAbs = path.resolve(__dirname, 'webview-preload.js');
  for (const [ses, id] of [
    [navioSession, 'navio-webview-preload'],
    [incognitoSession, 'navio-webview-preload-incognito']
  ]) {
    try {
      ses.registerPreloadScript({
        id,
        type: 'frame',
        filePath: webviewPreloadAbs
      });
    } catch (e) {
      console.error('[navio] registerPreloadScript failed:', id, e.message);
    }
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
  applySessionFixes(incognitoSession);
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
  handleDownloads(incognitoSession);
  handleDownloads(session.defaultSession);

  function handleCertErrors(ses) {
    ses.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
      event.preventDefault();
      const win = getMainWindow();
      let hostname = 'this site';
      try {
        hostname = new URL(url).hostname;
      } catch {
        /* keep default */
      }
      const errText = String(error || 'Certificate validation failed').slice(0, 400);
      dialog
        .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
          type: 'warning',
          title: 'Your connection is not private',
          message: `Navio cannot verify the identity of ${hostname}.`,
          detail: `${errText}\n\nProceed only if you trust this network and understand the risk.`,
          buttons: ['Go back (recommended)', 'Proceed anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        .then(({ response }) => {
          if (response === 1) {
            getMainWindow()?.webContents.send('certificate-warning', { hostname, error: errText });
            callback(true);
          } else {
            callback(false);
          }
        })
        .catch(() => callback(false));
    });
  }
  handleCertErrors(navioSession);
  handleCertErrors(incognitoSession);
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

   const incognitoPermMemory = new Map();

  function permMemoryKey(origin, permission) {
    return `${origin}\t${permission}`;
  }

  function attachPermissionHandlers(ses, { incognito }) {
    const ud = userData();

    /** @returns {boolean|null} */
    function storedDecision(origin, permission) {
      const k = permMemoryKey(origin, permission);
      if (incognito) {
        if (incognitoPermMemory.has(k)) return incognitoPermMemory.get(k);
        const disk = sitePerms.get(ud, origin, permission);
        if (disk === false) return false;
        return null;
      }
      return sitePerms.get(ud, origin, permission);
    }

    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      let pageUrl = '';
      try {
        pageUrl = (details && details.requestingUrl) || webContents.getURL() || '';
      } catch {
        pageUrl = '';
      }
      let { origin, isNavioLocal } = permissionOriginFromUrl(pageUrl);
      if (!origin && details && details.requestingUrl) {
        ({ origin, isNavioLocal } = permissionOriginFromUrl(details.requestingUrl));
      }
      if (!origin) {
        callback(false);
        return;
      }

      const stored = storedDecision(origin, permission);
      if (stored === true) {
        callback(true);
        return;
      }
      if (stored === false) {
        callback(false);
        return;
      }

      const win = getMainWindow();
      const host = isNavioLocal ? 'Navio Browser' : originHostname(origin);
      const want = permissionHumanLabel(permission);
      dialog
        .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
          type: 'question',
          title: 'Permission',
          message: `${host} wants permission:`,
          detail: want,
          buttons: ['Allow once', 'Deny', 'Always allow', 'Always deny'],
          defaultId: 0,
          cancelId: 1
        })
        .then(({ response }) => {
          const k = permMemoryKey(origin, permission);
          if (response === 2) {
            if (incognito) incognitoPermMemory.set(k, true);
            else sitePerms.set(ud, origin, permission, true);
            callback(true);
          } else if (response === 3) {
            if (incognito) incognitoPermMemory.set(k, false);
            else sitePerms.set(ud, origin, permission, false);
            callback(false);
          } else if (response === 0) {
            callback(true);
          } else {
            callback(false);
          }
        })
        .catch(() => callback(false));
    });

    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
        let pageUrl = '';
        try {
          pageUrl = wc.getURL() || '';
        } catch {
          pageUrl = '';
        }
        let { origin } = permissionOriginFromUrl(pageUrl);
        if (!origin && requestingOrigin) {
          ({ origin } = permissionOriginFromUrl(String(requestingOrigin)));
        }
        if (!origin) return true;
        const v = storedDecision(origin, permission);
        if (v === false) return false;
        return true;
      });
    }
  }

  attachPermissionHandlers(navioSession, { incognito: false });
  attachPermissionHandlers(incognitoSession, { incognito: true });
  /** Main BrowserWindow loads index.html on file:// — uses defaultSession, not persist:navio */
  attachPermissionHandlers(session.defaultSession, { incognito: false });

  const cfg0 = loadConfig();
  let adBlockEnabled = cfg0.adBlockEnabled !== false;
  let adBlockCount = 0;
  let adBlockBytes = 0;
  const AD_AVG_BYTES = 40 * 1024;

  function attachAdBlocker(ses) {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
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
  }
  attachAdBlocker(navioSession);
  attachAdBlocker(incognitoSession);

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
      features: (payload && payload.features) || '',
      hasPostBody: !!(payload && payload.hasPostBody),
      siteAllowsPopups: !!(payload && payload.siteAllowsPopups),
      openerOrigin: (payload && payload.openerOrigin) || '',
      cfg: {
        adBlockEnabled: cfg.adBlockEnabled !== false,
        popupBlockerEnabled: cfg.popupBlockerEnabled !== false,
        adStrictPopupBlock: cfg.adStrictPopupBlock !== false
      }
    });
    if (block) recordNavioPopupBlocked();
    event.returnValue = block;
  });

  ipcMain.handle('navio-site-popups-set', (_, { origin, allowed }) => {
    const o = typeof origin === 'string' ? origin.trim() : '';
    if (!o) return { ok: false, error: 'origin required' };
    const ud = userData();
    if (allowed) sitePerms.set(ud, o, 'popups', true);
    else sitePerms.set(ud, o, 'popups', false);
    return { ok: true };
  });

  ipcMain.handle('navio-site-popups-get', (_, { origin }) => {
    const o = typeof origin === 'string' ? origin.trim() : '';
    if (!o) return { allowed: null };
    const v = sitePerms.get(userData(), o, 'popups');
    return { allowed: v };
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

  /** F12 / Ctrl+Shift+I: DevTools for the active page tab (guest webview), not the shell UI. */
  function openActiveTabDevToolsShortcut() {
    getMainWindow()?.webContents.send('shortcut', 'devtools-active-tab');
  }
  try {
    const f12Ok = globalShortcut.register('F12', openActiveTabDevToolsShortcut);
    if (!f12Ok) {
      console.debug('[navio] F12 unavailable (often claimed by GPU overlays); Ctrl+Shift+I still opens tab DevTools.');
    }
  } catch (e) {
    console.warn('[navio] globalShortcut register error (F12 → tab DevTools)', e.message);
  }

  function sendShortcut(action) {
    getMainWindow()?.webContents.send('shortcut', action);
  }
  try {
    globalShortcut.register('F5', () => sendShortcut('reload'));
  } catch (e) {
    console.warn('[navio] globalShortcut register error (F5 → reload)', e.message);
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
  regShortcut('CommandOrControl+Shift+N', 'new-private-tab');
  regShortcut('CommandOrControl+W', 'close-tab');
  regShortcut('CommandOrControl+Shift+T', 'reopen-last-tab');
  regShortcut('CommandOrControl+L', 'focus-url');
  regShortcut('CommandOrControl+Shift+A', 'toggle-assistant');
  regShortcut('CommandOrControl+Shift+C', 'toggle-connectors');
  regShortcut('CommandOrControl+K', 'command-palette');
  regShortcut('CommandOrControl+H', 'history-panel');
  regShortcut('CommandOrControl+Shift+H', 'history-panel');
  regShortcut('CommandOrControl+Shift+O', 'tab-search');
  regShortcut('CommandOrControl+Shift+E', 'tab-search');
  regShortcut('CommandOrControl+Shift+B', 'bookmarks-panel');
  regShortcut('CommandOrControl+Shift+I', 'devtools-active-tab');

  regShortcut('CommandOrControl+R', 'reload');
  regShortcut('CommandOrControl+Shift+R', 'hard-reload');

  regShortcut('Alt+Left', 'go-back');
  regShortcut('Alt+Right', 'go-forward');

  regShortcut('CommandOrControl+Tab', 'next-tab');
  regShortcut('CommandOrControl+Shift+Tab', 'prev-tab');
  regShortcut('CommandOrControl+PageDown', 'next-tab');
  regShortcut('CommandOrControl+PageUp', 'prev-tab');

  for (let i = 1; i <= 9; i++) {
    regShortcut(`CommandOrControl+${i}`, `tab-${i}`);
  }
}

module.exports = { setupSessionInfrastructure, recordNavioPopupBlocked };
