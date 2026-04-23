'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { redactPII } = require('../electron/pii-redact');

describe('redactPII', () => {
  it('passes through non-strings', () => {
    assert.strictEqual(redactPII(null), null);
    assert.strictEqual(redactPII(undefined), undefined);
    assert.strictEqual(redactPII(12), 12);
    assert.strictEqual(redactPII(''), '');
  });

  it('redacts hyphenated SSN', () => {
    assert.strictEqual(
      redactPII('id 123-45-6789 end'),
      'id [REDACTED-SSN] end'
    );
  });

  it('redacts whitespace-separated SSN', () => {
    assert.strictEqual(
      redactPII('x 987 65 4321 y'),
      'x [REDACTED-SSN] y'
    );
  });

  it('does not redact compact 9-digit order ids', () => {
    assert.strictEqual(redactPII('order 280109384'), 'order 280109384');
  });

  it('redacts grouped card-like numbers', () => {
    assert.strictEqual(
      redactPII('card 4111-1111-1111-1111 ok'),
      'card [REDACTED-CARD] ok'
    );
    assert.strictEqual(
      redactPII('card 4111 1111 1111 1111 ok'),
      'card [REDACTED-CARD] ok'
    );
  });

  it('does not redact plain 16-digit string without separators', () => {
    const s = 'n 4111111111111111 m';
    assert.strictEqual(redactPII(s), s);
  });
});
