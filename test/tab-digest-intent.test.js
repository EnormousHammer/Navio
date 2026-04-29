'use strict';

// Smoke tests for AssistantManagerClass#_userWantsAllTabsDigest — the regex
// gate that decides if a user message should auto-trigger the multi-tab
// digest. Extracted out of src/js/assistant.js into a vm context so we don't
// need a real DOM / Electron / TabManager to exercise the logic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHelper() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'js', 'assistant.js'),
    'utf8'
  );
  const start = src.indexOf('_userWantsAllTabsDigest(text) {');
  if (start === -1) throw new Error('_userWantsAllTabsDigest not found');
  // Walk braces from the opening { of the method body.
  const openBrace = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error('Failed to find method end');
  // Wrap as a standalone function, stripping the method header.
  const methodSrc = src.slice(start, end); // "_userWantsAllTabsDigest(text) { ... }"
  const fnSrc = methodSrc.replace('_userWantsAllTabsDigest(text)', 'function userWantsAllTabsDigest(text)');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\nthis.fn = userWantsAllTabsDigest;', ctx);
  return ctx.fn;
}

const wants = loadHelper();

test('positive: explicit tab summary asks', () => {
  assert.strictEqual(wants('summarize my tabs'), true);
  assert.strictEqual(wants('Summarize all my open tabs'), true);
  assert.strictEqual(wants('give me an overview of my tabs'), true);
  assert.strictEqual(wants('rundown of my open tabs please'), true);
  assert.strictEqual(wants('catch me up on my tabs'), true);
  assert.strictEqual(wants('what is in my open tabs'), true);
  assert.strictEqual(wants("what's open right now"), true);
  assert.strictEqual(wants('show me everything open'), true);
  assert.strictEqual(wants('describe each tab I have open'), true);
  assert.strictEqual(wants('compare my open tabs'), true);
  assert.strictEqual(wants('anything important across my tabs?'), true);
});

test('negative: single-tab / page-only questions should NOT trigger', () => {
  assert.strictEqual(wants('summarize this page'), false);
  assert.strictEqual(wants('what is on this page'), false);
  assert.strictEqual(wants('explain this article'), false);
  assert.strictEqual(wants('what does this mean'), false);
  assert.strictEqual(wants('translate this'), false);
});

test('negative: general questions and commands', () => {
  assert.strictEqual(wants('open google.com'), false);
  assert.strictEqual(wants('what is the weather in tokyo'), false);
  assert.strictEqual(wants('search for the cheapest flight'), false);
  assert.strictEqual(wants('click the buy button'), false);
  assert.strictEqual(wants('check my unread emails'), false);
});

test('negative: empty / falsy input', () => {
  assert.strictEqual(wants(''), false);
  assert.strictEqual(wants(null), false);
  assert.strictEqual(wants(undefined), false);
  assert.strictEqual(wants(123), false);
});

test('group word alone without a request verb does NOT trigger (avoid false positives)', () => {
  // "i have a lot of tabs open" is a statement, not a request to summarize them.
  assert.strictEqual(wants('i have a lot of tabs open right now'), false);
  // "close all my open tabs" is a command, not a digest ask.
  assert.strictEqual(wants('close all my open tabs'), false);
});
