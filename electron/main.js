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

// ── Authoritative system prompt (main-process, never cached) ─────────────────
// The renderer's assistant.js may be stale due to Chromium bytecode cache.
// We ALWAYS inject this fresh system prompt in main.js, overriding whatever
// the renderer sends. This is the single source of truth for the AI's behaviour.
const NAVIO_SYSTEM_PROMPT = `You are Navio, an intelligent AI assistant built into the Navio Browser. You help users browse the web, understand content, and automate tasks.

BROWSER CONTROL:
When the user asks you to do something in the browser, write a short explanation first, then end your response with a <navio-actions> block listing every step needed.

Action block format — ONE action per line, no numbering, no bullet points:
<navio-actions>
navigate:https://full-url-here
click:text=Visible button label
type:text=Field label:text to type
scroll:down
goBack:
goForward:
</navio-actions>

RULES:
- ALWAYS end with a <navio-actions> block when browser actions are needed.
- Each line inside <navio-actions> must be: actionType:params
- For navigate, use the FULL URL including https://
- For click, use: click:text=visible text on the element
- For type, use: type:text=field label:text to type
- NEVER use ACTION0, ACTION1, ACTION2 or any numbered placeholders.
- NEVER use [[ACTION:...]] tokens — only use the <navio-actions> block.
- Do NOT ask "shall I proceed?" — just do it.

EXAMPLE — "go to youtube and search for world news":
I'll navigate straight to the YouTube search results for world news.
<navio-actions>
navigate:https://www.youtube.com/results?search_query=world+news
</navio-actions>

EXAMPLE — "search google for best laptops and click the first result":
I'll search Google and open the first result.
<navio-actions>
navigate:https://www.google.com/search?q=best+laptops
click:text=1
</navio-actions>

If no browser actions are needed, just reply with plain text and no <navio-actions> block.`;

// ── <navio-actions> block converter ──────────────────────────────────────────
// The system prompt asks the model to output a <navio-actions> block at the end
// of its response. This function converts that block into [[ACTION:type:params]]
// tokens that the renderer's formatMessage() can parse and display as cards.
// This runs in main.js (Node.js, no bytecode cache) so it always uses fresh code.

function convertNavioActionsBlock(text) {
  if (!text) return text;
  return text.replace(/<navio-actions>([\s\S]*?)<\/navio-actions>/gi, (_, body) => {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.map(line => {
      const colon = line.indexOf(':');
      if (colon < 0) return '';
      const type = line.slice(0, colon).trim().toLowerCase();
      const params = line.slice(colon + 1).trim();
      const valid = ['navigate', 'click', 'type', 'scroll', 'goback', 'goforward'];
      const normType = type === 'goback' ? 'goBack' : type === 'goforward' ? 'goForward' : type;
      if (!valid.includes(type)) return '';
      return `[[ACTION:${normType}:${params}]]`;
    }).filter(Boolean).join('\n');
  });
}

function aiResponseHasBrokenActions(text) {
  if (!text) return false;
  if (/\[\[ACTION:\w+:[\s\S]*?\]\]/.test(text)) return false; // has real tokens — fine
  if (/<navio-actions>/i.test(text)) return false;             // has our new block format
  return /\bACTION[\s_]?\d\b/i.test(text);                   // broken numbered labels
}

// Replaces ONLY the first system message with NAVIO_SYSTEM_PROMPT.
// Other system messages (page context, selection, tab list, etc.) are preserved.
// Called in every IPC handler so the cached renderer's stale system prompt is ignored.
function injectSystemPrompt(messages) {
  let replaced = false;
  const result = messages.map((m) => {
    if (!replaced && m.role === 'system') {
      replaced = true;
      return { role: 'system', content: NAVIO_SYSTEM_PROMPT };
    }
    return m;
  });
  if (!replaced) {
    result.unshift({ role: 'system', content: NAVIO_SYSTEM_PROMPT });
  }
  return result;
}

