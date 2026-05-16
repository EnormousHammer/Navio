# Navio

Futuristic AI-powered Chromium browser. Intelligence meets the internet.

## Download (install like any other app)

1. Open **[latest GitHub Release](https://github.com/EnormousHammer/Navio/releases/latest)**.
2. Under **Assets**, download the **real installers** (not “Source code”):
   - **Windows:** `Navio-Windows-Setup-{version}.exe` — NSIS wizard; installs Chromium + Navio. **No Node.js** on the PC.
   - **macOS (Apple Silicon):** `Navio-macOS-{version}-arm64.dmg` — open, drag Navio to Applications. **No Node.js.**
   - **macOS (Intel):** `Navio-macOS-{version}-x64.dmg` — same as above for Intel Macs.
   - **Optional:** Squirrel `Navio-* Setup.exe` (dash before version), portable `Navio-win32-x64-*.zip`, and `Navio-darwin-*.zip` — for auto-updates / USB; still **no Node.js** for end users.

If you see **“There aren’t any releases”**, the Release workflow has not finished or did not publish yet — check **[Actions](https://github.com/EnormousHammer/Navio/actions)**. For a **private** repo, you must be signed into GitHub with access to that page.

**Native (non-Electron) follow-on — one file only:** [`NAVIO_NATIVE/README.md`](NAVIO_NATIVE/README.md) *(new chat: read that file end-to-end)*.

## Navio vs Chrome (honest comparison)

Navio is built on **Electron and Chromium**, so core browsing (tabs, rendering, many sites) feels familiar. It is **not** a Google Chrome distribution: there is **no Chrome sync** (passwords, tabs, history across devices via Google), **no Google Safe Browsing** binary feed as shipped in Chrome, and **extension support is best-effort** (Manifest V3 unpacked / store ID install; many store extensions rely on APIs or behaviors Electron does not mirror). Navio adds a **local-first AI assistant** and connectors (where you attach keys and OAuth) without sending your keys to Navio’s servers. For day-to-day trade-offs and manual verification, see [docs/SMOKE.md](docs/SMOKE.md) and [docs/TRUE_BROWSER_IMPLEMENTATION_PLAN.md](docs/TRUE_BROWSER_IMPLEMENTATION_PLAN.md).

## Features

- **Navio AI** - Built-in assistant that reads, understands, and interacts with any web page
- **Multi-Provider** - OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint (bring your own key)
- **Cited web answers out of the box** - `web_search` uses Perplexity when connected, otherwise transparently falls back to the active provider's native web search (OpenAI Responses, Anthropic `web_search_20250305`, or Gemini `google_search`) — same key, no second bill
- **Chrome-style credential dropdown** - Password suggestions appear inline below login fields, just like Chrome's autofill
- **Smarter compatibility mode** - Autofill and form detection stay active on Cloudflare/carrier sites even when anti-bot patches are suppressed
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
| **NSIS installer (primary)** | `dist-eb/Navio-Windows-Setup-{version}.exe` | Run `npm run dist:win` — wizard installer. **No Node.js** for end users. |
| **Squirrel installer** | `out/make/squirrel.windows/x64/Navio-{version} Setup.exe` | Auto-update channel + Start menu install. **No Node.js** for end users. |
| **Portable ZIP** | `out/make/zip/win32/x64/Navio-win32-x64-{version}.zip` | Unzip and run `navio-browser.exe` next to `ffmpeg.dll`. |
| **Unpacked folder** | `out/Navio-win32-x64/` | Same as ZIP, not compressed. |

Artifacts (**macOS**, on a Mac):

| Output | Path | Use |
|--------|------|-----|
| **DMG installers** | `dist-eb/Navio-macOS-{version}-arm64.dmg`, `dist-eb/Navio-macOS-{version}-x64.dmg` | Run `npm run dist:mac` after `npm run make`. **No Node.js** for end users. |
| **Portable ZIP** | `out/make/zip/darwin/**/Navio-darwin-*.zip` | From Forge `npm run make`; unzip and run. |

Ship **`Navio-Windows-Setup-*.exe`** and **`Navio-macOS-*-*.dmg`** to users who expect a normal app installer. Windows is **x64** only; mac DMGs cover **arm64** and **x64** separately.

**Releases (CI):** Pushing a tag matching `v*` (after updating `package.json` `version`) runs **Release** (`.github/workflows/release.yml`): test, optional code signing, **`electron-forge publish`** (Squirrel, zips), then **`gh release upload`** attaches **`Navio-Windows-Setup-*.exe`** and **`Navio-macOS-*-*.dmg`** so Assets always include normal installers. **One-time repo setup:** GitHub → **Settings** → **Actions** → **General** → **Workflow permissions** → **Read and write** (see [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md)). **In-app updates** use `electron-updater` against `package.json` → `repository`.

**Releases (GitHub CLI, from your PC):** `npm run release:github` (see [tools/publish-github-release.ps1](tools/publish-github-release.ps1)) uploads **Windows** Squirrel + zip + **`Navio-Windows-Setup-*.exe`** after `npm run make` / `npm run dist:win`. **macOS DMGs** are produced on a Mac with `npm run dist:mac` and can be uploaded with `gh release upload` to the same tag, or rely on **CI** for a full set of assets. **Remove mistaken releases/tags:** `npm run release:cleanup` after `gh auth login` (see [tools/cleanup-github-releases.ps1](tools/cleanup-github-releases.ps1)).

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
