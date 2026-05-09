# Navio releases and auto-update

## How updates work

- **Installed** Navio builds (Squirrel **`Setup.exe`** on Windows, **`.dmg`** or ZIP on macOS from releases) bundle **`electron-updater`**.
- The app checks **GitHub Releases** for the same GitHub repository declared in `package.json` (`repository.url`), using the **GitHub provider** (configured in the main process when packaged).
- **Development** runs (`npm start` / `electron .`) are **not** packaged; the updater does not apply to them.

## What you must publish on each release

1. **Tag** — Create a git tag matching the app version (convention: `v` + `package.json` `version`, e.g. `v1.0.3`).
2. **GitHub Release** — On tag `v*`, CI runs **`electron-forge publish`** (Squirrel + zips) and **`gh release upload`** for **`Navio-Windows-Setup-*.exe`** and **`Navio-macOS-*-*.dmg`** from `electron-builder`, or attach artifacts manually / run **`npm run publish`** locally with a token.
3. **Windows (Squirrel)** — Typical outputs under `out/make/squirrel.windows/` include `RELEASES`, `.nupkg`, and `Navio-* Setup.exe`. Squirrel-installed builds use these for delta updates.
4. **macOS** — Release assets include **`Navio-macOS-{version}-arm64.dmg`** and **`-x64.dmg`** from `dist-eb` (plus optional Forge **darwin** `.zip` from `out/make`). NSIS-installed Windows builds use **`latest.yml`** / blockmap on the release when published from CI.

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
