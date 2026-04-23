'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fs.existsSync(filePath)) {
          resolve();
          return;
        }
      } catch {
        /* ignore */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for ${filePath}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

describe('e2e smoke', () => {
  test('main shell finishes loading (NAVIO_E2E)', async () => {
    const root = path.join(__dirname, '..');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'navio-e2e-'));
    const cfg = {
      onboardingComplete: true,
      showLaunchIntro: false,
      theme: 'dark',
      homepage: 'https://example.com'
    };
    fs.writeFileSync(path.join(userData, 'navio-config.json'), JSON.stringify(cfg, null, 2));

    const electronExe = require('electron');
    const readyPath = path.join(userData, 'navio-e2e-ready');

    const child = spawn(
      electronExe,
      [root, `--user-data-dir=${userData}`],
      {
        cwd: root,
        env: { ...process.env, NAVIO_E2E: '1' },
        stdio: 'ignore',
        windowsHide: true
      }
    );

    try {
      await waitForFile(readyPath, 120000);
      const stamp = fs.readFileSync(readyPath, 'utf8');
      assert.ok(/^\d+$/.test(stamp.trim()), 'ready file should contain epoch ms');
    } finally {
      killProcessTree(child);
    }
  });
});
