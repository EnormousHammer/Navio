'use strict';

/**
 * Host/path fragments for network + popup blocking. Matched with String#includes
 * against the full request or popup URL (case-sensitive is fine for these tokens).
 *
 * Not a full filter list (no cosmetic rules). Avoid bare CDNs / shared hosts (e.g. cloudflare,
 * jsdelivr) — those need dedicated rules, not substring matches.
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
  // Fake "install ad blocker / continue download" intermediaries (often unwanted extensions or worse)
  'heroadblocker.pro',
  'continue2download.com',
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
  '2mdn.net',
  // Video preroll / VAST / HTML5 IMA — common in third-party embed players (sports streams, etc.).
  // Do not use bare `googleapis.com`; IMA is only under this host.
  'imasdk.googleapis.com',
  'fwmrm.net',
  'freewheel.tv',
  'innovid.com',
  'springserve.com',
  'smartclip.net',
  'lkqd.net',
  'spotxcdn.com',
  // Extended: SSPs / exchanges / DMPs / video / mobile (EasyList-style third-party ad hosts).
  '1rx.io',
  '33across.com',
  '360yield.com',
  'adkernel.com',
  'admanmedia.com',
  'adition.com',
  'adition.net',
  'adriver.ru',
  'adskeeper.com',
  'adsrvr.org',
  'adsymptotic.com',
  'adtechus.com',
  'advanced-web-analytics.com',
  'advangelists.com',
  'aggregateknowledge.com',
  'airpr.com',
  'alexametrics.com',
  'amped.io',
  'applovin.com',
  'axonix.com',
  'beachfrontmedia.com',
  'betweendigital.com',
  'bluekai.com',
  'brand-display.com',
  'brealtime.com',
  'bttrack.com',
  'carbonads.com',
  'carbonads.net',
  'contextweb.com',
  'crwdcntrl.net',
  'demdex.net',
  'districtm.io',
  'districtm.net',
  'dotomi.com',
  'dyntrk.com',
  'emxdgt.com',
  'everesttech.net',
  'eyeota.net',
  'flashtalking.com',
  'gumgum.com',
  'id5-sync.com',
  'id5.io',
  'improvedigital.com',
  'indexexchange.com',
  'indexww.com',
  'ironsource.mobi',
  'krxd.net',
  'lijit.com',
  'liftoff.io',
  'liveintent.com',
  'liveramp.com',
  'mathtag.com',
  'mintegral.com',
  'moloco.com',
  'nexac.com',
  'nexage.com',
  'omtrdc.net',
  'owneriq.net',
  'ozoneproject.com',
  'pangle.io',
  'pippio.com',
  'playwire.com',
  'pub.network',
  'rezync.com',
  'rlcdn.com',
  'seedtag.com',
  'simpli.fi',
  'sovrn.com',
  'sonobi.com',
  'stickyadstv.com',
  'telaria.com',
  'the-ozone-project.com',
  'tremorhub.com',
  'tremorvideo.com',
  'tvpixel.com',
  'turn.com',
  'tapjoy.com',
  'unityads.unity3d.com',
  'vungle.com',
  'w55c.net',
  'yieldlab.net',
  'yieldoptimizer.com',
  // Extended batch 2: additional exchanges, measurement, mobile, video intermediaries.
  'acuityplatform.com',
  'adblade.com',
  'admarketplace.net',
  'admob.com',
  'adnexus.com',
  'adocean.pl',
  'adotmob.com',
  'adsfac.net',
  'adshuffle.com',
  'adsonar.com',
  'adtheorent.com',
  'adtilt.com',
  'adversal.com',
  'advertserve.com',
  'advertstream.com',
  'atdmt.com',
  'bannerflow.com',
  'bidr.io',
  'bidtellect.com',
  'bigabid.com',
  'blismedia.com',
  'btrll.com',
  'burstmedia.com',
  'c212.net',
  'c3metrics.com',
  'c3tag.com',
  'cedexis.com',
  'celtra.com',
  'cheetahmobile.com',
  'clickadilla.com',
  'clickfuse.com',
  'clicktripz.com',
  'clientgear.com',
  'clixgalore.com',
  'clixmetrix.com',
  'comscore.com',
  'connatix.com',
  'connextra.com',
  'crispadvertising.com',
  'cxense.com',
  'dealmedia.com',
  'demandbase.com',
  'domdex.com',
  'doubleverify.com',
  'e-planning.net',
  'eadexchange.com',
  'epom.com',
  'exdynsrv.com',
  'exosrv.com',
  'eyereturn.com',
  'eyereturn.net',
  'flurry.com',
  'imrworldwide.com',
  'ipredictive.com',
  'jivox.com',
  'knorex.com',
  'krux.com',
  // Sports-streaming / embed-player specific ad networks (popunders, push, video pre-roll).
  // These are the dominant ad vendors on third-party sports stream embeds (streamed.pk, etc.).
  'adsterra.com',
  'adsterra.net',
  'hilltopads.net',
  'hilltopads.com',
  'ad-maven.com',
  'admavencdn.com',
  'clickadu.com',
  'adcash.com',
  'adcash.net',
  'trafficstars.com',
  'traffichunt.com',
  'yllix.com',
  'juicyads.com',
  'juicyadult.com',
  'valueimpression.com',
  'contentabc.com',
  'realsrv.com',
  // Video pre-roll / outstream ad networks common in embed players
  'primis.tech',
  'vidazoo.com',
  'adinplay.com',
  'vmg-ad.com',
  // Push-notification consent scripts — streaming sites use these as an ad vector
  'onesignal.com',
  'pushcrew.com',
  'pushengage.com',
  'pushassist.com',
  'pushpushgo.com',
  'web-push-notifications.com',
  'megapu.sh',
  'propush.me',
  'pushground.com',
  'richpush.co',
  'onsitepush.com'
];

function urlMatchesAdBlock(url) {
  if (!url || typeof url !== 'string') return false;
  return AD_BLOCK_PATTERNS.some((p) => url.includes(p));
}

/**
 * Whether the webRequest handler should cancel this URL (ad blocking).
 * We still match the same URL fragments as {@link urlMatchesAdBlock}, but **do not** cancel
 * **image** or **font** requests: many legitimate URLs contain substrings that collide with
 * the blocklist (CDN paths, query params, `facebook.com/tr…`, etc.), which breaks logos,
 * icons, and product images. Scripts, XHRs, frames, and other subresources stay blocked.
 */
