'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sitePerms = require('../electron/site-permissions');

test('site-permissions load returns default shape for empty userData', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navio-sp-load-'));
  try {
    const data = sitePerms.load(dir);
    assert.strictEqual(data.version, 1);
    assert.ok(data.byOrigin && typeof data.byOrigin === 'object');
    assert.strictEqual(Object.keys(data.byOrigin).length, 0);
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
});

test('site-permissions set is no-op for empty origin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navio-sp-empty-'));
  try {
    sitePerms.set(dir, '', 'media', true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'navio-site-permissions.json')), false);
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
});

test('site-permissions get returns null for empty origin or unknown permission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navio-sp-'));
  try {
    assert.strictEqual(sitePerms.get(dir, '', 'media'), null);
    assert.strictEqual(sitePerms.get(dir, 'https://x.test', ''), null);
    assert.strictEqual(sitePerms.get(dir, 'https://x.test', 'notifications'), null);
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
