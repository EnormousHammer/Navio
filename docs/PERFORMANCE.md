# Navio performance notes

## Profiling

- Use **Chrome DevTools** on the shell window (F12) and **Memory** snapshots to inspect renderer growth.
- For main process, run with `electron --inspect=9229 .` and attach Chrome to `chrome://inspect`.

## Recommendations

1. **Idle webviews**: Many tabs increase memory; consider optional tab discarding in a future release (unload guest when tab inactive for N minutes).
2. **Lazy load**: Heavy panels (Connectors, Workspace) could defer initialization until first open.
3. **CSS**: Large `styles.css` is split incrementally under `src/css/parts/`; prefer adding new UI rules there.

## Startup

- Main process clears code caches on launch (see `electron/main.js` `app.whenReady`) to avoid stale renderer bytecode during development; this adds a small cold-start cost acceptable for dev builds.

## Windows installers (`npm run make`)

- **Squirrel** + **ZIP** are produced via Electron Forge (`forge.config.js`). There is no official `@electron-forge/maker-nsis` on npm v7; for a classic NSIS `.exe` installer, add a community maker or wire **electron-builder** separately.

## Icons

- `src/assets/icon.png` and `icon.ico` are used on Windows. For **macOS `.icns`**, generate an iconset from PNG and run Apple `iconutil` (or add a CI step on a Mac runner).