function shouldBlockAdNetworkRequest(url, resourceType) {
  if (!urlMatchesAdBlock(url)) return false;
  const rt = String(resourceType || '').toLowerCase();
  if (rt === 'image' || rt === 'font') return false;
  return true;
}

/**
 * Gmail attachments, inline images, and Drive/Docs viewer targets opened via window.open.
 * These often use small chrome-stripped windows and must not be classified as ad popups.
 */
function isGoogleMailDownloadOrContentUrl(url) {
  if (!url || typeof url !== 'string' || url === 'about:blank') return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h === 'mail.google.com' || h.endsWith('.mail.google.com')) return true;
    if (h === 'inbox.google.com') return true;
    if (h.endsWith('.googleusercontent.com')) return true;
    if (h === 'drive.google.com' || h.endsWith('.drive.google.com')) return true;
    if (h === 'docs.google.com') return true;
    return false;
  } catch {
    return false;
  }
}

/** Opener page is Gmail — used to allow a blank pre-navigation download window with script-like features. */
function isMailGoogleOpenerOrigin(openerOrigin) {
  if (!openerOrigin || typeof openerOrigin !== 'string') return false;
  try {
    const u = new URL(openerOrigin);
    const h = u.hostname.toLowerCase();
    return h === 'mail.google.com' || h.endsWith('.mail.google.com') || h === 'inbox.google.com';
  } catch {
    return false;
  }
}

/**
 * Courier / freight / broker sites often use window.open(about:blank, ..., stripped chrome) for
 * label preview, print, or quote PDF — same pattern as Gmail downloads. Allow when the opener
 * is a known carrier/shipping domain so Navio can route to a new tab instead of denying silently.
 */
function isShippingCarrierOpenerOrigin(openerOrigin) {
  if (!openerOrigin || typeof openerOrigin !== 'string') return false;
  try {
    const h = new URL(openerOrigin).hostname.toLowerCase();
    const roots = [
      'purolator.com',
      'fedex.com',
      'ups.com',
      'dhl.com',
      'usps.com',
      'canadapost-postescanada.ca',
      'canadapost.ca',
      'postescanada.ca',
      'tql.com',
      'chrobinson.com',
      'shipstation.com',
      'ontrac.com',
      'lasership.com',
      'spee-dee.com',
      'gls-canada.com',
      'gls-group.com',
      'stamps.com',
      'easypost.com',
      'freightcom.com'
    ];
    return roots.some((s) => h === s || h.endsWith('.' + s));
  } catch {
    return false;
  }
}

/**
 * Live / VoD streaming sites often open window.open with stripped chrome (ads, preroll, or player
 * helpers). Treat like mail/shipping: do not block those popups; main opens them as tabs instead.
 */