function buildActionFixMessages(originalMessages, brokenResponse) {
  return [
    ...originalMessages,
    { role: 'assistant', content: brokenResponse },
    {
      role: 'user',
      content: '[SYSTEM FIX: Your previous response used "ACTION0", "ACTION1" etc. as plain-text placeholders. Use a <navio-actions> block instead. Example:\nI\'ll search YouTube.\n<navio-actions>\nnavigate:https://www.youtube.com/results?search_query=breaking+world+news\nclick:text=first video\n</navio-actions>\nRewrite your complete response now with a proper <navio-actions> block.]'
    }
  ];
}

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
  processed = injectSystemPrompt(processed);
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
    let result = await performAiFetch(cfg, apiKey, processed, false);
    if (result.stream) return { error: 'Internal error: unexpected stream' };

    // Convert <navio-actions> block to [[ACTION:...]] tokens
    if (!result.error && result.content) {
      result = { ...result, content: convertNavioActionsBlock(result.content) };
    }

    // Fallback: if model still wrote ACTION0/ACTION1 placeholders, silently retry once
    if (!result.error && aiResponseHasBrokenActions(result.content)) {
      console.log('[navio] ACTION0 pattern detected — auto-retrying with format fix');
      const fixed = await performAiFetch(cfg, apiKey, buildActionFixMessages(processed, result.content), false);
      if (!fixed.error && fixed.content) {
        result = { ...fixed, content: convertNavioActionsBlock(fixed.content) };
      }
    }

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
  processed = injectSystemPrompt(processed);
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

  // Helper: collect an SSE stream from performAiFetch into a plain string
  const collectStream = async (fetchResult) => {
    if (fetchResult.error) return { error: fetchResult.error };
    if (!fetchResult.stream) return { error: 'Streaming unavailable for this provider.' };
    const reader = fetchResult.stream.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) fullText += delta;
        } catch { /* skip keep-alives */ }
      }
    }
    return { content: fullText };
  };

  try {
    // Collect the full response before sending to renderer so we can check the format
    let currentMessages = processed;
    let finalText = '';
    const MAX_FORMAT_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt++) {
      console.log(`[navio] ai-request-stream attempt ${attempt + 1}, model=${cfg.aiModel}, messages=${currentMessages.length}`);
      const fetchResult = await performAiFetch(cfg, apiKey, currentMessages, true);
      const collected = await collectStream(fetchResult);

      if (collected.error) {
        sender.send('ai-stream-error', collected.error);
        return { ok: false };
      }

      finalText = convertNavioActionsBlock(collected.content);
      console.log(`[navio] raw response (first 200): ${collected.content?.slice(0, 200)}`);
      console.log(`[navio] converted (first 200): ${finalText?.slice(0, 200)}`);

      if (!aiResponseHasBrokenActions(finalText) || attempt === MAX_FORMAT_RETRIES) break;

      console.log(`[navio] ACTION0 pattern detected (attempt ${attempt + 1}) — retrying with format fix`);
      currentMessages = buildActionFixMessages(currentMessages, finalText);
    }

    // Stream the final (possibly corrected) text to the renderer in chunks
    const CHUNK = 40;
    for (let i = 0; i < finalText.length; i += CHUNK) {
      sender.send('ai-stream-chunk', finalText.slice(i, i + CHUNK));
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

// Accessibility-first snapshot of interactive elements on the active page
ipcMain.handle('page-snapshot', async (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };
    const snapshot = await wc.executeJavaScript(`
      (() => {
        const results = [];
        const seen = new WeakSet();
        const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="tab"],[role="option"],[role="switch"],[role="combobox"],[role="searchbox"]';
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? el.type || 'input' : tag);
          const ariaLabel = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const title = el.getAttribute('title') || '';
          const name = el.getAttribute('name') || '';
          const id = el.id || '';
          const visibleText = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80);
          const label = (ariaLabel || visibleText || placeholder || title || name).trim().slice(0,80);
          let selector = id ? '#'+id : (name ? tag+'[name="'+name+'"]' : null);
          if (!selector) {
            const classes = Array.from(el.classList).filter(c => !/^[a-z]{1,2}$/.test(c)).slice(0,2);
            selector = tag + (classes.length ? '.'+classes.join('.') : '');
          }
          if (label) results.push({ role, label, selector });
          if (results.length >= 60) break;
        }
        return results;
      })()
    `);
    return { elements: snapshot, url: wc.getURL(), title: wc.getTitle() };
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
      case 'navigate': {
        // Wait for the page to fully load, not just navigation start.
        // did-finish-load fires once the HTML + resources are done; we add a
        // short extra wait so JS-rendered UIs (React, etc.) have time to paint.
        await new Promise((resolve, reject) => {
          const MAX_WAIT = 12000;
          let settled = false;
          const settle = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wc.removeListener('did-finish-load', onLoad);
            wc.removeListener('did-fail-load', onFail);
            if (err) reject(err); else resolve();
          };
          const timer = setTimeout(() => settle(), MAX_WAIT);
          const onLoad = () => setTimeout(() => settle(), 800);
          const onFail = (_, code, desc) => {
            if (code === -3) setTimeout(() => settle(), 800); // redirect — still ok
            else settle(new Error(`Navigation failed: ${desc} (${code})`));
          };
          wc.once('did-finish-load', onLoad);
          wc.once('did-fail-load', onFail);
          wc.loadURL(params.url).catch((e) => {
            if (e.message?.includes('ERR_ABORTED') || e.message?.includes('-3')) {
              // redirect in-flight — did-finish-load / did-fail-load will settle us
            } else {
              settle(e);
            }
          });
        });
        return { success: true };
      }

      case 'click': {
        const cSel = JSON.stringify(params.selector || '');
        const res = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const raw = ${cSel};
            // Multi-strategy element finder (accessibility-first, CSS fallback)
            function findEl(sel) {
              if (!sel) return null;
              if (sel.startsWith('text=')) {
                const q = sel.slice(5).trim().toLowerCase();
                const candidates = document.querySelectorAll(
                  'a,button,input[type="submit"],input[type="button"],[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
                );
                for (const el of candidates) {
                  const lbl = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().toLowerCase();
                  if (lbl.includes(q)) return el;
                }
                return null;
              }
              if (sel.startsWith('aria=')) {
                const q = sel.slice(5).trim().toLowerCase();
                for (const el of document.querySelectorAll('[aria-label]')) {
                  if (el.getAttribute('aria-label').toLowerCase().includes(q)) return el;
                }
                return null;
              }
              try { return document.querySelector(sel); } catch { return null; }
            }
            let tries = 0;
            const attempt = () => {
              const el = findEl(raw);
              if (el) {
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                el.focus();
                el.click();
                resolve({ ok: true });
              } else if (++tries < 14) {
                setTimeout(attempt, 250);
              } else {
                resolve({ ok: false, error: 'Element not found: ' + raw });
              }
            };
            attempt();
          })
        `);
        if (!res.ok) return { error: res.error };
        return { success: true };
      }

      case 'type': {
        const tSel = JSON.stringify(params.selector || '');
        const tVal = JSON.stringify(params.text || '');
        const tRes = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const raw = ${tSel};
            const text = ${tVal};
            function findEl(sel) {
              if (!sel) return null;
              if (sel.startsWith('text=') || sel.startsWith('aria=')) {
                const prefix = sel.startsWith('text=') ? 'text=' : 'aria=';
                const q = sel.slice(prefix.length).trim().toLowerCase();
                for (const el of document.querySelectorAll('input,textarea,select,[contenteditable]')) {
                  const lbl = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').toLowerCase();
                  if (lbl.includes(q)) return el;
                }
                return null;
              }
              try { return document.querySelector(sel); } catch { return null; }
            }
            let tries = 0;
            const attempt = () => {
              const el = findEl(raw);
              if (el) {
                el.focus();
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                // Native input setter so React/Vue controlled inputs detect change
                const proto = el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, text); else el.value = text;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                resolve({ ok: true });
              } else if (++tries < 14) {
                setTimeout(attempt, 250);
              } else {
                resolve({ ok: false, error: 'Element not found: ' + raw });
              }
            };
            attempt();
          })
        `);
        if (!tRes.ok) return { error: tRes.error };
        return { success: true };
      }

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

app.whenReady().then(async () => {
  console.log('[navio] ✅ main.js v7 loaded — system prompt is injected from main process');
  // Clear V8 code caches so every launch picks up the latest renderer JS source files.
  // We use both the Electron session API (in-memory cache) AND the filesystem folder
  // (persistent cache) to guarantee a clean slate.
  try {
    await session.defaultSession.clearCodeCaches({});
  } catch (e) {
    console.warn('[navio] session.clearCodeCaches failed:', e.message);
  }
  try {
    const codeCachePath = path.join(app.getPath('userData'), 'Code Cache');
    if (fs.existsSync(codeCachePath)) {
      fs.rmSync(codeCachePath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[navio] Could not clear code cache folder:', e.message);
  }

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
