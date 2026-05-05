'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guestConsoleLogLevel } = require('../electron/navio-logger');

test('guestConsoleLogLevel: real uncaught stays error', () => {
  assert.equal(
    guestConsoleLogLevel('[app.js:10] Uncaught ReferenceError: foo is not defined'),
    'error'
  );
});

test('guestConsoleLogLevel: MIME / login-wall noise → warn', () => {
  assert.equal(
    guestConsoleLogLevel(
      "[Welcome.aspx:0] Refused to apply style from 'https://x/y.css' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled."
    ),
    'warn'
  );
});

test('guestConsoleLogLevel: Google Analytics collect blocked → warn', () => {
  assert.equal(
    guestConsoleLogLevel(
      "[gtag/js:1] Fetch API cannot load https://www.google.com/g/collect?v=2&tid=G-XX"
    ),
    'warn'
  );
});

test('guestConsoleLogLevel: aria-hidden focus warning → warn', () => {
  assert.equal(
    guestConsoleLogLevel('[inbox:0] Blocked aria-hidden on an element because its descendant retained focus.'),
    'warn'
  );
});

test('guestConsoleLogLevel: prefetch-src CSP parse noise → warn', () => {
  assert.equal(
    guestConsoleLogLevel(
      "[main.js:1] Unrecognized Content-Security-Policy directive 'prefetch-src'."
    ),
    'warn'
  );
});
