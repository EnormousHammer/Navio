'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  shouldBlockWebPopup,
  featuresSuggestScriptPopup,
  isLikelyDocumentPictureInPictureShape,
  urlMatchesAdBlock,
  shouldBlockAdNetworkRequest
} = require('../electron/ad-block-patterns');

const baseCfg = {
  adBlockEnabled: true,
  popupBlockerEnabled: true,
  adStrictPopupBlock: true
};

test('featuresSuggestScriptPopup detects stripped chrome', () => {
  assert.strictEqual(featuresSuggestScriptPopup('width=400,height=300'), false);
  assert.strictEqual(
    featuresSuggestScriptPopup('menubar=no,toolbar=no,width=600,height=500'),
    true
  );
});

test('shouldBlockWebPopup: ad URL when ad blocking on', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://doubleclick.net/foo',
      disposition: 'default',
      cfg: baseCfg
    }),
    true
  );
});

test('shouldBlockWebPopup: respects popupBlockerEnabled off (non-ad)', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'default',
      optionsWidth: 300,
      optionsHeight: 280,
      cfg: { ...baseCfg, popupBlockerEnabled: false }
    }),
    false
  );
});

test('shouldBlockWebPopup: allows new tab dispositions', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://example.com/x',
      disposition: 'foreground-tab',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: allows form post body', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://example.com/',
      disposition: 'new-window',
      hasPostBody: true,
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: site allow list', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      optionsWidth: 300,
      optionsHeight: 280,
      siteAllowsPopups: true,
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: chrome-stripped blank window blocked (pop-under shell)', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      openerOrigin: 'https://some-news-site.example.com',
      cfg: baseCfg
    }),
    true
  );
});

test('shouldBlockWebPopup: real URL with stripped chrome allowed if not ad-listed', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://example.com/print-preview',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      openerOrigin: 'https://www.example.com',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: Gmail attachment googleusercontent not blocked', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://mail-attachment.googleusercontent.com/attachment/u/0/?ui=2',
      disposition: 'new-window',
      optionsWidth: 400,
      optionsHeight: 320,
      features: 'menubar=no,toolbar=no,width=400,height=320',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: Gmail blank download shell with script-like features allowed', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'new-window',
      optionsWidth: 400,
      optionsHeight: 300,
      features: 'menubar=no,toolbar=no,width=400,height=300',
      openerOrigin: 'https://mail.google.com',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: streaming site script-style popup not blocked (stay on player tab)', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      openerOrigin: 'https://www.twitch.tv',
      cfg: baseCfg
    }),
    false
  );
});

test('isLikelyDocumentPictureInPictureShape: widescreen PiP yes, IAB 400x250 no', () => {
  assert.strictEqual(isLikelyDocumentPictureInPictureShape(400, 225), true);
  assert.strictEqual(isLikelyDocumentPictureInPictureShape(360, 270), true);
  assert.strictEqual(isLikelyDocumentPictureInPictureShape(400, 250), false);
  assert.strictEqual(isLikelyDocumentPictureInPictureShape(300, 250), false);
});

test('shouldBlockWebPopup: document PiP shaped blank window not blocked on generic site', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'new-window',
      optionsWidth: 400,
      optionsHeight: 225,
      features: 'menubar=no,toolbar=no,width=400,height=225',
      openerOrigin: 'https://www.example-news.com',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: 400x250 script popup still blocked (not PiP shape)', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'new-window',
      optionsWidth: 400,
      optionsHeight: 250,
      features: 'menubar=no,toolbar=no,width=400,height=250',
      openerOrigin: 'https://www.example-news.com',
      cfg: baseCfg
    }),
    true
  );
});

test('shouldBlockWebPopup: carrier label/print popup from Purolator opener allowed', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'about:blank',
      disposition: 'new-window',
      optionsWidth: 400,
      optionsHeight: 300,
      features: 'menubar=no,toolbar=no,width=400,height=300',
      openerOrigin: 'https://www.purolator.com',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: small real URL popup from FedEx opener allowed', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://www.fedex.com/print/preview',
      disposition: 'new-window',
      optionsWidth: 480,
      optionsHeight: 400,
      features: 'width=480,height=400',
      openerOrigin: 'https://www.fedex.com',
      cfg: baseCfg
    }),
    false
  );
});

