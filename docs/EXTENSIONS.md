# Extensions in Navio

Navio loads **unpacked Manifest V3** extensions via Electron `session.loadExtension` on the `persist:navio` partition. You can:

- **Load unpacked…** (folder) from **Settings → Browser**.
- **Install from Chrome Web Store ID** — paste the 32-character id from the store URL; the app downloads the `.crx`, extracts the ZIP payload, and loads it (many extensions still fail in Electron; errors are shown in an alert).

Optional **toolbar** buttons in the navbar open `default_popup` when the manifest defines one; **Options** opens `options_page` / `options_ui.page` when present.

The section below defines a **target** `navio.*` manifest shape for future tighter integration.

## Principles

1. **AI access is off by default** — extensions cannot read assistant history or inject into model context unless the user enables **Allow extensions to use AI** in Settings.
2. **Capabilities are declared** — each extension lists `navio.permissions` (read tabs, modify page, native hooks).
3. **Isolated worlds** — content scripts do not share JS context with the page; assistant context is brokered only through the main process.

## Example manifest fragment (future)

```json
{
  "manifest_version": 3,
  "name": "Example",
  "navio": {
    "permissions": ["activeTab"],
    "aiAccess": false
  }
}
```

## Migration

Bookmark import from Chromium-based browsers is supported ([electron/main.js](../electron/main.js)). Full extension migration is out of scope until a loader exists.
