# Navio Electron → new browser migration plan

This folder (`electron/migration/`) is the **only** place migration export logic should live. The exporter writes a **single timestamped directory** (see Settings → Browser → **Export everything…**).

## What the new host should import (priority order)

1. **`secrets.json`** — Main `apiKey`, `connectorApiKeys`, `oauthTokens`, `imapAccounts`, `passwordVault`, `syncPassphrase`, optional `oemStremioCredentials`. Store with your new vault/crypto model; delete the export folder after import.
2. **`settings.json`** — Full merged preferences (homepage, NTP, AI toggles, `mcpServers` list lives here too; `mcp-config.json` duplicates MCP slice for convenience).
3. **`config-on-disk.json`** — Optional raw snapshot of `navio-config.json` (apiKey stripped) for diffing or missing-default recovery.
4. **`bookmarks.json`** / **`history.json`** / **`reading-list.json`** — Standard data stores.
5. **`extensions.json`** + **`extensions-unpacked-index.json`** — Extension registry + per-id `manifest.json` snapshots; **reinstall** unpacked/CRX binaries in the new product (paths in the index are Electron userData paths).
6. **`memory.json`**, **`context-graph.json`**, **`workspace.json`**, **`assistant-chat.json`** — AI memory / workspace / chat persistence.
7. **`site-permissions.json`**, **`site-compat.json`** — Per-site popup/compat flags.
8. **`schedules.json`**, **`live-connector-data.json`**, **`workflows-legacy.json`**, **`recorded-workflows/`**, **`skills/`** — Automations, connectors cache, workflows, per-site skills.
9. **`action-ledger.jsonl`** (+ **`action-ledger.meta.json`** if truncated) — Agent/action log; cap was 20 MB in source.
10. **`sync-cloud-navio-sync.navbak`** / **`navio-sync-local-copy.navbak`** — Encrypted profile blobs; need existing passphrase flow to decrypt inside the new app if you still use that format.
11. **`extra-userdata/`** — Catch-all for **other** top-level `*.json` / `*.jsonl` / `*.navbak` found under userData (future files we did not hard-code). Review each release.
12. **`e2e-assistant.json`**, **`e2e-ready.marker.txt`** — Dev only; safe to ignore in production importers.

## Intentionally not exportable from Electron (plan for manual gap)

| Item | Why |
|------|-----|
| Logged-in **sessions** (cookies, HTTP cache, storage) | Lives in Chromium partitions (`Partitions/`, `Session Storage`, etc.), not in the JSON we own. Users re-login or use OS/browser profile export separately if ever needed. |
| **Extension binaries** | Under `userData/extensions/<id>/`; too large and path-specific. Use `extensions-unpacked-index.json` to reinstall. |
| **Code Cache / GPUCache** | Rebuild automatically. |
| **Other Navio profiles** | Export is for the **active** `userData` directory only. Repeat export per profile (`--navio-profile=`). |

## Next engineering steps (new browser repo)

1. Implement **import wizard**: read `manifest.json` → validate `navioMigrationExportVersion`.
2. Map **`settings.json`** keys to your config schema (rename or subset as needed).
3. Map **`secrets.json`** into your secret store (never write plaintext back to disk long-term).
4. Implement **bookmark/history** importers matching your DB or JSON shape.
5. **OAuth**: refresh tokens in `oauthTokens` — wire to your token refresh pipeline per provider.
6. **MCP**: `settings.mcpServers` + `mcp-config.json` — spawn or SSE connect from your main process.
7. Add automated **round-trip tests** using a sanitized fake export folder in CI.

## Versioning

- Bump **`navioMigrationExportVersion`** in `write-folder.js` whenever you add/remove/rename export artifacts so the importer can branch.
