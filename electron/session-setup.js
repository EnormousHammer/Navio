'use strict';

const { ipcMain, session, shell, globalShortcut, dialog, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  AD_BLOCK_PATTERNS,
  shouldBlockWebPopup,
  shouldBlockAdNetworkRequest
} = require('./ad-block-patterns');
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

/** Assigned inside setupSessionInfrastructure — primes globalShortcut when the main window is focused. */
let navioShortcutPrimeIfFocused = null;

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

function normalizePopupOriginInput(origin) {
  const raw = typeof origin === 'string' ? origin.trim() : '';
  if (!raw) return '';
  if (raw === NAVIO_LOCAL_UI_ORIGIN) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {
    /* ignore */
  }
  return '';
}

function _navioFormatBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function _navioFormatEta(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.ceil(sec))}s left`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  return `${m}m ${s}s left`;
}

/** Count of pop-ups denied by shouldBlockWebPopup (main + sync IPC). */
let adPopupBlockedCount = 0;

function recordNavioPopupBlocked() {
  adPopupBlockedCount++;
}

/**
 * Shows a native dialog listing available screens and windows so the user can
 * choose what to share via getDisplayMedia(). Returns the chosen DesktopCapturerSource
 * or null if cancelled.
 */
async function showScreenSourcePickerDialog(win) {
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 }
    });
  } catch (e) {
    console.error('[navio] desktopCapturer.getSources error:', e.message);
    return null;
  }

  if (!sources || sources.length === 0) return null;

  const screenSources = sources.filter((s) => s.id.startsWith('screen:'));
  const windowSources = sources
    .filter((s) => s.id.startsWith('window:') && s.name && s.name.trim())
    .slice(0, 12);

  const allSources = [...screenSources, ...windowSources];
  const screenLabels = screenSources.map((_, i) =>
    screenSources.length === 1 ? 'Entire Screen' : `Entire Screen ${i + 1}`
  );
  const windowLabels = windowSources.map((s) =>
    s.name.length > 55 ? s.name.slice(0, 55) + '\u2026' : s.name
  );
  const buttons = [...screenLabels, ...windowLabels, 'Cancel'];

  try {
    const { response } = await dialog.showMessageBox(
      win && !win.isDestroyed() ? win : undefined,
      {
        type: 'question',
        title: 'Share Screen',
        message: 'Choose what to share',
        detail: 'Select a screen or window to share with this site.',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true
      }
    );
    if (response === buttons.length - 1) return null;
    return allSources[response] || null;
  } catch (e) {
    console.error('[navio] showScreenSourcePickerDialog error:', e.message);
    return null;
  }
}

/**
 * Webview session, downloads, certs, ad blocker, permissions, global shortcuts.
 * Call after createStore + createMainWindow from main.js.
 */
function setupSessionInfrastructure({ app, getMainWindow, loadConfig, saveConfig }) {
  /** Active Electron download items by final save path (for cancel from renderer). */
  const activeDownloadItemsByPath = new Map();

  /**
   * Guest <webview> ids (from window.open routed to a new tab) that should auto-close
   * when the navigation turns into a download, so the user stays on the opener tab.
   */
  const guestDownloadShellWebContentsIds = new Set();

  const userData = () => app.getPath('userData');
  const navioSession = session.fromPartition(NAVIO_PARTITION_MAIN);
  const incognitoSession = session.fromPartition(NAVIO_PARTITION_INCOGNITO);

  // Guest `<webview>` scripts are loaded via the `preload` attribute (see tabs.js +
  // `navio-webview-guest-preload-href` IPC). Session-wide registerPreloadScript was
  // removed to avoid double-injection alongside the tag preload on Electron 35+.

  function applySessionFixes(ses) {
    const ua = ses
      .getUserAgent()
      .replace(/\s*Electron\/[\d.]+/g, '')
      .replace(/\s*NavioBrowser\/[\d.]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    ses.setUserAgent(ua);

    if (typeof ses.setSpellCheckerLanguages === 'function') {
      ses.setSpellCheckerLanguages(['en-US']);
    }

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

  /**
   * Pick a non-colliding save path in the default downloads dir. Up to 99 " (n)"
   * variants before falling back to a timestamped suffix — never silently
   * overwrites an existing file.
   */
  function pickUniqueDownloadPath(downloadsDir, filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || 'download';
    let candidate = path.join(downloadsDir, filename);
    if (!fs.existsSync(candidate)) return candidate;
    for (let n = 1; n <= 99; n++) {
      candidate = path.join(downloadsDir, `${base} (${n})${ext}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    // After 99 duplicates, fall back to timestamped filename (never overwrite).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(downloadsDir, `${base} (${stamp})${ext}`);
  }

  /**
   * Download lifecycle telemetry sent to the renderer. Emits 5 event shapes:
   *   download-started   { filename, savePath, total, totalStr, url, indeterminate }
   *   download-progress  { ...bytes, paused, state }
   *   download-done      { filename, savePath, state, totalStr, url }
   * The renderer uses these to render shelf + drawer + toolbar badge.
   */
  function wireDownloadItem(item, savePath, originalUrl) {
    activeDownloadItemsByPath.set(savePath, item);
    const displayName = path.basename(savePath);
    console.log(`[navio] Download started: ${displayName} → ${savePath}`);

    let lastProgT = Date.now();
    let lastProgB = 0;

    const startTotal = item.getTotalBytes();
    getMainWindow()?.webContents.send('download-started', {
      filename: displayName,
      savePath,
      total: startTotal,
      totalStr: startTotal > 0 ? _navioFormatBytes(startTotal) : '',
      url: originalUrl || '',
      /** Size-unknown servers — renderer can flip to indeterminate immediately instead of waiting. */
      indeterminate: !(startTotal > 0)
    });

    item.on('updated', (_, state) => {
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      const now = Date.now();
      let bytesPerSec = null;
      let etaSec = null;
      const dt = (now - lastProgT) / 1000;
      if (dt >= 0.2) {
        const d = received - lastProgB;
        if (d >= 0) {
          bytesPerSec = d / dt;
          lastProgT = now;
          lastProgB = received;
        }
      }
      if (total > 0 && bytesPerSec != null && bytesPerSec > 500) {
        etaSec = (total - received) / bytesPerSec;
      }
      let paused = false;
      try { paused = !!item.isPaused(); } catch { /* older electron — ignore */ }
      getMainWindow()?.webContents.send('download-progress', {
        filename: displayName,
        savePath,
        state,
        paused,
        received,
        total,
        bytesPerSec: bytesPerSec != null ? Math.round(bytesPerSec) : null,
        etaSec: etaSec != null && Number.isFinite(etaSec) ? etaSec : null,
        receivedStr: _navioFormatBytes(received),
        totalStr: total > 0 ? _navioFormatBytes(total) : '',
        etaStr: _navioFormatEta(etaSec)
      });
    });

    item.once('done', (_, state) => {
      activeDownloadItemsByPath.delete(savePath);
      console.log(`[navio] Download ${state}: ${displayName}`);
      const doneTotal = item.getTotalBytes();
      getMainWindow()?.webContents.send('download-done', {
        filename: displayName,
        savePath,
        state,
        totalStr: doneTotal > 0 ? _navioFormatBytes(doneTotal) : '',
        url: originalUrl || ''
      });
      const cfg = loadConfig();
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
  }

  ipcMain.handle('navio-register-guest-download-shell', (_, { webContentsId }) => {
    const id = Number(webContentsId);
    if (!Number.isFinite(id)) return { ok: false, error: 'bad_id' };
    guestDownloadShellWebContentsIds.add(id);
    return { ok: true };
  });
  ipcMain.handle('navio-unregister-guest-download-shell', (_, { webContentsId }) => {
    const id = Number(webContentsId);
    if (!Number.isFinite(id)) return { ok: false, error: 'bad_id' };
    guestDownloadShellWebContentsIds.delete(id);
    return { ok: true };
  });

  function handleDownloads(ses) {
    ses.on('will-download', (event, item, webContents) => {
      let guestWcId = null;
      try {
        if (webContents && typeof webContents.getType === 'function' && webContents.getType() === 'webview') {
          guestWcId = webContents.id;
        }
      } catch {
        /* ignore */
      }
      if (guestWcId != null && guestDownloadShellWebContentsIds.has(guestWcId)) {
        guestDownloadShellWebContentsIds.delete(guestWcId);
        try {
          getMainWindow()?.webContents.send('navio-close-download-shell-tab', { webContentsId: guestWcId });
        } catch {
          /* ignore */
        }
      }

      // Capture the origin URL so we can offer Retry on failed rows.
      let originalUrl = '';
      try { originalUrl = item.getURL() || ''; } catch { /* ignore */ }

      let filename = '';
      try {
        filename = item.getFilename() || 'download';
      } catch {
        filename = 'download';
      }
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

      if (cfg.downloadAskWhere === true) {
        // Async save dialog — never block the UI thread. We pause the item
        // until the user picks a path so the save location is guaranteed to
        // take effect before any bytes are written.
        try { item.pause(); } catch { /* best-effort on older electron */ }
        const win = getMainWindow();
        const defaultPath = path.join(downloadsDir, filename);
        dialog
          .showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
            title: 'Save file',
            defaultPath,
            buttonLabel: 'Save',
            properties: ['showOverwriteConfirmation']
          })
          .then((result) => {
            if (result.canceled || !result.filePath) {
              try { item.cancel(); } catch { /* already ended */ }
              return;
            }
            const savePath = result.filePath;
            try {
              item.setSavePath(savePath);
              try { item.resume(); } catch { /* fine if never paused */ }
              wireDownloadItem(item, savePath, originalUrl);
            } catch (err) {
              console.error('[navio] setSavePath (async) failed:', err.message);
              try { item.cancel(); } catch { /* ignore */ }
            }
          })
          .catch((err) => {
            console.error('[navio] Save dialog failed:', err.message);
            try { item.cancel(); } catch { /* ignore */ }
          });
        return;
      }

      // Chrome-default path: save silently to Downloads with collision-safe name.
      const savePath = pickUniqueDownloadPath(downloadsDir, filename);
      try {
        item.setSavePath(savePath);
      } catch (e) {
        console.error('[navio] setSavePath failed:', e.message);
        try { item.cancel(); } catch { /* ignore */ }
        return;
      }
      wireDownloadItem(item, savePath, originalUrl);
    });
  }
  handleDownloads(navioSession);
  handleDownloads(incognitoSession);
  handleDownloads(session.defaultSession);

  ipcMain.handle('cancel-download', (_, savePath) => {
    const p = typeof savePath === 'string' ? savePath.trim() : '';
    if (!p) return { ok: false, error: 'no_path' };
    const item = activeDownloadItemsByPath.get(p);
    if (!item) return { ok: false, error: 'not_found' };
    try {
      item.cancel();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('pause-download', (_, savePath) => {
    const p = typeof savePath === 'string' ? savePath.trim() : '';
    if (!p) return { ok: false, error: 'no_path' };
    const item = activeDownloadItemsByPath.get(p);
    if (!item) return { ok: false, error: 'not_found' };
    try {
      if (item.isPaused()) return { ok: true, paused: true };
      item.pause();
      return { ok: true, paused: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('resume-download', (_, savePath) => {
    const p = typeof savePath === 'string' ? savePath.trim() : '';
    if (!p) return { ok: false, error: 'no_path' };
    const item = activeDownloadItemsByPath.get(p);
    if (!item) return { ok: false, error: 'not_found' };
    try {
      if (!item.isPaused()) return { ok: true, paused: false };
      if (typeof item.canResume === 'function' && !item.canResume()) {
        return { ok: false, error: 'not_resumable' };
      }
      item.resume();
      return { ok: true, paused: false };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * Retry a failed/cancelled download from the renderer. We use the
   * original URL captured at will-download time and re-issue the download
   * on the same session — Electron will emit a fresh will-download event.
   */
  ipcMain.handle('retry-download', (_, payload) => {
    const url = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
    const incognito = !!(payload && payload.incognito);
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'bad_url' };
    const targetSes = incognito ? incognitoSession : navioSession;
    try {
      targetSes.downloadURL(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

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

  /** Until app quit: remembers "Allow once" / "Deny" so the same site does not re-prompt every action. */
  const sessionPermSessionMemory = new Map();

  function permMemoryKey(origin, permission) {
    return `${origin}\t${permission}`;
  }

  function sessionScopeKey(incognito, origin, permission) {
    return `${incognito ? 'i' : 'n'}:${permMemoryKey(origin, permission)}`;
  }

  function attachPermissionHandlers(ses, { incognito }) {
    const ud = userData();

    /** @returns {boolean|null} */
    function storedDecision(origin, permission) {
      const k = permMemoryKey(origin, permission);
      const sk = sessionScopeKey(incognito, origin, permission);
      if (incognito) {
        if (incognitoPermMemory.has(k)) return incognitoPermMemory.get(k);
        const disk = sitePerms.get(ud, origin, permission);
        if (disk === false) return false;
      } else {
        const p = sitePerms.get(ud, origin, permission);
        if (p === true) return true;
        if (p === false) return false;
      }
      if (sessionPermSessionMemory.has(sk)) return sessionPermSessionMemory.get(sk);
      return null;
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

      // Google web apps (Gmail compose, Docs, Drive): allow clipboard / file-picker permissions without
      // repeated prompts so paste and drag–drop behave like Chrome (attachments, images in body).
      const o = String(origin || '');
      const googleTrusted =
        o.startsWith('https://mail.google.com') ||
        o.startsWith('https://docs.google.com') ||
        o.startsWith('https://drive.google.com') ||
        o.startsWith('https://docs.googleusercontent.com') ||
        o.startsWith('https://meet.google.com') ||
        o.startsWith('https://chat.google.com') ||
        o.startsWith('https://calendar.google.com') ||
        o.startsWith('https://sheets.google.com') ||
        o.startsWith('https://slides.google.com');
      if (
        googleTrusted &&
        (permission === 'clipboard-read' ||
          permission === 'clipboard-sanitized-write' ||
          permission === 'fileSystem' ||
          permission === 'displayCapture' ||
          permission === 'media')
      ) {
        callback(true);
        return;
      }

      // Fullscreen for embedded video (Stremio web, players): HTTPS only, no dialog — matches common browser behavior.
      if (permission === 'fullscreen' && o.startsWith('https://')) {
        callback(true);
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
          const sk = sessionScopeKey(incognito, origin, permission);
          if (response === 2) {
            if (incognito) incognitoPermMemory.set(k, true);
            else sitePerms.set(ud, origin, permission, true);
            callback(true);
          } else if (response === 3) {
            if (incognito) incognitoPermMemory.set(k, false);
            else sitePerms.set(ud, origin, permission, false);
            callback(false);
          } else if (response === 0) {
            sessionPermSessionMemory.set(sk, true);
            callback(true);
          } else if (response === 1) {
            sessionPermSessionMemory.set(sk, false);
            callback(false);
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

  /**
   * Required in Electron 17+: without setDisplayMediaRequestHandler the browser
   * rejects all getDisplayMedia() calls (screen/window/tab sharing), which breaks
   * Google Meet, Zoom web, Teams web, etc. We show a native source-picker dialog
   * and pass the chosen DesktopCapturerSource to the callback.
   * Audio loopback captures system audio on Windows so remote participants hear
   * shared-window sound without extra steps.
   */
  function attachDisplayMediaHandler(ses) {
    if (typeof ses.setDisplayMediaRequestHandler !== 'function') return;
    ses.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const win = getMainWindow();
        const chosen = await showScreenSourcePickerDialog(win);
        if (!chosen) {
          callback({});
          return;
        }
        callback({ video: chosen, audio: 'loopback' });
      } catch (e) {
        console.error('[navio] displayMedia handler error:', e.message);
        callback({});
      }
    });
  }

  attachDisplayMediaHandler(navioSession);
  attachDisplayMediaHandler(incognitoSession);
  attachDisplayMediaHandler(session.defaultSession);

  const cfg0 = loadConfig();
  let adBlockEnabled = cfg0.adBlockEnabled !== false;
  let adBlockCount = 0;
  let adBlockBytes = 0;
  const AD_AVG_BYTES = 40 * 1024;

  function attachAdBlocker(ses) {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      if (adBlockEnabled) {
        const url = details.url;
        if (shouldBlockAdNetworkRequest(url, details.resourceType)) {
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
    const o = normalizePopupOriginInput(origin);
    if (!o) return { ok: false, error: 'origin required' };
    const ud = userData();
    if (allowed) sitePerms.set(ud, o, 'popups', true);
    else sitePerms.set(ud, o, 'popups', false);
    return { ok: true };
  });

  ipcMain.handle('navio-site-popups-get', (_, { origin }) => {
    const o = normalizePopupOriginInput(origin);
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

  /**
   * Window-scoped shortcut registry.
   *
   * globalShortcut.register() attaches accelerators at the OS level — they
   * fire even when Navio is *not* the focused application, which means a
   * user typing Ctrl+T in VSCode would silently open a new Navio tab and
   * pull focus away from their editor. That is unacceptable in a shipping
   * desktop app.
   *
   * We keep using globalShortcut because it supports the widest set of
   * accelerators on Windows/Linux (including Ctrl+Tab / Ctrl+PageDown which
   * Menu-based accelerators cannot always receive), but we now only hold
   * the registration while the Navio main window is focused. On blur we
   * unregister, so other apps see the accelerators normally.
   */
  const navioShortcutList = [];
  let navioShortcutsActive = false;

  function openActiveTabDevToolsShortcut() {
    getMainWindow()?.webContents.send('shortcut', 'devtools-active-tab');
  }
  function sendShortcut(action) {
    getMainWindow()?.webContents.send('shortcut', action);
  }

  function regShortcut(accelerator, action) {
    // Record the binding; actual OS registration happens in _registerAll.
    navioShortcutList.push({ accelerator, action });
  }

  function _registerAll() {
    if (navioShortcutsActive) return;
    navioShortcutsActive = true;
    try {
      const f12Ok = globalShortcut.register('F12', openActiveTabDevToolsShortcut);
      if (!f12Ok) {
        console.debug('[navio] F12 unavailable (often claimed by GPU overlays); Ctrl+Shift+I still opens tab DevTools.');
      }
    } catch (e) {
      console.warn('[navio] globalShortcut register error (F12)', e.message);
    }
    try {
      globalShortcut.register('F5', () => sendShortcut('reload'));
    } catch (e) {
      console.warn('[navio] globalShortcut register error (F5 → reload)', e.message);
    }
    navioShortcutList.forEach(({ accelerator, action }) => {
      try {
        const ok = globalShortcut.register(accelerator, () => sendShortcut(action));
        if (!ok) {
          console.warn(`[navio] globalShortcut register failed: ${accelerator} → ${action}`);
        }
      } catch (e) {
        console.warn(`[navio] globalShortcut register error: ${accelerator}`, e.message);
      }
    });
  }

  function _unregisterAll() {
    if (!navioShortcutsActive) return;
    navioShortcutsActive = false;
    try { globalShortcut.unregister('F12'); } catch { /* ignore */ }
    try { globalShortcut.unregister('F5'); } catch { /* ignore */ }
    navioShortcutList.forEach(({ accelerator }) => {
      try { globalShortcut.unregister(accelerator); } catch { /* ignore */ }
    });
  }

  // Attach focus/blur listeners once a main window exists. getMainWindow()
  // may still return null here during cold-start — app.on('browser-window-focus'/'browser-window-blur') handles it generically.
  app.on('browser-window-focus', (_e, win) => {
    const main = getMainWindow();
    if (!main || win !== main) return;
    _registerAll();
  });
  app.on('browser-window-blur', (_e, win) => {
    const main = getMainWindow();
    if (!main || win !== main) return;
    _unregisterAll();
  });
  // If the window is already focused at registration time (typical cold
  // start) prime the bindings immediately so the first Ctrl+T works.
  setImmediate(() => {
    const main = getMainWindow();
    if (main && main.isFocused()) _registerAll();
  });

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
  regShortcut('CommandOrControl+,', 'open-settings');
  regShortcut('CommandOrControl+J', 'downloads-panel');
  regShortcut('CommandOrControl+Shift+I', 'devtools-active-tab');
  // Find in page + zoom: shell document key handlers do not run when a <webview> is focused, so
  // we register OS-level accelerators while the window is focused (see focus/_registerAll above).
  regShortcut('CommandOrControl+f', 'find-in-page');
  regShortcut('CommandOrControl+0', 'zoom-reset');
  regShortcut('CommandOrControl+-', 'zoom-out');
  regShortcut('CommandOrControl+Plus', 'zoom-in');
  regShortcut('CommandOrControl+=', 'zoom-in');
  regShortcut('CommandOrControl+numadd', 'zoom-in');
  regShortcut('CommandOrControl+numsub', 'zoom-out');

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

  // Cold start: `setImmediate` in this module often runs before the BrowserWindow is shown,
  // so `isFocused()` is false and OS shortcuts (incl. Ctrl+Shift+A) never register until a blur/focus cycle.
  navioShortcutPrimeIfFocused = () => {
    try {
      const main = getMainWindow();
      if (main && !main.isDestroyed() && main.isFocused()) _registerAll();
    } catch {
      /* ignore */
    }
  };
}

module.exports = {
  setupSessionInfrastructure,
  recordNavioPopupBlocked,
  navioPrimeGlobalShortcutsIfFocused: () => {
    try {
      if (typeof navioShortcutPrimeIfFocused === 'function') navioShortcutPrimeIfFocused();
    } catch {
      /* ignore */
    }
  }
};
