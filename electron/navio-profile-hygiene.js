'use strict';

const fs = require('fs');
const path = require('path');
const { getBundledOAuthDefaults } = require('./bundled-oauth-defaults');

/** Bump when a one-time cleanup must run for all installs (public-release hygiene). */
const PROFILE_GENERATION = 2;

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

function applyBundledOAuthDefaults(loadConfig, saveConfig) {
  const bundled = getBundledOAuthDefaults();
  if (!bundled.oauthGoogleClientId) return;

  const cfg = loadConfig();
  let changed = false;
  if (!(cfg.oauthGoogleClientId || '').trim()) {
    cfg.oauthGoogleClientId = bundled.oauthGoogleClientId;
    changed = true;
  }
  if (!(cfg.oauthGoogleClientSecret || '').trim() && bundled.oauthGoogleClientSecret) {
    cfg.oauthGoogleClientSecret = bundled.oauthGoogleClientSecret;
    changed = true;
  }
  if (changed) saveConfig(cfg);
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
 * so GitHub installers start empty. Re-applies bundled OAuth client when present.
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

  if (current >= PROFILE_GENERATION) {
    applyBundledOAuthDefaults(loadConfig, saveConfig);
    return;
  }

  clearOAuthTokens(userData);
  clearImapCreds(userData);
  stripPersonalConfigFields(loadConfig, saveConfig);
  applyBundledOAuthDefaults(loadConfig, saveConfig);

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
  applyBundledOAuthDefaults,
  STRIP_CONFIG_KEYS,
};
