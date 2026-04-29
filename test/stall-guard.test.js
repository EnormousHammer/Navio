'use strict';

// Unit tests for the navioCheckStall stall-guard function embedded in
// electron/main.js#executeToolLoop. We extract the function + the
// stallTrack array into a throwaway vm context to exercise the logic
// without booting Electron.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStallGuard() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

  // Find the STALL_THRESHOLD declaration, which starts the stall block.
  const threshStart = src.indexOf('const STALL_THRESHOLD =');
  if (threshStart === -1) throw new Error('STALL_THRESHOLD not found in main.js');

  // Find navioCheckStall function
  const fnStart = src.indexOf('function navioCheckStall(');
  if (fnStart === -1) throw new Error('navioCheckStall not found in main.js');

  // Walk braces to find end of the function.
  const openBrace = src.indexOf('{', fnStart);
  let depth = 0;
  let fnEnd = -1;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { fnEnd = i + 1; break; }
    }
  }
  if (fnEnd === -1) throw new Error('Could not find end of navioCheckStall');

  // Build standalone script: threshold + stallTrack array + the function.
  const stallTrackDecl = 'const stallTrack = [];';
  const threshLine = src.slice(threshStart, src.indexOf('\n', threshStart) + 1);
  const fnSrc = src.slice(fnStart, fnEnd);

  const script = `
${threshLine}
${stallTrackDecl}
${fnSrc}
this.fn = navioCheckStall;
this.stallTrack = stallTrack;
`;
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(script, ctx);

  // Helper to reset between sub-tests.
  ctx.reset = () => { ctx.stallTrack.length = 0; };
  return ctx;
}

const ctx = loadStallGuard();

test('no stall on first call', () => {
  ctx.reset();
  const r = ctx.fn('read_page', { filter: 'interactive' });
  assert.strictEqual(r, null);
});

test('no stall on two identical calls', () => {
  ctx.reset();
  ctx.fn('read_page', { filter: 'interactive' });
  const r = ctx.fn('read_page', { filter: 'interactive' });
  assert.strictEqual(r, null);
});

test('stall fires on third identical call', () => {
  ctx.reset();
  ctx.fn('read_page', { filter: 'interactive' });
  ctx.fn('read_page', { filter: 'interactive' });
  const r = ctx.fn('read_page', { filter: 'interactive' });
  assert.ok(r !== null, 'expected stall result');
  assert.ok(typeof r.error === 'string');
  assert.ok(r.error.includes('[STALL DETECTED]'), `error="${r.error}"`);
});

test('stall result for read_page mentions filter=all or screenshot', () => {
  ctx.reset();
  ctx.fn('read_page', { filter: 'interactive' });
  ctx.fn('read_page', { filter: 'interactive' });
  const r = ctx.fn('read_page', { filter: 'interactive' });
  const msg = r.error.toLowerCase();
  assert.ok(msg.includes('filter') || msg.includes('screenshot'), `message: ${msg}`);
});

test('stall resets when a different tool is called', () => {
  ctx.reset();
  ctx.fn('read_page', { filter: 'interactive' });
  ctx.fn('read_page', { filter: 'interactive' });
  // Different tool — should reset streak.
  const r1 = ctx.fn('navigate', { url: 'https://example.com' });
  assert.strictEqual(r1, null, 'navigate should not stall on first call after reset');
  // Now read_page again — streak is fresh, should not stall yet.
  const r2 = ctx.fn('read_page', { filter: 'interactive' });
  assert.strictEqual(r2, null, 'read_page should not stall immediately after streak reset');
});

test('different args on same tool do NOT trigger stall', () => {
  ctx.reset();
  ctx.fn('read_page', { filter: 'interactive' });
  ctx.fn('read_page', { filter: 'all' });  // different arg
  const r = ctx.fn('read_page', { filter: 'interactive' });
  // Not 3 identical calls — should not stall.
  assert.strictEqual(r, null);
});

test('stall fires on fourth+ call too (count keeps incrementing)', () => {
  ctx.reset();
  for (let i = 0; i < 3; i++) ctx.fn('navigate', { url: 'https://x.com' });
  // Already stalled; 4th call should also return error.
  const r = ctx.fn('navigate', { url: 'https://x.com' });
  assert.ok(r && r.error && r.error.includes('[STALL DETECTED]'));
});

test('web_search stall mentions rephrase', () => {
  ctx.reset();
  const args = { query: 'best laptop 2026' };
  ctx.fn('web_search', args);
  ctx.fn('web_search', args);
  const r = ctx.fn('web_search', args);
  const msg = (r && r.error || '').toLowerCase();
  assert.ok(msg.includes('[stall detected]'), `missing stall tag: ${r && r.error}`);
  assert.ok(msg.includes('rephrase') || msg.includes('query') || msg.includes('keyword'), `msg: ${msg}`);
});

test('click stall mentions screenshot or different ref', () => {
  ctx.reset();
  const args = { ref: 'ref_12', text: 'Submit' };
  ctx.fn('click', args);
  ctx.fn('click', args);
  const r = ctx.fn('click', args);
  const msg = (r && r.error || '').toLowerCase();
  assert.ok(msg.includes('[stall detected]'));
  assert.ok(msg.includes('screenshot') || msg.includes('ref') || msg.includes('text='), `msg: ${msg}`);
});