test('urlMatchesAdBlock: scam download-gate host', () => {
  assert.strictEqual(
    urlMatchesAdBlock('https://continue2download.com/continue.html?sid=1'),
    true
  );
});

test('urlMatchesAdBlock: fake extension promo host (Hero Ad Blocker funnel)', () => {
  assert.strictEqual(
    urlMatchesAdBlock('https://heroadblocker.pro/ext.php?ah=dgadNZaLAgu'),
    true
  );
});

test('urlMatchesAdBlock: IMA / video preroll SDK hosts', () => {
  assert.strictEqual(
    urlMatchesAdBlock('https://imasdk.googleapis.com/js/sdkloader/ima3.js'),
    true
  );
  assert.strictEqual(
    urlMatchesAdBlock('https://innovid.com/vast.xml'),
    true
  );
});

test('urlMatchesAdBlock: extended SSP / data / mobile hosts', () => {
  assert.strictEqual(urlMatchesAdBlock('https://adsrvr.org/bid'), true);
  assert.strictEqual(urlMatchesAdBlock('https://contextweb.com/pixel'), true);
  assert.strictEqual(urlMatchesAdBlock('https://unityads.unity3d.com/'), true);
});

test('urlMatchesAdBlock: extended batch 2 (measurement / exchanges)', () => {
  assert.strictEqual(urlMatchesAdBlock('https://atdmt.com/pixel'), true);
  assert.strictEqual(urlMatchesAdBlock('https://doubleverify.com/'), true);
  assert.strictEqual(urlMatchesAdBlock('https://cedexis.com/radar'), true);
});

test('urlMatchesAdBlock is used only with adBlockEnabled', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://doubleclick.net/foo',
      disposition: 'default',
      cfg: { ...baseCfg, adBlockEnabled: false }
    }),
    false
  );
  assert.strictEqual(urlMatchesAdBlock('https://doubleclick.net/foo'), true);
});

test('shouldBlockAdNetworkRequest: blocks scripts on ad hosts', () => {
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://doubleclick.net/foo.js', 'script'),
    true
  );
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://doubleclick.net/foo.js', 'xmlhttprequest'),
    true
  );
});

test('shouldBlockAdNetworkRequest: does not cancel image/font (avoids broken logos)', () => {
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://doubleclick.net/pixel.png', 'image'),
    false
  );
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://doubleclick.net/font.woff2', 'font'),
    false
  );
  assert.strictEqual(urlMatchesAdBlock('https://doubleclick.net/pixel.png'), true);
});

test('shouldBlockAdNetworkRequest: blocks script-like types on ad hosts', () => {
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://doubleclick.net/track', 'stylesheet'),
    true
  );
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://doubleclick.net/beacon', 'ping'),
    true
  );
});

test('shouldBlockAdNetworkRequest: non-ad URL is never blocked', () => {
  assert.strictEqual(
    shouldBlockAdNetworkRequest('https://example.com/app.js', 'script'),
    false
  );
});

test('shouldBlockWebPopup: cross-origin popup from streaming embed is blocked (casino/redirect)', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://bizcasino.com/landing',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      openerOrigin: 'https://embedme.today',
      cfg: baseCfg
    }),
    true
  );
});

test('shouldBlockWebPopup: same-origin popup from streaming embed is allowed (player helper)', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://embedme.today/player/fullscreen',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      openerOrigin: 'https://embedme.today',
      cfg: baseCfg
    }),
    false
  );
});

test('shouldBlockWebPopup: cross-origin popup from Predicta blocked when ad-block on', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://some-redirect-ad.net/click',
      disposition: 'new-window',
      features: 'width=900,height=700',
      openerOrigin: 'https://predicta-bet.vercel.app',
      cfg: baseCfg
    }),
    true
  );
});

test('shouldBlockWebPopup: cross-origin popup from streaming embed allowed when ad-block off', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://bizcasino.com/landing',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      openerOrigin: 'https://embedme.today',
      cfg: { ...baseCfg, adBlockEnabled: false }
    }),
    false
  );
});
