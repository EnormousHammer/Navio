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

test('localeFallback reads app.getLocale', () => {
  assert.strictEqual(localeFallback({ getLocale: () => 'pt-BR' }), 'pt-br');
  assert.strictEqual(localeFallback({ getLocale: () => 'en-US' }), 'en-us');
});

test('resolveTranslateTargetLang prefers config over locale', () => {
  assert.strictEqual(
    resolveTranslateTargetLang({ getLocale: () => 'en-US' }, { translateTargetLang: 'es' }),
    'es'
  );
  assert.strictEqual(resolveTranslateTargetLang({ getLocale: () => 'de' }, {}), 'de');
});
