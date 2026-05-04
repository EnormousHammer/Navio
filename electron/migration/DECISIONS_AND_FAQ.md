# Decisions & FAQ (stub — avoid drift)

**Single handoff file *in this repo*:** `**NAVIO_NATIVE/README.md`** (entire native reboot instructions — no second file).

**Canonical decisions doc (long form):** `..\navio_browser\DECISIONS_AND_FAQ.md` (optional mirror next to this repo).

**Policy:** Keep this file a **short pointer only**. When decisions change, edit the canonical file first, then adjust this stub if the link or one-liners need updating.

**Branding (owner preference):** User-facing name **NAVIO** — *Where intelligence meets the internet.* (Repo / folders may stay `NavioBrowser`, `navio_browser`, etc.)

**Phase 0 (native stack):** See canonical **§ Phase 0 — how to start** + **§ Research summary — AI agent control** (CEF vs WebView2 vs fork for CDP / complex tasks).

**Electron export work:** Not blocked unless you bump `navioMigrationExportVersion` or change export layout — then update `MIGRATION_PLAN.md` + canonical `DECISIONS_AND_FAQ.md` + `navio_browser\migration\` mirror.