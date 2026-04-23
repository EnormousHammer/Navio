'use strict';

/**
 * Navio Site Intelligence System
 *
 * Auto-injects expert-level knowledge packs into the agent system prompt
 * based on the active tab URL. Each pack encodes site-specific workflows,
 * URL patterns, common failures, and optimized tool strategies so the
 * agent never has to reason about a site's structure from scratch.
 *
 * Packs live in electron/prompt-blocks/ as site-<key>.txt files.
 * To add a new site: add an entry to SITE_REGISTRY and create the .txt file.
 */

const fs = require('fs');
const path = require('path');

const SITE_PACKS_DIR = path.join(__dirname, 'prompt-blocks');

/**
 * Registry of site intelligence packs.
 * Order matters — first match wins. Put more specific patterns before general ones.
 */
const SITE_REGISTRY = [
  // Google sub-services (must come before generic google.com)
  { key: 'google-docs',    urlPattern: /docs\.google\.com/i,                                     file: 'site-google-docs.txt' },
  { key: 'google-flights', urlPattern: /google\.com\/travel\/flights/i,                          file: 'site-google-flights.txt' },
  { key: 'google-maps',    urlPattern: /google\.com\/maps/i,                                     file: 'site-google-maps.txt' },

  // Major productivity / dev
  { key: 'github',         urlPattern: /github\.com/i,                                           file: 'site-github.txt' },
  { key: 'notion',         urlPattern: /notion\.so|notion\.com/i,                               file: 'site-notion.txt' },
  { key: 'slack',          urlPattern: /app\.slack\.com|slack\.com/i,                           file: 'site-slack.txt' },
  { key: 'jira',           urlPattern: /atlassian\.net\/jira|jira\./i,                          file: 'site-jira.txt' },
  { key: 'vercel',         urlPattern: /vercel\.com|\.vercel\.app/i,                             file: 'site-vercel.txt' },
  { key: 'render',         urlPattern: /render\.com|\.onrender\.com/i,                           file: 'site-render.txt' },

  // Commerce
  { key: 'amazon',         urlPattern: /amazon\.(com|ca|co\.uk|de|fr|es|it|co\.jp|com\.au)/i,  file: 'site-amazon.txt' },
  { key: 'shopify',        urlPattern: /myshopify\.com|admin\.shopify\.com/i,                   file: 'site-shopify.txt' },

  // Social / content
  { key: 'linkedin',       urlPattern: /linkedin\.com/i,                                         file: 'site-linkedin.txt' },
  { key: 'reddit',         urlPattern: /reddit\.com/i,                                           file: 'site-reddit.txt' },
  { key: 'twitter-x',     urlPattern: /(?:twitter|x)\.com/i,                                    file: 'site-twitter-x.txt' },
  { key: 'youtube',        urlPattern: /youtube\.com|youtu\.be/i,                               file: 'site-youtube.txt' },

  // Travel / booking
  { key: 'booking',        urlPattern: /booking\.com/i,                                         file: 'site-booking.txt' },
  { key: 'airbnb',         urlPattern: /airbnb\.com/i,                                          file: 'site-airbnb.txt' },
  { key: 'kayak',          urlPattern: /kayak\.com/i,                                           file: 'site-kayak.txt' },
];

// Pre-load all packs at startup — zero latency during requests
const _cache = {};
for (const entry of SITE_REGISTRY) {
  try {
    const content = fs.readFileSync(path.join(SITE_PACKS_DIR, entry.file), 'utf8');
    _cache[entry.key] = content;
  } catch {
    // Pack file not yet created — skip silently
    _cache[entry.key] = '';
  }
}

/**
 * Returns the site intelligence pack string for a given URL.
 * Returns empty string when no pack matches (no overhead added to prompt).
 * @param {string} url - The active tab URL
 * @returns {string}
 */
function getSiteIntelForUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    for (const entry of SITE_REGISTRY) {
      if (entry.urlPattern.test(url)) {
        return _cache[entry.key] || '';
      }
    }
  } catch {
    // never crash the prompt pipeline
  }
  return '';
}

/**
 * Extract the active tab URL from a messages array (same logic as _detectPromptBlocks).
 * @param {Array} messages
 * @returns {string}
 */
function extractActiveUrl(messages) {
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if (!m || m.role !== 'system') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    const match = content.match(/\[Active tab[^\]]*\]\s*[:\-–]?\s*(https?:\/\/[^\s\]]+)/i);
    if (match) return match[1];
  }
  return '';
}

module.exports = { getSiteIntelForUrl, extractActiveUrl };
