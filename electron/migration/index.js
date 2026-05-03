'use strict';

/**
 * Electron → other browser: one folder export (all migration logic lives under electron/migration/).
 */

const fs = require('fs');
const path = require('path');
const { collectMigrationBundle } = require('./collect-bundle');
const { writeMigrationFolder } = require('./write-folder');

/**
 * @param {string} userData app.getPath('userData')
 * @param {string} destDir empty or new directory path
 * @returns {object} manifest written
 */
function exportMigrationToFolder(userData, destDir) {
  const bundle = collectMigrationBundle(userData);
  return writeMigrationFolder(bundle, destDir, userData);
}

/**
 * Pick a unique child folder name under parentDir.
 * @param {string} parentDir
 * @returns {string} full path to created directory
 */
function createTimestampedMigrationDir(parentDir) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  let base = path.join(parentDir, `navio-browser-migration-${stamp}`);
  let n = 0;
  while (fs.existsSync(base)) {
    n += 1;
    base = path.join(parentDir, `navio-browser-migration-${stamp}-${n}`);
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}

module.exports = {
  collectMigrationBundle,
  writeMigrationFolder,
  exportMigrationToFolder,
  createTimestampedMigrationDir
};
