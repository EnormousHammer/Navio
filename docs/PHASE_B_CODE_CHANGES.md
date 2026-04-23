# Phase B — remaining code and CI changes

**Status:** Markdown documentation and README links are in the repo. **Implementation of non-markdown files was blocked** (Plan mode / Agent mode switch rejected). Apply the sections below in **Agent mode** or manually.

---

## 1. `package.json`

- Add `"repository"`, `"bugs"`, `"homepage"` pointing at `https://github.com/EnormousHammer/Navio` (adjust if the canonical repo changes).
- Ensure devDependency **`@electron-forge/publisher-github`** is present (run `npm install -D @electron-forge/publisher-github@^7.11.1`).

---

## 2. `forge.config.js`

- Replace static `packagerConfig` with a small helper that reads env:

  - If `WINDOWS_CERTIFICATE_FILE` exists on disk → set `certificateFile` and `certificatePassword` from `WINDOWS_CERTIFICATE_PASSWORD`.
  - If `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` are set → set `osxNotarize` with `{ tool: 'notarytool', appleId, appleIdPassword, teamId }`.
  - If `APPLE_SIGNING_IDENTITY` is set → set `osxSign: { identity: ... }`.

- Add top-level **`publishers`:**

```js
publishers: [
  {
    name: '@electron-forge/publisher-github',
    config: {
      repository: { owner: 'EnormousHammer', name: 'Navio' },
      draft: false,
      prerelease: false,
      generateReleaseNotes: true
    }
  }
]
```

(`authToken` is optional; CI uses `GITHUB_TOKEN`.)

---

## 3. `electron/main.js` — `electron-updater` GitHub feed

Inside `navioEnsureAutoUpdaterWired()`, **before** attaching event listeners (and only when `!autoUpdater.__navioWired`), parse `require('../package.json').repository.url` with a regex for `github.com/:owner/:repo` and call:

```js
autoUpdater.setFeedURL({
  provider: 'github',
  owner,
  repo: repo.replace(/\.git$/i, '')
});
```

Wrap in try/catch and log a warning if parsing fails.

---

## 4. `.github/workflows/release.yml` (new)

- **Trigger:** `push` tags `v*`.
- **Matrix:** `windows-latest` and `macos-latest` each run `npm ci` && `npm run make`.
- **Windows:** optional step decodes secret `WINDOWS_CERTIFICATE_PFX_BASE64` to `%RUNNER_TEMP%\navio-sign.pfx` (PowerShell) and sets `WINDOWS_CERTIFICATE_FILE` / `WINDOWS_CERTIFICATE_PASSWORD` env for Forge.
- **macOS:** pass `APPLE_*` secrets as env for notarize/sign.
- **Publish:** either  
  - run `npx electron-forge publish` **once** after merging artifacts (recommended: third job downloads both `out/make` trees and publishes), or  
  - run publish on each runner if you confirm the GitHub publisher **merges assets** onto one release without races.

- **Permissions:** `contents: write` where `GITHUB_TOKEN` publishes.

---

## 5. `.github/dependabot.yml` (new)

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
```

---

## 6. `.github/workflows/build.yml`

- After `npm test` / `npm run lint`, add a step:

```yaml
- run: npm audit --audit-level=high
  continue-on-error: true
```

Tighten to `false` when the backlog is clean.

---

## 7. `src/index.html` — About panel

Under **Settings → About**, add links (open in default browser) using existing `window.navio.openExternal`:

- Privacy — `https://github.com/EnormousHammer/Navio/blob/main/docs/PRIVACY.md`
- Security — `https://github.com/EnormousHammer/Navio/blob/main/docs/SECURITY_THREAT_MODEL.md`
- Third-party — `https://github.com/EnormousHammer/Navio/blob/main/docs/THIRD_PARTY_NOTICES.md`

Use `<button type="button" class="btn btn-secondary">` with small scripts or `onclick` calling `window.navio.openExternal(...)` (match existing patterns in the codebase).

---

## 8. Post-merge verification

- Tag `v1.0.1` (or bump `package.json` version first), run release workflow, confirm **GitHub Release** assets and that a **packaged** app finds updates.
- macOS: `spctl --assess -vv` on the built app when signed + notarized.

---

After these steps are applied, delete or trim this file if you no longer need the checklist.
