/** @type {import('@electron-forge/shared-types').ForgeConfig} */

// Windows Authenticode signing: set WINDOWS_CERTIFICATE_FILE + WINDOWS_CERTIFICATE_PASSWORD in CI.
// See docs/RELEASE_SIGNING.md for how to decode the PFX from a GitHub secret.
const winCertFile = (process.env.WINDOWS_CERTIFICATE_FILE || '').trim();
const winCertPass = process.env.WINDOWS_CERTIFICATE_PASSWORD || '';

// macOS Developer ID signing + notarization (only when non-empty; GitHub-hosted
// runners have no cert in keychain — do not set APPLE_* secrets there unless you import a .p12).
const appleId = (process.env.APPLE_ID || '').trim();
const appleAppPassword = (process.env.APPLE_APP_SPECIFIC_PASSWORD || '').trim();
const appleTeamId = (process.env.APPLE_TEAM_ID || '').trim();
const appleIdentity = (process.env.APPLE_SIGNING_IDENTITY || '').trim();

module.exports = {
  packagerConfig: {
    name: 'Navio',
    executableName: 'navio-browser',
    asar: true,
    icon: './src/assets/icon',
    extraResource: ['./public'],

    // Windows code signing — only active when the PFX path is present in the environment.
    ...(winCertFile ? {
      certificateFile: winCertFile,
      certificatePassword: winCertPass || '',
    } : {}),

    // macOS Developer ID signing — only active when the identity is set.
    ...(appleIdentity ? {
      osxSign: {
        identity: appleIdentity,
        hardenedRuntime: true,
        entitlements: 'build/entitlements.mac.plist',
        'entitlements-inherit': 'build/entitlements.mac.plist',
      },
    } : {}),

    // macOS notarization — only active when Apple ID credentials are set.
    ...(appleId && appleAppPassword && appleTeamId ? {
      osxNotarize: {
        tool: 'notarytool',
        appleId,
        appleIdPassword: appleAppPassword,
        teamId: appleTeamId,
      },
    } : {}),
  },

  rebuildConfig: {},

  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'navio_browser',
        /** Shown in Windows “Apps & features” / installer UI. */
        title: 'Navio Browser',
        authors: 'Navio',
        description: 'Navio — AI-powered browser for Windows.',
        // Squirrel installer also picks up the cert when the env vars are set.
        ...(winCertFile ? {
          certificateFile: winCertFile,
          certificatePassword: winCertPass || '',
        } : {}),
      },
    },
    // Portable ZIPs for Releases come from electron-builder (both Windows + macOS archs).
    // Keep maker-zip for darwin only so `forge make` on Mac still has a maker; Windows uses EB zip only.
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    // macOS .dmg installers ship via electron-builder (see electron-builder.yml + CI) for stable filenames.
  ],

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
  ],

  plugins: [],
};
