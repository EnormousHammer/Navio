'use strict';

/** Valid Google Translate `tl` values are mostly 2-letter or ll-REGION (e.g. zh-cn). */
function sanitizeTranslateCode(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const s = raw.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s;
  if (/^[a-z]{2}-[a-z0-9]{2,8}$/.test(s)) return s;
  return '';
}

function localeFallback(app) {
  try {
    const loc = String(app.getLocale?.() || 'en').replace(/_/g, '-');
    const parts = loc.split('-').filter(Boolean);
    if (!parts.length) return 'en';
    const p0 = parts[0].toLowerCase();
    if (!/^[a-z]{2}$/.test(p0)) return 'en';
    if (parts.length >= 2 && /^[a-z]{2}$/i.test(parts[1])) {
      return `${p0}-${parts[1].toLowerCase()}`;
    }
    return p0;
  } catch {
    return 'en';
  }
}

/**
 * Target language for context-menu "Translate page" (Google Translate).
 * @param {import('electron').App} app
 * @param {{ translateTargetLang?: string } | null | undefined} config
 */
function resolveTranslateTargetLang(app, config) {
  const fromCfg = sanitizeTranslateCode(config && config.translateTargetLang);
  if (fromCfg) return fromCfg;
  return localeFallback(app);
}

module.exports = {
  sanitizeTranslateCode,
  localeFallback,
  resolveTranslateTargetLang
};
