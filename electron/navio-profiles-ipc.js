'use strict';

const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

function profilesDir(profilesBase) {
  return path.join(profilesBase, 'profiles');
}

function listProfileIds(profilesBase) {
  const dir = profilesDir(profilesBase);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id));
  } catch {
    return [];
  }
}

function activeProfileId() {
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith('--navio-profile='));
  const p = a ? a.slice('--navio-profile='.length).trim() : (process.env.NAVIO_PROFILE || '').trim();
  return !p || p === 'default' ? 'default' : p;
}

function registerProfilesIpc(ipcMain, { profilesBase }) {
  ipcMain.handle('profiles-list', () => {
    const base = profilesBase || app.getPath('userData');
    const ids = listProfileIds(base);
    const active = activeProfileId();
    const profiles = [{ id: 'default', name: 'Default', active: active === 'default' }];
    for (const id of ids) {
      profiles.push({ id, name: id, active: active === id });
    }
    return { profiles, profilesBase: base };
  });

  ipcMain.handle('profiles-set-active', async (_, { profileId }) => {
    const id = (profileId || 'default').trim();
    if (id !== 'default' && !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return { ok: false, error: 'Invalid profile id' };
    }
    try {
      const rawArgs = process.argv.slice(1).filter((a) => !String(a).startsWith('--navio-profile='));
      const nextArgs =
        !id || id === 'default' ? rawArgs : rawArgs.concat([`--navio-profile=${id}`]);
      app.relaunch({ args: nextArgs });
      app.exit(0);
      return { ok: true, restarting: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('profiles-create', async (_, { profileId }) => {
    const id = (profileId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return { ok: false, error: 'Use letters, numbers, underscore, hyphen (1–64 chars)' };
    }
    const base = profilesBase || app.getPath('userData');
    const dir = path.join(profilesDir(base), id);
    try {
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerProfilesIpc };
