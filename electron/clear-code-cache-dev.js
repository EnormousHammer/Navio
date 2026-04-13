'use strict';

/**
 * Clears renderer code caches on startup when running with `--dev`
 * (see package.json script `dev`). Packaged/production launches skip this for faster cold start.
 */
async function clearRendererCodeCachesIfDev(app, session, fs, path) {
  if (!app.commandLine.hasSwitch('dev')) return;

  console.log('[navio] Dev mode: clearing renderer code caches');
  try {
    await session.defaultSession.clearCodeCaches({});
  } catch (e) {
    console.warn('[navio] session.clearCodeCaches failed:', e.message);
  }
  try {
    const codeCachePath = path.join(app.getPath('userData'), 'Code Cache');
    if (fs.existsSync(codeCachePath)) {
      fs.rmSync(codeCachePath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[navio] Could not clear code cache folder:', e.message);
  }
}

module.exports = { clearRendererCodeCachesIfDev };
