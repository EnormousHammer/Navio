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

## Troubleshooting (top failure modes)

These are the usual reasons an extension **installs but seems dead**, or behaves differently than in Google Chrome:

1. **Incomplete `chrome.*` APIs** — Electron implements a subset. Extensions that depend on missing APIs may fail silently or only log errors in their service worker (not always visible in Navio).
2. **MV3 service worker assumptions** — Background logic may expect Chrome’s event or lifetime model; subtle differences can stop updates or messaging.
3. **Native messaging / host apps** — Extensions that talk to a companion executable are not supported.
4. **Chrome enterprise / policy features** — Not available; extensions that require managed policy will not work.
5. **Content script isolation** — Scripts cannot read page JavaScript variables; DOM-only access matches Chrome, but anything that expects shared JS context will fail.
6. **Permissions prompts** — Some permission flows differ; use **Popup** and **Options** from **Settings → Browser** when the manifest defines them.
7. **Web Store `.crx` install** — Navio unpacks the ZIP payload from Google’s update endpoint; if the CRX format or signing changes, install can fail (an alert should explain).

**What to try:** **Load unpacked** from a local folder, watch for alerts on load, toggle the extension **On** in the list, and exercise **Popup** / **Options**. For built-in blocking, use **Privacy** settings instead of a store ad-blocker.

In the app, **Settings → Browser → Extension troubleshooting** summarizes this in the UI.
