# Navio privacy overview

This document describes what Navio stores locally, what may leave your device, and how to control it. It is not a substitute for legal counsel; adjust or host a lawyer-reviewed policy if you distribute Navio commercially.

## Data that stays on this device

- **Browser profile** — cookies, cache, local storage, and site data for pages you visit (standard Chromium/Electron behavior).
- **Preferences** — stored as JSON in the application user data folder (`navio-config.json`).
- **API keys** — when you enter a provider key in Settings, Navio stores it using the OS keychain where available (Electron `safeStorage`), or a separate local file if encryption is unavailable on your platform.
- **Bookmarks, history, passwords (if you use Navio’s password vault), reading list, workflows, and “Browser Memory”** — persisted under the same user data directory unless you clear them.

Navio does not send your API keys to Navio’s servers (there is no separate Navio cloud for keys).

## Data sent to third parties (by design, when you use features)

- **AI providers** — When you use Navio AI, messages and optional page context are sent to the provider you selected (OpenAI, Anthropic, Google, Ollama, or a custom endpoint), under that provider’s terms and privacy policy.
- **Websites** — Normal browsing traffic goes to the sites you visit, same as any browser.
- **Connectors** — Optional integrations (e.g. Gmail, web search connectors) send only what is needed for that feature to the relevant service, using credentials you configure.
- **Model Context Protocol (MCP)** — If you enable MCP servers, Navio runs those servers as configured; their tools may access local or network resources according to each server’s design.

## Updates

- Installed releases may check **GitHub Releases** (or another feed configured in the build) for newer versions via `electron-updater`. That contact uses HTTPS and does not include your browsing history.

## Optional diagnostics

- If you turn on **Send anonymous crash reports** in Settings **and** the build was configured with a Sentry DSN, uncaught errors may be sent to Sentry. Payloads are minimized; do not rely on this for sensitive data—keep the toggle off if you do not want diagnostics.

## Your controls

- **Settings → Privacy** — Pop-up blocking, ad blocking, clearing browsing data, memory, and diagnostics toggle.
- **Settings → AI** — Kill switch, data scope, PII redaction, and connector behavior.
- **Uninstall** — Remove the app and delete the user data folder if you want to erase local state entirely (path depends on OS; see Electron `userData` documentation).

## Contact

Use the repository issue tracker linked from the project README for security or privacy questions related to this open-source build.
