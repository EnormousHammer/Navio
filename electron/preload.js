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
  oauthProvidersConfig: () => ipcRenderer.invoke('oauth-providers-config'),

  // IMAP — direct email connection, no OAuth/tokens needed
  // Works in background even when no email tab is open
  imapConnect: (serviceId, email, password) => ipcRenderer.invoke('imap-connect', { serviceId, email, password }),
  imapDisconnect: (serviceId) => ipcRenderer.invoke('imap-disconnect', { serviceId }),
  imapStatus: () => ipcRenderer.invoke('imap-status'),
  imapGetUnread: (serviceId, limit) => ipcRenderer.invoke('imap-get-unread', { serviceId, limit }),
  imapSearch: (serviceId, query, limit) => ipcRenderer.invoke('imap-search', { serviceId, query, limit }),
  imapCreateDraft: (serviceId, opts) => ipcRenderer.invoke('imap-create-draft', { serviceId, ...opts }),
  imapGetEmailBody:     (serviceId, uid) => ipcRenderer.invoke('imap-get-email-body', { serviceId, uid }),
  gmailGetMessageBody:  (id)             => ipcRenderer.invoke('gmail-get-message-body', { id }),
  ntpFetchStocks: () => ipcRenderer.invoke('ntp-stocks'),
  ntpFetchSports: () => ipcRenderer.invoke('ntp-sports'),
  ntpGmailInbox: () => ipcRenderer.invoke('ntp-gmail-inbox'),

  setAdBlocker: (enabled) => ipcRenderer.invoke('set-ad-blocker', { enabled }),
  getAdBlockStats: () => ipcRenderer.invoke('get-ad-block-stats'),

  // Browser Memory
  memoryGet: () => ipcRenderer.invoke('memory-get'),
  memoryAdd: (content) => ipcRenderer.invoke('memory-add', { content }),
  memoryDelete: (id) => ipcRenderer.invoke('memory-delete', { id }),
  memoryClear: () => ipcRenderer.invoke('memory-clear'),

  // External protocol handler — opens mailto:, tel:, sms: in the OS default app
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Reveal a downloaded file in the OS file manager (Explorer / Finder)
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),

  // Reading List ("save for later")
  readingListAdd:      (url, title, favicon) => ipcRenderer.invoke('reading-list-add', { url, title, favicon }),
  readingListGet:      ()                    => ipcRenderer.invoke('reading-list-get'),
  readingListRemove:   (url)                 => ipcRenderer.invoke('reading-list-remove', { url }),
  readingListMarkRead: (url)                 => ipcRenderer.invoke('reading-list-mark-read', { url }),

  // Password manager (safeStorage-encrypted vault)
  passwordsSave:      (url, username, password) => ipcRenderer.invoke('passwords-save', { url, username, password }),
  passwordsList:      ()                        => ipcRenderer.invoke('passwords-list'),
  passwordsGet:       (url)                     => ipcRenderer.invoke('passwords-get', { url }),
  passwordsDelete:    (origin, username)        => ipcRenderer.invoke('passwords-delete', { origin, username }),
  passwordsExportCsv: ()                        => ipcRenderer.invoke('passwords-export-csv'),
  passwordsImportCsv: (csv)                     => ipcRenderer.invoke('passwords-import-csv', { csv }),

  // Download lifecycle events pushed from the main process
  onDownloadStarted: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('download-started', h);
    return () => ipcRenderer.removeListener('download-started', h);
  },
  onDownloadProgress: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('download-progress', h);
    return () => ipcRenderer.removeListener('download-progress', h);
  },
  onDownloadDone: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('download-done', h);
    return () => ipcRenderer.removeListener('download-done', h);
  },

  // Certificate warning pushed when a self-signed / untrusted cert is bypassed
  onCertificateWarning: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('certificate-warning', h);
    return () => ipcRenderer.removeListener('certificate-warning', h);
  }
});
