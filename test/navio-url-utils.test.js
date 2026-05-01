'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { navioNormalizeHistoryKey } = require('../electron/navio-url-utils');

test('navioNormalizeHistoryKey strips hash', () => {
  assert.strictEqual(
    navioNormalizeHistoryKey('https://example.com/path#frag'),
    'https://example.com/path'
  );
});

test('navioNormalizeHistoryKey preserves query', () => {
  assert.strictEqual(
    navioNormalizeHistoryKey('https://a.org/x?q=1#h'),
    'https://a.org/x?q=1'
  );
});