function isStreamingVideoOpenerOrigin(openerOrigin) {
  if (!openerOrigin || typeof openerOrigin !== 'string') return false;
  try {
    const h = new URL(openerOrigin).hostname.toLowerCase();
    const roots = [
      'youtube.com',
      'youtu.be',
      'twitch.tv',
      'twitch.com',
      'kick.com',
      'vimeo.com',
      'dailymotion.com',
      'rumble.com',
      'bilibili.com',
      'nicovideo.jp',
      'nimo.tv',
      'streamable.com',
      'facebook.com',
      'instagram.com',
      // Predicta sports hub — streams open via streamed.pk embeds
      'predicta-bet.vercel.app',
      'streamed.su',
      'embedme.today',
      'embedsports.me',
      'watchsports.today'
    ];
    return roots.some((s) => h === s || h.endsWith('.' + s));
  } catch {
    return false;
  }
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

/**
 * Document Picture-in-Picture (and similar) opens a blank same-origin window with explicit
 * width/height like a wide video frame. Without this, strict pop-up rules block PiP on sites
 * that are not in the streaming allowlist (e.g. embedded players on blogs).
 * Excludes common IAB-style rectangles (e.g. 400×250) via aspect / minimum height rules.
 */
function isLikelyDocumentPictureInPictureShape(width, height) {
  if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1) return false;
  if (width < 200 || width > 896 || height < 120 || height > 520) return false;
  const r = width / height;
  if (r >= 1.65 && height >= 140) return true;
  if (r >= 1.28 && r <= 1.45 && height >= 220) return true;
  return false;
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
 * @param {{ url?: string, disposition?: string, optionsWidth?: number, optionsHeight?: number, features?: string, hasPostBody?: boolean, siteAllowsPopups?: boolean, openerOrigin?: string, cfg: { adBlockEnabled?: boolean, popupBlockerEnabled?: boolean, adStrictPopupBlock?: boolean } }} payload
 */
function shouldBlockWebPopup(payload) {
  const url = (payload && payload.url) || '';
  const disposition = (payload && payload.disposition) || 'default';
  const width = payload && payload.optionsWidth;
  const height = payload && payload.optionsHeight;
  const features = (payload && payload.features) || '';
  const hasPostBody = !!(payload && payload.hasPostBody);
  const siteAllowsPopups = !!(payload && payload.siteAllowsPopups);
  const openerOrigin = (payload && payload.openerOrigin) || '';
  const cfg = payload && payload.cfg;
  if (!cfg) return false;

  if (cfg.adBlockEnabled !== false && urlMatchesAdBlock(url)) return true;

  if (hasPostBody) return false;
  if (siteAllowsPopups) return false;

  if (cfg.popupBlockerEnabled === false) return false;

  if (disposition === 'foreground-tab' || disposition === 'background-tab') return false;
  if (isOAuthOrLoginUrl(url)) return false;
  if (isGoogleMailDownloadOrContentUrl(url)) return false;

  const noUrl = !url || url === 'about:blank';
  const small = isLikelyAdSizedPopup(width, height);
  const oauthSizedBlank =
    noUrl &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    (width >= 480 || height >= 520);
  if (oauthSizedBlank) return false;

  if (noUrl && isLikelyDocumentPictureInPictureShape(width, height)) return false;

  if (featuresSuggestScriptPopup(features)) {
    if (noUrl && isMailGoogleOpenerOrigin(openerOrigin)) return false;
    if (noUrl && isShippingCarrierOpenerOrigin(openerOrigin)) return false;
    if (noUrl && isStreamingVideoOpenerOrigin(openerOrigin)) return false;
    // Real navigation URL: ad hosts are already blocked above. Many legitimate sites use
    // stripped chrome (print, preview, docs); blocking those caused "blocks everything but ads".
    if (!noUrl) return false;
    return true;
  }

  if (cfg.adStrictPopupBlock === false) return false;

  if (noUrl && small) {
    if (isMailGoogleOpenerOrigin(openerOrigin)) return false;
    if (isShippingCarrierOpenerOrigin(openerOrigin)) return false;
    if (isStreamingVideoOpenerOrigin(openerOrigin)) return false;
    return true;
  }
  return false;
}

module.exports = {
  AD_BLOCK_PATTERNS,
  urlMatchesAdBlock,
  shouldBlockAdNetworkRequest,
  isOAuthOrLoginUrl,
  isGoogleMailDownloadOrContentUrl,
  isMailGoogleOpenerOrigin,
  isShippingCarrierOpenerOrigin,
  isStreamingVideoOpenerOrigin,
  isLikelyAdSizedPopup,
  isLikelyDocumentPictureInPictureShape,
  featuresSuggestScriptPopup,
  shouldBlockWebPopup
};
