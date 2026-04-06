/**
 * API key storage using Electron safeStorage when available.
 * Falls back to a separate UTF-8 file if encryption is unavailable (e.g. some Linux setups).
 */

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

function keyPath(userData) {
  return path.join(userData, 'navio-api-key.bin');
}

function hasStoredKey(userData) {
  return fs.existsSync(keyPath(userData));
}

function getApiKey(userData) {
  const p = keyPath(userData);
  if (!fs.existsSync(p)) return '';
  const buf = fs.readFileSync(p);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function setApiKey(userData, key) {
  const p = keyPath(userData);
  if (!key || typeof key !== 'string') {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(p, safeStorage.encryptString(key));
  } else {
    fs.writeFileSync(p, key, 'utf8');
  }
}

module.exports = { getApiKey, setApiKey, hasStoredKey, keyPath };
