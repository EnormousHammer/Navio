# True browser implementation plan (Navio)

**Purpose:** Paste this file (or sections) into a new agent chat to implement Navio as a **credible daily driver**—Chrome-class reliability and polish, with AI-native differentiation (Comet/Atlas class *experience*, not Google’s sync ecosystem).

**Constraints (do not ignore):**

- Stack stays **Electron + Chromium `webview`** unless an ADR explicitly changes it (`[docs/adr/001-electron-chromium.md](./adr/001-electron-chromium.md)`).
- **No mock data** in product paths; use real APIs, real user config, real tool results.
- **Email safety:** no silent send; drafts/API paths follow existing policy (`[docs/adr/002-email-mvp-webmail.md](./adr/002-email-mvp-webmail.md)`).
- Read `[docs/COMPETITIVE_GAPS_AND_PLAN.md](./COMPETITIVE_GAPS_AND_PLAN.md)` and `[docs/EXTENSIONS.md](../EXTENSIONS.md)` for known Electron limits.

### Non-negotiables: RAM and speed

**A “true browser” must feel fast and stay light enough to leave open all day.** Every phase below should be implemented with:


| Priority    | What to optimize                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RAM**     | Fewer live `webview` processes holding fat pages; **tab discard/snooze** when idle (`[tabDiscardIdleMinutes](../electron/config-store.js)`); avoid duplicate heavy listeners; lazy-init panels (Connectors, Workspace, heavy NTP widgets) until first open (`[docs/PERFORMANCE.md](./PERFORMANCE.md)`). |
| **Startup** | Cold path: defer non-critical work after first paint; avoid blocking the shell on optional network (`[docs/PERFORMANCE.md](./PERFORMANCE.md)` startup note).                                                                                                                                            |
| **Runtime** | Main process: avoid extra IPC round-trips in hot paths; renderer: no huge synchronous DOM work on every keystroke; assistant: cap context / tab digest size (existing settings—don’t regress).                                                                                                          |
| **Proof**   | Before/after: **Task Manager** private working set with same scenario (e.g. 15 tabs + assistant open); optional Chrome DevTools **Memory** on shell (`F12`). Document deltas in PR when changing hot paths.                                                                                             |


If a feature **spikes RAM or janks the UI**, ship it behind a setting or defer it until perf is addressed.

---

## Phase 0 — Baseline & definition of done

**Goal:** Agree what “true browser” means in Navio: **tabs, navigation, downloads, extensions (best-effort), memory, security, and AI that doesn’t fight the shell.**

**Exit criteria:**

