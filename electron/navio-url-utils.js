'use strict';

/**
 * Pure URL helper utilities shared between main.js and IPC modules.
 * No Electron or Node dependencies — safe to require at any time.
 */

function navioIsExternalProtocolUrl(url) {
  return /^(mailto|tel|sms|callto|wtai|market|ms-windows-store):/i.test(url || '');
}

/**
 * Windows / Google sometimes emit "open in Edge/Chrome/…" handoff URLs instead of plain https.
 * If we do not rewrite them, Chromium hands the protocol off to the OS default browser and
 * OAuth leaves Navio entirely (e.g. Vercel "Sign in with Google").
 */
function navioExtractHttpsFromBrowserHandoffUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const direct =
    /^(?:microsoft-edge(?:-holographic)?|googlechrome|cometbrowser|comet|brave|vivaldi|firefox):(?:\/\/|)(https?:\/\/[^\s'"]+)/i.exec(raw);
  if (direct) return direct[2];

  const lower = raw.toLowerCase();
  if (
    lower.startsWith('microsoft-edge:') ||
    lower.startsWith('microsoft-edge-holographic:') ||
    lower.startsWith('googlechrome:')
  ) {
    try {
      const qIdx = raw.indexOf('?');
      if (qIdx !== -1) {
        const params = new URLSearchParams(raw.slice(qIdx + 1));
        const uq = params.get('url');
        if (uq && /^https?:\/\//i.test(uq)) return decodeURIComponent(uq);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function navioNormalizeTabOpenUrl(url) {
  const raw0 = String(url || '').trim();
  const raw = navioExtractHttpsFromBrowserHandoffUrl(raw0) || raw0;
  if (!raw) return 'about:blank';
  if (raw === 'about:blank') return raw;
  if (navioIsExternalProtocolUrl(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') {
      return u.href;
    }
  } catch {
    /* ignore */
  }
  return null;
}

module.exports = {
  navioIsExternalProtocolUrl,
  navioExtractHttpsFromBrowserHandoffUrl,
  navioNormalizeTabOpenUrl,
};
