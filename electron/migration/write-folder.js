'use strict';

const fs = require('fs');
const path = require('path');

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), 'utf8');
}

function writeUtf8(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, 'utf8');
}

function safeSkillFilename(name) {
  const base = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return base.endsWith('.json') ? base : `${base}.json`;
}

function safeExtraTopLevelName(name) {
  return String(name).replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^\.+/, '') || 'extra';
}

/**
 * Writes migration bundle into destDir (caller must create unique empty folder).
 * @param {object} bundle from collectMigrationBundle
 * @param {string} destDir absolute path
 * @param {string} [userData] if set, copies local sync backup file when present
 */
function writeMigrationFolder(bundle, destDir, userData) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const files = [];

  writeJson(destDir, 'settings.json', bundle.settings);
  files.push({ file: 'settings.json', role: 'Merged UI + AI preferences (no primary API key).' });

  writeJson(destDir, 'secrets.json', bundle.secrets);
  files.push({
    file: 'secrets.json',
    role: 'Plaintext: main apiKey, connector keys, OAuth, IMAP, password vault, sync passphrase.'
  });

  if (bundle.configOnDisk && Object.keys(bundle.configOnDisk).length > 0) {
    writeJson(destDir, 'config-on-disk.json', bundle.configOnDisk);
    files.push({ file: 'config-on-disk.json', role: 'Raw navio-config.json keys (apiKey stripped if present).' });
  }

  const optionalWrites = [
    ['bookmarks.json', bundle.bookmarks],
    ['history.json', bundle.history],
    ['reading-list.json', bundle.readingList],
    ['extensions.json', bundle.extensions],
    ['memory.json', bundle.memory],
    ['schedules.json', bundle.schedules],
    ['live-connector-data.json', bundle.liveConnectorData],
    ['context-graph.json', bundle.contextGraph],
    ['workspace.json', bundle.workspace],
    ['assistant-chat.json', bundle.assistantChat],
    ['site-permissions.json', bundle.sitePermissions],
    ['site-compat.json', bundle.siteCompat],
    ['mcp-config.json', bundle.mcpConfig],
    ['workflows-legacy.json', bundle.workflowsLegacy]
  ];

  for (const [fname, data] of optionalWrites) {
    if (data == null) continue;
    if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0 && fname !== 'bookmarks.json' && fname !== 'history.json') {
      continue;
    }
    writeJson(destDir, fname, data);
    files.push({ file: fname, role: 'Data store' });
  }

  if (bundle.skills && bundle.skills.size > 0) {
    const skillDir = path.join(destDir, 'skills');
    fs.mkdirSync(skillDir, { recursive: true });
    for (const [name, obj] of bundle.skills) {
      const fn = safeSkillFilename(name);
      writeJson(skillDir, fn, obj);
    }
    files.push({ file: 'skills/*.json', role: 'Per-site AI skills' });
  }

  if (bundle.recordedWorkflows && bundle.recordedWorkflows.length > 0) {
    const wfDir = path.join(destDir, 'recorded-workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    for (const { name, content } of bundle.recordedWorkflows) {
      const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      writeUtf8(wfDir, safe, content);
    }
    files.push({ file: 'recorded-workflows/*.json', role: 'Assistant / palette recorded workflows' });
  }

  if (bundle.ledger && bundle.ledger.text != null) {
    writeUtf8(destDir, 'action-ledger.jsonl', bundle.ledger.text);
    files.push({ file: 'action-ledger.jsonl', role: 'Append-only action ledger (may be truncated).' });
    if (bundle.ledger.truncated) {
      writeJson(destDir, 'action-ledger.meta.json', {
        truncated: true,
        totalBytes: bundle.ledger.totalBytes,
        exportedBytes: Buffer.byteLength(bundle.ledger.text, 'utf8')
      });
      files.push({ file: 'action-ledger.meta.json', role: 'Ledger truncation metadata' });
    }
  }

  if (bundle.e2eAssistant != null) {
    writeJson(destDir, 'e2e-assistant.json', bundle.e2eAssistant);
    files.push({ file: 'e2e-assistant.json', role: 'E2E / dev assistant fixture (if present).' });
  }
  if (bundle.e2eReady != null) {
    writeUtf8(destDir, 'e2e-ready.marker.txt', bundle.e2eReady);
    files.push({ file: 'e2e-ready.marker.txt', role: 'E2E ready marker file contents (if present).' });
  }

  if (bundle.extensionsUnpackedIndex && bundle.extensionsUnpackedIndex.length > 0) {
    writeJson(destDir, 'extensions-unpacked-index.json', bundle.extensionsUnpackedIndex);
    files.push({
      file: 'extensions-unpacked-index.json',
      role: 'Manifest snapshot per folder under userData/extensions/ (not the binaries).'
    });
  }

  const extra = bundle.extraTopLevel && typeof bundle.extraTopLevel === 'object' ? bundle.extraTopLevel : {};
  if (Object.keys(extra).length > 0) {
    const extraDir = path.join(destDir, 'extra-userdata');
    fs.mkdirSync(extraDir, { recursive: true });
    for (const [name, data] of Object.entries(extra)) {
      const safe = safeExtraTopLevelName(name);
      if (typeof data === 'string') {
        writeUtf8(extraDir, safe, data);
      } else {
        writeJson(extraDir, safe.endsWith('.json') ? safe : `${safe}.json`, data);
      }
    }
    files.push({
      file: 'extra-userdata/*',
      role: 'Other top-level .json / .jsonl / .navbak in userData not covered above.'
    });
  }

  if (bundle.syncCloudNavbak != null) {
    if (typeof bundle.syncCloudNavbak === 'string') {
      writeUtf8(destDir, 'sync-cloud-navio-sync.navbak', bundle.syncCloudNavbak);
      files.push({
        file: 'sync-cloud-navio-sync.navbak',
        role: 'Copy of navio-sync.navbak from Integrations sync folder (when under size cap).'
      });
    } else {
      writeJson(destDir, 'sync-cloud-navbak.meta.json', bundle.syncCloudNavbak);
      files.push({
        file: 'sync-cloud-navbak.meta.json',
        role: 'Cloud sync backup was not copied (too large or unreadable).'
      });
    }
  }

  if (userData) {
    const syncLocal = path.join(userData, 'navio-sync.navbak');
    if (fs.existsSync(syncLocal)) {
      try {
        fs.copyFileSync(syncLocal, path.join(destDir, 'navio-sync-local-copy.navbak'));
        files.push({
          file: 'navio-sync-local-copy.navbak',
          role: 'Copy of navio-sync.navbak from userData (encrypted backup blob).'
        });
      } catch (e) {
        console.error('[migration] copy sync backup', e.message);
      }
    }
  }

  const manifest = {
    navioMigrationExportVersion: 3,
    exportedAt: new Date().toISOString(),
    source: 'navio-electron',
    readme:
      'Import settings.json + secrets.json first; merge other JSON as your new host supports. See electron/migration/MIGRATION_PLAN.md in the Navio repo for the full checklist. Delete this folder after migration.',
    notIncluded: [
      'Cookies, localStorage, IndexedDB, Service Workers, and login sessions (full Chromium profile / partitions under userData).',
      'Unpacked extension binaries under userData/extensions/<id>/ (see extensions-unpacked-index.json for paths + manifest snapshots).',
      'navio-sync.navbak in the cloud sync folder if it exceeded the export size cap (see sync-cloud-navbak.meta.json when present).'
    ],
    files
  };
  writeJson(destDir, 'manifest.json', manifest);

  return manifest;
}

module.exports = { writeMigrationFolder };
