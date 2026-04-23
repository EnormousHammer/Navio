'use strict';

const js = require('@eslint/js');
const globals = require('globals');

/** Narrow lint surface: new security-adjacent modules + all tests (CI stays green). */
module.exports = [
  {
    files: ['electron/pii-redact.js', 'electron/navio-crash-reporter.js', 'electron/config-store.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  },
  {
    files: ['test/**/*.js', 'e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  }
];
