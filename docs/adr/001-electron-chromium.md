# ADR-001: Rendering engine and shell

## Status

Accepted

## Context

Navio ships as an **Electron** application, embedding **Chromium** via the `webview` tag for tabs.

## Decision

- **Stay on Electron + Chromium** for the medium term.
- Do **not** fork the engine for MVP; rely on Chromium sandboxing and site isolation as provided by Electron updates.

## Consequences

- Fast path to WebExtensions-style features later; shared codebase with existing `webview` implementation.
- Long-term, engine choice can be revisited if WebView2 or Gecko embedding is required for enterprise policy.
