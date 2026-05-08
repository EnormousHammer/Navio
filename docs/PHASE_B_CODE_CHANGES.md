# Phase B checklist — implemented

The items from the former checklist are now in the tree:

- **`package.json`** — `repository`, `bugs`, `homepage` for GitHub metadata and `electron-updater`.
- **`forge.config.js`** — `publishers` → `@electron-forge/publisher-github` (`EnormousHammer` / `Navio`).
- **`electron/main.js`** — `navioParseGitHubRepoFromPackage()` + `autoUpdater.setFeedURL({ provider: 'github', owner, repo })` in `navioEnsureAutoUpdaterWired()`.
- **`build/entitlements.mac.plist`** — Hardened runtime entitlements for macOS signing.
- **`.github/workflows/release.yml`** — Tag `v*` → test, build Windows + macOS, upload artifacts, then **`electron-forge publish`** on Windows then macOS (same GitHub Release). Needs repo **Workflow permissions → Read and write** for `GITHUB_TOKEN`.
- **`.github/workflows/build.yml`** — Optional Windows PFX decode + macOS `APPLE_*` env; artifacts use `out/make`; tag builds removed here (handled only by `release.yml`).
- **`src/index.html` / `src/js/settings.js`** — About → Documentation links (Privacy, Security, Third-party notices).

For operational steps (tags, smoke tests, `spctl`), see [UPDATES.md](./UPDATES.md) and [RELEASE_SIGNING.md](./RELEASE_SIGNING.md).
