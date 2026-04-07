const { app, BrowserWindow, ipcMain, session, dialog, Menu, MenuItem, globalShortcut, nativeTheme, clipboard, webContents: electronWebContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const secureConfig = require('./secure-config');
const { createStore } = require('./navio-store');

const INTRO_VIDEO_PATH = path.join(__dirname, '..', 'public', 'intro_video', 'intro_final.mp4');

let mainWindow = null;
let store = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'navio-config.json');
}

const DEFAULT_CONFIG = {
  aiProvider: 'openai',
  aiModel: 'gpt-4o',
  customEndpoint: '',
  theme: 'dark',
  searchEngine: 'https://www.google.com/search?q=',
  homepage: 'https://www.google.com',
  sidebarWidth: 240,
  assistantWidth: 420,
  startupMode: 'new-tab',
  defaultZoom: 1,
  aiIncludePageContext: true,
  aiDataScope: 'excerpt',
  aiRedactPII: true,
  aiKillSwitch: false,
  aiStreamResponses: true,
  aiProactivity: 'off',
  shortcuts: {},
  extensionsAllowAI: false,
  mcpEnabled: false,
  mcpServers: [],
  syncEnabled: false,
  readingModeFontScale: 1,
  formAutofillAssist: true,
  onboardingComplete: false,
  userName: '',
  lastProactiveSuggestionAt: 0
};

function readConfigFile() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {
    console.error('readConfigFile', e.message);
  }
  return {};
}

function writeConfigFile(obj) {
  const clean = { ...obj };
  delete clean.apiKey;
  delete clean.hasApiKey;
  fs.writeFileSync(getConfigPath(), JSON.stringify(clean, null, 2));
}

function loadConfig() {
  const userData = app.getPath('userData');
  let file = readConfigFile();

  if (file.apiKey && typeof file.apiKey === 'string' && file.apiKey.length > 0) {
    secureConfig.setApiKey(userData, file.apiKey);
    delete file.apiKey;
    writeConfigFile(file);
  }

  const merged = { ...DEFAULT_CONFIG, ...file };
  if (merged.aiDataScope === undefined || merged.aiDataScope === null) {
    merged.aiDataScope = merged.aiIncludePageContext === false ? 'none' : 'excerpt';
  }
  const key = secureConfig.getApiKey(userData);
  merged.hasApiKey = !!key;
  delete merged.apiKey;
  return merged;
}

function saveConfig(partial) {
  const userData = app.getPath('userData');
  const file = readConfigFile();

  if (Object.prototype.hasOwnProperty.call(partial, 'apiKey')) {
    const k = partial.apiKey;
    if (k === '' || k == null) {
      secureConfig.setApiKey(userData, '');
    } else if (typeof k === 'string') {
      secureConfig.setApiKey(userData, k);
    }
  }

  const { apiKey, hasApiKey, ...rest } = partial;
  const next = { ...file, ...rest };
  delete next.apiKey;
  delete next.hasApiKey;
  writeConfigFile(next);

  if (partial.theme) {
    nativeTheme.themeSource = partial.theme === 'light' ? 'light' : 'dark';
  }
  return true;
}

function redactPII(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b\d{3}\s?\d{2}\s?\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED-CARD]');
  return t;
}

function hashContext(messages) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return crypto.createHash('sha256').update(sys.slice(0, 4000)).digest('hex').slice(0, 20);
}

const RISKY_BROWSER_ACTIONS = new Set(['navigate', 'click', 'type']);

function createMainWindow() {
  const config = loadConfig();
  const isDark = config.theme !== 'light';
  nativeTheme.themeSource = isDark ? 'dark' : 'light';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    backgroundColor: isDark ? '#080c18' : '#f4f5f7',
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });


  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state-changed', 'maximized');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state-changed', 'normal');
  });
}

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (event, partial) => {
  saveConfig(partial);
  return true;
});

ipcMain.handle('get-api-key-for-settings', () => {
  return secureConfig.getApiKey(app.getPath('userData'));
});

