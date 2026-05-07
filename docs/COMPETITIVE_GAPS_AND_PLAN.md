# Competitive gaps and execution plan

**Purpose:** Consolidate what Navio already does (from code + docs), what is still missing versus Chrome, Perplexity Comet, and ChatGPT Atlas, what the assistant cannot “know” by default, and a **single prioritized plan** to close the highest-value gaps without abandoning Navio’s safety thesis.

**Related:** [AI_BROWSER_SPEC.md](./AI_BROWSER_SPEC.md), [ROADMAP.md](./ROADMAP.md), [EXTENSIONS.md](./EXTENSIONS.md), [PERFORMANCE.md](./PERFORMANCE.md), [adr/001](./adr/001-electron-chromium.md), [adr/002](./adr/002-email-mvp-webmail.md).

---

## 1. What Navio already has (verified in repo)

- **Engine:** Electron + Chromium via `webview` (ADR-001).
- **AI core:** Multi-provider BYOK, streaming, tool calling (`electron/navio-tools.js` + loop in `electron/main.js`), action tiers / confirmations, kill switch, PII redaction option, context receipt, action ledger (Phase 1 items in ROADMAP).
- **Context:** Data scopes (`none` / `selection` / `excerpt` / `full`) per spec; `extract-page-content` / selection IPC; assistant injects **open tab titles + URLs** (up to 20) for session awareness (`src/js/assistant.js`).
- **Connectors:** Rich `connector-query` surface in main (GitHub, Notion, **Perplexity with `return_citations`**, Linear, Gmail, Drive, Calendar, Dropbox, OneDrive, Slack, Outlook, etc.). Assistant **heuristically** pulls Perplexity/Gmail/etc. into connector context (`_buildConnectorContext` in `src/js/assistant.js`).
- **Live integrations:** `live-connectors.js` and OAuth/key flows; Gmail API tools in `navio-tools.js` for agent paths.
- **MCP:** **Real** `@modelcontextprotocol/sdk` wiring in `electron/navio-mcp.js` (stdio + SSE), tool discovery, proxy into the agent loop — not merely conceptual (note: ROADMAP Phase 4 wording and some UI copy lag this).
- **UX:** Command palette, omnibox `?` intent, workspace/projects/tasks/notes, reading mode, screenshot tooling, NTP with AI + widgets, inline AI toolbar, voice **input** (Web Speech API).
- **Agent loop (browse tools):** Trusted CDP `click` / `type` by ref ([electron/a11y-tree.js](../electron/a11y-tree.js)), **pre-click occlusion** via `checkOcclusion`, verify-after **click** and **type_text** (ref) with `no_change_warning` / `page_change` / field readback ([electron/main.js](../electron/main.js), [electron/navio-agent-verify.js](../electron/navio-agent-verify.js)); system prompt instructs the model to react to those signals ([electron/navio-system-prompt.txt](../electron/navio-system-prompt.txt)).
- **Intent routing:** [src/js/navio-intent-router.js](../src/js/navio-intent-router.js) (assistant + connector prefetch hints).
- **Saved workflows:** Merged `workflow-list` / `workflow-load` ([electron/main.js](../electron/main.js)); run from command palette, **URL bar workflows button**, **assistant header**, and Settings → Browser.
- **Passwords:** Local password manager + autofill affordances in shell (`src/js/app.js`).
- **Sync:** **Manual** encrypted profile export/import (`syncExportProfile` / `syncImportProfile` from settings) — not cloud continuous sync.
- **Extensions:** Unpacked MV3 + Chrome Web Store ID install; documented Electron limitations ([EXTENSIONS.md](./EXTENSIONS.md)); “extensions use AI” is **future-facing** / default off.

---

## 2. Gap analysis (deeper pass)

### 2.1 Versus Google Chrome (product, not just Blink)

| Theme | Gap |
|--------|-----|
| Identity & sync | No Google account, no always-on cross-device sync of everything (history, passwords, extensions, settings). Navio has optional manual profile backup only. |
| Extension compatibility | Electron + `loadExtension` — many Web Store extensions fail; no Chrome-scale compatibility story. |
| Safety net | Chrome’s Safe Browsing / update cadence / enterprise policy depth; Navio inherits Electron release and your own feature surface. |
| Platform integrations | Casting, payments breadth, deep OS hooks, Android companion — generally out of scope for current Navio. |
| Resource management | **Tab discarding is shipped** (`tabDiscardIdleMinutes` in [electron/config-store.js](../electron/config-store.js), logic in [src/js/tabs.js](../src/js/tabs.js)); Chrome may still edge ahead on extreme tab counts and process model. |

