'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sitePerms = require('../electron/site-permissions');

test('site-permissions get/set roundtrip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navio-sp-'));
  try {
    assert.strictEqual(sitePerms.get(dir, 'https://a.test', 'media'), null);
    sitePerms.set(dir, 'https://a.test', 'media', true);
    assert.strictEqual(sitePerms.get(dir, 'https://a.test', 'media'), true);
    sitePerms.set(dir, 'https://a.test', 'media', false);
    assert.strictEqual(sitePerms.get(dir, 'https://a.test', 'media'), false);
  } finally {
    try {
      fs.unlinkSync(path.join(dir, 'navio-site-permissions.json'));
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
});