ipcMain.handle('get-intro-video-url', () => {
  try {
    if (!fs.existsSync(INTRO_VIDEO_PATH)) return null;
    return pathToFileURL(INTRO_VIDEO_PATH).href;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('clear-browsing-data', async () => {
  try {
    const ses = session.fromPartition('persist:navio');
    await ses.clearStorageData({
      storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-memory-info', () => {
  try {
    const mu = process.memoryUsage();
    return {
      heapUsed: mu.heapUsed,
      heapTotal: mu.heapTotal,
      rss: mu.rss
    };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('open-devtools-active', (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (wc) {
      wc.openDevTools({ mode: 'detach' });
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: false, error: 'WebContents not found' };
});

async function performAiFetch(cfg, apiKey, messages, useStream) {
  const provider = cfg.aiProvider || 'openai';
  const model = cfg.aiModel || 'gpt-4o';
  const endpoint = cfg.customEndpoint || '';

  let url;
  let headers;
  let body;

  if (provider === 'openai' || provider === 'custom') {
    url = endpoint || 'https://api.openai.com/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    // max_completion_tokens is the correct parameter for all current OpenAI models.
    // max_tokens is deprecated and rejected by newer models (GPT-5+, o-series).
    // o-series reasoning models also reject the temperature parameter entirely.
    const isOSeries = /^o[1-9]/i.test(model || '');
    const bodyObj = {
      model: model || 'gpt-4o',
      messages,
      max_completion_tokens: 4096,
      stream: !!useStream
    };
    if (isOSeries) {
      // o-series fixes temperature at 1 internally; sending it causes a 400 error
      delete bodyObj.temperature;
    }
    body = JSON.stringify(bodyObj);
  } else if (provider === 'anthropic') {
    if (useStream) return { error: 'Streaming not implemented for this provider; disable stream in settings.' };
    url = 'https://api.anthropic.com/v1/messages';
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMsgs = messages.filter((m) => m.role !== 'system');
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = JSON.stringify({
      model: model || 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemMsg?.content || '',
      messages: chatMsgs
    });
  } else if (provider === 'google') {
    if (useStream) return { error: 'Streaming not implemented for this provider; disable stream in settings.' };
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
    const systemInstruction = messages.find((m) => m.role === 'system');
    body = JSON.stringify({
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction.content }] } : undefined
    });
  } else {
    return { error: `Unknown provider: ${provider}` };
  }

  const response = await fetch(url, { method: 'POST', headers, body });

  if (useStream && (provider === 'openai' || provider === 'custom')) {
    if (!response.ok) {
      const errText = await response.text();
      return { error: errText || response.statusText };
    }
    return { stream: response.body, provider };
  }

  const data = await response.json();
  if (!response.ok) {
    return { error: data.error?.message || JSON.stringify(data) };
  }

  let content = '';
  if (provider === 'anthropic') {
    content = data.content?.[0]?.text || '';
  } else if (provider === 'google') {
    content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    content = data.choices?.[0]?.message?.content || '';
  }

  return { content };
}

ipcMain.handle('ai-request', async (event, { messages }) => {
  const cfg = loadConfig();
  if (cfg.aiKillSwitch) {
    return { error: 'AI is turned off (kill switch). Enable it in Settings → AI.' };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey) {
    return { error: 'No API key configured. Add one in Settings → AI.' };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (cfg.aiRedactPII !== false) {
    processed = processed.map((m) =>
      typeof m.content === 'string' ? { ...m, content: redactPII(m.content) } : m
    );
  }

  if (store) {
    store.appendLedger({
      type: 'ai_request',
      provider: cfg.aiProvider,
      model: cfg.aiModel,
      messageCount: processed.length,
      contextFingerprint: hashContext(processed)
    });
  }

  try {
    const result = await performAiFetch(cfg, apiKey, processed, false);
    if (result.stream) return { error: 'Internal error: unexpected stream' };
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ai-request-stream', async (event, { messages }) => {
  const cfg = loadConfig();
  const sender = event.sender;
  if (cfg.aiKillSwitch) {
    sender.send('ai-stream-error', 'AI is turned off (kill switch).');
    return { ok: false };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey) {
    sender.send('ai-stream-error', 'No API key configured.');
    return { ok: false };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (cfg.aiRedactPII !== false) {
    processed = processed.map((m) =>
      typeof m.content === 'string' ? { ...m, content: redactPII(m.content) } : m
    );
  }

  if (store) {
    store.appendLedger({
      type: 'ai_request_stream',
      provider: cfg.aiProvider,
      model: cfg.aiModel,
      messageCount: processed.length,
      contextFingerprint: hashContext(processed)
    });
  }

  try {
    const result = await performAiFetch(cfg, apiKey, processed, true);
    if (result.error) {
      sender.send('ai-stream-error', result.error);
      return { ok: false };
    }
    if (!result.stream) {
      sender.send('ai-stream-error', 'Streaming unavailable for this provider.');
      return { ok: false };
    }

    const reader = result.stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          sender.send('ai-stream-done', {});
          return { ok: true };
        }
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) sender.send('ai-stream-chunk', delta);
        } catch {
          /* ignore parse errors for keep-alive lines */
        }
      }
    }
    sender.send('ai-stream-done', {});
    return { ok: true };
  } catch (err) {
    sender.send('ai-stream-error', err.message);
    return { ok: false };
  }
});

ipcMain.handle('extract-page-content', async (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };

    const result = await wc.executeJavaScript(`
      (function() {
        const getMetaContent = (name) => {
          const el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
          return el ? el.getAttribute('content') : '';
        };
        return JSON.stringify({
          title: document.title,
          url: window.location.href,
          description: getMetaContent('description') || getMetaContent('og:description'),
          text: document.body.innerText.substring(0, 15000),
          headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0, 30).map(h => ({
            level: h.tagName,
            text: h.textContent.trim()
          })),
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
            text: a.textContent.trim().substring(0, 100),
            href: a.href
          })).filter(l => l.text && l.href.startsWith('http')),
          images: Array.from(document.querySelectorAll('img[alt]')).slice(0, 20).map(img => ({
            alt: img.alt,
            src: img.src
          })),
          forms: Array.from(document.querySelectorAll('form')).slice(0, 5).map(f => ({
            action: f.action,
            fields: Array.from(f.querySelectorAll('input, select, textarea')).map(el => ({
              type: el.type || el.tagName.toLowerCase(),
              name: el.name,
              placeholder: el.placeholder,
              id: el.id
            }))
          }))
        });
      })()
    `);
    return JSON.parse(result);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('extract-page-selection', async (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };
    const text = await wc.executeJavaScript(
      `(() => { try { return window.getSelection().toString() || ''; } catch (e) { return ''; } })()`
    );
    return { selection: typeof text === 'string' ? text : '' };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('browser-action', async (event, { webContentsId, action, params, userConfirmed }) => {
  try {
    if (RISKY_BROWSER_ACTIONS.has(action) && !userConfirmed) {
      return { error: 'This action requires user confirmation in the UI.' };
    }
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };

    if (store) {
      store.appendLedger({
        type: 'browser_action',
        action,
        userConfirmed: !!userConfirmed,
        url: wc.getURL?.() || ''
      });
    }

    switch (action) {
      case 'navigate':
        await wc.loadURL(params.url);
        return { success: true };

      case 'click':
        await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector('${params.selector.replace(/'/g, "\\'")}');
            if (el) { el.click(); return true; }
            return false;
          })()
        `);
        return { success: true };

      case 'type':
        await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector('${params.selector.replace(/'/g, "\\'")}');
            if (el) {
              el.focus();
              el.value = '${params.text.replace(/'/g, "\\'")}';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          })()
        `);
        return { success: true };

      case 'scroll':
        await wc.executeJavaScript(`
          window.scrollBy(0, ${params.direction === 'up' ? -500 : 500})
        `);
        return { success: true };

      case 'goBack':
        wc.goBack();
        return { success: true };

      case 'goForward':
        wc.goForward();
        return { success: true };

      case 'screenshot': {
        const image = await wc.capturePage();
        return { screenshot: image.toDataURL() };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('context-graph', (event, payload) => {
  if (!store) return { error: 'Store not ready' };
  const g = store.loadGraph();
  const op = payload?.op;
  if (op === 'get') {
    return { graph: g };
  }
  if (op === 'pinTab') {
    const id = payload.tabId;
    if (id && !g.pinnedTabIds.includes(id)) g.pinnedTabIds.push(id);
    store.saveGraph(g);
    return { graph: g };
  }
  if (op === 'unpinTab') {
    g.pinnedTabIds = (g.pinnedTabIds || []).filter((x) => x !== payload.tabId);
    store.saveGraph(g);
    return { graph: g };
  }
  if (op === 'addTurn') {
    g.turns = g.turns || [];
    g.turns.push({
      id: `turn-${Date.now()}`,
      at: Date.now(),
      role: payload.role,
      summary: (payload.summary || '').slice(0, 500),
      tabId: payload.tabId || null,
      url: payload.url || ''
    });
    if (g.turns.length > 200) g.turns = g.turns.slice(-200);
    store.saveGraph(g);
    return { graph: g };
  }
  if (op === 'addGraphNote') {
    g.notes = g.notes || [];
    g.notes.push({
      id: `n-${Date.now()}`,
      text: payload.text || '',
      tabId: payload.tabId || null,
      at: Date.now()
    });
    store.saveGraph(g);
    return { graph: g };
  }
  return { error: 'Unknown op' };
});

ipcMain.handle('workspace', (event, payload) => {
  if (!store) return { error: 'Store not ready' };
  const w = store.loadWorkspace();
  const op = payload?.op;
  if (op === 'get') return { workspace: w };
  if (op === 'save') {
    const next = { ...w, ...payload.workspace, version: 1 };
    store.saveWorkspace(next);
    return { workspace: next };
  }
  if (op === 'addProject') {
    w.projects = w.projects || [];
    w.projects.push({
      id: `p-${Date.now()}`,
      name: payload.name || 'Untitled',
      tabIds: payload.tabIds || []
    });
    store.saveWorkspace(w);
    return { workspace: w };
  }
  if (op === 'addTask') {
    w.tasks = w.tasks || [];
    w.tasks.push({
      id: `t-${Date.now()}`,
      title: payload.title || '',
      done: false,
      projectId: payload.projectId || null,
      sourceUrl: payload.sourceUrl || ''
    });
    store.saveWorkspace(w);
    return { workspace: w };
  }
  if (op === 'toggleTask') {
    const t = (w.tasks || []).find((x) => x.id === payload.taskId);
    if (t) t.done = !t.done;
    store.saveWorkspace(w);
    return { workspace: w };
  }
  if (op === 'addWorkspaceNote') {
    w.notes = w.notes || [];
    w.notes.push({
      id: `wn-${Date.now()}`,
      body: payload.body || '',
      tabUrl: payload.tabUrl || '',
      at: Date.now()
    });
    store.saveWorkspace(w);
    return { workspace: w };
  }
  return { error: 'Unknown op' };
});

ipcMain.handle('mcp-config', (event, payload) => {
  const cfg = loadConfig();
  if (payload?.op === 'get') {
    return {
      enabled: !!cfg.mcpEnabled,
      servers: Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []
    };
  }
  if (payload?.op === 'set') {
    saveConfig({
      mcpEnabled: !!payload.enabled,
      mcpServers: Array.isArray(payload.servers) ? payload.servers : []
    });
    if (store) {
      store.appendLedger({ type: 'mcp_config', enabled: !!payload.enabled, serverCount: (payload.servers || []).length });
    }
    return { ok: true };
  }
  if (payload?.op === 'list-tools-stub') {
    return {
      tools: cfg.mcpEnabled
        ? [
            { name: 'navio.echo', description: 'Stub MCP tool (enable real MCP SDK in a future release)' }
          ]
        : []
    };
  }
  return { error: 'Unknown op' };
});

ipcMain.handle('proactive-tick', (event, payload) => {
  const cfg = loadConfig();
  if (cfg.aiProactivity === 'off' || !cfg.hasApiKey) {
    return { suggestion: null };
  }
  const now = Date.now();
  const last = cfg.lastProactiveSuggestionAt || 0;
  const minGap = cfg.aiProactivity === 'active' ? 120000 : 600000;
  if (now - last < minGap) return { suggestion: null };
  saveConfig({ lastProactiveSuggestionAt: now });
  return { suggestion: { fire: true, id: `sug-${now}` } };
});

ipcMain.handle('live-connector-data', (event, payload) => {
  const dataPath = path.join(app.getPath('userData'), 'live-connector-data.json');
  try {
    if (payload?.op === 'get') {
      if (fs.existsSync(dataPath)) {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        return { data: JSON.parse(raw) };
      }
      return { data: { liveConfig: {}, styleMemory: {} } };
    }
    if (payload?.op === 'set' && payload.data) {
      fs.writeFileSync(dataPath, JSON.stringify(payload.data, null, 2));
      return { ok: true };
    }
  } catch (e) {
    return { error: e.message };
  }
  return { error: 'Unknown op' };
});

ipcMain.handle('ledger-export', () => {
  if (!store || !fs.existsSync(store.ledgerPath)) return '';
  try {
    return fs.readFileSync(store.ledgerPath, 'utf-8');
  } catch {
    return '';
  }
});

ipcMain.handle('detect-browsers', async () => {
  const browsers = [];
  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';

  const candidates = [
    { id: 'chrome', name: 'Google Chrome', bookmarks: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks') },
    { id: 'edge', name: 'Microsoft Edge', bookmarks: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks') },
    { id: 'brave', name: 'Brave', bookmarks: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks') },
    { id: 'opera', name: 'Opera', bookmarks: path.join(appData, 'Opera Software', 'Opera Stable', 'Bookmarks') },
    { id: 'vivaldi', name: 'Vivaldi', bookmarks: path.join(localAppData, 'Vivaldi', 'User Data', 'Default', 'Bookmarks') }
  ];

  for (const b of candidates) {
    try {
      if (fs.existsSync(b.bookmarks)) {
        const data = JSON.parse(fs.readFileSync(b.bookmarks, 'utf-8'));
        const count = countBookmarks(data.roots);
        browsers.push({ id: b.id, name: b.name, path: b.bookmarks, bookmarkCount: count });
      }
    } catch (e) {
      /* skip */
    }
  }
  return browsers;
});

function countBookmarks(roots) {
  let count = 0;
  function walk(node) {
    if (!node) return;
    if (node.type === 'url') {
      count++;
      return;
    }
    if (node.children) node.children.forEach(walk);
    if (typeof node === 'object' && !node.type && !node.children) {
      Object.values(node).forEach((v) => {
        if (v && typeof v === 'object') walk(v);
      });
    }
  }
  walk(roots);
  return count;
}

ipcMain.handle('import-bookmarks', async (event, browserPath) => {
  try {
    const data = JSON.parse(fs.readFileSync(browserPath, 'utf-8'));
    const bookmarks = [];
    function extract(node, folder) {
      if (!node) return;
      if (node.type === 'url') {
        bookmarks.push({ title: node.name, url: node.url, folder });
        return;
      }
      const folderName = node.name || folder;
      if (node.children) node.children.forEach((c) => extract(c, folderName));
      if (typeof node === 'object' && !node.type && !node.children) {
        Object.values(node).forEach((v) => {
          if (v && typeof v === 'object') extract(v, folder);
        });
      }
    }
    extract(data.roots, 'root');
    return { bookmarks };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));

ipcMain.handle('show-webview-context-menu', (event, { webContentsId, x, y, params }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return;

    const menu = new Menu();

    if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', click: () => wc.copy() }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut', role: 'cut', click: () => wc.cut() }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', click: () => wc.copy() }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', click: () => wc.paste() }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll', click: () => wc.selectAll() }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.linkURL) {
      menu.append(new MenuItem({
        label: 'Open Link in New Tab',
        click: () => mainWindow?.webContents.send('open-url-in-new-tab', params.linkURL)
      }));
      menu.append(new MenuItem({
        label: 'Copy Link Address',
        click: () => clipboard.writeText(params.linkURL)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.mediaType === 'image' && params.srcURL) {
      menu.append(new MenuItem({
        label: 'Open Image in New Tab',
        click: () => mainWindow?.webContents.send('open-url-in-new-tab', params.srcURL)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({ label: 'Back', click: () => { if (wc.canGoBack()) wc.goBack(); }, enabled: wc.canGoBack() }));
    menu.append(new MenuItem({ label: 'Forward', click: () => { if (wc.canGoForward()) wc.goForward(); }, enabled: wc.canGoForward() }));
    menu.append(new MenuItem({ label: 'Reload', click: () => wc.reload() }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Inspect Element', click: () => wc.openDevTools({ mode: 'detach' }) }));

    menu.popup({ window: mainWindow });
  } catch (e) {
    console.error('context-menu error:', e.message);
  }
});

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));

  createMainWindow();

  // Set up the persist:navio session used by all webview tabs
  const navioSession = session.fromPartition('persist:navio');

  // Allow all permission requests from web content (camera, mic, notifications, etc.)
  navioSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  // Allow all permission checks (Electron 15+)
  if (typeof navioSession.setPermissionCheckHandler === 'function') {
    navioSession.setPermissionCheckHandler(() => true);
  }

  // Apply ad-blocker to the navio session (where webview traffic actually flows)
  const adPatterns = [
    'doubleclick.net',
    'googlesyndication.com',
    'adservice.google',
    'facebook.com/tr',
    'analytics.facebook.com'
  ];

  navioSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const shouldBlock = adPatterns.some((pattern) => details.url.includes(pattern));
    callback({ cancel: shouldBlock });
  });

  globalShortcut.register('F12', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  globalShortcut.register('CommandOrControl+T', () => {
    mainWindow?.webContents.send('shortcut', 'new-tab');
  });
  globalShortcut.register('CommandOrControl+W', () => {
    mainWindow?.webContents.send('shortcut', 'close-tab');
  });
  globalShortcut.register('CommandOrControl+L', () => {
    mainWindow?.webContents.send('shortcut', 'focus-url');
  });
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    mainWindow?.webContents.send('shortcut', 'toggle-assistant');
  });
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    mainWindow?.webContents.send('shortcut', 'toggle-connectors');
  });
  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.send('shortcut', 'command-palette');
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

Menu.setApplicationMenu(null);
