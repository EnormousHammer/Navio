'use strict';

/**
 * Redact common PII patterns from outbound AI text (SSN, card groups).
 * Kept pure for unit tests.
 */
function redactPII(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b\d{3}\s+\d{2}\s+\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b\d{4}(?:[-\s]\d{4}){3}\b/g, '[REDACTED-CARD]');
  return t;
}

module.exports = { redactPII };
