const { app, BrowserWindow, ipcMain, session, dialog, Menu, globalShortcut, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
const CONFIG_PATH = path.join(app.getPath('userData'), 'navio-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) { /* use defaults */ }
  return {
    apiKey: '',
    aiProvider: 'openai',
    aiModel: 'gpt-5.4',
    customEndpoint: '',
    theme: 'dark',
    searchEngine: 'https://www.google.com/search?q=',
    homepage: 'https://www.google.com',
    sidebarWidth: 240,
    assistantWidth: 400
  };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
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
    backgroundColor: isDark ? '#08080e' : '#f4f5f7',
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
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

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());

// Config management
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (event, config) => {
  saveConfig(config);
  if (config.theme) {
    nativeTheme.themeSource = config.theme === 'light' ? 'light' : 'dark';
  }
  return true;
});

// AI API proxy - routes through main process for security
ipcMain.handle('ai-request', async (event, { provider, apiKey, model, messages, endpoint }) => {
  try {
    let url, headers, body;

    if (provider === 'openai' || provider === 'custom') {
      url = endpoint || 'https://api.openai.com/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };
      body = JSON.stringify({
        model: model || 'gpt-5.4',
        messages,
        max_tokens: 4096,
        stream: false
      });
    } else if (provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      const systemMsg = messages.find(m => m.role === 'system');
      const chatMsgs = messages.filter(m => m.role !== 'system');
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
      body = JSON.stringify({
        model: model || 'claude-opus-4.6',
        max_tokens: 4096,
        system: systemMsg?.content || '',
        messages: chatMsgs
      });
    } else if (provider === 'google') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-3.1-pro'}:generateContent?key=${apiKey}`;
      headers = { 'Content-Type': 'application/json' };
      const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }));
      const systemInstruction = messages.find(m => m.role === 'system');
      body = JSON.stringify({
        contents,
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction.content }] } : undefined
      });
    }

    const response = await fetch(url, { method: 'POST', headers, body });
    const data = await response.json();

    if (!response.ok) {
      return { error: data.error?.message || JSON.stringify(data) };
    }

    // Normalize response
    let content = '';
    if (provider === 'anthropic') {
      content = data.content?.[0]?.text || '';
    } else if (provider === 'google') {
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      content = data.choices?.[0]?.message?.content || '';
    }

    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

// Page content extraction helper
ipcMain.handle('extract-page-content', async (event, webContentsId) => {
  try {
    const wc = require('electron').webContents.fromId(webContentsId);
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

// Browser automation commands
ipcMain.handle('browser-action', async (event, { webContentsId, action, params }) => {
  try {
    const wc = require('electron').webContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };

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

      case 'screenshot':
        const image = await wc.capturePage();
        return { screenshot: image.toDataURL() };

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { error: err.message };
  }
});

// Browser detection and bookmark import
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
    } catch (e) { /* skip */ }
  }
  return browsers;
});

function countBookmarks(roots) {
  let count = 0;
  function walk(node) {
    if (!node) return;
    if (node.type === 'url') { count++; return; }
    if (node.children) node.children.forEach(walk);
    if (typeof node === 'object' && !node.type && !node.children) {
      Object.values(node).forEach(v => { if (v && typeof v === 'object') walk(v); });
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
      if (node.children) node.children.forEach(c => extract(c, folderName));
      if (typeof node === 'object' && !node.type && !node.children) {
        Object.values(node).forEach(v => { if (v && typeof v === 'object') extract(v, folder); });
      }
    }
    extract(data.roots, 'root');
    return { bookmarks };
  } catch (e) {
    return { error: e.message };
  }
});

// Downloads
ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));

app.whenReady().then(() => {
  createMainWindow();

  // Ad blocker - basic
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const adPatterns = [
      'doubleclick.net', 'googlesyndication.com', 'adservice.google',
      'facebook.com/tr', 'analytics.facebook.com'
    ];
    const shouldBlock = adPatterns.some(pattern => details.url.includes(pattern));
    callback({ cancel: shouldBlock });
  });

  // Keyboard shortcuts
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
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

Menu.setApplicationMenu(null);
