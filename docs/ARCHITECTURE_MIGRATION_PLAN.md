# Navio architecture migration plan — `<webview>` → `WebContentsView`

**Status:** Active — supersedes the "stay on Electron + webview" constraint in ADR-001.
**Decision:** Migrate tab rendering from Electron `<webview>` tags to `WebContentsView` (Electron's
first-class tab primitive). This is **not** a framework switch — we stay on Electron + Node.js.
What changes is how tabs live inside the app.

**Related docs:**
- [ADR-001](./adr/001-electron-chromium.md) — superseded by this plan
- [AGENT_CORE_PLAN.md](./AGENT_CORE_PLAN.md) — agent improvements that are blocked until this lands
- [TRUE_BROWSER_IMPLEMENTATION_PLAN.md](./TRUE_BROWSER_IMPLEMENTATION_PLAN.md) — product feature plan
- [COMPETITIVE_GAPS_AND_PLAN.md](./COMPETITIVE_GAPS_AND_PLAN.md) — why this matters

---

## Why we're doing this

### The wall we keep hitting

Every significant roadblock in the last few months traces back to the same root cause:
**`<webview>` puts the browser content inside the renderer process, which puts a wall between
us and the content.**

| Roadblock | Root cause |
|---|---|
| Agent clicks blocked by `isTrusted` guards | Synthetic `element.click()` through webview — no real mouse events |
| CDP debugger attaches unreliably | `<webview>` wraps WebContents in a way that makes single-client debugger ownership fragile |
| Extensions silently break | `session.loadExtension()` doesn't cleanly propagate through webview isolation |
| Memory can't be properly managed per-tab | Can't call `webContents.forcefullyCrashRenderer()` or proper discard on a webview from main |
| Session/cookie quirks | Webview partition strings vs proper named sessions — different behavior than Chrome |
| Preload chain complexity | Two preloads deep (shell preload → webview-preload) just to get data out of a tab |
| DevTools kills the agent | One debugger client per WebContents — opening DevTools evicts our CDP attachment |

