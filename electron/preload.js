const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navio', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onWindowStateChanged: (callback) => {
    ipcRenderer.on('window-state-changed', (_, state) => callback(state));
  },

  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_, action) => callback(action));
  },

  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getApiKeyForSettings: () => ipcRenderer.invoke('get-api-key-for-settings'),

  aiRequest: (params) => ipcRenderer.invoke('ai-request', params),
  aiRequestStream: (params) => ipcRenderer.invoke('ai-request-stream', params),
  onAiStreamChunk: (callback) => {
    const handler = (_, chunk) => callback(chunk);
    ipcRenderer.on('ai-stream-chunk', handler);
    return () => ipcRenderer.removeListener('ai-stream-chunk', handler);
  },
  onAiStreamDone: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('ai-stream-done', handler);
    return () => ipcRenderer.removeListener('ai-stream-done', handler);
  },
  onAiStreamError: (callback) => {
    const handler = (_, msg) => callback(msg);
    ipcRenderer.on('ai-stream-error', handler);
    return () => ipcRenderer.removeListener('ai-stream-error', handler);
  },

  extractPageContent: (webContentsId) => ipcRenderer.invoke('extract-page-content', webContentsId),
  extractPageSelection: (webContentsId) => ipcRenderer.invoke('extract-page-selection', webContentsId),
  pageSnapshot: (webContentsId) => ipcRenderer.invoke('page-snapshot', webContentsId),
  browserAction: (params) => ipcRenderer.invoke('browser-action', params),

  contextGraph: (payload) => ipcRenderer.invoke('context-graph', payload),
  workspace: (payload) => ipcRenderer.invoke('workspace', payload),
  mcpConfig: (payload) => ipcRenderer.invoke('mcp-config', payload),
  proactiveTick: (payload) => ipcRenderer.invoke('proactive-tick', payload),
  ledgerExport: () => ipcRenderer.invoke('ledger-export'),

  getMemoryInfo: () => ipcRenderer.invoke('get-memory-info'),
  openDevtoolsActive: (webContentsId) => ipcRenderer.invoke('open-devtools-active', webContentsId),

  detectBrowsers: () => ipcRenderer.invoke('detect-browsers'),
  importBookmarks: (browserPath) => ipcRenderer.invoke('import-bookmarks', browserPath),

  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),

  showWebviewContextMenu: (params) => ipcRenderer.invoke('show-webview-context-menu', params),

  onOpenUrlInNewTab: (callback) => {
    const handler = (_, url) => callback(url);
    ipcRenderer.on('open-url-in-new-tab', handler);
    return () => ipcRenderer.removeListener('open-url-in-new-tab', handler);
  },

  clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),

  getIntroVideoUrl: () => ipcRenderer.invoke('get-intro-video-url'),

  liveConnectorData: (payload) => ipcRenderer.invoke('live-connector-data', payload),

  connectorSaveKey: (serviceId, apiKey) => ipcRenderer.invoke('connector-save-key', { serviceId, apiKey }),
  connectorGetKeys: () => ipcRenderer.invoke('connector-get-keys'),
  connectorRemoveKey: (serviceId) => ipcRenderer.invoke('connector-remove-key', { serviceId }),
  connectorQuery: (serviceId, query, options) => ipcRenderer.invoke('connector-query', { serviceId, query, options }),

  scanEmailInbox: (webContentsId) => ipcRenderer.invoke('scan-email-inbox', { webContentsId }),

  // OAuth 2.0 — "Sign in with Google / Microsoft / etc." flow
  oauthConnect: (providerId) => ipcRenderer.invoke('oauth-connect', { providerId }),
  oauthDisconnect: (providerId) => ipcRenderer.invoke('oauth-disconnect', { providerId }),
  oauthStatus: () => ipcRenderer.invoke('oauth-status'),
  oauthProvidersConfig: () => ipcRenderer.invoke('oauth-providers-config')
});
