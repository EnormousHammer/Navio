#!/usr/bin/env node
'use strict';
/**
 * Runs `node --test` on all *.test.js files under given dirs (default: test).
 * Avoids shell glob expansion — Windows CI passes literal *.test.js to Node otherwise.
 */
const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..');
const dirs = process.argv.slice(2).filter(Boolean);
const targets = dirs.length ? dirs : ['test'];

const files = [];
for (const d of targets) {
  const base = join(root, d);
  let names;
  try {
    names = readdirSync(base);
  } catch (e) {
    console.error(`[run-node-tests] Cannot read directory ${base}:`, e.message);
    process.exit(1);
  }
  for (const name of names) {
    if (name.endsWith('.test.js')) files.push(join(base, name));
  }
}

if (!files.length) {
  console.error('[run-node-tests] No *.test.js files under:', targets.join(', '));
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  windowsHide: true,
  cwd: root
});
if (r.error) {
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