### 2.2 Versus Perplexity Comet

| Theme | Gap |
|--------|-----|
| Bundled “answer web” | **Closed (Apr 2026):** `web_search` now falls back to the **active LLM provider’s own web search** (OpenAI Responses `web_search`, Anthropic `web_search_20250305`, Gemini `google_search`) when no Perplexity key is present — users never need a second paid key. Perplexity is still preferred when connected (best citations). See `queryProviderWebSearch` in `electron/main.js`. |
| Productized agents | Comet markets long-running task chains, shopping, heavy delegation; Navio has **saved workflows** (palette + URL bar + assistant) and tools + connectors, but not the same vendor-packaged “operator” onboarding and marketing. |
| Mobile | Comet on Android/iOS; Navio is desktop Electron today. |
| Voice | Navio: speech-to-text input; Comet emphasizes voice as a full modality (including multi-tab voice on mobile) — **TTS / voice replies** not first-class here. |
| Citations UX | Backend can return citations (Perplexity API); UI could still be strengthened (clickable source chips, persistence in thread, citation preview). |

### 2.3 Versus OpenAI ChatGPT Atlas

| Theme | Gap |
|--------|-----|
| Account-native memory | Atlas ties to ChatGPT memory; Navio is **local / policy-scoped** by design — no automatic cloud “memory graph” unless user wires MCP or provider features. |
| AI-first search NTP | Atlas centers ChatGPT-orchestrated search + result tabs; Navio NTP is strong but not the same vendor-integrated search product. |
| Agent positioning | Atlas pushes agent mode as headline; Navio emphasizes **confirmations and tiers** — correct for safety, different user expectation. |
| Windows | Atlas roadmap included Windows after macOS; Navio is already Windows-capable via Electron — **platform advantage** on paper, offset by Chrome/Comet polish. |

### 2.4 “Assistant knowledge” — what the model still misses

These are **epistemic** limits (not just missing buttons):

1. **Full page and all frames** — Only what `extract-page-content` and scope allow; dynamic/auth-only content may be partial.
2. **Deep multi-tab content** — Model sees **titles/URLs** for open tabs; full bodies require explicit actions (“summarize all tabs”), `@` references, or tools — not automatic like some competitor demos imply.
3. **Connector coverage** — `_buildConnectorContext` uses **regex intents**; misclassified queries skip Gmail/Perplexity/etc. until improved routing or explicit UI toggles (“include web search”).
4. **Live web without Perplexity/tools** — `web_search` now works key-free-for-a-second-party by routing through the user’s active LLM provider (OpenAI/Anthropic/Google). If the user has no AI key at all, there is still no live web; deep-web / paywalled content still requires the browse tools.
5. **Long-horizon personalization** — Local memory features exist, but not Atlas-style server memory unless the chosen provider supports it and user opts in.
6. **Extensions** — Isolated; AI bridge off by default and not fully productized ([EXTENSIONS.md](./EXTENSIONS.md)).
7. **MCP off by default** — `mcpEnabled: false` in config; users must enable and configure servers to unlock external tools.

### 2.5 Internal consistency / tech debt (worth fixing in-plan)

- **ROADMAP Phase 4** — reconciled with real MCP SDK wiring (see `docs/ROADMAP.md`).
- **Settings MCP hint** — uses `list-tools` + `get`; shows tool count when MCP is enabled.
- **`src/index.html`** MCP copy — updated to describe SDK-based integration (not a stub).

### 2.6 Automation: workflows vs `navio-skills.js`

| Theme | Status |
|--------|--------|
| **Saved workflows** | **Primary replay path:** named sequences (legacy JSON + per-file tool steps), `workflow-list` / `workflow-load`, run from command palette, URL bar control, assistant header, Settings → Browser. |
| **`electron/navio-skills.js`** | **Deferred:** module is not `require()`’d from `electron/main.js`; no parallel “auto-skills” layer until design merges with workflows to avoid two sources of truth. |

---

## 3. Execution plan (prioritized phases)

Principles: **minimal invasive changes**, preserve ADR-002 email MVP (no silent send), keep AI kill switch and tiered actions, **no mock data**.

### Phase A — Truth in product + developer experience (1–2 days)

**Goal:** Align docs/UI with reality; fix broken MCP hints.

