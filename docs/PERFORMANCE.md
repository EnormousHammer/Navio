# Navio performance notes

## Baseline (fill when changing hot paths)

Record on a **fixed machine** so before/after comparisons mean something. Use Windows **Task Manager → Details → Navio** (or **Performance** memory) for rough **Private working set**; optionally DevTools **Memory** on the shell (F12).

**Windows — sum Navio’s Electron children (repeatable):** PowerShell:

```powershell
$pids = (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -match 'NavioBrowser' }).ProcessId
($pids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64 } |
  Measure-Object -Sum).Sum / 1MB
```

Close other Electron apps first, or the filter may include stray paths.


| Scenario                                   | Private WS (MB) | Notes                                                                                                                                                                                               |
| ------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle, default NTP / few tabs               | 3957            | 2026-04-16 dev run — sum of all `electron.exe` with `NavioBrowser` in command line (~14 processes incl. GPU/helpers).                                                                               |
| ~15 tabs, assistant open                   | —               | **Measure locally:** open 15 mixed tabs + assistant sidebar, wait ~30 s for settle, run PowerShell snippet above. Record here after measuring (baseline pre-discard; compare after discard enabled). |
| Cold start → URL bar usable (subjective s) | —               | **Measure locally:** `npm start`, stopwatch until the omnibox accepts keyboard input. Typically 3–6 s on SSD; record to track regressions after main-process changes.                               |


Re-run after large changes to tabs, webview lifecycle, or assistant context.

## Profiling

- Use **Chrome DevTools** on the shell window (F12) and **Memory** snapshots to inspect renderer growth.
- For main process, run with `electron --inspect=9229 .` and attach Chrome to `chrome://inspect`.

## Recommendations

1. **Idle webviews**: Tab discarding is implemented (`tabDiscardIdleMinutes: 30` default). Verify RAM savings with the 15-tab scenario above — compare with discard on vs off.
2. **Lazy load (done)**: `ConnectorsManager` now defers OAuth/IMAP status calls to first hub open. Only `getConfig()` + `connectorGetKeys()` run at startup. Verify startup TTI improvement by re-measuring cold start.
3. **CSS**: Large `styles.css` is split incrementally under `src/css/parts/`; prefer adding new UI rules there.

## Startup

- Main process clears code caches on launch (see `electron/main.js` `app.whenReady`) to avoid stale renderer bytecode during development; this adds a small cold-start cost acceptable for dev builds.

## Windows installers (`npm run make`)

- **Squirrel** + **ZIP** are produced via Electron Forge (`forge.config.js`). There is no official `@electron-forge/maker-nsis` on npm v7; for a classic NSIS `.exe` installer, add a community maker or wire **electron-builder** separately.

## Icons

- `src/assets/icon.png` and `icon.ico` are used on Windows. For **macOS `.icns`**, generate an iconset from PNG and run Apple `iconutil` (or add a CI step on a Mac runner).

