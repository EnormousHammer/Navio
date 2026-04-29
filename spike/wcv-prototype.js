/**
 * Phase 0 — WebContentsView spike prototype.
 *
 * Validates that WebContentsView solves the core problems before committing
 * to the full migration. Run with:
 *
 *   electron spike/wcv-prototype.js
 *   electron spike/wcv-prototype.js --ext-path=/path/to/unpacked-extension
 *
 * Go/no-go gate:
 *   [✓] Trusted clicks (isTrusted: true) via Input.dispatchMouseEvent
 *   [✓] DevTools on tab-1 while debugger is attached to tab-2 (no eviction)
 *   [✓] Extension injection via session.loadExtension() (optional, needs --ext-path)
 *   [✓] Idle RSS reported (compare 3-tab WCV vs 3-tab webview)
 *
 * DELETE this file after the go decision.
 */

'use strict';

const { app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────
const SPIKE_PARTITION = 'persist:navio-wcv-spike';
const SPIKE_URLS = [
  'https://example.com',        // tab 0 — used for trusted-click test
  'https://example.com',        // tab 1 — DevTools target
  'https://example.com'         // tab 2 — debugger target (coexistence test)
];

const extPath = (() => {
  const arg = process.argv.find(a => a.startsWith('--ext-path='));
  return arg ? arg.slice('--ext-path='.length) : null;
})();

// ── Globals ──────────────────────────────────────────────────────────────────
let mainWindow = null;
const wcvTabs = [];   // { wcv, id, url }
let activeIdx = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(label, ...args) {
  console.log(`[spike] [${label}]`, ...args);
}

function rssKB() {
  const mem = process.memoryUsage();
  return Math.round(mem.rss / 1024);
}

/**
 * Position the active WebContentsView to fill the content area below the toolbar.
 * The toolbar is 40px tall.
 */
function layoutTabs(win) {
  const [w, h] = win.getContentSize();
  const toolbarH = 40;
  for (let i = 0; i < wcvTabs.length; i++) {
    const { wcv } = wcvTabs[i];
    if (i === activeIdx) {
      wcv.setBounds({ x: 0, y: toolbarH, width: w, height: h - toolbarH });
    } else {
      // Push off-screen instead of destroying — easier to switch back
      wcv.setBounds({ x: 0, y: toolbarH, width: 0, height: 0 });
    }
  }
}

function switchTab(idx) {
  if (idx < 0 || idx >= wcvTabs.length) return;
  activeIdx = idx;
  layoutTabs(mainWindow);
  log('switch-tab', `Now on tab ${idx} → ${wcvTabs[idx].url}`);
}

// ── Test 1: Trusted click ────────────────────────────────────────────────────

/**
 * Inject a small script that listens for click events and reports isTrusted,
 * then fire Input.dispatchMouseEvent via CDP.
 *
 * A real click from a physical mouse always has isTrusted=true.
 * element.click() from JS gives isTrusted=false.
 * Input.dispatchMouseEvent via CDP gives isTrusted=true — same as physical.
 *
 * We load a known data: URL with a button at a fixed position so coordinates
 * are reliable regardless of which site is loaded.
 */
async function testTrustedClick(wc) {
  log('trusted-click', 'Starting test — loading test fixture page...');
  let attachedHere = false;

  // Load a minimal test page with a button at a known position
  const testPage = `data:text/html,<!DOCTYPE html><html><body style="margin:0;padding:0">
    <button id="btn" style="position:fixed;top:100px;left:100px;width:200px;height:60px;font-size:18px">
      Click me
    </button>
    <div id="result" style="position:fixed;top:200px;left:100px;font-size:14px">waiting...</div>
    <script>
      document.getElementById('btn').addEventListener('click', function(e) {
        document.getElementById('result').textContent = 'isTrusted=' + e.isTrusted;
        window.__navioTrustedClickResult = e.isTrusted;
      });
    </script>
  </body></html>`;

  try {
    await wc.loadURL(testPage);
    // Wait for page to finish loading
    await new Promise(r => setTimeout(r, 500));

    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }

    // Reset result
    await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.__navioTrustedClickResult = null',
      returnByValue: true
    });

    // Click the center of the button: (100 + 100 = 200, 100 + 30 = 130)
    const BX = 200, BY = 130;
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: BX, y: BY, button: 'left', clickCount: 1
    });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: BX, y: BY, button: 'left', clickCount: 1
    });

    // Wait for event to propagate
    await new Promise(r => setTimeout(r, 400));

    const result = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.__navioTrustedClickResult',
      returnByValue: true
    });

    const isTrusted = result?.result?.value;
    if (isTrusted === true) {
      log('trusted-click', '✅ PASS  isTrusted=true — CDP Input.dispatchMouseEvent events are trusted');
    } else if (isTrusted === false) {
      log('trusted-click', '❌ FAIL  isTrusted=false — CDP mouse events are NOT trusted (unexpected on WCV)');
    } else {
      log('trusted-click', '⚠️  UNKNOWN — isTrusted result:', JSON.stringify(isTrusted),
        '— click may have missed the button. BX/BY:', BX, BY);
    }
  } catch (err) {
    log('trusted-click', '❌ ERROR:', err.message);
  } finally {
    if (attachedHere && wc.debugger.isAttached()) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

// ── Test 2: DevTools coexistence ─────────────────────────────────────────────

/**
 * Attach debugger to tab 2, then open DevTools on tab 1.
 * If DevTools evicts our debugger, the next sendCommand will throw.
 * On WebContentsView this should NOT happen — each WCV is its own WebContents.
 */
async function testDevToolsCoexistence() {
  if (wcvTabs.length < 3) {
    log('devtools-coexist', '⚠️  Need 3 tabs to test — skipping');
    return;
  }

  const debugTarget = wcvTabs[2].wcv.webContents;  // attach debugger here
  const devToolsTarget = wcvTabs[1].wcv.webContents; // open DevTools here

  log('devtools-coexist', 'Attaching debugger to tab-2...');
  let attachedHere = false;

  try {
    if (!debugTarget.debugger.isAttached()) {
      debugTarget.debugger.attach('1.3');
      attachedHere = true;
      log('devtools-coexist', 'Debugger attached to tab-2 OK');
    }

    log('devtools-coexist', 'Opening DevTools on tab-1...');
    devToolsTarget.openDevTools();
    await new Promise(r => setTimeout(r, 1000));

    // Now try a CDP command on tab-2 while DevTools is open on tab-1
    const titleResult = await debugTarget.debugger.sendCommand('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });
    const title = titleResult?.result?.value;
    log('devtools-coexist', '✅ PASS  Debugger on tab-2 still works while DevTools is on tab-1');
    log('devtools-coexist', `         tab-2 title: "${title}"`);
  } catch (err) {
    log('devtools-coexist', '❌ FAIL  Debugger evicted or errored:', err.message);
  } finally {
    if (attachedHere && debugTarget.debugger.isAttached()) {
      try { debugTarget.debugger.detach(); } catch { /* ignore */ }
    }
    // Leave DevTools open on tab-1 intentionally so you can inspect visually
  }
}

// ── Test 3: Extension loading ─────────────────────────────────────────────────

async function testExtensionLoad(ses) {
  if (!extPath) {
    log('extensions', '⚠️  No --ext-path provided — skipping extension test');
    log('extensions', '   Rerun with: electron spike/wcv-prototype.js --ext-path=/path/to/unpacked-ext');
    return;
  }

  if (!fs.existsSync(extPath)) {
    log('extensions', `❌ Extension path not found: ${extPath}`);
    return;
  }

  try {
    const ext = await ses.loadExtension(extPath, { allowFileAccess: true });
    log('extensions', `✅ PASS  Extension loaded: "${ext.name}" (${ext.id})`);
    log('extensions', '         Check browser tabs to confirm content scripts injected');
  } catch (err) {
    log('extensions', '❌ FAIL  session.loadExtension() threw:', err.message);
  }
}

// ── Memory snapshot ───────────────────────────────────────────────────────────

function logMemory(label) {
  const rss = rssKB();
  log('memory', `[${label}] RSS: ${rss} KB (${Math.round(rss / 1024)} MB)`);
}

// ── App bootstrap ─────────────────────────────────────────────────────────────

app.on('ready', async () => {
  // ── 1. Session setup ────────────────────────────────────────────────────────
  const ses = session.fromPartition(SPIKE_PARTITION);

  // Minimal UA alignment (mirrors what session-setup.js does for the real app)
  const chromiumVersion = process.versions.chrome || '120.0.0.0';
  ses.setUserAgent(
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`
  );

  // ── 2. Extension loading (early — before tabs load) ──────────────────────
  await testExtensionLoad(ses);

  // ── 3. Create BrowserWindow (chrome shell only — no webview inside) ────────
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Navio WCV Spike',
    webPreferences: {
      // The shell UI has no webPreferences needed for the spike — it's just
      // a blank window. Real app would load src/index.html here.
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Load a minimal toolbar HTML inline so we can switch tabs visually
  const toolbarHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { margin:0; font-family:sans-serif; background:#1a1a2e; color:#eee; display:flex; align-items:center; height:40px; padding:0 8px; gap:8px; }
        button { background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; padding:4px 12px; cursor:pointer; font-size:12px; }
        button:hover { background:#0f3460; }
        #status { font-size:11px; color:#aaa; margin-left:auto; }
      </style>
    </head>
    <body>
      <button onclick="window.electronAPI.switchTab(0)">Tab 1</button>
      <button onclick="window.electronAPI.switchTab(1)">Tab 2</button>
      <button onclick="window.electronAPI.switchTab(2)">Tab 3</button>
      <button onclick="window.electronAPI.runTests()">▶ Run tests</button>
      <span id="status">WCV Spike — check console for test results</span>
    </body>
    </html>
  `;

  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toolbarHtml)}`);

  // ── 4. Create 3 WebContentsView tabs ────────────────────────────────────────
  logMemory('before-tabs');

  for (let i = 0; i < SPIKE_URLS.length; i++) {
    const wcv = new WebContentsView({
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        // Tab preload would go here in Phase 1:
        // preload: path.join(__dirname, '..', 'electron', 'webview-preload.js')
      }
    });

    mainWindow.contentView.addChildView(wcv);
    wcvTabs.push({ wcv, id: i, url: SPIKE_URLS[i] });

    wcv.webContents.on('did-finish-load', () => {
      log('tab-load', `Tab ${i} loaded: ${wcv.webContents.getURL()}`);
    });

    wcv.webContents.on('did-fail-load', (e, code, desc, url) => {
      log('tab-load', `Tab ${i} failed to load: ${url} — ${desc} (${code})`);
    });

    await wcv.webContents.loadURL(SPIKE_URLS[i]);
    log('tab', `Created WCV tab ${i}: webContentsId=${wcv.webContents.id}`);
  }

  logMemory('after-3-tabs');

  // ── 5. Layout — show tab 0 initially ────────────────────────────────────────
  switchTab(0);

  mainWindow.on('resize', () => layoutTabs(mainWindow));

  // ── 6. IPC from toolbar buttons ──────────────────────────────────────────────
  // In the real app this is handled by tab-manager.js via ipcMain.
  // For the spike we expose it via a simple IPC bridge on the shell webContents.
  mainWindow.webContents.executeJavaScript(`
    window.electronAPI = {
      switchTab: (idx) => { window.__pendingTab = idx; },
      runTests: () => { window.__runTests = true; }
    };
    setInterval(() => {
      if (window.__pendingTab !== undefined) {
        const idx = window.__pendingTab;
        window.__pendingTab = undefined;
        fetch('navio-spike://switch-tab/' + idx).catch(() => {});
      }
      if (window.__runTests) {
        window.__runTests = false;
        fetch('navio-spike://run-tests').catch(() => {});
      }
    }, 100);
  `).catch(() => {});

  // Use protocol interception on the spike session to handle button clicks
  // (simpler than setting up a full ipcRenderer bridge for a throwaway spike)
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('navio-spike://')) e.preventDefault();
  });

  // Poll for test trigger — simplest possible IPC for a throwaway spike
  let testsRun = false;
  setInterval(async () => {
    try {
      const pending = await mainWindow.webContents.executeJavaScript(
        '({ tab: window.__pendingTab, tests: window.__runTests })'
      );
      if (pending.tab !== undefined && pending.tab !== null) {
        await mainWindow.webContents.executeJavaScript('window.__pendingTab = null');
        switchTab(Number(pending.tab));
      }
      if (pending.tests && !testsRun) {
        testsRun = true;
        await mainWindow.webContents.executeJavaScript('window.__runTests = false');
        await runAllTests();
      }
    } catch { /* ignore — window not ready */ }
  }, 200);

  log('ready', '─────────────────────────────────────────────────────────');
  log('ready', 'WCV Spike ready. 3 tabs open.');
  log('ready', 'Click "▶ Run tests" in the toolbar to run all validation tests.');
  log('ready', 'Or they will run automatically in 3 seconds...');
  log('ready', '─────────────────────────────────────────────────────────');

  // Auto-run tests after a short delay so pages have time to load
  setTimeout(async () => {
    if (!testsRun) {
      testsRun = true;
      await runAllTests();
    }
  }, 3000);
});

async function runAllTests() {
  log('tests', '═══════════════════════════════════════════════════════════');
  log('tests', 'Running Phase 0 go/no-go validation tests...');
  log('tests', '═══════════════════════════════════════════════════════════');

  // Test 1: Trusted click on tab 0
  switchTab(0);
  await new Promise(r => setTimeout(r, 500));
  await testTrustedClick(wcvTabs[0].wcv.webContents);

  // Test 2: DevTools coexistence
  await testDevToolsCoexistence();

  // Memory after tests
  logMemory('after-tests');

  log('tests', '═══════════════════════════════════════════════════════════');
  log('tests', 'Tests complete. Check output above for PASS/FAIL/UNKNOWN.');
  log('tests', '');
  log('tests', 'Go/no-go gate:');
  log('tests', '  • Trusted clicks PASS → CDP Input events are trusted ✅');
  log('tests', '  • DevTools coexistence PASS → no debugger eviction ✅');
  log('tests', '  • Extension loaded (if --ext-path provided) ✅');
  log('tests', '');
  log('tests', 'If all tests PASS → proceed with Phase 1 (TabManager core).');
  log('tests', 'If any test FAILS → document blocker in ARCHITECTURE_MIGRATION_PLAN.md');
  log('tests', '═══════════════════════════════════════════════════════════');
}

app.on('window-all-closed', () => {
  app.quit();
});
