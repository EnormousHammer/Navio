'use strict';

const fs = require('fs');
const path = require('path');
/** Bump when a one-time cleanup must run for all installs (public-release hygiene). */
const PROFILE_GENERATION = 3;

/** Never restore these from an old folder — user signs in / imports themselves. */
const STRIP_CONFIG_KEYS = [
  'oauthGoogleClientId',
  'oauthGoogleClientSecret',
  'importedBookmarks',
  'importSource',
  'userName',
  'syncEnabled',
  'syncFolderPath',
  'syncLastSeenExportedAt',
];

function generationPath(userData) {
  return path.join(userData, 'navio-profile-generation.json');
}

function clearOAuthTokens(userData) {
  const p = path.join(userData, 'navio-oauth-tokens.json');
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.warn('[navio] clear OAuth tokens:', e.message);
  }
}

function clearImapCreds(userData) {
  const p = path.join(userData, 'navio-imap-creds.json');
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.warn('[navio] clear IMAP creds:', e.message);
  }
}

function stripPersonalConfigFields(loadConfig, saveConfig) {
  const cfg = loadConfig();
  let changed = false;
  for (const key of STRIP_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cfg, key)) {
      delete cfg[key];
      changed = true;
    }
  }
  if (changed) saveConfig(cfg);
}

/**
 * One-time migration: clear signed-in mail accounts and dev-only config leftovers
 * so public installers start empty. Does not inject any OAuth client — each user
 * (or your org) configures Google credentials in Settings if needed.
 *
 * Does not touch navio-passwords.json — managed Stremio login stays in the vault.
 * Call ensureStremioManagedLogin() after this runs to refresh from OEM file if present.
 */
function maybeApplyProfileHygiene({ app, loadConfig, saveConfig }) {
  const userData = app.getPath('userData');
  const genPath = generationPath(userData);
  let current = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(genPath, 'utf8'));
    current = Number(raw.generation) || 0;
  } catch {
    /* first launch */
  }

  if (current >= PROFILE_GENERATION) return;

  clearOAuthTokens(userData);
  clearImapCreds(userData);
  stripPersonalConfigFields(loadConfig, saveConfig);

  try {
    fs.writeFileSync(
      genPath,
      JSON.stringify({ generation: PROFILE_GENERATION, appliedAt: Date.now() }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.warn('[navio] profile generation marker:', e.message);
  }

  console.info(
    '[navio] Profile hygiene applied (generation',
    PROFILE_GENERATION,
    ') — mail sign-ins cleared; use Sign in with Google for your own account.'
  );
}

module.exports = {
  PROFILE_GENERATION,
  maybeApplyProfileHygiene,
  STRIP_CONFIG_KEYS,
};
