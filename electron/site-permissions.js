'use strict';

const fs = require('fs');
const path = require('path');

function storePath(userData) {
  return path.join(userData, 'navio-site-permissions.json');
}

function load(userData) {
  try {
    const p = storePath(userData);
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && typeof j.byOrigin === 'object') return j;
    }
  } catch (e) {
    console.warn('[navio] site-permissions load:', e.message);
  }
  return { version: 1, byOrigin: {} };
}

function save(userData, data) {
  try {
    fs.writeFileSync(storePath(userData), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('[navio] site-permissions save:', e.message);
    return false;
  }
}

function get(userData, origin, permission) {
  if (!origin || !permission) return null;
  const data = load(userData);
  const row = data.byOrigin[origin];
  if (!row || typeof row[permission] !== 'boolean') return null;
  return row[permission];
}

function set(userData, origin, permission, granted) {
  if (!origin || !permission) return;
  const data = load(userData);
  if (!data.byOrigin[origin]) data.byOrigin[origin] = {};
  data.byOrigin[origin][permission] = !!granted;
  save(userData, data);
}

module.exports = { get, set, load };
