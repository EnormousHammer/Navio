# Extension capability model (Phase 7)

Navio does not yet load Chrome Web Store extensions. This document defines the **target** manifest so future work stays consistent.

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
