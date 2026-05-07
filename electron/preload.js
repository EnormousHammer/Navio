const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navio', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  /** Echo a line to the terminal (main process stdout). For debugging shell UI (e.g. assistant toggle). */
  shellLog: (message) => ipcRenderer.send('navio-shell-log', String(message)),

  // ── Debug log panel ────────────────────────────────────────────────────────
  /** Subscribe to live log entries pushed from the main process. Returns an unsubscribe fn. */
  onLogEntry: (callback) => {
    const h = (_, entry) => { try { callback(entry); } catch { /* ignore */ } };
    ipcRenderer.on('navio-log-entry', h);
    return () => ipcRenderer.removeListener('navio-log-entry', h);
  },
  /** Fetch the most recent N log entries persisted on disk. */
  getRecentLogs: (n) => ipcRenderer.invoke('navio-log-get-recent', n || 200),
  /** Get the absolute path to the log file (for "open in folder" button). */
  getLogPath: () => ipcRenderer.invoke('navio-log-get-path'),
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * User-Agent for tab guests — read from the same session as partition persist:navio / incognito.
   * Must align with session-setup Sec-CH-UA overrides (shell navigator.userAgent can differ).
   * @param {boolean} [incognito]
   */
  getGuestUserAgentSync: (incognito) => {
    try {
      const v = ipcRenderer.sendSync('navio-guest-user-agent-sync', !!incognito);
      return typeof v === 'string' && v.trim() ? v.trim() : '';
    } catch {
      return '';
    }
  },
  onWindowStateChanged: (callback) => {
    ipcRenderer.on('window-state-changed', (_, state) => callback(state));
  },

  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_, action) => callback(action));
  },

  getConfig: () => ipcRenderer.invoke('get-config'),
  /** file:// URL of the full-page in-tab AI chat (Navio AI tab). */
  getInternalChatPageUrl: () => ipcRenderer.invoke('navio-internal-chat-page-url'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getApiKeyForSettings: () => ipcRenderer.invoke('get-api-key-for-settings'),
  /** Returns 'openai' | 'anthropic' | 'google' | null from common key prefixes. */
  inferAiProviderFromApiKey: (key) => ipcRenderer.invoke('infer-ai-provider-from-key', key),

  /** Opt-in diagnostics: forwards to main Sentry only when enabled and DSN configured. */
  reportDiagnosticsError: (payload) =>
    ipcRenderer.invoke('navio-report-diagnostics', {
      message: String(payload && payload.message != null ? payload.message : ''),
      stack: payload && typeof payload.stack === 'string' ? payload.stack : ''
    }),

  aiRequest: (params) => ipcRenderer.invoke('ai-request', params),
  aiRequestStream: (params) => ipcRenderer.invoke('ai-request-stream', params),
  /** Abort in-flight AI for a tab (`{ tabId }`) or all tabs for this window if omitted. */
  aiAbort: (payload) => ipcRenderer.invoke('ai-abort', payload || {}),
  /** When storage key changes mid-turn (tab joined a workspace group), map abort id so Stop still targets the same run. */
  aiAbortTabIdAlias: (payload) => ipcRenderer.invoke('ai-abort-tab-id-alias', payload || {}),
  aiRequestWithTools: (params) => ipcRenderer.invoke('ai-request-with-tools', params),
  onToolProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-progress', handler);
    return () => ipcRenderer.removeListener('tool-progress', handler);
  },
  onToolNavigate: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-navigate', handler);
    return () => ipcRenderer.removeListener('tool-navigate', handler);
  },
  toolNavigateAck: (result) => ipcRenderer.send('tool-navigate-ack', result),

  // Tab management tool events (agent → renderer → ack)
  onToolOpenTab: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-open-tab', handler);
    return () => ipcRenderer.removeListener('tool-open-tab', handler);
  },
  toolOpenTabAck: (result) => ipcRenderer.send('tool-open-tab-ack', result),
  onToolCloseTab: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-close-tab', handler);
    return () => ipcRenderer.removeListener('tool-close-tab', handler);
  },
  toolCloseTabAck: (result) => ipcRenderer.send('tool-close-tab-ack', result),
  onToolSwitchTab: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-switch-tab', handler);
    return () => ipcRenderer.removeListener('tool-switch-tab', handler);
  },
  toolSwitchTabAck: (result) => ipcRenderer.send('tool-switch-tab-ack', result),
  onToolListTabs: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-list-tabs', handler);
    return () => ipcRenderer.removeListener('tool-list-tabs', handler);
  },
  toolListTabsAck: (result) => ipcRenderer.send('tool-list-tabs-ack', result),
  onToolSplitTabs: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-split-tabs', handler);
    return () => ipcRenderer.removeListener('tool-split-tabs', handler);
  },
  toolSplitTabsAck: (result) => ipcRenderer.send('tool-split-tabs-ack', result),

  // Tool reasoning (intermediate AI thinking during tool loop)
  onToolReasoning: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-reasoning', handler);
    return () => ipcRenderer.removeListener('tool-reasoning', handler);
  },

  // Planning mode (propose_plan tool → user approval)
  onToolProposePlan: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-propose-plan', handler);
    return () => ipcRenderer.removeListener('tool-propose-plan', handler);
  },
  toolProposePlanAck: (result) => ipcRenderer.send('tool-propose-plan-ack', result),
  onToolGmailSendConfirm: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('tool-gmail-send-confirm', handler);
    return () => ipcRenderer.removeListener('tool-gmail-send-confirm', handler);
  },
  toolGmailSendConfirmAck: (result) => ipcRenderer.send('tool-gmail-send-confirm-ack', result),
  onAiStreamChunk: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('ai-stream-chunk', handler);
    return () => ipcRenderer.removeListener('ai-stream-chunk', handler);
  },
  onAiStreamDone: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('ai-stream-done', handler);
    return () => ipcRenderer.removeListener('ai-stream-done', handler);
  },
  onAiStreamError: (callback) => {
    const handler = (_, payload) => callback(payload);
    ipcRenderer.on('ai-stream-error', handler);
    return () => ipcRenderer.removeListener('ai-stream-error', handler);
  },

  extractPageContent: (webContentsId) => ipcRenderer.invoke('extract-page-content', webContentsId),
  extractPageSelection: (webContentsId) => ipcRenderer.invoke('extract-page-selection', webContentsId),
  pageSnapshot: (webContentsId) => ipcRenderer.invoke('page-snapshot', webContentsId),
  browserAction: (params) => ipcRenderer.invoke('browser-action', params),

  deepResearch: (params) => ipcRenderer.invoke('deep-research', params),
  workflowSave: (params) => ipcRenderer.invoke('workflow-save', params),
  workflowList: () => ipcRenderer.invoke('workflow-list'),
  workflowLoad: (params) => ipcRenderer.invoke('workflow-load', params),
  workflowDelete: (params) => ipcRenderer.invoke('workflow-delete', params),
  /** Packaged app: ask main to check electron-updater (requires publish URL in shipped build). */
  checkForUpdates: () => ipcRenderer.invoke('app-check-for-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('app-get-update-status'),
  installUpdate: () => ipcRenderer.invoke('app-install-update'),
  onUpdateStatusChanged: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch { /* ignore */ } };
    ipcRenderer.on('update-status-changed', handler);
    return () => { try { ipcRenderer.removeListener('update-status-changed', handler); } catch { /* ignore */ } };
  },

  // Scheduler (recurring workflows)
  schedulerList: () => ipcRenderer.invoke('scheduler-list'),
  schedulerAdd: (params) => ipcRenderer.invoke('scheduler-add', params),
  schedulerRemove: (params) => ipcRenderer.invoke('scheduler-remove', params),
  schedulerToggle: (params) => ipcRenderer.invoke('scheduler-toggle', params),
  schedulerRunNow: (params) => ipcRenderer.invoke('scheduler-run-now', params),
  onScheduledWorkflowRun: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('scheduled-workflow-run', handler);
    return () => ipcRenderer.removeListener('scheduled-workflow-run', handler);
  },
  replaceSelectionInPage: (params) => ipcRenderer.invoke('replace-selection-in-page', params),
  webviewPasteClipboard: (params) => ipcRenderer.invoke('webview-paste-clipboard', params),

  contextGraph: (payload) => ipcRenderer.invoke('context-graph', payload),
  assistantChatLoad: () => ipcRenderer.invoke('assistant-chat-load'),
  assistantChatSave: (payload) => ipcRenderer.invoke('assistant-chat-save', payload),
  getPopupWindows: () => ipcRenderer.invoke('get-popup-windows'),
  focusPopupWindow: (popupId) => ipcRenderer.invoke('focus-popup-window', { popupId }),
  workspace: (payload) => ipcRenderer.invoke('workspace', payload),
  mcpConfig: (payload) => ipcRenderer.invoke('mcp-config', payload),
  proactiveTick: (payload) => ipcRenderer.invoke('proactive-tick', payload),
  ledgerExport: () => ipcRenderer.invoke('ledger-export'),

  navioTTS: (params) => ipcRenderer.invoke('navio-tts', params),
  navioSTT: (params) => ipcRenderer.invoke('navio-stt', params),

  getMemoryInfo: () => ipcRenderer.invoke('get-memory-info'),
  openDevtoolsActive: (webContentsId) => ipcRenderer.invoke('open-devtools-active', webContentsId),

  detectBrowsers: () => ipcRenderer.invoke('detect-browsers'),
  importBookmarks: (browserPath) => ipcRenderer.invoke('import-bookmarks', browserPath),

  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),

  showWebviewContextMenu: (params) => ipcRenderer.invoke('show-webview-context-menu', params),

  onOpenUrlInNewTab: (callback) => {
    const handler = (_, payload) => {
      if (typeof payload === 'string') callback(payload, { incognito: false });
      else {
        callback(payload && payload.url, {
          incognito: !!(payload && payload.incognito),
          background: !!(payload && payload.background),
          guestWindowOpen: !!(payload && payload.guestWindowOpen)
        });
      }
    };
    ipcRenderer.on('open-url-in-new-tab', handler);
    return () => ipcRenderer.removeListener('open-url-in-new-tab', handler);
  },

  /**
   * Guest `window.open` tabs that exist only to hit a download URL should close when
   * `will-download` fires (Chrome behavior). Register on dom-ready; main clears on first real load.
   */
  registerGuestDownloadShell: (webContentsId) =>
    ipcRenderer.invoke('navio-register-guest-download-shell', { webContentsId }),
  unregisterGuestDownloadShell: (webContentsId) =>
    ipcRenderer.invoke('navio-unregister-guest-download-shell', { webContentsId }),
  onCloseDownloadShellTab: (callback) => {
    const h = (_, data) => callback(data || {});
    ipcRenderer.on('navio-close-download-shell-tab', h);
    return () => ipcRenderer.removeListener('navio-close-download-shell-tab', h);
  },

  clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),

  getIntroVideoUrl: () => ipcRenderer.invoke('get-intro-video-url'),
  searchSuggestions: (q, searchEngine) => ipcRenderer.invoke('search-suggestions', { q, searchEngine }),
  /** file:// URL passed to `<webview preload>` so guest scripts always load (password save, etc.). */
  getWebviewGuestPreloadHref: () => ipcRenderer.invoke('navio-webview-guest-preload-href'),

  liveConnectorData: (payload) => ipcRenderer.invoke('live-connector-data', payload),

  connectorSaveKey: (serviceId, apiKey) => ipcRenderer.invoke('connector-save-key', { serviceId, apiKey }),
  connectorGetKeys: () => ipcRenderer.invoke('connector-get-keys'),
  connectorRemoveKey: (serviceId) => ipcRenderer.invoke('connector-remove-key', { serviceId }),
  connectorQuery: (serviceId, query, options) => ipcRenderer.invoke('connector-query', { serviceId, query, options }),

  scanEmailInbox: (webContentsId) => ipcRenderer.invoke('scan-email-inbox', { webContentsId }),

  // OAuth 2.0 — "Sign in with Google / Microsoft / etc." flow
  gmailSendDraft: (draftId) => ipcRenderer.invoke('gmail-send-draft', { draftId }),
  gmailUpdateDraft: (payload) => ipcRenderer.invoke('gmail-update-draft', payload),
  gmailGetSignaturePlain: () => ipcRenderer.invoke('gmail-get-signature-plain'),
  gmailDeleteDraft: (draftId) => ipcRenderer.invoke('gmail-delete-draft', { draftId }),
  oauthConnect: (providerId) => ipcRenderer.invoke('oauth-connect', { providerId }),
  oauthDisconnect: (providerId) => ipcRenderer.invoke('oauth-disconnect', { providerId }),
  oauthGetConnectedAccounts: () => ipcRenderer.invoke('oauth-get-connected-accounts'),
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
  imapMarkRead:         (serviceId, uid) => ipcRenderer.invoke('imap-mark-read', { serviceId, uid }),
  imapTrashMessage:     (serviceId, uid) => ipcRenderer.invoke('imap-trash-message', { serviceId, uid }),
  gmailModifyMessage:   (id, addLabelIds, removeLabelIds, serviceId) => ipcRenderer.invoke('gmail-modify-message', { id, addLabelIds, removeLabelIds, serviceId }),
  gmailTrashMessage:    (id, serviceId) => ipcRenderer.invoke('gmail-trash-message', { id, serviceId }),
  gmailGetMessageBody: (idOrOpts) =>
    ipcRenderer.invoke(
      'gmail-get-message-body',
      typeof idOrOpts === 'string' ? { id: idOrOpts } : idOrOpts && typeof idOrOpts === 'object' ? idOrOpts : { id: idOrOpts }
    ),
  gmailCreateReplyDraft: (payload)      => ipcRenderer.invoke('gmail-create-reply-draft', payload),
  ntpFetchStocks: () => ipcRenderer.invoke('ntp-stocks'),
  ntpFetchSports: () => ipcRenderer.invoke('ntp-sports'),
  ntpGmailInbox: () => ipcRenderer.invoke('ntp-gmail-inbox'),
  /** Proxied JSON from https://streamed.pk/api/{path} — path e.g. sports | matches/football | stream/source/id */
  streamedPkApi: (path) => ipcRenderer.invoke('streamed-pk-api', { path }),

  setAdBlocker: (enabled) => ipcRenderer.invoke('set-ad-blocker', { enabled }),
  getAdBlockStats: () => ipcRenderer.invoke('get-ad-block-stats'),
  /**
   * Returns true if this new-window request should be blocked (blocklist and/or strict pop-up rules).
   * @param {{ url?: string, disposition?: string, optionsWidth?: number, optionsHeight?: number }} payload
   */
  evalPopupBlock: (payload) => ipcRenderer.sendSync('navio-eval-popup-block', payload || {}),

  onPopupBlocked: (callback) => {
    const handler = (_, data) => callback(data || {});
    ipcRenderer.on('navio-popup-blocked', handler);
    return () => ipcRenderer.removeListener('navio-popup-blocked', handler);
  },

  onPopupWindow: (callback) => {
    const handler = (_, data) => callback(data || {});
    ipcRenderer.on('navio-popup-window', handler);
    return () => ipcRenderer.removeListener('navio-popup-window', handler);
  },
  sitePopupsSet: (origin, allowed) =>
    ipcRenderer.invoke('navio-site-popups-set', { origin: String(origin || ''), allowed: !!allowed }),
  sitePopupsGet: (origin) => ipcRenderer.invoke('navio-site-popups-get', { origin: String(origin || '') }),

  // Per-site Compatibility Mode (kill switch for in-page Navio injections —
  // selection toolbar, password autofill detection, login form observer, etc.).
  // Toggle this for sites that misbehave when Navio's preload runs (carrier
  // portals, banking, gov forms, Cloudflare-protected SPAs, etc.).
  siteCompatList: () => ipcRenderer.invoke('navio-site-compat-list'),
  siteCompatGet: (url) => ipcRenderer.invoke('navio-site-compat-get', { url: String(url || '') }),
  siteCompatSet: (url, enabled) =>
    ipcRenderer.invoke('navio-site-compat-set', { url: String(url || ''), enabled: !!enabled }),
  siteCompatToggle: (url) => ipcRenderer.invoke('navio-site-compat-toggle', { url: String(url || '') }),
  onSiteCompatChanged: (cb) => {
    const h = (_, d) => cb(d || {});
    ipcRenderer.on('navio-site-compat-changed', h);
    return () => ipcRenderer.removeListener('navio-site-compat-changed', h);
  },

  // Browser Memory
  memoryGet: () => ipcRenderer.invoke('memory-get'),
  memoryAdd: (content) => ipcRenderer.invoke('memory-add', { content }),
  memoryDelete: (id) => ipcRenderer.invoke('memory-delete', { id }),
  memoryClear: () => ipcRenderer.invoke('memory-clear'),

  // External protocol handler — opens mailto:, tel:, sms: in the OS default app
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Cancel an in-progress download (matches save path from download-started). */
  cancelDownload: (savePath) => ipcRenderer.invoke('cancel-download', savePath),
  /** Pause an in-progress download (resumable only). */
  pauseDownload:  (savePath) => ipcRenderer.invoke('pause-download',  savePath),
  /** Resume a paused download. */
  resumeDownload: (savePath) => ipcRenderer.invoke('resume-download', savePath),
  /** Re-issue a download for a failed / cancelled URL (main spawns a fresh DownloadItem). */
  retryDownload:  (payload)  => ipcRenderer.invoke('retry-download',  payload),

  // Reveal a downloaded file in the OS file manager (Explorer / Finder)
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  /** Open a file with the default application (shell.openPath). */
  openFilePath: (filePath) => ipcRenderer.invoke('open-file-path', filePath),
  /** Stable file:// URL for a local path (open downloads in a tab). */
  pathToFileUrl: (filePath) => ipcRenderer.invoke('navio-path-to-file-url', filePath),
  /** When a dropped File has size 0 but Electron set `path` (e.g. Windows Explorer / Downloads). */
  readFileForAttachment: (filePath) => ipcRenderer.invoke('read-file-for-attachment', filePath),
  /** Extract readable text from an office document (DOCX, XLSX, PPTX, RTF, ODT…) given its bytes as base64. */
  extractAttachmentText: (args) => ipcRenderer.invoke('extract-attachment-text', args),

  // Reading List ("save for later")
  readingListAdd:      (url, title, favicon) => ipcRenderer.invoke('reading-list-add', { url, title, favicon }),
  readingListGet:      ()                    => ipcRenderer.invoke('reading-list-get'),
  readingListRemove:   (url)                 => ipcRenderer.invoke('reading-list-remove', { url }),
  readingListMarkRead: (url)                 => ipcRenderer.invoke('reading-list-mark-read', { url }),

  // Password manager (safeStorage-encrypted vault)
  passwordsSave:      (url, username, password, hidden) =>
    ipcRenderer.invoke('passwords-save', { url, username, password, hidden }),
  passwordsList:      ()                        => ipcRenderer.invoke('passwords-list'),
  passwordsGet:       (url)                     => ipcRenderer.invoke('passwords-get', { url }),
  passwordsReveal:    (origin, username)        => ipcRenderer.invoke('passwords-reveal', { origin, username }),
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
  },

  bookmarksGet: () => ipcRenderer.invoke('bookmarks-get'),
  bookmarksAdd: (payload) => ipcRenderer.invoke('bookmarks-add', payload),
  bookmarksUpdate: (payload) => ipcRenderer.invoke('bookmarks-update', payload),
  bookmarksRemove: (id) => ipcRenderer.invoke('bookmarks-remove', { id }),
  bookmarksReorder: (payload) => ipcRenderer.invoke('bookmarks-reorder', payload),
  bookmarksMigrateImported: () => ipcRenderer.invoke('bookmarks-migrate-imported'),
  bookmarksPatchFaviconForUrl: (payload) => ipcRenderer.invoke('bookmarks-patch-favicon-for-url', payload),

  historyGet: () => ipcRenderer.invoke('history-get'),
  historyAdd: (payload) => ipcRenderer.invoke('history-add', payload),
  historyPatchFavicon: (payload) => ipcRenderer.invoke('history-patch-favicon', payload),
  historySearch: (query, limit) => ipcRenderer.invoke('history-search', { query, limit }),
  historyRemove: (id) => ipcRenderer.invoke('history-remove', { id }),
  historyClear: () => ipcRenderer.invoke('history-clear'),

  webviewFindInPage: (webContentsId, text, options) =>
    ipcRenderer.invoke('webview-find-in-page', { webContentsId, text, options }),
  webviewStopFindInPage: (webContentsId, action) =>
    ipcRenderer.invoke('webview-stop-find-in-page', { webContentsId, action }),
  webviewPrint: (webContentsId) => ipcRenderer.invoke('webview-print', { webContentsId }),
  webviewSetZoom: (webContentsId, factor) => ipcRenderer.invoke('webview-set-zoom', { webContentsId, factor }),
  webviewGetZoom: (webContentsId) => ipcRenderer.invoke('webview-get-zoom', { webContentsId }),
  webviewGetNavHistory: (webContentsId, direction, max) =>
    ipcRenderer.invoke('webview-get-nav-history', { webContentsId, direction, max }),
  webviewGotoNavIndex: (webContentsId, index) =>
    ipcRenderer.invoke('webview-goto-nav-index', { webContentsId, index }),
  captureScreen: (opts) => ipcRenderer.invoke('capture-screen', opts || {}),
  captureScreenSources: (opts) => ipcRenderer.invoke('capture-screen-sources', opts || {}),
  onFoundInPageResult: (cb) => {
    const h = (_, d) => cb(d);
    ipcRenderer.on('found-in-page-result', h);
    return () => ipcRenderer.removeListener('found-in-page-result', h);
  },
  windowSetFullscreen: (fullscreen) => ipcRenderer.invoke('window-set-fullscreen', { fullscreen }),
  windowIsFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),

  extensionsList: () => ipcRenderer.invoke('extensions-list'),
  extensionsLoadUnpacked: () => ipcRenderer.invoke('extensions-load-unpacked'),
  extensionsRemove: (extensionId) => ipcRenderer.invoke('extensions-remove', { extensionId }),
  extensionsSetEnabled: (extensionId, enabled) =>
    ipcRenderer.invoke('extensions-set-enabled', { extensionId, enabled }),
  extensionsInstallCrxId: (extensionId) => ipcRenderer.invoke('extensions-install-crx-id', { extensionId }),
  extensionsOpenPopup: (extensionId) => ipcRenderer.invoke('extensions-open-popup', { extensionId }),
  extensionsOpenOptions: (extensionId) => ipcRenderer.invoke('extensions-open-options', { extensionId }),

  memorySearch: (query) => ipcRenderer.invoke('memory-search', { query }),

  agentRunPlan: (payload) => ipcRenderer.invoke('agent-run-plan', payload),

  /** Plaintext JSON: config, API keys, connectors, OAuth, IMAP, password vault, bookmarks, … */
  exportFullMigration: () => ipcRenderer.invoke('navio-export-full-migration'),

  syncExportProfile: (opts) => ipcRenderer.invoke('sync-export-profile', opts || {}),
  syncImportProfile: (opts) => ipcRenderer.invoke('sync-import-profile', opts || {}),
  syncPickFolder: () => ipcRenderer.invoke('sync-pick-folder'),
  syncGetStatus: () => ipcRenderer.invoke('sync-get-status'),
  syncSavePassphrase: (opts) => ipcRenderer.invoke('sync-save-passphrase', opts || {}),
  syncRunNow: () => ipcRenderer.invoke('sync-run-now'),
  onSyncEvent: (cb) => {
    ipcRenderer.on('navio-sync-event', (_, payload) => {
      try {
        cb(payload);
      } catch (_) {}
    });
  },

  profilesList: () => ipcRenderer.invoke('profiles-list'),
  profilesSetActive: (profileId) => ipcRenderer.invoke('profiles-set-active', { profileId }),
  profilesCreate: (profileId) => ipcRenderer.invoke('profiles-create', { profileId }),

  ollamaDetect: () => ipcRenderer.invoke('ollama-detect'),

  // ── WebContentsView tab management (Phase 1 migration) ──────────────────────
  // The WebviewShim in src/js/wcv-webview-shim.js uses these to route all
  // webview method calls to the main process tab-manager.js.

  /** Create a WCV tab synchronously — returns { tabId, webContentsId }. */
  wcvCreateTab: (opts) => ipcRenderer.sendSync('wcv-create-tab', opts || {}),

  wcvSwitchTab: (tabId) => ipcRenderer.send('wcv-switch-tab', tabId),
  wcvCloseTab: (tabId) => ipcRenderer.send('wcv-close-tab', tabId),

  wcvNavigate: (tabId, url) => ipcRenderer.send('wcv-navigate', { tabId, url }),
  wcvGoBack: (tabId) => ipcRenderer.send('wcv-go-back', tabId),
  wcvGoForward: (tabId) => ipcRenderer.send('wcv-go-forward', tabId),
  wcvReload: (tabId, ignoreCache) => ipcRenderer.send('wcv-reload', { tabId, ignoreCache: !!ignoreCache }),
  wcvStop: (tabId) => ipcRenderer.send('wcv-stop', tabId),
  wcvFocus: (tabId) => ipcRenderer.send('wcv-focus', tabId),
  wcvSetMuted: (tabId, muted) => ipcRenderer.send('wcv-set-muted', { tabId, muted }),

  /**
   * Update the WCV bounds from the renderer's layout computation.
   * Called by WebviewShim's style proxy whenever _syncWebviewSizes changes the bounds.
   */
  wcvSetBounds: (tabId, bounds) => ipcRenderer.send('wcv-set-bounds', { tabId, bounds }),

  /**
   * Re-stack the shell WebContentsView above tab WebContentsViews.
   * Call after UI interactions that open overlays (WCV guests otherwise paint on top).
   */
  wcvEnsureShellOnTop: () => ipcRenderer.send('wcv-ensure-shell-on-top'),

  wcvDiscardTab: (tabId) => ipcRenderer.send('wcv-discard-tab', tabId),
  wcvRestoreTab: (tabId) => ipcRenderer.send('wcv-restore-tab', tabId),

  /** Synchronous URL read (for getURL() in shim). */
  wcvGetUrl: (tabId) => ipcRenderer.sendSync('wcv-get-url', tabId),
  /** Synchronous nav-state reads (for canGoBack/Forward). */
  wcvCanGoBack: (tabId) => ipcRenderer.sendSync('wcv-can-go-back', tabId),
  wcvCanGoForward: (tabId) => ipcRenderer.sendSync('wcv-can-go-forward', tabId),

  /**
   * Listen for navigation/lifecycle events pushed from main for ALL tabs.
   * Each event: { tabId, type, ...payload }
   */
  onWcvTabEvent: (callback) => {
    const handler = (_, data) => { try { callback(data); } catch { /* ignore */ } };
    ipcRenderer.on('wcv-tab-event', handler);
    return () => ipcRenderer.removeListener('wcv-tab-event', handler);
  },

  /**
   * Send a message from the renderer shell to a specific WCV tab's preload
   * (replaces webview.send(channel, ...args) in classic webview mode).
   */
  wcvSendToTab: (tabId, channel, ...args) =>
    ipcRenderer.send('wcv-send-to-tab', { tabId, channel, args }),

  /** Run JS in a WCV tab's page (replaces `<webview>.executeJavaScript` for WebviewShim). */
  wcvExecuteJavaScript: (tabId, code) => ipcRenderer.invoke('wcv-execute-javascript', { tabId, code })
});
