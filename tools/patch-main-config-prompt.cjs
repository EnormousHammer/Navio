'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'electron', 'main.js');
let s = fs.readFileSync(p, 'utf8');
const cfgStart = s.indexOf('function getConfigPath()');
const cfgEnd = s.indexOf('function redactPII');
const cfgRepl = "const { loadConfig, saveConfig } = require('./config-store');\n\n";
if (cfgStart < 0 || cfgEnd < 0) throw new Error('config block not found');
s = s.slice(0, cfgStart) + cfgRepl + s.slice(cfgEnd);
const prStart = s.indexOf('// ── Authoritative system prompt');
const prEnd = s.indexOf('// ── Markdown → HTML converter');
const prRepl =
  "// ── Authoritative system prompt (file: electron/navio-system-prompt.txt)\n" +
  "const NAVIO_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'navio-system-prompt.txt'), 'utf8');\n\n";
if (prStart < 0 || prEnd < 0) throw new Error('prompt block not found');
s = s.slice(0, prStart) + prRepl + s.slice(prEnd);
fs.writeFileSync(p, s);
console.log('patched main.js ok, length', s.length);
