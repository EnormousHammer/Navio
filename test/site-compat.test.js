'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const siteCompat = require('../electron/site-compat');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'navio-sc-'));
}

function rmTmp(dir) {
  try {
    fs.unlinkSync(path.join(dir, 'navio-site-compat.json'));
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }
}

test('site-compat originFromUrl normalizes http(s) URLs to scheme://host[:port]', () => {
  assert.strictEqual(
    siteCompat.originFromUrl('https://www.purolator.com/en/login?next=/dashboard'),
    'https://www.purolator.com'
  );
  assert.strictEqual(
    siteCompat.originFromUrl('http://localhost:3000/whatever'),
    'http://localhost:3000'
  );
  assert.strictEqual(siteCompat.originFromUrl('https://www.purolator.com'), 'https://www.purolator.com');
});

test('site-compat originFromUrl returns empty for unsupported / malformed input', () => {
  assert.strictEqual(siteCompat.originFromUrl(''), '');
  assert.strictEqual(siteCompat.originFromUrl(null), '');
  assert.strictEqual(siteCompat.originFromUrl('about:blank'), '');
  assert.strictEqual(siteCompat.originFromUrl('chrome://settings'), '');
  assert.strictEqual(siteCompat.originFromUrl('file:///c/foo.html'), '');
  assert.strictEqual(siteCompat.originFromUrl('not a url'), '');
});

test('site-compat empty store returns empty list and isCompat=false', () => {
  const dir = mkTmp();
  try {
    assert.deepStrictEqual(siteCompat.listOrigins(dir), []);
    assert.strictEqual(siteCompat.isCompat(dir, 'https://www.purolator.com/login'), false);
  } finally {
    rmTmp(dir);
  }
});

test('site-compat setCompat persists per-origin and isCompat reflects it', () => {
  const dir = mkTmp();
  try {
    const r = siteCompat.setCompat(dir, 'https://www.purolator.com/anything?x=1', true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.origin, 'https://www.purolator.com');
    assert.strictEqual(r.enabled, true);

    assert.strictEqual(siteCompat.isCompat(dir, 'https://www.purolator.com/different/path'), true);
    assert.strictEqual(siteCompat.isCompat(dir, 'https://www.fedex.com'), false);
    assert.deepStrictEqual(siteCompat.listOrigins(dir), ['https://www.purolator.com']);

    siteCompat.setCompat(dir, 'https://www.purolator.com', false);
    assert.strictEqual(siteCompat.isCompat(dir, 'https://www.purolator.com'), false);
    assert.deepStrictEqual(siteCompat.listOrigins(dir), []);
  } finally {
    rmTmp(dir);
  }
});

test('site-compat toggleCompat flips and persists', () => {
  const dir = mkTmp();
  try {
    let r = siteCompat.toggleCompat(dir, 'https://www.fedex.com/abc');
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(siteCompat.isCompat(dir, 'https://www.fedex.com'), true);

    r = siteCompat.toggleCompat(dir, 'https://www.fedex.com/abc');
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(siteCompat.isCompat(dir, 'https://www.fedex.com'), false);
  } finally {
    rmTmp(dir);
  }
});

test('site-compat setCompat rejects invalid origins without crashing', () => {
  const dir = mkTmp();
  try {
    const r = siteCompat.setCompat(dir, 'about:blank', true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'invalid_origin');
    // Store should remain empty / unchanged.
    assert.deepStrictEqual(siteCompat.listOrigins(dir), []);
  } finally {
    rmTmp(dir);
  }
});

test('site-compat list is sorted and deduped across multiple sets', () => {
  const dir = mkTmp();
  try {
    siteCompat.setCompat(dir, 'https://www.purolator.com', true);
    siteCompat.setCompat(dir, 'https://www.purolator.com/two', true);
    siteCompat.setCompat(dir, 'https://www.fedex.com', true);
    siteCompat.setCompat(dir, 'https://www.dhl.com', true);
    const origins = siteCompat.listOrigins(dir);
    assert.deepStrictEqual(
      origins,
      ['https://www.dhl.com', 'https://www.fedex.com', 'https://www.purolator.com']
    );
  } finally {
    rmTmp(dir);
  }
});
