'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  sanitizeTranslateCode,
  localeFallback,
  resolveTranslateTargetLang
} = require('../electron/translate-locale');

test('sanitizeTranslateCode accepts ISO-style codes', () => {
  assert.strictEqual(sanitizeTranslateCode('  EN  '), 'en');
  assert.strictEqual(sanitizeTranslateCode('zh-CN'), 'zh-cn');
  assert.strictEqual(sanitizeTranslateCode('bad code'), '');
});

test('sanitizeTranslateCode rejects null and malformed region segments', () => {
  assert.strictEqual(sanitizeTranslateCode(null), '');
  assert.strictEqual(sanitizeTranslateCode(undefined), '');
  assert.strictEqual(sanitizeTranslateCode(''), '');
  assert.strictEqual(sanitizeTranslateCode('en-1'), '');
  assert.strictEqual(sanitizeTranslateCode('en-abcdefghi'), '');
  assert.strictEqual(sanitizeTranslateCode('e'), '');
});

test('localeFallback reads app.getLocale', () => {
  assert.strictEqual(localeFallback({ getLocale: () => 'pt-BR' }), 'pt-br');
  assert.strictEqual(localeFallback({ getLocale: () => 'en-US' }), 'en-us');
});

test('localeFallback returns en when getLocale throws or is missing', () => {
  assert.strictEqual(
    localeFallback({
      getLocale: () => {
        throw new Error('no locale');
      }
    }),
    'en'
  );
  assert.strictEqual(localeFallback({}), 'en');
});

test('resolveTranslateTargetLang prefers config over locale', () => {
  assert.strictEqual(
    resolveTranslateTargetLang({ getLocale: () => 'en-US' }, { translateTargetLang: 'es' }),
    'es'
  );
  assert.strictEqual(resolveTranslateTargetLang({ getLocale: () => 'de' }, {}), 'de');
});

test('resolveTranslateTargetLang ignores invalid config and falls back to locale', () => {
  assert.strictEqual(
    resolveTranslateTargetLang({ getLocale: () => 'fr' }, { translateTargetLang: '!!!' }),
    'fr'
  );
  assert.strictEqual(
    resolveTranslateTargetLang({ getLocale: () => 'ja' }, { translateTargetLang: '' }),
    'ja'
  );
});
