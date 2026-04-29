'use strict';

// Pure-function smoke tests for navioReasoningParamsForRequest.
// We extract the function source out of electron/main.js and eval it in a
// throwaway VM context (no Electron deps required) so this stays a fast unit
// test runnable under `npm test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHelper() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const start = src.indexOf('function navioReasoningParamsForRequest(');
  if (start === -1) throw new Error('navioReasoningParamsForRequest not found in main.js');
  // Walk braces from the opening { after the args to find the matching close.
  const openParen = src.indexOf('(', start);
  const closeParen = src.indexOf(')', openParen);
  const openBrace = src.indexOf('{', closeParen);
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
  if (end === -1) throw new Error('Failed to find function end');
  const fnSrc = src.slice(start, end);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fnSrc + '\nthis.fn = navioReasoningParamsForRequest;', ctx);
  return ctx.fn;
}

const fn = loadHelper();

test('off short-circuits regardless of provider/model', () => {
  assert.strictEqual(fn({ aiProvider: 'openai', aiReasoningEffort: 'off' }, 'gpt-5.4'), null);
  assert.strictEqual(fn({ aiProvider: 'anthropic', aiReasoningEffort: 'off' }, 'claude-opus-4-5'), null);
  assert.strictEqual(fn({ aiProvider: 'google', aiReasoningEffort: 'off' }, 'gemini-2.5-pro'), null);
});

test('OpenAI: enables reasoning_effort on GPT-5 family with auto -> medium', () => {
  const r = fn({ aiProvider: 'openai', aiReasoningEffort: 'auto' }, 'gpt-5.4');
  assert.strictEqual(r.provider, 'openai');
  assert.strictEqual(r.reasoning_effort, 'medium');
});

test('OpenAI: enables reasoning_effort on o-series models', () => {
  const r = fn({ aiProvider: 'openai', aiReasoningEffort: 'high' }, 'o3-mini');
  assert.strictEqual(r.provider, 'openai');
  assert.strictEqual(r.reasoning_effort, 'high');
});

test('OpenAI: returns null for non-reasoning models (gpt-4o)', () => {
  assert.strictEqual(fn({ aiProvider: 'openai', aiReasoningEffort: 'auto' }, 'gpt-4o'), null);
  assert.strictEqual(fn({ aiProvider: 'openai', aiReasoningEffort: 'high' }, 'gpt-4-turbo'), null);
});

test('Anthropic: enables thinking + interleaved beta on Claude 4 family', () => {
  const r = fn({ aiProvider: 'anthropic', aiReasoningEffort: 'auto' }, 'claude-opus-4-5');
  assert.strictEqual(r.provider, 'anthropic');
  assert.strictEqual(r.thinking.type, 'enabled');
  assert.strictEqual(r.thinking.budget_tokens, 8000);
  assert.strictEqual(r.beta, 'interleaved-thinking-2025-05-14');
});

test('Anthropic: enables thinking on claude-3-7-sonnet', () => {
  const r = fn({ aiProvider: 'anthropic', aiReasoningEffort: 'low' }, 'claude-3-7-sonnet-20250219');
  assert.strictEqual(r.provider, 'anthropic');
  assert.strictEqual(r.thinking.budget_tokens, 2000);
});

test('Anthropic: returns null for non-thinking models (claude-3-5-sonnet, claude-3-opus)', () => {
  assert.strictEqual(fn({ aiProvider: 'anthropic', aiReasoningEffort: 'auto' }, 'claude-3-5-sonnet-20241022'), null);
  assert.strictEqual(fn({ aiProvider: 'anthropic', aiReasoningEffort: 'high' }, 'claude-3-opus-20240229'), null);
});

test('Gemini: enables thinkingConfig on 2.5 / 3.x models', () => {
  const r = fn({ aiProvider: 'google', aiReasoningEffort: 'auto' }, 'gemini-2.5-pro');
  assert.strictEqual(r.provider, 'google');
  assert.strictEqual(r.thinkingConfig.thinkingBudget, 8192);
  assert.strictEqual(r.thinkingConfig.includeThoughts, false);
  const r3 = fn({ aiProvider: 'google', aiReasoningEffort: 'high' }, 'gemini-3.0-pro');
  assert.strictEqual(r3.thinkingConfig.thinkingBudget, 24576);
});

test('Gemini: returns null for non-thinking models (2.0-flash, 1.5-pro)', () => {
  assert.strictEqual(fn({ aiProvider: 'google', aiReasoningEffort: 'auto' }, 'gemini-2.0-flash'), null);
  assert.strictEqual(fn({ aiProvider: 'google', aiReasoningEffort: 'high' }, 'gemini-1.5-pro'), null);
});

test('Ollama: returns null for typical local models (llama3.2)', () => {
  assert.strictEqual(fn({ aiProvider: 'ollama', aiReasoningEffort: 'auto' }, 'llama3.2'), null);
});

test('Custom OpenAI-compatible endpoint with gpt-5 model still gets reasoning', () => {
  const r = fn({ aiProvider: 'custom', aiReasoningEffort: 'auto' }, 'gpt-5');
  assert.strictEqual(r.provider, 'openai');
  assert.strictEqual(r.reasoning_effort, 'medium');
});

test('Unknown effort value falls back to auto-medium', () => {
  const r = fn({ aiProvider: 'openai', aiReasoningEffort: 'turbo-extra-thinking' }, 'gpt-5');
  assert.strictEqual(r.reasoning_effort, 'medium');
});
