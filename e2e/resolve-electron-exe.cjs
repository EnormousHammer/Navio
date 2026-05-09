'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Path to the Electron binary for spawning from Node e2e tests.
 * Prefers node_modules/electron/dist/* so tests still run if the electron
 * package metadata is missing (e.g. interrupted npm ci) but the binary unpacked.
 */
function resolveElectronExe(repoRoot) {
  const dist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') {
    const win = path.join(dist, 'electron.exe');
    if (fs.existsSync(win)) return win;
  } else if (process.platform === 'darwin') {
    const mac = path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (fs.existsSync(mac)) return mac;
  }
  const linux = path.join(dist, 'electron');
  if (fs.existsSync(linux)) return linux;

  try {
    return require('electron');
  } catch {
    throw new Error(
      `Electron binary not found under ${dist}. Close apps using this repo's Electron files, then run npm install.`
    );
  }
}

module.exports = { resolveElectronExe };
