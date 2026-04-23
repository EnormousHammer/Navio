/**
 * Replace UTF-8 read-as-Windows-1252 mojibake in navio-system-prompt.txt with ASCII.
 */
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'electron', 'navio-system-prompt.txt');
let s = fs.readFileSync(p, 'utf8');
if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

const pairs = [
  ['\u00e2\u2022\u0090', '='], // BOX DRAWINGS DOUBLE HORIZONTAL (UTF-8 E2 95 90 misread; middle is U+2022)
  ['\u00e2\u20ac\u201d', ' - '], // EM DASH
  ['\u00e2\u20ac\u201c', '-'], // EN DASH (rare)
  ['\u00e2\u2020\u2019', '->'], // RIGHTWARDS ARROW
  ['\u00e2\u2020\u0090', '<-'], // LEFTWARDS ARROW
  ['\u00e2\u20ac\u00a6', '...'], // HORIZONTAL ELLIPSIS
  ['\u00e2\u20ac\u2122', "'"], // RIGHT SINGLE QUOTATION MARK
  ['\u00e2\u20ac\u0153', '"'], // LEFT DOUBLE QUOTATION MARK
  ['\u00e2\u20ac\u009d', '"'], // RIGHT DOUBLE QUOTATION MARK (U+009D control - as char in file)
  ['\u00e2\u0153\u2014', '[x]'], // BALLOT X mark wrong
  ['\u00e2\u0153\u201c', '[ok]'] // CHECK MARK wrong
];

// Detect check/cross from file (third byte may vary by font pipeline)
function triAt(sub) {
  const i = s.indexOf(sub.slice(0, 2));
  if (i < 0) return null;
  return s.slice(i, i + 3);
}
const tBad = triAt('\u00e2\u0153');
if (tBad && tBad.length === 3) pairs.push([tBad, '[x]']);
const tOk = s.includes('\u00e2\u0153') ? null : null;

// â‰  (not equal) if present
pairs.push(['\u00e2\u2030\xa0', '!=']);

for (const [from, to] of pairs) {
  if (!from || from.length < 2) continue;
  let guard = 0;
  while (s.includes(from) && guard < 100000) {
    s = s.split(from).join(to);
    guard++;
  }
}

s = s.replace(/  -  /g, ' - ');

fs.writeFileSync(p, s, 'utf8');
console.log('OK', p);
