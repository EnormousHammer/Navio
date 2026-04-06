# Navio — AI-native browser specification

**Version:** 1.0.0  
**Status:** Living document — aligned with [ROADMAP.md](./ROADMAP.md).

## 1. Product thesis

Navio treats **user intent and task context** as first-class, not only origins and URLs. The assistant consumes **policy-scoped** page context, logs **high-level actions**, and requires **confirmation** for risky automation.

## 2. Non-goals

- Replacing the open web with proprietary formats as default.
- Sending full page content to third-party models without user-configured scope and consent.
- Unattended browsing (no silent navigation or form submit without explicit user approval for tier-2 actions).

## 3. Glossary

| Term | Definition |
|------|------------|
| **Context package** | Structured metadata + text excerpts attached to an AI request under the active **AI data scope**. |
| **Action tier** | 0 = read-only / low risk; 1 = DOM interaction; 2 = navigation or sensitive input — requires confirmation in UI. |
| **Action ledger** | Append-only local log of AI-related actions (type, tab, timestamp) — no full message bodies. |
| **MCP scope** | Allowed Model Context Protocol servers and tools; off by default. |

## 4. Threat model (summary)

- Malicious pages may attempt **prompt injection** — mitigated by separating system instructions, optional PII redaction, and user-visible context receipts.
- **API keys** stored with OS **safeStorage** when available; not persisted in plaintext JSON.
- **Extensions** (future): AI access off by default ([EXTENSIONS.md](./EXTENSIONS.md)).

## 5. Architecture (logical)

1. **Shell** — [src/index.html](../src/index.html), [src/js/app.js](../src/js/app.js)  
2. **Browser core** — [electron/main.js](../electron/main.js), [src/js/tabs.js](../src/js/tabs.js)  
3. **AI runtime** — policy in main + [src/js/assistant.js](../src/js/assistant.js)  
4. **Stores** — context graph, workspace, ledger (userData)

See ADRs in [docs/adr/](./adr/).

## 6. AI data scopes

| Scope | Behavior |
|-------|----------|
| `none` | No automatic page content in chat. |
| `selection` | Selected text in the active tab, if any; otherwise a short notice. |
| `excerpt` | Title, URL, headings, truncated body text (default). |
| `full` | Larger body extract (still capped server-side); use with care. |

## 7. References

- [ROADMAP.md](./ROADMAP.md) — phased delivery and exit criteria  
- [EXTENSIONS.md](./EXTENSIONS.md) — extension capability model  
