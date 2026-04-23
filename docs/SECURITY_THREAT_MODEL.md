# Navio security threat model (high level)

This document sketches trust boundaries and primary risks. It is meant for developers and advanced users; it should evolve as features change.

## Trust boundaries


| Zone                                               | Role                                                                | Notes                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Main process** (`electron/main.js` and helpers)  | Node.js, full OS access                                             | Holds IPC handlers, AI proxying, file IO, sessions, updater.                                                                     |
| **Shell renderer** (`src/index.html` + `src/js/*`) | Chromium renderer with **context isolation** and **preload** bridge | No Node integration; reaches main only via `window.navio` APIs exposed in `electron/preload.js`.                                 |
| **Guest `<webview>`**                              | Per-tab web content                                                 | Site origins isolated from the shell; session partitions for normal vs private browsing.                                         |
| **Extension UI / background**                      | Chromium extension contexts                                         | May use different `webPreferences` than the shell for compatibility; treat extensions as **trusted only if you installed them**. |
| **MCP servers**                                    | External processes (stdio/SSE)                                      | Run with your user privileges; can expose tools that read files or call the network depending on server configuration.           |
| **Network**                                        | Remote services                                                     | AI vendors, websites, optional Sentry, update feed, OAuth providers.                                                             |


## Primary assets to protect

- **User filesystem** — downloads, exports, profile backup paths, arbitrary paths opened via user actions.
- **Secrets** — API keys, OAuth tokens, IMAP passwords, sync passphrase material.
- **Browsing data** — history, cookies, saved passwords, page content sent to AI when the user enables context.

## Main risks (non-exhaustive)

1. **IPC abuse** — Any bug that lets untrusted renderer or webview code invoke privileged handlers without intent could exfiltrate data or drive navigation. Mitigations: context isolation, preload allowlist, validation in handlers, user confirmation for destructive **browser-action** tiers.
2. **AI tool loop** — Tools can navigate, click, type, or call MCP actions. Mitigations: confirmation gates, kill switch, data scope, PII redaction options.
3. **Malicious MCP server** — Could expose tools that leak repo or environment. Mitigations: disable MCP by default, run only servers you trust, review tool lists in Settings.
4. **Malicious extension** — Electron does not mirror Chrome’s extension sandbox identically. Mitigations: only install extensions you trust; keep **Allow extensions to use AI** off unless required.
5. **Update channel compromise** — If an attacker controls the update feed or GitHub release assets, they could ship malicious binaries. Mitigations: HTTPS-only feed, signed releases, verify checksums, use GitHub org access controls.

## What this document is not

- Not a formal penetration test or certification.
- Not legal advice.

## Related

- [IPC_INVENTORY.md](./IPC_INVENTORY.md) — channel list and owning modules.
- [UPDATES.md](./UPDATES.md) — how releases and auto-update are expected to work.