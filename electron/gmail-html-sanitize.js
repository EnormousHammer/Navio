'use strict';

/**
 * Strip dangerous constructs from AI-supplied HTML email fragments.
 * Conservative regex-based cleanup (not a full parser).
 */
function navioSanitizeEmailHtmlFragment(html) {
  if (!html || typeof html !== 'string') return '';
  let s = String(html);
  s = s.replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  s = s.replace(/<\s*script\b[^>]*\/?\s*>/gi, '');
  s = s.replace(/<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, '');
  s = s.replace(/<\s*iframe\b[^>]*\/?\s*>/gi, '');
  s = s.replace(/<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '');
  s = s.replace(/<\s*(object|embed|base|meta|link)\b[^>]*>/gi, '');
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  }
  s = s.replace(/javascript:/gi, 'navio-blocked:');
  s = s.replace(/data:text\/html/gi, 'data-navio-blocked:');
  s = s.replace(/vbscript:/gi, 'navio-blocked:');
  return s.trim();
}

module.exports = { navioSanitizeEmailHtmlFragment };