These are not bugs we can fix. They are the design of `<webview>`. The tag was designed for
embedding a single contained web page (like Electron's own apps do for settings pages), not for
building a multi-tab browser.

### What `WebContentsView` changes

`WebContentsView` is Electron's answer to this. It was designed specifically to replace
`BrowserView` for browser-shell use cases. Each tab becomes a first-class `WebContents` object
owned by the **main process** — the same place our AI loop, CDP, and session management live.

```
Before (webview)
─────────────────
Main process
  └── BrowserWindow
        └── Renderer process (src/index.html)
              ├── <webview id="tab-1">  ← child renderer
              ├── <webview id="tab-2">  ← child renderer
              └── <webview id="tab-3">  ← child renderer

After (WebContentsView)
────────────────────────
Main process
  ├── BrowserWindow
  │     ├── WebContentsView (tab-1)  ← owned here, full API access here
  │     ├── WebContentsView (tab-2)
  │     └── WebContentsView (tab-3)
  └── Renderer process (src/index.html = chrome shell only, no tabs inside it)
```

Consequences of moving tabs to the main process:

- **CDP attaches cleanly.** `webContentsView.webContents.debugger.attach()` — one line, no
  wrapper, no IPC round-trip to get a guest webContents ID first.
- **Trusted input events work.** `Input.dispatchMouseEvent` from a debugger attached to the
  actual WebContents is indistinguishable from a physical mouse click. `isTrusted: true`.
- **Extensions load per-session, not per-webview.** `session.loadExtension()` on a proper named
  session that all tabs in a window share — same model Chrome uses.
- **Memory control is real.** We can call `webContents.forcefullyCrashRenderer()` to discard a
  tab, then lazy-restore on focus. Currently this is approximated with JS-level unload tricks.
- **No double-preload complexity.** The shell preload (for `window.navio.*`) and the tab's own
  preload (for page content extraction) are independent. No IPC-through-renderer needed.
- **DevTools coexists with the agent.** We can open DevTools on a separate WebContents session,
  leaving our debugger attachment untouched.

---

## What we are NOT doing

| Not doing | Why |
|---|---|
| Forking Chromium (Comet/Arc approach) | 12–18 months of C++ infrastructure work before we write any product feature. Our Node.js CDP access gives us the same agent capabilities they get from their fork. |
| Switching to Tauri / WebView2 | Uses the OS native webview — we'd lose Chromium entirely. Wrong direction for a browser. |
| Rewriting in another language | All the product logic (AI loop, connectors, MCP, tools, workflows) stays as-is in Node.js. |
| Migrating everything at once | Phased approach — old webview tabs and new WebContentsView tabs coexist during migration. |

---

## Migration phases

### Phase 0 — Spike and validate (1 week)

**Goal:** Prove that `WebContentsView` actually solves the problems before committing to the
full migration. Build a throwaway branch.

**Spike checklist:**
- [ ] Create a minimal Electron window that opens 3 `WebContentsView` tabs side by side
- [ ] Load gmail.com and try a trusted `Input.dispatchMouseEvent` click — verify `isTrusted: true`
  in the page's click handler
- [ ] Open DevTools on tab 1 while the debugger is attached to tab 2 — confirm they don't evict
  each other
- [ ] Load an unpacked MV3 extension via `session.loadExtension()` — confirm it injects into tabs
- [ ] Measure idle RSS: 3-tab WCV session vs 3-tab webview session (Task Manager)

**Go/no-go gate:** If trusted clicks work and DevTools coexistence is confirmed, proceed.
If a blocker is found, document it in this file and evaluate alternatives before continuing.

**Files touched:** throwaway `spike/wcv-prototype.js` only. Delete after go decision.

---

### Phase 1 — New TabManager core (3–4 weeks)

**Goal:** Rebuild `TabManager` in `electron/main.js` using `WebContentsView`. The renderer
shell (`src/js/tabs.js`) becomes a **display layer only** — it renders tab strips and
forwards user actions, but no longer owns or drives WebContents.

**Architecture shift:**

```
Today: src/js/tabs.js → IPC → electron/main.js → IPC → webview in renderer
After: src/js/tabs.js → IPC → electron/main.js → WebContentsView (direct)
```

**Implementation tasks:**

- [ ] **`electron/tab-manager.js`** — new module (extracted from `main.js`):
  - `createTab(url, options)` → instantiates `WebContentsView`, attaches to `BrowserWindow`,
    wires navigation events back to renderer via IPC
  - `switchTab(tabId)` → brings the correct `WebContentsView` to front, hides others
  - `closeTab(tabId)` → destroys WebContentsView, GC-safe
  - `discardTab(tabId)` → `webContents.forcefullyCrashRenderer()` + store URL for restore
  - `restoreTab(tabId)` → `webContents.loadURL(storedUrl)`
  - Exposes the same IPC surface that `src/js/tabs.js` currently expects
    (`tab-created`, `tab-updated`, `tab-closed`, `switch-tab`, etc.) so the renderer
    doesn't need to change in this phase

- [ ] **`electron/main.js`** — remove `<webview>` IPC handlers; delegate to `tab-manager.js`.
  Keep all other IPC (AI, connectors, MCP, config) untouched.

- [ ] **`electron/session-setup.js`** — move session config from webview partition strings to
  `session.fromPartition('persist:navio-default')` used by all `WebContentsView` tabs.
  Cookie, request filter, permission, and ad-block logic stays identical — just the binding
  changes.

- [ ] **`electron/webview-preload.js`** — repurpose as the `WebContentsView` tab preload.
  The exported surface (`window.navioTab.*`) stays the same so `src/js/tabs.js` calls work
  without changes.

**Exit criteria:**
- Can open, navigate, switch between, and close 10+ tabs using WebContentsView
- Tab discard/restore works (`forcefullyCrashRenderer` + reload)
- Session cookies persist across tab switches (not wiped on webview teardown)
- Smoke test: Gmail, YouTube, GitHub — no regressions vs current

---

### Phase 2 — CDP and agent layer (2–3 weeks)

**Goal:** Wire the agent's CDP primitives directly to `WebContentsView.webContents` and unlock
the improvements in `AGENT_CORE_PLAN.md` Phase A+B that were blocked by the webview debugger
limitation.

**Implementation tasks:**

- [ ] **`electron/a11y-tree.js`** — replace the per-call attach/detach pattern with a persistent
  debugger on the tab's `WebContents`. No more `getWebviewContents()` IPC round-trip.
  ```js
  // Before: had to ask the renderer for the webview's webContentsId
  // After: tab-manager.js exposes getWebContents(tabId) directly
  const wc = tabManager.getWebContents(tabId);
  wc.debugger.attach('1.3');
  ```

- [ ] **`electron/cdp-inspector.js`** — update `startMonitoring(tabId)` to use the same
  direct WebContents reference. Remove the `webview-id` → `webContentsId` lookup that
  currently adds a round-trip.

- [ ] Implement **AGENT_CORE_PLAN Phase A** (trusted input) now that the debugger is stable:
  - Replace synthetic `element.click()` with `Input.dispatchMouseEvent`
  - Replace bulk `Input.insertText` with `Input.dispatchKeyEvent` for React-controlled inputs
  - Shadow-DOM piercing via `DOM.querySelector({ pierce: true })`

- [ ] Implement **AGENT_CORE_PLAN Phase B** (verify-after-action) now that persistent attach
  means we can subscribe to `DOM.childNodeInserted` between calls without losing the session.

**Exit criteria:**
- `isTrusted: true` confirmed on Stripe test checkout, a Cloudflare challenge page
- DevTools can be opened on a tab while agent is attached to a different tab — no eviction
- Phase A + B of AGENT_CORE_PLAN checklist passes benchmark

---

### Phase 3 — Extensions (2 weeks)

**Goal:** Replace the current webview `loadExtension` path with a proper session-level
extension load that applies to all tabs.

**Implementation tasks:**

- [ ] **`electron/extensions-ipc.js`** — change `loadExtension` calls to target
  `session.fromPartition('persist:navio-default')` instead of the individual webview session.
  This is a small change in binding, not in logic.

- [ ] Test the top 10 user-reported broken extensions (ad blockers, password managers,
  1Password, Bitwarden, React DevTools, Grammarly):
  - For each: document pass/fail and root cause
  - Fix the fixable ones (most content-script issues resolve with session-level load)
  - Document the remaining Chrome-only API gaps in `EXTENSIONS.md` (don't pretend they work)

- [ ] **`electron/session-setup.js`** — add `allowRendererProcessReuse: true` and any
  MV3-required flags to the session used by WebContentsView tabs.

**Exit criteria:**
- Bitwarden or 1Password extension injects into Gmail without manual intervention
- Ad blocker (uBlock Origin) blocks requests on news sites
- `EXTENSIONS.md` updated with accurate compat table

---

### Phase 4 — Renderer cleanup (1–2 weeks)

**Goal:** Now that tabs no longer live in the renderer, strip the renderer shell of webview
management code. This is the biggest line-count reduction.

**Implementation tasks:**

- [ ] **`src/js/tabs.js`** — remove all `document.getElementById('webview-...')`,
  `webview.loadURL()`, `webview.addEventListener(...)` calls. Replace with IPC calls to
  `tab-manager.js`. The tab strip UI (DOM elements, drag/drop, favicon display) stays.
  Estimated line reduction: ~1,200 lines.

- [ ] **`src/index.html`** — remove the `<webview>` container div and any inline webview
  attributes. The tab content area becomes a blank host region that Electron fills with
  `WebContentsView` bounds. The shell overlay (toolbar, sidebar, assistant) stays as-is.

- [ ] **`electron/webview-actions-ipc.js`** — migrate to call webContents methods directly
  (scroll, find-in-page, zoom, print) instead of proxying through the renderer to the webview.
  Estimated line reduction: ~100 lines, significant latency reduction.

- [ ] **`electron/preload.js`** — remove webview-related `window.navio.*` entries that are
  now handled by `tab-manager.js` directly. Keep all AI, config, tools, connector entries.

**Exit criteria:**
- `<webview>` tag appears **zero times** in `src/index.html` and `src/js/tabs.js`
- All 440 `window.navio.*` call sites work unchanged
- Shell HTML/JS under 90% of current line count

---

### Phase 5 — Validation and performance baseline (1 week)

**Goal:** Confirm we haven't regressed anything and document the before/after.

- [ ] Run full smoke checklist (`docs/SMOKE.md`) — every item passes
- [ ] Run agent benchmark suite (`test/agent-benchmark/`) — score improves vs pre-migration
- [ ] Measure RAM: 15-tab session idle — compare to `docs/PERFORMANCE.md` baseline
- [ ] Measure TTI (cold start to usable URL bar) — should be flat or improved
- [ ] Update `docs/PERFORMANCE.md` with new baseline numbers
- [ ] Update `docs/adr/001-electron-chromium.md` status to Superseded, link this doc

---

## What doesn't change

This is explicit because the temptation to "clean up while we're here" is high.

| Component | Status |
|---|---|
| `electron/main.js` AI loop | **Unchanged.** Tool calling, streaming, action tiers, kill switch all stay. |
| `electron/navio-tools.js` | **Unchanged** (until AGENT_CORE_PLAN phases run, which update specific primitives). |
| `src/js/assistant.js` | **Unchanged.** 10K lines of assistant UI/logic are not touched. |
| All connectors (GitHub, Gmail, Notion, etc.) | **Unchanged.** |
| MCP integration | **Unchanged.** |
| Config store / settings | **Unchanged.** |
| Passwords / profiles | **Unchanged.** |
| Sync / backup | **Unchanged.** |
| `electron/preload.js` `window.navio.*` surface | **Unchanged shape** — existing callers work without modification. |
| All 440 `window.navio.*` call sites in the renderer | **Unchanged.** |
| Packaging / Forge config | **Unchanged.** |
| Tests | **Unchanged.** Existing tests should pass throughout. |

---

## Risk log

| Risk | Likelihood | Mitigation |
|---|---|---|
| `WebContentsView` bounds management on resize is fiddly | Medium | Spike covers this. Handle `did-resize` and `resize` observer on the shell. |
| Some Electron API we use doesn't have a WCV equivalent | Low | Electron docs confirm full `WebContents` API parity. `webviewTag: false` in WCV context cleans up legacy surface. |
| Tab strip visual positioning (overlay chrome) requires coordinate math | Medium | `BrowserWindow.setBrowserView`-style positioning is well documented. Covered in Phase 1. |
| Extension coexistence with AI debugger | Medium | Phase 0 spike validates this before committing. Extensions and debugger use separate channels. |
| Migration takes longer than estimated | Medium | Old system stays in parallel until Phase 4. Users are never broken mid-migration. |

---

## Sequencing

```
Phase 0: Spike (1 week)  →  go/no-go
    |
Phase 1: TabManager (3–4 weeks)  ← longest phase, enables everything else
    |
    ├── Phase 2: CDP + Agent (2–3 weeks)  ← AGENT_CORE_PLAN Phase A+B unlocked here
    |
    ├── Phase 3: Extensions (2 weeks)  ← can run in parallel with Phase 2
    |
Phase 4: Renderer cleanup (1–2 weeks)  ← after Phase 1+2+3 stable
    |
Phase 5: Validation (1 week)
```

**Total calendar estimate (solo):** 10–13 weeks
**Total calendar estimate (two contributors, Phases 2+3 parallel):** 7–9 weeks

---

## How to use this doc in an agent chat

Paste this into the new chat:

> Read `docs/ARCHITECTURE_MIGRATION_PLAN.md`. Then execute the current unchecked phase in
> sequence, following Navio cardinal rules: stability first, one slice at a time, no mock data,
> preserve all existing IPC surface. The old webview system stays functional until Phase 4.
> Run `npm test` and the smoke checklist after each phase. Update the checkboxes when done.

---

## After this migration

Once `WebContentsView` is stable, the next architectural horizon (if we want it) is a
**Chrome Extension + native messaging host** model — shipping Navio as an extension on top of
the user's existing Chrome instead of a standalone Electron app. That is a separate decision
and a separate document. The `WebContentsView` migration does not block or prevent it — in fact,
it makes the agent and session code much easier to port since it's now cleanly separated from
the renderer shell.

---

*Created: 2026-04-29. Update phase checkboxes as work lands.*