- [x] `docs/` or README has a one-paragraph **“Navio vs Chrome”** honest comparison (sync, extensions, Safe Browsing—what we don’t ship). → [README.md](../README.md#navio-vs-chrome-honest-comparison)
- [x] A **“smoke checklist”** (manual) in this doc or `docs/SMOKE.md`: cold start, new tab, navigate, back/forward, download, open PDF, Gmail compose attach/paste, extension load, assistant tool loop—each pass/fail. → [SMOKE.md](./SMOKE.md)
- [x] **Perf baseline recorded:** same machine, rough **RAM at idle** (few tabs) and **RAM with N tabs** (e.g. 15) + **time-to-interactive** (cold start until URL bar usable). Re-run after major phases. → [PERFORMANCE.md](./PERFORMANCE.md) (example row + PowerShell method); fill **15 tabs** / **TTI** locally.

**Agent instructions:** Phase 0 checklist + templates are in repo; fill perf numbers locally when validating releases.

---

## Phase 1 — Chrome parity: invisible shell

**Goal:** Remove “half browser” moments in the paths users hit every day.

**Slice (this repo pass):**

- [x] **1.1** Downloads drawer under toolbar; **Open Downloads folder** label; per-row **Show in folder**; **Ctrl+J** wired in `session-setup.js` → `downloads-panel`.
- [x] **1.2** Google Workspace clipboard/file-picker auto-grant extended (Meet, Chat, Calendar, Sheets, Slides) alongside Gmail/Docs/Drive.
- [x] **1.3** Tab discard logic unchanged (pinned / incognito / agent / chat / background); default remains **Off** (`tabDiscardIdleMinutes: 0`) to avoid surprise reloads — user picks 15–120 min in Settings.
- [x] **1.4** Load failures show **human-readable** copy plus optional technical line (code + raw `ERR_*`), not only raw `ERR_ABORTED` text.

### 1.1 Downloads & files

- Downloads UI anchored to toolbar; **Open Downloads folder**; **Ctrl+J** (already started—verify on Windows).
- Optional: **download shelf** behavior (toast + consistent “Show in folder”)—audit `src/js/app.js` download toasts vs drawer.
- **Settings:** “Ask where to save” vs “Save to Downloads” clearly labeled; default sensible for new users.

### 1.2 Clipboard & paste (web apps)

- Gmail/Google Docs: **clipboard** permissions for trusted origins—verify `[electron/session-setup.js](../electron/session-setup.js)` auto-grant list is complete.
- If paste still fails: trace **webview focus** (`agent-input-focus.js`, tab focus) and document root cause.

### 1.3 Tabs & memory (RAM-critical)

- **Tab discard / snooze** (`tabDiscardIdleMinutes`)—verify logic in `[src/js/tabs.js](../src/js/tabs.js)`: pinned, incognito, agent tab, chat tab, background `switchTo: false`.
- **Defaults:** ship a **sensible default** for snooze (e.g. off vs 30m)—pick one that balances RAM vs surprise reloads; document in Settings copy.
- **Stress test:** 20+ tabs, idle discard on, no crash; restore reload works; **measure RAM** vs same scenario with discard off.
- **Future:** optional **hard cap** on concurrent non-discarded heavy tabs (research; may need UX).

### 1.4 Navigation & URL

- Omnibox: HTTPS upgrade, search vs URL, **errors** readable (not raw `ERR_ABORTED` only).
- Single-message Gmail URLs: **API intercept** path documented in system prompt; ensure no user-facing dead end.

**Exit criteria:** Phase 1 smoke checklist passes without “known broken” notes.

---

## Phase 2 — AI as first-class (not a sidebar accident)

**Goal:** Default experience feels like “the browser helps me on the web,” not “I opened a chat.”

**RAM/speed:** Connector prefetch and **tab digest** must stay **bounded** (token caps, off by default where appropriate). No unbounded “send entire DOM of all tabs” without explicit user action.

**Slice (this repo pass):**

- [x] **2.1** **Settings → AI:** “Live web answers” and “Gmail / mail context” with **Auto / Always / Off**; **Tab digest** toggle; synced with assistant sidebar (`settings.js` + `assistantConnectorWeb` / `assistantConnectorMail`).
- [x] **2.1** **NTP:** Single hero line + hint; **Quick starts** collapsed under `<details>` so the search box is the obvious primary action.
- [x] **2.2** Citation **chips** from Perplexity unchanged; **fallback** parses markdown / `Sources` URLs in assistant replies when no connector array is present (bounded).
- [x] **2.3** **Agent loop:** clearer **step-limit** message; **transient** provider errors append a short retry / **continue** hint.

### 2.1 Default intelligence path

- **Settings UX:** “Live web answers” (Perplexity or similar) when API key present—clear **on/off/auto**; avoid regex-only surprises (`[src/js/assistant.js](../src/js/assistant.js)` connector routing).
- **NTP:** One obvious primary action (e.g. “Ask” or “Search”) that mirrors Comet’s clarity—no crowded competing CTAs.

### 2.2 Citations & trust

- When provider returns citations, **always render clickable source chips** in assistant UI (verify existing implementation; fix gaps).
- **Receipt / context line** (what was sent to the model) stays accurate—see assistant config.

### 2.3 Agent loop polish

- Tool step limit, **continue** UX, and **failure recovery** copy are user-proof (`[electron/main.js](../electron/main.js)` tool loop).
- **Gmail:** `gmail_create_draft` + `gmail_create_reply_draft` documented in system prompt; no model claims “Navio blocks API.”

**Exit criteria:** New user can get a **cited web answer** and a **Gmail draft** without reading source code.

---

## Phase 3 — Extensions & power users (honest)

**Goal:** Best-effort Chrome extensions without promising Chrome parity.

- [x] **Settings → Browser:** collapsible **Extension troubleshooting** + expanded **`docs/EXTENSIONS.md` → Troubleshooting** (failure modes, what to try).
- Optional: **compatibility toggles** only if Electron exposes stable flags (research-only sub-task; document in ADR if added).

**Exit criteria:** Users report fewer “extension silently does nothing” mysteries—**or** we show a clear in-app error.

---

## Phase 4 — Platform & ship

**Goal:** Installable, updatable, trustworthy for non-devs.

- **Windows installer story:** evaluate NSIS or electron-builder path (`[docs/PERFORMANCE.md](./PERFORMANCE.md)` notes Forge limits).
- [x] **Auto-update UX:** **Settings → About → Check for updates** invokes `electron-updater` (`autoDownload` stays off); dev builds get an explanatory message. **Publishers** still need a configured update feed for checks to succeed.
- **Crash reporting** (optional): gated, privacy-preserving.

**Exit criteria:** A non-technical user can install, update, and recover from a bad update.

---

## Phase 5 — “Comet-class” narrative (optional product layer)

**Goal:** Product feels **AI-native**, not a Chromium fork with a sidebar.

- **Voice:** TTS for last assistant reply (opt-in); document provider/OS choice.
- [x] **Task chains:** **Settings → Browser → Saved workflows** lists, runs (opens assistant + queues steps), and deletes; command palette unchanged.
- **Second search backend** (e.g. Brave Search API + user key) to reduce Perplexity-only dependency—citations-first.

**Exit criteria:** Marketing copy matches what the binary actually does.

---

## Execution order (recommended)

1. **Phase 0** (1 session) — include **perf baseline** numbers
2. **Phase 1** (multiple sessions; ship in vertical slices: **tabs/memory** early if RAM is painful → downloads → paste)
3. **Phase 2** (AI UX; highest differentiation ROI; **guard token/context size**)
4. **Phase 3** + **Phase 4** in parallel if two contributors
5. **Phase 5** only after Phase 1–2 are solid

**Gate:** Do not add heavy always-on features (extra background polling, full-page screenshot loops, etc.) without a **RAM impact note** and, where possible, an **off switch** or lazy activation.

---

## For the agent in a new chat

**Start every task with:**

1. Read this plan and the linked `docs/` files.
2. `git status` / branch hygiene.
3. **One phase, one PR-sized slice**—no drive-by refactors.
4. After changes: run **existing tests** (`npm test`), manual **smoke** for the touched area.
5. If the change can affect **memory or responsiveness**, note **before/after** (Task Manager or DevTools) in the PR description.
6. Update **this doc** checkboxes when a slice is done.

**Repository anchors:**

- Main process: `[electron/main.js](../electron/main.js)`, `[electron/session-setup.js](../electron/session-setup.js)`
- Tabs: `[src/js/tabs.js](../src/js/tabs.js)`
- Shell UI: `[src/js/ui-shell-extras.js](../src/js/ui-shell-extras.js)`, `[src/index.html](../src/index.html)`
- Assistant: `[src/js/assistant.js](../src/js/assistant.js)`
- Prompts/tools: `[electron/navio-system-prompt.txt](../electron/navio-system-prompt.txt)`, `[electron/navio-tools.js](../electron/navio-tools.js)`
- Config: `[electron/config-store.js](../electron/config-store.js)`

---

*Last updated: 2026 — align with repo reality when implementing.*