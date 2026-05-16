'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Optional release-time OAuth client (written in CI from GitHub secrets).
 * Never commit real secrets — see bundled-oauth-defaults.json.example.
 */
function getBundledOAuthDefaults() {
  const fromEnv = {
    oauthGoogleClientId: String(process.env.NAVIO_OAUTH_GOOGLE_CLIENT_ID || '').trim(),
    oauthGoogleClientSecret: String(process.env.NAVIO_OAUTH_GOOGLE_CLIENT_SECRET || '').trim(),
  };
  if (fromEnv.oauthGoogleClientId) return fromEnv;

  try {
    const p = path.join(__dirname, 'bundled-oauth-defaults.json');
    if (!fs.existsSync(p)) return { oauthGoogleClientId: '', oauthGoogleClientSecret: '' };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      oauthGoogleClientId: String(raw.oauthGoogleClientId || '').trim(),
      oauthGoogleClientSecret: String(raw.oauthGoogleClientSecret || '').trim(),
    };
  } catch {
    return { oauthGoogleClientId: '', oauthGoogleClientSecret: '' };
  }
}

module.exports = { getBundledOAuthDefaults };
