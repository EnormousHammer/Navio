'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { navioSanitizeEmailHtmlFragment } = require('../electron/gmail-html-sanitize');

test('strips script tags', () => {
  const out = navioSanitizeEmailHtmlFragment('<p>Hi</p><script>evil()</script><table><tr><td>x</td></tr></table>');
  assert.match(out, /<table>/);
  assert.doesNotMatch(out, /script/i);
});

test('preserves table with inline styles', () => {
  const html =
    '<table style="border-collapse:collapse"><tr><td style="border:1px solid #ccc;padding:4px">A</td></tr></table>';
  assert.equal(navioSanitizeEmailHtmlFragment(html), html);
});

test('neutralizes javascript: URLs', () => {
  const out = navioSanitizeEmailHtmlFragment('<a href="javascript:alert(1)">x</a>');
  assert.match(out, /navio-blocked:/i);
  assert.doesNotMatch(out, /javascript:/i);
});
