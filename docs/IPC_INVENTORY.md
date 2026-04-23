# IPC inventory (main process handlers)

Channels exposed via `ipcMain.handle` (and closely related patterns). Callers are expected to be the **trusted shell preload** (`electron/preload.js`) unless noted. Webview-specific handlers take a `webContentsId` and must validate ownership where applicable.

> **Note:** `electron/main.js` also registers many handlers in one file; smaller modules group related surface area.

## By module

### `electron/main.js` (representative groups)

| Channel | Purpose / sensitivity |
|---------|------------------------|
| `get-config`, `save-config` | Preferences; API key handling via secure side paths. |
| `navio-internal-chat-page-url` | Returns internal `file:` URL for AI tab. |
| `navio-report-diagnostics` | Optional Sentry forwarding; rate-limited. |
| `app-check-for-updates`, `app-get-update-status`, `app-install-update` | Auto-update control. |
| `get-api-key-for-settings` | Returns key for Settings UI only. |
| `clear-browsing-data` | Clears session data. |
| `get-memory-info` | Local diagnostics. |
| `open-devtools-active` | Opens DevTools for a webContents. |
| `memory-*` | Browser Memory CRUD. |
| `ai-request`, `ai-abort`, `ai-request-stream`, `ai-request-with-tools` | **High** — outbound AI; keys in main. |
| `extract-page-content`, `extract-page-selection`, `page-snapshot` | Page content extraction for AI/automation. |
| `deep-research` | Long-running research flow. |
| `navio-stt`, `navio-tts` | Speech APIs. |
| `ollama-detect` | Local Ollama discovery. |
| `workflow-*` | Saved workflow persistence. |
| `replace-selection-in-page`, `webview-paste-clipboard` | **Medium** — mutates guest page via webContentsId. |
| `browser-action` | **High** — navigation/UI automation; uses `userConfirmed` for sensitive tiers. |
| `context-graph`, `assistant-chat-*`, `workspace`, `proactive-tick`, `live-connector-data` | Assistant / workspace / connectors. |
| `ledger-export` | Exports AI action metadata. |
| `oauth-*` | OAuth connect/disconnect/status. |
| `connector-*` | Third-party API keys and queries (Perplexity, etc.). |
| `imap-*` | IMAP mail operations. |
| `ntp-*`, `streamed-pk-api` | NTP widgets / sports API. |
| `gmail-*`, `scan-email-inbox` | Gmail and inbox helpers. |
| `detect-browsers`, `import-bookmarks` | Migration. |
| `reading-list-*` | Reading list. |
| `passwords-*` | **High** — local password vault. |
| `show-webview-context-menu` | Context menu for webview. |

### `electron/bookmarks-ipc.js`

| `bookmarks-get`, `bookmarks-add`, `bookmarks-update`, `bookmarks-remove`, `bookmarks-reorder`, `bookmarks-migrate-imported` | Bookmark tree. |

### `electron/history-ipc.js`

| `history-get`, `history-add`, `history-search`, `history-remove`, `history-clear` | History store. |

### `electron/file-ipc.js`

| `get-downloads-path`, `open-downloads-folder`, `show-in-folder`, `open-file-path`, `navio-path-to-file-url` | **Medium** — filesystem paths; validate before open. |

### `electron/webview-actions-ipc.js`

| `webview-find-in-page`, `webview-stop-find-in-page`, `webview-print`, `webview-set-zoom`, `webview-get-zoom`, `window-set-fullscreen`, `window-is-fullscreen`, `webview-get-nav-history`, `webview-goto-nav-index`, `capture-screen`, `capture-screen-sources` | Webview/window controls; screen capture is sensitive. |

### `electron/session-setup.js`

| `navio-register-guest-download-shell`, `navio-unregister-guest-download-shell`, `cancel-download`, `pause-download`, `resume-download`, `retry-download`, `open-external`, `navio-site-popups-*`, `set-ad-blocker`, `get-ad-block-stats` | Downloads, pop-up prefs, ad blocking. |

### `electron/extensions-ipc.js`

| `extensions-list`, `extensions-load-unpacked`, `extensions-remove`, `extensions-set-enabled`, `extensions-install-crx-id`, `extensions-open-popup`, `extensions-open-options` | **High** — extension lifecycle; extension windows may differ from shell hardening. |

### `electron/navio-sync-ipc.js`

| `sync-export-profile`, `sync-import-profile`, `sync-pick-folder`, `sync-get-status`, `sync-save-passphrase`, `sync-run-now` | **High** — profile backup/restore. |

### `electron/navio-profiles-ipc.js`

| `profiles-list`, `profiles-set-active`, `profiles-create` | Profile switching (separate userData dirs). |

### `electron/navio-agent-ipc.js`

| `agent-run-plan` | **High** — agent plan execution with `userConfirmed`. |

### `electron/navio-scheduler.js`

| `scheduler-list`, `scheduler-add`, `scheduler-remove`, `scheduler-toggle`, `scheduler-run-now` | Scheduled assistant runs. |

### `electron/navio-mcp.js`

| `mcp-config` | **High** — MCP server configuration and tool exposure. |

## Maintenance

When adding `ipcMain.handle`, append a row here (or in the relevant subsection) with sensitivity and caller expectations.
