# Manual smoke checklist (Navio)

Run after meaningful changes to the shell, tabs, downloads, assistant, or Electron session. Record **Pass** / **Fail** and a one-line note if fail.

| Step | Action | Pass/Fail | Notes |
|------|--------|-----------|-------|
| 1 | **Cold start** — launch Navio; shell and URL bar appear without long hang | | |
| 2 | **New tab** — Ctrl+T; new tab opens | | |
| 3 | **Navigate** — open a known HTTPS site; page renders | | |
| 4 | **Back / forward** — history buttons work on a multi-page site | | |
| 5 | **Download** — save a small file; progress in Downloads panel; **Show in folder** or toast **Show** works | | |
| 6 | **Ctrl+J** — toggles Downloads drawer | | |
| 7 | **Open Downloads folder** — Folder button in drawer opens system Downloads | | |
| 8 | **PDF** — open a `.pdf` URL or file; viewer or download behaves | | |
| 9 | **Gmail** (optional) — compose; paste or attach; clipboard not blocked for trusted Google origins | | |
| 10 | **Extension** — load unpacked or note store-ID result; any error is visible (alert or list) | | |
| 11 | **Assistant** — send a message with API key set; tool loop or reply without crash | | |
| 12 | **Tab discard** (if enabled) — background tab idle; discards; click tab reloads | | |

## Perf spot-check (same machine, after major changes)

Fill on one machine for comparability. See [PERFORMANCE.md](./PERFORMANCE.md) for the **PowerShell sum** of Navio `electron.exe` children (same method each time).

| Metric | Few tabs (idle) | ~15 tabs | Cold start → URL bar usable |
|--------|-----------------|----------|-----------------------------|
| Date | 2026-04-16 (example) | | |
| Rough private WS (sum script) | ~3957 MB | | |
| Notes | Dev machine; includes GPU + all helpers | | |
