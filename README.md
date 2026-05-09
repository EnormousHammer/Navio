# Navio

Futuristic AI-powered Chromium browser. Intelligence meets the internet.

**Native (non-Electron) follow-on — one file only:** [`NAVIO_NATIVE/README.md`](NAVIO_NATIVE/README.md) *(new chat: read that file end-to-end)*.

## Navio vs Chrome (honest comparison)

Navio is built on **Electron and Chromium**, so core browsing (tabs, rendering, many sites) feels familiar. It is **not** a Google Chrome distribution: there is **no Chrome sync** (passwords, tabs, history across devices via Google), **no Google Safe Browsing** binary feed as shipped in Chrome, and **extension support is best-effort** (Manifest V3 unpacked / store ID install; many store extensions rely on APIs or behaviors Electron does not mirror). Navio adds a **local-first AI assistant** and connectors (where you attach keys and OAuth) without sending your keys to Navio’s servers. For day-to-day trade-offs and manual verification, see [docs/SMOKE.md](docs/SMOKE.md) and [docs/TRUE_BROWSER_IMPLEMENTATION_PLAN.md](docs/TRUE_BROWSER_IMPLEMENTATION_PLAN.md).

## Features

- **Navio AI** - Built-in assistant that reads, understands, and interacts with any web page
- **Multi-Provider** - OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint (bring your own key)
- **Cited web answers out of the box** - `web_search` uses Perplexity when connected, otherwise transparently falls back to the active provider's native web search (OpenAI Responses, Anthropic `web_search_20250305`, or Gemini `google_search`) — same key, no second bill
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
| **Installer** | `out/make/squirrel.windows/x64/Navio-1.0.2 Setup.exe` | Run on each PC to install (Start menu, auto-updater friendly). |
| **Portable ZIP** | `out/make/zip/win32/x64/Navio-win32-x64-1.0.2.zip` | Unzip anywhere and run `navio-browser.exe` — good for USB or “no installer” machines. |
| **Unpacked folder** | `out/Navio-win32-x64/` | Copy the whole folder to another PC (same as ZIP, but not compressed). |

Artifacts (**macOS**, run `npm run build` on a Mac):

| Output | Path | Use |
|--------|------|-----|
| **Disk image (.dmg)** | `out/make/dmg/**/Navio-1.0.2-*.dmg` (path varies by Intel vs Apple Silicon) | Double-click to drag Navio to Applications. |
| **Portable ZIP** | `out/make/zip/darwin/**/Navio-darwin-*.zip` | Unzip and run without installing. |

Copy the **Windows `Setup.exe`** or **macOS `.dmg`** to share installers. Windows builds are **x64** only; mac DMG/ZIP are built per architecture on that machine.

**Releases (CI):** Pushing a tag matching `v*` (after updating `package.json` `version`) runs **Release** (`.github/workflows/release.yml`): test, optional code signing, then **`electron-forge publish`** uploads Windows and macOS assets to a **GitHub Release** for that tag. **One-time repo setup:** GitHub → **Settings** → **Actions** → **General** → **Workflow permissions** → enable **Read and write permissions** so the default `GITHUB_TOKEN` can create releases (see [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md)). Workflow run artifacts are still available as a backup download. **In-app updates** use `electron-updater` against `package.json` → `repository`.

**Releases (GitHub CLI, from your PC):** Install [GitHub CLI](https://cli.github.com/) (`winget install GitHub.cli`), run `gh auth login`, then `npm run release:github` to run `npm run make` and upload `out/make` assets with `gh release create` (see [tools/publish-github-release.ps1](tools/publish-github-release.ps1); use `-SkipMake` / `-VerifyTag` as documented there). **Remove mistaken releases/tags** (e.g. `v1.0.1`, `v1.1.0`): `npm run release:cleanup` after `gh auth login` (see [tools/cleanup-github-releases.ps1](tools/cleanup-github-releases.ps1); override `-Tags` if needed).

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

## Security and privacy (Phase B docs)

- [Threat model](docs/SECURITY_THREAT_MODEL.md) — trust boundaries and main risks.
- [IPC inventory](docs/IPC_INVENTORY.md) — main-process `invoke` channels by module.
- [Updates and releases](docs/UPDATES.md) — GitHub Releases and auto-update expectations.
- [Release signing](docs/RELEASE_SIGNING.md) — Windows and macOS signing/notarization env vars.
- [Privacy overview](docs/PRIVACY.md) — what stays local vs what may leave the device.
- [Third-party notices](docs/THIRD_PARTY_NOTICES.md) — major OSS components (refresh for compliance).

## Development and diagnostics

- **Unit tests:** `npm test`
- **Lint (security-adjacent modules + tests):** `npm run lint`
- **Headless smoke (launches Electron):** `npm run test:e2e` — sets `NAVIO_E2E=1` and waits for the main window to finish loading.
- **Optional crash reporting:** set environment variable `NAVIO_SENTRY_DSN` to your Sentry DSN, then enable **Settings → Privacy → Send anonymous crash reports**. If the variable is unset, the toggle stays disabled.

## License

MIT
