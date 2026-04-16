# Navio

Futuristic AI-powered Chromium browser. Intelligence meets the internet.

## Navio vs Chrome (honest comparison)

Navio is built on **Electron and Chromium**, so core browsing (tabs, rendering, many sites) feels familiar. It is **not** a Google Chrome distribution: there is **no Chrome sync** (passwords, tabs, history across devices via Google), **no Google Safe Browsing** binary feed as shipped in Chrome, and **extension support is best-effort** (Manifest V3 unpacked / store ID install; many store extensions rely on APIs or behaviors Electron does not mirror). Navio adds a **local-first AI assistant** and connectors (where you attach keys and OAuth) without sending your keys to Navio’s servers. For day-to-day trade-offs and manual verification, see [docs/SMOKE.md](docs/SMOKE.md) and [docs/TRUE_BROWSER_IMPLEMENTATION_PLAN.md](docs/TRUE_BROWSER_IMPLEMENTATION_PLAN.md).

## Features

- **Navio AI** - Built-in assistant that reads, understands, and interacts with any web page
- **Multi-Provider** - OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint (bring your own key)
- **Premium Dark UI** - Futuristic glass-morphism design with electric cyan-to-violet accents
- **Tab Management** - Sidebar-based tabs with favicons, live loading indicators, and **rename** (double-click the tab title or use the tab context menu)
- **Smart Navigation** - URL bar detects URLs vs search queries automatically
- **Keyboard Driven** - Full shortcut support for power users
- **Ad Blocking** - Built-in blocking of ad network requests, ad URLs in new windows, and optional **strict** blocking of small script-driven pop-ups (OAuth-aware heuristics)
- **Page Intelligence** - AI reads headings, links, forms, and full text content
- **Privacy** - API keys stay local, zero telemetry

## Quick Start

```bash
npm install
npm start
```

## Desktop app (install on other Windows PCs)

Navio is packaged with **Electron Forge**. On this machine, a full build is:

```bash
npm install
npm run build
```

Artifacts (64-bit Windows):

| Output | Path | Use |
|--------|------|-----|
| **Installer** | `out/make/squirrel.windows/x64/Navio-1.0.0 Setup.exe` | Run on each PC to install (Start menu, auto-updater friendly). |
| **Portable ZIP** | `out/make/zip/win32/x64/Navio-win32-x64-1.0.0.zip` | Unzip anywhere and run `navio-browser.exe` — good for USB or “no installer” machines. |
| **Unpacked folder** | `out/Navio-win32-x64/` | Copy the whole folder to another PC (same as ZIP, but not compressed). |

Copy the **Setup.exe** or **ZIP** to a USB drive or cloud share; each target PC must match **Windows x64**. Building for macOS or Linux requires running `npm run build` on those platforms (Forge makers are configured per OS).

## AI Setup

1. Launch Navio
2. Open **Settings** (gear icon, sidebar)
3. Choose provider, enter API key, select model
4. Save and press **Ctrl+Shift+A** to summon Navio AI

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+L` | Focus URL bar |
| `Ctrl+Shift+A` | Toggle AI assistant |
| `Ctrl+Shift+S` | Toggle sidebar |

## Stack

- **Electron** (Chromium engine)
- **Vanilla JS** (zero-framework for speed)
- **CSS Custom Properties** (full design system)

## License

MIT
