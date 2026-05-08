# Navio releases and auto-update

## How updates work

- **Installed** Navio builds (Squirrel installer on Windows, or packaged macOS ZIP from releases) bundle **`electron-updater`**.
- The app checks **GitHub Releases** for the same GitHub repository declared in `package.json` (`repository.url`), using the **GitHub provider** (configured in the main process when packaged).
- **Development** runs (`npm start` / `electron .`) are **not** packaged; the updater does not apply to them.

## What you must publish on each release

1. **Tag** — Create a git tag matching the app version (convention: `v` + `package.json` `version`, e.g. `v1.0.1`).
2. **GitHub Release** — Attach platform artifacts from Electron Forge **`make`** (for example downloaded from a tag’s **Release** workflow run), or run **`npm run publish`** locally with a GitHub token so Forge uploads via **`@electron-forge/publisher-github`**.
3. **Windows (Squirrel)** — Typical outputs under `out/make/squirrel.windows/` include `RELEASES`, `.nupkg`, and `Setup.exe`. The updater reads these from the release assets.
4. **macOS** — ZIP (or DMG if you add a DMG maker) must be present on the release; `electron-updater` expects the standard asset naming for the GitHub provider.

**Draft releases:** Auto-update generally targets **published** (non-draft) releases. Keep releases published once you want users to receive updates.

## Verifying an update (smoke)

1. Install build **N** from a release.
2. Publish build **N+1** with a higher `version` in `package.json`.
3. On a test machine, open Navio **N**, go to **Settings → About → Check for updates**, wait for download, then **Restart & install** when offered.

## Checksums

Publish SHA256 (or similar) checksums alongside large binaries on the release page so users can verify downloads independently of GitHub’s UI.

## Related configuration

- Repository metadata: root `package.json` → `repository`.
- Forge publishers: `forge.config.js` → `publishers` → `@electron-forge/publisher-github`.
- Signing / notarization: see [RELEASE_SIGNING.md](./RELEASE_SIGNING.md).
