# Navio implementation roadmap

Phases match the approved AI-native browser plan. **Exit criteria** must pass before closing a phase.

## Phase 0 — Specification and governance ✅ (docs)

**Deliverables:** This repo includes `docs/AI_BROWSER_SPEC.md`, `docs/ROADMAP.md`, and ADRs under `docs/adr/`.

**Exit:** Docs committed; ADR-001 (engine) and ADR-002 (email MVP) recorded.

---

## Phase 1 — AI core (policy, context, ledger, secure key)

**Exit criteria**

- [x] User can set **AI data scope** and see a **context receipt** for what was included.
- [x] **PII redaction** optional toggle affects outbound context.
- [x] **AI kill switch** blocks requests.
- [x] API key stored with **safeStorage** when supported; legacy plaintext migrated.
- [x] **Action ledger** records AI request metadata (no full prompts in log).
- [x] **browser-action** tier: navigate / click / type require `userConfirmed: true`.

---

## Phase 2 — Power UX

**Exit criteria**

- [x] Command palette (**Ctrl+K** / **Cmd+K**) opens; searches tabs + commands.
- [x] Omnibox supports **?** prefix to send query to assistant (intent mode).
- [x] Shortcut registry in config (extensible; `shortcuts` object reserved).

---

## Phase 3 — Productivity workspace

**Exit criteria**

- [x] Projects, tasks, notes persisted locally; assistant can reference pinned tab / workspace IDs.
- [x] Quick capture opens note tied to active tab.

---

## Phase 4 — MCP

**Exit criteria**

- [x] MCP panel in settings; enable/disable; stub broker logs tool intent.
- [x] At least one documented path to attach a real MCP server (future: SDK).

---

## Phase 5 — Email

**Exit criteria**

- [x] ADR-002 followed: web-mail MVP + assistant hooks for “mail context” placeholder.
- [x] No send automation without explicit user action in this MVP.

---

## Phase 6 — Polish features

**Exit criteria**

- [x] Screenshot tool, reading mode, DevTools shortcut, memory readout (incremental).

---

## Phase 7 — Extensions

**Exit criteria**

- [x] `EXTENSIONS.md` capability model; settings flag **Allow extensions to use AI** (default off).

---

## Dependency order

Phase 1 → enables 4, 5 safely. Phase 2 can parallelize with 3. Phase 7 ongoing.
