/**
 * Navio home + setup wallpaper — same image as the new tab page.
 * Resolved via main process so packaged builds load from extraResources/public/.
 */
const NavioWallpaper = (() => {
  const DEFAULT_FILE = 'navio_background.jpg';
  let _cachedHref = null;

  async function resolveUrl(fileName = DEFAULT_FILE) {
    if (fileName === DEFAULT_FILE && _cachedHref) return _cachedHref;
    try {
      const r = await window.navio.getPublicAssetUrl(fileName);
      if (r && r.ok && r.href) {
        if (fileName === DEFAULT_FILE) _cachedHref = r.href;
        return r.href;
      }
    } catch { /* fallback below */ }
    const rel = `../public/${encodeURIComponent(fileName)}`;
    if (fileName === DEFAULT_FILE) _cachedHref = rel;
    return rel;
  }

  async function applyTo(selectors, fileName = DEFAULT_FILE) {
    const href = await resolveUrl(fileName);
    const value = `url("${String(href).replace(/"/g, '%22')}")`;
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.backgroundImage = value;
      });
    }
  }

  return {
    applyAll: () => applyTo(['.ntp-bg-layer', '.ob-bg-layer']),
    applyNtp: () => applyTo('.ntp-bg-layer'),
    applyOnboarding: () => applyTo('.ob-bg-layer'),
  };
})();