| Task | Exit criterion |
|------|----------------|
| Update ROADMAP Phase 4 and settings/NTP copy to reflect **real MCP SDK** (optional: separate “broker hardening” follow-up). | Docs and UI strings match `navio-mcp.js` behavior. |
| Fix `refreshMcpHint` to use `list-tools` (or equivalent) and show connected server count + tool count. | Settings shows non-empty hint when MCP connected. |
| Add a short “MCP quickstart” pointer in settings (link to existing doc section or inline steps). | New user can enable MCP without reading source. |

**Dependencies:** None.

---

### Phase B — Assistant “knows more” safely (highest user-visible ROI)

**Goal:** Reduce missed connector context and shallow tab awareness without sending full DOM for every tab by default.

| Task | Exit criterion |
|------|----------------|
| **Explicit toggles** in assistant panel: “Include web search (Perplexity)” / “Include mail context” when connected — overrides fragile regex-only routing for power users. | **Done:** Web/Mail selects (auto / always / off) + persist in `navio-config.json`. |
| **Improve intent routing:** lightweight classifier or expanded heuristics + fallback (“no connector fired — did you mean to search the web?”). | Partially addressed by toggles; classifier optional. |
| **Optional “tab digest” mode:** user-triggered or setting to attach **one-line summaries** or first N chars per tab (cap tokens), not default-on. | **Done:** “Tab digest” checkbox (off by default); capped excerpts per open tab. |
| **Citations UX** for Perplexity path: render sources as clickable list in assistant bubble. | **Done:** “Sources” chips under assistant replies when Perplexity returns citations. |

**Dependencies:** Phase A optional but helps MCP users.

---

### Phase C — Browser parity “where Electron can compete”

**Goal:** Close practical gaps vs Chrome **without** pretending to be Google.

| Task | Exit criterion |
|------|----------------|
| **Tab discarding** (idle webview unload + restore) per PERFORMANCE.md. | Memory stable with many idle tabs; user can disable in settings. |
| **Extension reliability:** document top failure modes; optional compatibility toggles if Electron adds flags (research-only sub-task). | Fewer “silent broken extension” reports or clearer errors. |
| **Installer story:** PERFORMANCE.md NSIS note — evaluate one path (community forge maker or electron-builder) if shipping to non-technical users. | Repeatable Windows installer beyond ZIP/Squirrel if desired. |

**Dependencies:** None; can parallelize with B.

---

### Phase D — AI-native differentiators (Comet/Atlas class)

**Goal:** Optional features that match competitor narratives while keeping Navio’s policy model.

| Task | Exit criterion |
|------|----------------|
| **Task chains / saved workflows:** surface `navio-workflows.js` in UI with clear confirmations for tier-2 steps. | **Done (surface):** palette entry “Saved workflows — run one”, dedicated workflow picker, URL bar + assistant header buttons; Settings → Browser unchanged. Ledger behavior unchanged. |
| **Voice output:** TTS for last assistant message (opt-in, provider or OS). | Accessibility + parity with “voice assistant” browsers. |
| **Second search backend** (e.g. Brave Search API or user key) as alternative to Perplexity-only — still citations-first. | Reduces vendor lock-in for live web. |
| **Mobile:** only if scope expands — likely **separate project** (Capacitor/WebView or native); call out as long-term. | Roadmap explicitly states platform boundary. |

**Dependencies:** B helps; C optional.

---

## 4. Suggested sequencing

```text
Phase A: docs + MCP hint fix
    |
    v
Phase B: assistant knowledge + connector UX (highest ROI)
    |
    +---> Phase C: tab discarding, extensions, installer (parallel OK)
    |
    v
Phase D: workflows, voice out, second search backend, mobile (long-term)
```

**Quick wins:** Phase A + Perplexity citations UI + assistant toggles (subset of B).

**Measure success:** Fewer “AI didn’t see my tabs/email/web” reports; MCP adoption up; memory usage on 30+ tab sessions improved after discarding.

---

## 5. Out of scope (explicit)

- Replacing Electron with Chrome fork or WebView2 (ADR-001 revisit is a major decision).
- Full Chrome Web Store compatibility without engine work.
- Unattended tier-2 actions without confirmation (contradicts spec).
- Native IMAP client (ADR-002: web-mail MVP unless product direction changes).

---

*Last updated: 2026-05 — agent verify/occlusion/type verify, workflow discoverability, docs aligned with `main.js` / `a11y-tree.js` / `navio-agent-verify.js`.*
