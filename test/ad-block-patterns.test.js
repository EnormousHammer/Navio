'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  shouldBlockWebPopup,
  featuresSuggestScriptPopup,
  urlMatchesAdBlock
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

test('shouldBlockWebPopup: chrome-stripped features blocked', () => {
  assert.strictEqual(
    shouldBlockWebPopup({
      url: 'https://example.com/ad',
      disposition: 'new-window',
      features: 'menubar=no,toolbar=no,width=800,height=600',
      cfg: baseCfg
    }),
    true
  );
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
