# ADR-002: Email integration strategy (MVP)

## Status

Accepted

## Context

A full native IMAP/SMTP client is a large surface area (sync, security, attachments, search).

## Decision

- **MVP:** Treat email as **web mail** opened in a normal tab (Gmail, Outlook, etc.) via Connectors Hub and bookmarks.
- **Assistant integration:** Structured **email context** type is reserved in the context graph; UI exposes “Use mail tab as context” as a follow-up when a native client exists.
- **No auto-send** in MVP; any draft/summarize features must not call send APIs without explicit future consent UX.

## Consequences

- Faster shipping; users keep provider-native UX.
- Native client and OAuth IMAP remain a Phase 5+ option without blocking other work.
