# NAVIO native — **this one file is the whole handoff**

**Use this file only.** No other file in `NAVIO_NATIVE/` is required to start a new Cursor chat.

**Product:** **NAVIO** — *Where intelligence meets the internet.*  
**What this is:** Post-Electron, **native Chromium-class** desktop browser work. **Where:** only under `NavioBrowser/NAVIO_NATIVE/` in this repo. Electron app code stays elsewhere.

---

## New Cursor chat — read order

1. **This file** (`NAVIO_NATIVE/README.md`) — end to end.
2. **`electron/migration/DECISIONS_AND_FAQ.md`** — stub + pointers.
3. **`electron/migration/MIGRATION_PLAN.md`** — export folder v3 contract.

**Optional long-form decisions + research:** `C:\APPLICATIONS MADE BY ME\WINDOWS\navio_browser\DECISIONS_AND_FAQ.md` (only if you need the full FAQ; not required to start).

---

## Paste this as the first message to the AI

```text
Workspace: NavioBrowser (this git repo).

Read only: NAVIO_NATIVE/README.md (full file), then electron/migration/DECISIONS_AND_FAQ.md, then electron/migration/MIGRATION_PLAN.md.

Task: Phase 0 — default stack is CEF (Chromium Embedded Framework). First deliverable: create NAVIO_NATIVE/ARCHITECTURE.md (process model, sandbox, CDP, how UI talks to content). Do not use Electron for the new shell. Do not move Electron app code into the native tree yet.

Product: NAVIO — Where intelligence meets the internet.
```

---

## Best start for our goals (AI + hard sites + leave Electron)

**Default Phase 0:** **[CEF](https://github.com/chromiumembedded/cef)** (native host usually **C++**). Real Blink, Chromium-style processes, **CDP-class** control for agents, cross-platform.

**Windows-only prototype first:** **WebView2** is OK short-term only if **`ARCHITECTURE.md`** requires **CDP / remote debugging from day one** and a **dated milestone** to move to **CEF** before v1 / cross-platform claims.

**Not the default here:** Tauri-only-webview, Electron again. Chromium **fork** only if you accept long build/merge cost.

---

## What you do first (engineering)

1. Add **`ARCHITECTURE.md`** in this folder (`NAVIO_NATIVE/`) — Phase 0, **CEF**, as above.
2. Migration export from the Electron app: **Settings → Browser → Export everything…** — spec lives in **`electron/migration/`**.

---

## If Cursor is opened on `navio_browser` only (mirror folder)

Path: `C:\APPLICATIONS MADE BY ME\WINDOWS\navio_browser` — optional docs mirror. **Authoritative in-repo work is still** `NavioBrowser/NAVIO_NATIVE/README.md` **(this file)** when you have the full repo — open the Navio repo and read this path.

---

## Optional disk mirror

`C:\APPLICATIONS MADE BY ME\WINDOWS\navio_browser` — extra copies of handoff/migration docs. **This repo + this file win** when both exist.
