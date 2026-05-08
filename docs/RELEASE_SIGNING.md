# Release signing (Windows and macOS)

Signing and notarization are **optional in local dev** but expected for **public releases** so users and OS gatekeepers can trust binaries.

## Windows (Authenticode)

1. Obtain a **code signing certificate** (PFX or hardware token per your CA).
2. In CI, avoid committing the PFX. Store **base64 of the PFX** in a GitHub Actions secret (example name: `WINDOWS_CERTIFICATE_PFX_BASE64`) and the password in `WINDOWS_CERTIFICATE_PASSWORD`.
3. In the workflow, decode the PFX to a temp path and set:

   - `WINDOWS_CERTIFICATE_FILE` — absolute path to the `.pfx` file  
   - `WINDOWS_CERTIFICATE_PASSWORD` — password string  

4. **Electron Forge** passes these through `packagerConfig` as `certificateFile` / `certificatePassword` when the file exists (see `forge.config.js`).

### GitHub Actions (`.github/workflows/build.yml` and `release.yml`)

Store the following as **repository secrets** (Settings → Secrets and variables → Actions). Omit any you do not use; builds then ship unsigned for that platform.

| Secret | Used for |
|--------|----------|
| `WINDOWS_CERTIFICATE_PFX_BASE64` | Base64 of the `.pfx` file (Windows Authenticode). |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for that PFX. |
| `APPLE_SIGNING_IDENTITY` | Exact name of the “Developer ID Application: …” identity on the macOS runner. |
| `APPLE_ID` | Apple ID email for notarytool. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization. |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID. |

On Windows runners, the workflow decodes `WINDOWS_CERTIFICATE_PFX_BASE64` into a temp `.pfx` and sets `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD` for Forge. macOS jobs pass the `APPLE_*` variables into `npm run make` so `osxSign` / `osxNotarize` in `forge.config.js` activate when all required values are present.

## macOS (Developer ID + notarytool)

1. Enroll in the **Apple Developer Program**.
2. Create a **Developer ID Application** signing identity.
3. Create an **app-specific password** for notarization (Apple ID account).
4. Export these to CI secrets, for example:

   - `APPLE_ID` — Apple ID email  
   - `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password  
   - `APPLE_TEAM_ID` — 10-character team ID  
   - `APPLE_SIGNING_IDENTITY` — exact name of the “Developer ID Application: … (…)” identity  

5. Forge `packagerConfig` should set `osxSign.identity` when `APPLE_SIGNING_IDENTITY` is set, and `osxNotarize` with `tool: 'notarytool'` when Apple ID env vars are set.

## Publishing release assets (not done in CI)

- **CI** (`.github/workflows/release.yml` on tag `v*`) only produces **workflow artifacts**. Create the GitHub Release yourself and upload the built `Setup.exe`, ZIPs, Squirrel `RELEASES` / `.nupkg` if you use them, and macOS ZIPs from those artifacts.
- **Optional — local Forge publish:** On a machine with network access and a token that has **`contents: write`** on the repo, run `npm run publish` (or `npx electron-forge publish`) so **`@electron-forge/publisher-github`** uploads to a release. That uses your environment (for example `GH_TOKEN` / `GITHUB_TOKEN`), not the tag workflow.

## Operational notes

- Rotate certificates and secrets on compromise or staff change.
- Keep **release artifacts immutable** once published; ship a new version for fixes.
