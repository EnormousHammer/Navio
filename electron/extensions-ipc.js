'use strict';

const { ipcMain, dialog, session, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (_) {
  AdmZip = null;
}

function followRedirectDownload(url, maxRedirects = 8) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          followRedirectDownload(next, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
  });
}

function crxBufferToZipBuffer(buf) {
  const sig = buf.subarray(0, 4).toString();
  let off = 0;
  if (sig === 'Cr24') {
    const ver = buf.readUInt32LE(4);
    if (ver === 2) {
      const keyLen = buf.readUInt32LE(8);
      const sigLen = buf.readUInt32LE(12);
      off = 16 + keyLen + sigLen;
    } else if (ver === 3) {
      const headerLen = buf.readUInt32LE(8);
      off = 12 + headerLen;
    } else {
      throw new Error('Unsupported CRX version ' + ver);
    }
  }
  const pk = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), off);
  if (pk < 0) throw new Error('No ZIP payload in CRX');
  return buf.subarray(pk);
}

function statePath(userData) {
  return path.join(userData, 'navio-extensions.json');
}

function loadState(userData) {
  try {
    const p = statePath(userData);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('extensions loadState', e.message);
  }
  return { version: 1, entries: [] };
}

function saveState(userData, s) {
  fs.writeFileSync(statePath(userData), JSON.stringify(s, null, 2), 'utf8');
}

async function loadPersistedExtensionsOnStartup(app) {
  const userData = app.getPath('userData');
  const state = loadState(userData);
  const navioSession = session.fromPartition('persist:navio');
  for (const e of state.entries || []) {
    if (!e.enabled || !e.path) continue;
    try {
      if (!fs.existsSync(e.path)) continue;
      await navioSession.loadExtension(e.path, { allowFileAccess: true });
      console.log('[navio] Loaded extension:', e.path);
    } catch (err) {
      console.warn('[navio] Extension load failed:', e.path, err.message);
    }
  }
}

