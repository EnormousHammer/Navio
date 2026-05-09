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

On Windows runners, the workflow decodes `WINDOWS_CERTIFICATE_PFX_BASE64` into a temp `.pfx` and sets `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD` for Forge. **GitHub-hosted macOS runners do not inject `APPLE_*` secrets** into `npm run make`: if you set `APPLE_SIGNING_IDENTITY` without importing a matching certificate into the runner keychain, **codesign fails** and the build breaks. For hosted CI, builds are **unsigned**; add a prior workflow step to import a `.p12` and then export `APPLE_*` when you are ready for signed mac artifacts in CI.

### Enable CI to publish GitHub Releases (one-time)

The **Release** workflow (`.github/workflows/release.yml`) uses `GITHUB_TOKEN` with `permissions: contents: write` to run **`electron-forge publish`**. Your repository must allow that token to write contents:

1. GitHub → **Settings** → **Actions** → **General**.
2. Under **Workflow permissions**, choose **Read and write permissions**.
3. Save.

If this stays on **Read repository contents and packages permissions** only, publish steps will fail when creating or updating the release. Organization owners can enforce a default; this repo may need an exception.

### GitHub Actions artifact storage quota

If a job fails with **`Failed to CreateArtifact: Artifact storage quota has been hit`**, the build itself may have succeeded; **uploading** workflow artifacts failed because the account/org exceeded [Actions artifact storage](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions#artifact-storage). **Fix:** GitHub → **Settings** → **Actions** → **General** → **Artifacts** (or the org’s storage view) → **delete old artifacts**, or buy more storage. The **Build** workflow does not upload `out/make` (only verifies); **Release** uploads keep **`retention-days: 3`** so large blobs expire quickly after publish.

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

## Publishing release assets

- **CI** (`.github/workflows/release.yml` on tag `v*`) runs **`npx electron-forge publish`** twice (Windows job, then macOS job) so all built assets attach to the same **GitHub Release**. Requires workflow **read/write** permission (see above).
- **Fallback — local publish:** With `GH_TOKEN` or `GITHUB_TOKEN` exported and **`contents: write`**, run `npm run publish` from a machine that has the `out/make` outputs you want to ship.

## Operational notes

- Rotate certificates and secrets on compromise or staff change.
- Keep **release artifacts immutable** once published; ship a new version for fixes.
