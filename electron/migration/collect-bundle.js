'use strict';

/**
 * Gathers all migration payload parts from Navio Electron userData (main process only).
 */

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const secureConfig = require('../secure-config');
const { loadConfig, readConfigFile } = require('../config-store');
const { loadBookmarks } = require('../bookmarks-ipc');
const { loadHistory } = require('../history-ipc');

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('[migration] readJsonFile', filePath, e.message);
  }
  return fallback;
}

function readTextFile(filePath, maxBytes) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    const cap = maxBytes != null && maxBytes > 0 ? Math.min(st.size, maxBytes) : st.size;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(cap);
      fs.readSync(fd, buf, 0, cap, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    console.error('[migration] readTextFile', filePath, e.message);
    return null;
  }
}

function decryptStr(b64) {
  if (typeof b64 !== 'string' || !b64) return '';
  const buf = Buffer.from(b64, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function loadConnectorEncMap(userData) {
  return readJsonFile(path.join(userData, 'navio-connector-keys.json'), {});
}

function loadOAuthEncMap(userData) {
  return readJsonFile(path.join(userData, 'navio-oauth-tokens.json'), {});
}

function loadImapEncMap(userData) {
  return readJsonFile(path.join(userData, 'navio-imap-creds.json'), {});
}

function decryptImapEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    email: decryptStr(entry.email),
    password: decryptStr(entry.password)
  };
}

function loadPasswordVaultPlain(userData) {
  const vault = readJsonFile(path.join(userData, 'navio-passwords.json'), {});
  const out = {};
  for (const origin of Object.keys(vault)) {
    const rows = Array.isArray(vault[origin]) ? vault[origin] : [];
    out[origin] = rows.map((row) => ({
      username: row.username,
      password: decryptStr(row.password),
      created: row.created,
      ...(row.hidden ? { hidden: true } : {})
    }));
  }
  return out;
}

function loadSyncPassphrasePlain(userData) {
  const p = path.join(userData, 'navio-sync-passphrase.sec');
  if (!fs.existsSync(p)) return '';
  try {
    return decryptStr(fs.readFileSync(p, 'utf8'));
  } catch {
    return '';
  }
}

function loadSkillsMap(userData) {
  const dir = path.join(userData, 'navio-skills');
  const out = new Map();
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      try {
        out.set(name, JSON.parse(fs.readFileSync(fp, 'utf8')));
      } catch (_) {
        /* skip */
      }
    }
  } catch (e) {
    console.error('[migration] skills', e.message);
  }
  return out;
}

function loadRecordedWorkflowFiles(userData) {
  const dir = path.join(userData, 'workflows');
  const out = [];
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      try {
        out.push({ name, content: fs.readFileSync(fp, 'utf8') });
      } catch (_) {
        /* skip */
      }
    }
  } catch (e) {
    console.error('[migration] workflows dir', e.message);
  }
  return out;
}

function loadLedger(userData) {
  const ledgerPath = path.join(userData, 'navio-action-ledger.jsonl');
  const maxFull = 20 * 1024 * 1024;
  try {
    if (!fs.existsSync(ledgerPath)) {
      return { text: null, truncated: false, totalBytes: 0 };
    }
    const sz = fs.statSync(ledgerPath).size;
    if (sz <= maxFull) {
      return { text: readTextFile(ledgerPath, null), truncated: false, totalBytes: sz };
    }
    return { text: readTextFile(ledgerPath, maxFull), truncated: true, totalBytes: sz };
  } catch {
    return { text: null, truncated: false, totalBytes: 0 };
  }
}

function optionalJson(userData, name) {
  return readJsonFile(path.join(userData, name), null);
}

/** Top-level userData files we already map explicitly — do not duplicate under extra-userdata/. */
const KNOWN_TOP_LEVEL_NAMES = new Set([
  'navio-config.json',
  'navio-bookmarks.json',
  'navio-history.json',
  'navio-reading-list.json',
  'navio-extensions.json',
  'navio-memory.json',
  'navio-schedules.json',
  'live-connector-data.json',
  'navio-context-graph.json',
  'navio-workspace.json',
  'navio-assistant-chat.json',
  'navio-site-permissions.json',
  'navio-site-compat.json',
  'navio-connector-keys.json',
  'navio-oauth-tokens.json',
  'navio-imap-creds.json',
  'navio-passwords.json',
  'navio-sync-passphrase.sec',
  'navio-api-key.bin',
  'navio-workflows.json',
  'navio-action-ledger.jsonl',
  'navio-sync.navbak',
  'oem-stremio-credentials.json',
  'navio-e2e-assistant.json',
  'manifest.json',
  'package.json'
]);

const EXTRA_FILE_MAX_BYTES = 8 * 1024 * 1024;
const SYNC_NAVBAK_MAX_BYTES = 50 * 1024 * 1024;

function collectExtraTopLevelUserData(userData) {
  const out = {};
  try {
    for (const name of fs.readdirSync(userData)) {
      if (KNOWN_TOP_LEVEL_NAMES.has(name)) continue;
      const p = path.join(userData, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!/\.(json|jsonl|navbak)$/i.test(name)) continue;
      try {
        const sz = st.size;
        if (sz > EXTRA_FILE_MAX_BYTES) {
          out[name] = { _skippedTooLarge: true, sizeBytes: sz };
          continue;
        }
        const raw = fs.readFileSync(p, 'utf8');
        if (name.endsWith('.json')) {
          try {
            out[name] = JSON.parse(raw);
          } catch {
            out[name] = { _rawUtf8: raw };
          }
        } else {
          out[name] = raw;
        }
      } catch (e) {
        out[name] = { _exportError: e.message || String(e) };
      }
    }
  } catch (e) {
    console.error('[migration] extra scan', e.message);
  }
  return out;
}