function registerExtensionsIpc(ipcMain, { app, getMainWindow }) {
  ipcMain.handle('extensions-list', async () => {
    const userData = app.getPath('userData');
    const state = loadState(userData);
    let loaded = [];
    try {
      const navioSession = session.fromPartition('persist:navio');
      if (typeof navioSession.getAllExtensions === 'function') {
        loaded = navioSession.getAllExtensions().map((ex) => ({
          id: ex.id,
          name: ex.name,
          path: ex.path,
          version: ex.version
        }));
      }
    } catch (e) {
      loaded = [];
    }
    return { persisted: state.entries || [], loaded };
  });

  ipcMain.handle('extensions-load-unpacked', async () => {
    const win = getMainWindow();
    const r = await dialog.showOpenDialog(win || undefined, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true };
    const dir = r.filePaths[0];
    const navioSession = session.fromPartition('persist:navio');
    const ext = await navioSession.loadExtension(dir, { allowFileAccess: true });
    const userData = app.getPath('userData');
    const state = loadState(userData);
    state.entries = state.entries || [];
    const idx = state.entries.findIndex((x) => x.id === ext.id);
    const row = { id: ext.id, path: ext.path, enabled: true };
    if (idx >= 0) state.entries[idx] = row;
    else state.entries.push(row);
    saveState(userData, state);
    return { ok: true, extension: { id: ext.id, name: ext.name, path: ext.path, version: ext.version } };
  });

  ipcMain.handle('extensions-remove', async (_, { extensionId }) => {
    if (!extensionId) return { ok: false, error: 'Missing id' };
    const navioSession = session.fromPartition('persist:navio');
    try {
      navioSession.removeExtension(extensionId);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const userData = app.getPath('userData');
    const state = loadState(userData);
    state.entries = (state.entries || []).filter((x) => x.id !== extensionId);
    saveState(userData, state);
    return { ok: true };
  });

  ipcMain.handle('extensions-set-enabled', async (_, { extensionId, enabled }) => {
    if (!extensionId) return { ok: false, error: 'Missing id' };
    const userData = app.getPath('userData');
    const state = loadState(userData);
    const row = (state.entries || []).find((x) => x.id === extensionId);
    if (!row) return { ok: false, error: 'Unknown extension' };
    row.enabled = !!enabled;
    saveState(userData, state);
    const navioSession = session.fromPartition('persist:navio');
    try {
      if (enabled) {
        if (row.path && fs.existsSync(row.path)) {
          await navioSession.loadExtension(row.path, { allowFileAccess: true });
        }
      } else {
        navioSession.removeExtension(extensionId);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true };
  });

  ipcMain.handle('extensions-install-crx-id', async (_, { extensionId }) => {
    if (!AdmZip) {
      return { ok: false, error: 'Dependency adm-zip missing — run npm install in the project root' };
    }
    const id = (extensionId || '').trim();
    if (!/^[a-p]{32}$/.test(id)) {
      return { ok: false, error: 'Invalid Chrome Web Store extension id (32 lowercase letters a–p)' };
    }
    const prod = process.versions.chrome || '120.0.0.0';
    const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(
      prod
    )}&x=id%3D${id}%26installsource%3Dondemand%26uc`;
    let buf;
    try {
      buf = await followRedirectDownload(url);
    } catch (e) {
      return { ok: false, error: `Download failed: ${e.message}` };
    }
    let zipBuf;
    try {
      zipBuf = crxBufferToZipBuffer(buf);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const userData = app.getPath('userData');
    const outDir = path.join(userData, 'extensions', id);
    fs.mkdirSync(outDir, { recursive: true });
    try {
      const zip = new AdmZip(zipBuf);
      zip.extractAllTo(outDir, true);
    } catch (e) {
      return { ok: false, error: `Unzip failed: ${e.message}` };
    }
    const navioSession = session.fromPartition('persist:navio');
    let ext;
    try {
      ext = await navioSession.loadExtension(outDir, { allowFileAccess: true });
    } catch (e) {
      return { ok: false, error: `loadExtension: ${e.message}` };
    }
    const st = loadState(userData);
    st.entries = st.entries || [];
    const idx = st.entries.findIndex((x) => x.id === ext.id);
    const row = { id: ext.id, path: ext.path, enabled: true };
    if (idx >= 0) st.entries[idx] = row;
    else st.entries.push(row);
    saveState(userData, st);
    return { ok: true, extension: { id: ext.id, name: ext.name, path: ext.path, version: ext.version } };
  });

  ipcMain.handle('extensions-open-popup', async (_, { extensionId }) => {
    const navioSession = session.fromPartition('persist:navio');
    let extPath = null;
    let extId = extensionId;
    if (typeof navioSession.getAllExtensions === 'function') {
      const found = navioSession.getAllExtensions().find((e) => e.id === extensionId);
      if (found) extPath = found.path;
    }
    if (!extPath) {
      const userData = app.getPath('userData');
      const row = (loadState(userData).entries || []).find((x) => x.id === extensionId);
      if (row && row.path) extPath = row.path;
    }
    if (!extPath || !fs.existsSync(path.join(extPath, 'manifest.json'))) {
      return { ok: false, error: 'Extension not installed or missing manifest' };
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    } catch (e) {
      return { ok: false, error: 'manifest.json unreadable' };
    }
    const popupPath = (manifest.action && manifest.action.default_popup) ||
      (manifest.browser_action && manifest.browser_action.default_popup) ||
      '';
    const rel = String(popupPath || '').replace(/^\//, '');
    if (!rel) return { ok: false, error: 'No default_popup in manifest' };
    const url = `chrome-extension://${extId}/${rel}`;
    const win = new BrowserWindow({
      width: 400,
      height: 520,
      autoHideMenuBar: true,
      webPreferences: {
        session: navioSession,
        sandbox: false,
        contextIsolation: false
      }
    });
    try {
      await win.loadURL(url);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true };
  });

  ipcMain.handle('extensions-open-options', async (_, { extensionId }) => {
    const navioSession = session.fromPartition('persist:navio');
    let extPath = null;
    let extId = extensionId;
    if (typeof navioSession.getAllExtensions === 'function') {
      const found = navioSession.getAllExtensions().find((e) => e.id === extensionId);
      if (found) extPath = found.path;
    }
    if (!extPath) {
      const userData = app.getPath('userData');
      const row = (loadState(userData).entries || []).find((x) => x.id === extensionId);
      if (row && row.path) extPath = row.path;
    }
    if (!extPath) return { ok: false, error: 'Extension path unknown' };
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(extPath, 'manifest.json'), 'utf8'));
    } catch (e) {
      return { ok: false, error: 'manifest.json unreadable' };
    }
    const opt =
      manifest.options_page ||
      (manifest.options_ui && manifest.options_ui.page) ||
      '';
    const rel = String(opt || '').replace(/^\//, '');
    if (!rel) return { ok: false, error: 'No options page in manifest' };
    const url = `chrome-extension://${extId}/${rel}`;
    const win = new BrowserWindow({
      width: 720,
      height: 640,
      autoHideMenuBar: true,
      webPreferences: {
        session: navioSession,
        sandbox: false,
        contextIsolation: false
      }
    });
    try {
      await win.loadURL(url);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return { ok: true };
  });
}

module.exports = { registerExtensionsIpc, loadPersistedExtensionsOnStartup };
