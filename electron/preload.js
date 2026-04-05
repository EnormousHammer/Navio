const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navio', {
  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onWindowStateChanged: (callback) => {
    ipcRenderer.on('window-state-changed', (_, state) => callback(state));
  },

  // Keyboard shortcuts
  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_, action) => callback(action));
  },

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // AI
  aiRequest: (params) => ipcRenderer.invoke('ai-request', params),

  // Page content extraction
  extractPageContent: (webContentsId) => ipcRenderer.invoke('extract-page-content', webContentsId),

  // Browser automation
  browserAction: (params) => ipcRenderer.invoke('browser-action', params),

  // Downloads
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path')
});