function loadExtensionsUnpackedIndex(userData) {
  const extRoot = path.join(userData, 'extensions');
  const out = [];
  try {
    if (!fs.existsSync(extRoot) || !fs.statSync(extRoot).isDirectory()) return out;
    for (const id of fs.readdirSync(extRoot)) {
      const dir = path.join(extRoot, id);
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const mpath = path.join(dir, 'manifest.json');
      let manifest = null;
      if (fs.existsSync(mpath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
        } catch {
          manifest = { _parseError: true };
        }
      }
      out.push({
        id,
        path: dir,
        manifestPresent: !!manifest,
        manifest
      });
    }
  } catch (e) {
    console.error('[migration] extensions index', e.message);
  }
  return out;
}

function loadSyncCloudNavbak(syncFolderPath) {
  const folder = String(syncFolderPath || '').trim();
  if (!folder || !fs.existsSync(folder)) return null;
  const p = path.join(folder, 'navio-sync.navbak');
  if (!fs.existsSync(p)) return null;
  try {
    const sz = fs.statSync(p).size;
    if (sz > SYNC_NAVBAK_MAX_BYTES) {
      return { _skippedTooLarge: true, sizeBytes: sz, path: p };
    }
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { _readError: e.message || String(e) };
  }
}

/**
 * @returns {object} Bundle for write-folder (never log).
 */
function collectMigrationBundle(userData) {
  const cfg = { ...loadConfig() };
  delete cfg.hasApiKey;
  delete cfg.crashReportingAvailable;
  const apiKey = secureConfig.getApiKey(userData) || '';

  const connectorEnc = loadConnectorEncMap(userData);
  const connectorApiKeys = {};
  for (const id of Object.keys(connectorEnc)) {
    connectorApiKeys[id] = decryptStr(connectorEnc[id]);
  }

  const oauthEnc = loadOAuthEncMap(userData);
  const oauthTokens = {};
  for (const providerId of Object.keys(oauthEnc)) {
    const e = oauthEnc[providerId];
    if (!e || typeof e !== 'object') continue;
    oauthTokens[providerId] = {
      accessToken: decryptStr(e.access),
      refreshToken: decryptStr(e.refresh),
      expiresAt: e.expiresAt || 0,
      email: e.email || '',
      name: e.name || '',
      avatar: e.avatar || ''
    };
  }

  const imapEnc = loadImapEncMap(userData);
  const imapAccounts = {};
  for (const serviceId of Object.keys(imapEnc)) {
    const plain = decryptImapEntry(imapEnc[serviceId]);
    if (plain && (plain.email || plain.password)) imapAccounts[serviceId] = plain;
  }

  const settings = { ...cfg };
  delete settings.apiKey;

  let configOnDisk = null;
  try {
    configOnDisk = readConfigFile();
    if (configOnDisk && typeof configOnDisk === 'object') {
      delete configOnDisk.apiKey;
    }
  } catch (_) {
    configOnDisk = null;
  }

  const oemStremio = optionalJson(userData, 'oem-stremio-credentials.json');

  const secrets = {
    apiKey,
    connectorApiKeys,
    oauthTokens,
    imapAccounts,
    passwordVault: loadPasswordVaultPlain(userData),
    syncPassphrase: loadSyncPassphrasePlain(userData),
    ...(oemStremio && Object.keys(oemStremio).length > 0 ? { oemStremioCredentials: oemStremio } : {})
  };

  const workflowsLegacy = optionalJson(userData, 'navio-workflows.json');

  const e2eAssistant = optionalJson(userData, 'navio-e2e-assistant.json');
  let e2eReady = null;
  try {
    const er = path.join(userData, 'navio-e2e-ready');
    if (fs.existsSync(er) && fs.statSync(er).isFile()) {
      e2eReady = fs.readFileSync(er, 'utf8').slice(0, 4096);
    }
  } catch (_) {
    e2eReady = null;
  }

  const extraTopLevel = collectExtraTopLevelUserData(userData);
  const extensionsUnpackedIndex = loadExtensionsUnpackedIndex(userData);
  const syncCloudNavbak = loadSyncCloudNavbak(cfg.syncFolderPath);

  return {
    settings,
    secrets,
    configOnDisk,
    bookmarks: loadBookmarks(userData),
    history: loadHistory(userData),
    readingList: optionalJson(userData, 'navio-reading-list.json'),
    extensions: optionalJson(userData, 'navio-extensions.json'),
    memory: optionalJson(userData, 'navio-memory.json'),
    schedules: optionalJson(userData, 'navio-schedules.json'),
    liveConnectorData: optionalJson(userData, 'live-connector-data.json'),
    contextGraph: optionalJson(userData, 'navio-context-graph.json'),
    workspace: optionalJson(userData, 'navio-workspace.json'),
    assistantChat: optionalJson(userData, 'navio-assistant-chat.json'),
    sitePermissions: optionalJson(userData, 'navio-site-permissions.json'),
    siteCompat: optionalJson(userData, 'navio-site-compat.json'),
    mcpConfig: {
      mcpEnabled: !!cfg.mcpEnabled,
      mcpServers: Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []
    },
    skills: loadSkillsMap(userData),
    workflowsLegacy,
    recordedWorkflows: loadRecordedWorkflowFiles(userData),
    ledger: loadLedger(userData),
    e2eAssistant,
    e2eReady,
    extraTopLevel,
    extensionsUnpackedIndex,
    syncCloudNavbak
  };
}

module.exports = { collectMigrationBundle };
