# Third-party open source notices

Navio is built on many open-source components. The following are major direct dependencies as of the last manual refresh of this file; run a full license audit (e.g. `npx license-checker --summary`) before a commercial release to satisfy your compliance process.

| Project | License | Use |
|---------|---------|-----|
| [Electron](https://www.electronjs.org/) | MIT | Desktop shell and Chromium embedding |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | Auto-update client |
| [@electron-forge/*](https://www.electronforge.io/) | MIT | Packaging and publishing |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP client |
| [@sentry/electron](https://github.com/getsentry/sentry-electron) | MIT | Optional crash reporting |
| [adm-zip](https://github.com/cthackers/adm-zip) | MIT | ZIP handling |
| [imapflow](https://imapflow.com/) | MIT | IMAP client |

Full transitive notices belong in a generated file in your release pipeline if required (e.g. `THIRD_PARTY_NOTICES.txt`).
