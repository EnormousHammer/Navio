'use strict';

/**
 * Host/path fragments for network + popup blocking. Matched with String#includes
 * against the full request or popup URL (case-sensitive is fine for these tokens).
 */
const AD_BLOCK_PATTERNS = [
  'doubleclick.net',
  'googlesyndication.com',
  'adservice.google',
  'googleadservices.com',
  'googletagservices.com',
  'tpc.googlesyndication.com',
  'pagead2.googlesyndication.com',
  'fundingchoicesmessages.google.com',
  'amazon-adsystem.com',
  'assoc-amazon.com',
  'ads.yahoo.com',
  'gemini.yahoo.com',
  'advertising.yahoo.com',
  'syndication.twitter.com',
  'ads.twitter.com',
  'ads.linkedin.com',
  'snap.licdn.com',
  'facebook.com/tr',
  'connect.facebook.net',
  'analytics.facebook.com',
  'scorecardresearch.com',
  'quantserve.com',
  'quantcast.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'openx.com',
  'casalemedia.com',
  'criteo.com',
  'criteo.net',
  'bidswitch.net',
  'sharethrough.com',
  'triplelift.com',
  'smartadserver.com',
  'smaato.net',
  'spotxchange.com',
  'spotx.tv',
  'teads.tv',
  'teads.com',
  'yieldmo.com',
  'zedo.com',
  'undertone.com',
  'unrulymedia.com',
  'media.net',
  'outbrain.com',
  'outbrainimg.com',
  'taboola.com',
  'revcontent.com',
  'mgid.com',
  'propellerads.com',
  'propellerclick.com',
  'adzerk.net',
  'adzerk.com',
  'advertising.com',
  'adtech.de',
  'adform.net',
  'moatads.com',
  'adsafeprotected.com',
  'adcolony.com',
  'appsflyer.com',
  'adjust.com',
  'adjust.io',
  'mopub.com',
  'chartboost.com',
  'adrollapp.com',
  'buysellads.com',
  'buysellads.net',
  'pagefair.com',
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'crazyegg.com',
  'mixpanel.com',
  'amplitude.com',
  'heap.com',
  'heapanalytics.com',
  'popads.net',
  'popcash.net',
  'exoclick.com',
  'trafficjunky.net',
  'trafficholder.com',
  'cdnwidget.com',
  'adnium.com',
  'justpremium.com',
  // Popup / redirect / pop-under heavy (often not loaded as subresources)
  'adf.ly',
  'adfoc.us',
  'ouo.io',
  'bc.vc',
  'linkbucks.com',
  'clicksfly.com',
  'clk.sh',
  'destyy.com',
  'shortest.link',
  'click.dtiserv.com',
  'rotator.tradetracker.net',
  'tracking.binarypromos.com',
  'syndication.exoclick.com',
  'serving-sys.com',
  'bs.serving-sys.com',
  'fastclick.net',
  'eyeblaster.com',
  'mediaplex.com',
  '247realmedia.com',
  'atwola.com',
  'hitbox.com',
  'interclick.com',
  'questionmarket.com',
  '2mdn.net'
];

function urlMatchesAdBlock(url) {
  if (!url || typeof url !== 'string') return false;
  return AD_BLOCK_PATTERNS.some((p) => url.includes(p));
}

/** Avoid blocking OAuth / SSO flows that use small or blank pop-up windows. */
function isOAuthOrLoginUrl(url) {
  if (!url || url === 'about:blank') return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    const p = `${u.pathname}${u.search}`.toLowerCase();
    if (h === 'accounts.google.com' || (h.endsWith('.google.com') && /\/(o\/oauth|accounts\/)/.test(p))) return true;
    if (h.endsWith('login.microsoftonline.com')) return true;
    if (h.endsWith('github.com') && p.includes('/login/oauth')) return true;
    if (h.endsWith('facebook.com') && p.includes('/dialog/oauth')) return true;
    if (h.includes('auth0.com')) return true;
    if (h.includes('okta.com') && p.includes('oauth')) return true;
    if (h.startsWith('appleid.apple.com')) return true;
    if (/[?&]client_id=/.test(u.search)) return true;
    if (p.includes('/oauth') || p.includes('/oauth2/')) return true;
    return false;
  } catch {
    return false;
  }
}

/** Typical script-driven ad pop-ups; real SSO windows are usually larger. */
function isLikelyAdSizedPopup(width, height) {
  if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) return false;
  return width <= 520 && height <= 560;
}

/**
 * window.open features that strip multiple chrome UI pieces — common for ad pop-unders
 * and script-driven windows (Chrome blocks these aggressively).
 */
function featuresSuggestScriptPopup(features) {
  const f = String(features || '');
  if (!f.trim()) return false;
  const stripped = ['menubar', 'toolbar', 'location', 'status', 'scrollbars'].filter((name) =>
    new RegExp(`${name}\\s*=\\s*(no|0|false)`, 'i').test(f)
  );
  return stripped.length >= 2;
}

/**
 * @param {{ url?: string, disposition?: string, optionsWidth?: number, optionsHeight?: number, features?: string, hasPostBody?: boolean, siteAllowsPopups?: boolean, cfg: { adBlockEnabled?: boolean, popupBlockerEnabled?: boolean, adStrictPopupBlock?: boolean } }} payload
 */
function shouldBlockWebPopup(payload) {
  const url = (payload && payload.url) || '';
  const disposition = (payload && payload.disposition) || 'default';
  const width = payload && payload.optionsWidth;
  const height = payload && payload.optionsHeight;
  const features = (payload && payload.features) || '';
  const hasPostBody = !!(payload && payload.hasPostBody);
  const siteAllowsPopups = !!(payload && payload.siteAllowsPopups);
  const cfg = payload && payload.cfg;
  if (!cfg) return false;

  if (cfg.adBlockEnabled !== false && urlMatchesAdBlock(url)) return true;

  if (hasPostBody) return false;
  if (siteAllowsPopups) return false;

  if (cfg.popupBlockerEnabled === false) return false;

  if (disposition === 'foreground-tab' || disposition === 'background-tab') return false;
  if (isOAuthOrLoginUrl(url)) return false;

  const noUrl = !url || url === 'about:blank';
  const small = isLikelyAdSizedPopup(width, height);
  const oauthSizedBlank =
    noUrl &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    (width >= 480 || height >= 520);
  if (oauthSizedBlank) return false;

  if (featuresSuggestScriptPopup(features)) return true;

  if (cfg.adStrictPopupBlock === false) return false;

  if (noUrl && small) return true;
  if (!noUrl && small && !isOAuthOrLoginUrl(url)) return true;
  return false;
}

module.exports = {
  AD_BLOCK_PATTERNS,
  urlMatchesAdBlock,
  isOAuthOrLoginUrl,
  isLikelyAdSizedPopup,
  featuresSuggestScriptPopup,
  shouldBlockWebPopup
};
