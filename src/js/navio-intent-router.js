/**
 * Navio Intent Router — Phase E
 *
 * Classifies a user turn into structured intent signals that drive:
 *   - connector prefetch (Gmail, Drive, Calendar, Perplexity, Slack, etc.)
 *   - tool hint injection for the main AI turn
 *   - routing decisions (API path vs browser path)
 *
 * Works in both Node.js (main/preload) and browser (renderer) contexts.
 *
 * Intent categories (non-exclusive — a turn can have multiple):
 *   gmail        — reading, searching, listing, triaging inbox
 *   gmail_draft  — composing or replying to emails
 *   gmail_thread — reading a full email chain / conversation
 *   gmail_attach — reading attachment content inside an email
 *   drive        — finding, reading, listing Google Drive files
 *   calendar     — listing or creating Google Calendar events
 *   pickup       — scheduling a carrier pickup (FedEx, Purolator, etc.)
 *   shipping     — freight/LTL/FTL quotes, carrier rates
 *   web_search   — real-time web search / general knowledge
 *   browser_nav  — navigating to a website, filling a form
 *   direct_answer — question answerable from context without tools
 *   multi        — two or more distinct service intents
 */

/* global module, exports */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    // Node / CommonJS
    module.exports = factory();
  } else {
    // Browser — attach to window
    root.NavioIntentRouter = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

// ── Signal definitions ────────────────────────────────────────────────────────

const INTENTS = {
  gmail: [
    /\b(email|emails?|inbox|unread|mail|gmail|message|messages?|newsletter|mailing)\b/i,
    /\b(check\s+(my\s+)?mail|what.?s\s+(in\s+)?my\s+(inbox|mail)|any\s+new\s+(email|mail|messages?))\b/i,
    /\b(from:\s*\S+|subject:\s*\S+|in:inbox|is:unread)\b/i,
    /\b(read\s+(the\s+)?(email|mail|message)|open\s+(the\s+)?email)\b/i,
    /\b(bounce|bounces?|NDR|undeliverable|mailer.daemon|postmaster|delivery\s+failure)\b/i
  ],
  gmail_draft: [
    /\b(draft|reply|compose|write\s+(an?\s+)?email|send\s+(an?\s+)?email|create\s+(a\s+)?draft)\b/i,
    /\b(respond\s+to|answer\s+(the\s+)?email|get\s+back\s+to)\b/i,
    /\b(draft\s+(a\s+)?(reply|response|message|email))\b/i
  ],
  gmail_thread: [
    /\b(full\s+(thread|chain|conversation|email\s+chain)|whole\s+conversation|back.and.forth)\b/i,
    /\b(read\s+(the\s+)?(entire|whole|full)\s+(thread|conversation|chain|email))\b/i,
    /\b(what\s+(did\s+they|was\s+the)\s+(say|respond|reply|write))\b/i,
    /\b(show\s+(me\s+)?the\s+(whole|full|entire)\s+(email|thread|conversation))\b/i,
    /\b(thread|email\s+chain|conversation\s+chain|full\s+back.and.forth)\b/i
  ],
  gmail_attach: [
    /\b(attachment|attached|the\s+(PDF|spreadsheet|document|file|invoice|PO|BOL|manifest))\b/i,
    /\b(read\s+(the\s+)?(attachment|PDF|file|invoice|document)|what.?s\s+in\s+the\s+(file|attachment|PDF))\b/i,
    /\b(open\s+(the\s+)?(attachment|PDF|file)|what\s+does\s+the\s+(invoice|PDF|file|document)\s+say)\b/i,
    /\b(content\s+of\s+the\s+(attachment|file|PDF|document))\b/i
  ],
  drive: [
    /\b(google\s+drive|drive|gdrive|google\s+docs?|google\s+sheets?|google\s+slides?|Drive\s+file)\b/i,
    /\b(find\s+(a\s+)?(file|document|spreadsheet|folder|sheet)\s+(on|in)\s+drive)\b/i,
    /\b(my\s+(files?|documents?|sheets?|docs?)\s+(on|in)\s+(drive|google))\b/i,
    /\b(look\s+(up|for)\s+(a\s+)?(file|document)\s+(on|in)\s+(my\s+)?drive)\b/i,
    /\b(what.?s\s+in\s+(my\s+)?(drive|google\s+drive|the\s+folder))\b/i,
    /\b(list\s+(my\s+)?(drive\s+files?|files?\s+in\s+drive))\b/i
  ],
  calendar: [
    /\b(calendar|schedule|meeting|appointment|event|reminder|Google\s+meet|gcal)\b/i,
    /\b(what.?s\s+on\s+my\s+(calendar|schedule)|my\s+(schedule|meetings?|appointments?))\b/i,
    /\b(do\s+I\s+have\s+(any\s+)?(meetings?|events?|appointments?)\s+(today|tomorrow|this\s+week))\b/i,
    /\b(add\s+(a\s+)?(meeting|event|appointment|reminder)\s+to\s+(my\s+)?calendar)\b/i,
    /\b(schedule\s+(a\s+)?(meeting|call|event|appointment))\b/i,
    /\b(create\s+(a\s+)?(calendar\s+)?(event|meeting|appointment))\b/i,
    /\b(today.?s?\s+schedule|this\s+week.?s?\s+meetings?|upcoming\s+(meetings?|events?))\b/i
  ],
  pickup: [
    /\b(schedule\s+(a\s+)?pickup|book\s+(a\s+)?pickup|arrange\s+(a\s+)?(pickup|collection)|request\s+(a\s+)?pickup)\b/i,
    /\b(FedEx\s+pickup|Purolator\s+pickup|UPS\s+pickup|DHL\s+pickup|Canada\s+Post\s+pickup)\b/i,
    /\b(carrier\s+pickup|courier\s+pickup|set\s+up\s+(a\s+)?pickup|organize\s+(a\s+)?pickup)\b/i,
    /\b(pickup\s+(from|at)\s+(my\s+)?(address|warehouse|location|office|facility))\b/i,
    /\b(book\s+(a\s+)?(courier|carrier|shipper|FedEx|UPS|Purolator|DHL)\s+(for\s+)?pickup)\b/i
  ],
  shipping: [
    /\b(ship|shipping|shipment|freight|LTL|FTL|rate|rates?|quote|quotes?|carrier|courier)\b/i,
    /\b(get\s+(a\s+)?rate|get\s+(a\s+)?quote|shipping\s+(rate|cost|price|fee))\b/i,
    /\b(TQL|Echo\s+Global|Coyote|XPO|Old\s+Dominion|ODFL|Saia|Estes|R\+L|Daylight|Dicom|Canpar)\b/i,
    /\b(BOL|bill\s+of\s+lading|pallet|pallets|truckload|LTL\s+shipment|freight\s+quote)\b/i,
    /\b(how\s+much\s+(is|would)\s+(it\s+cost\s+)?to\s+ship|shipping\s+from\s+\w+\s+to\s+\w+)\b/i
  ],
  web_search: [
    /\b(search|look\s+up|find\s+out|what.?s\s+the\s+(latest|news|price|current|weather))\b/i,
    /\b(who\s+is|what\s+is|where\s+is|when\s+(is|was|did)|how\s+(do|does|did|much|many|long))\b/i,
    /\b(current\s+(price|rate|news|status|weather)|latest\s+(news|update|version|release))\b/i,
    /\b(definition\s+of|meaning\s+of|explain|difference\s+between|compare\s+\w+\s+(vs?\.?\s*|and\s*)\w+)\b/i,
    /\b(stock\s+price|crypto|weather|today.?s\s+news|breaking\s+news)\b/i
  ],
  browser_nav: [
    /\b(navigate\s+to|go\s+to|open|visit|take\s+me\s+to|browse\s+to)\b/i,
    /\b(click|fill\s+(in|out)|submit|sign\s+in|log\s+in)\s+(the\s+)?(form|page|site|button|field)\b/i,
    /\bhttps?:\/\//i,
    /\b(website|webpage|web\s+page|page|site)\b/i
  ]
};

// Strong signals that override everything — these mean "definitely this"
const OVERRIDE_INTENTS = {
  gmail_thread: [
    /\b(full\s+thread|full\s+(email\s+)?chain|entire\s+thread|whole\s+conversation)\b/i
  ],
  gmail_attach: [
    /\b(read\s+(the\s+)?(PDF|invoice|attachment)|what.?s\s+in\s+(the\s+)?attachment)\b/i
  ],
  pickup: [
    /\b(schedule\s+(a\s+)?pickup|book\s+(a\s+)?pickup)\b/i
  ],
  calendar: [
    /\b(add\s+(to\s+)?calendar|create\s+(calendar\s+)?event|schedule\s+(a\s+)?meeting|my\s+schedule\s+(today|tomorrow))\b/i
  ],
  drive: [
    /\b(find\s+(it\s+)?on\s+(my\s+)?drive|search\s+(my\s+)?drive|open\s+(that\s+)?file\s+(from|in)\s+drive)\b/i
  ]
};

// ── Cache ─────────────────────────────────────────────────────────────────────

// Simple LRU-ish cache — cap at 128 entries, keyed by first 120 chars of text
const _cache = new Map();
const CACHE_MAX = 128;
const CACHE_TTL_MS = 30 * 1000; // 30 s

function _cacheKey(text) {
  return text.slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
}

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return entry.value;
}

function _cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX) {
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
  _cache.set(key, { value, ts: Date.now() });
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify the user's text into a set of intent signals.
 *
 * @param {string} text — raw user turn text
 * @param {object} [opts]
 * @param {string[]} [opts.connectedServices] — ['gmail','gdrive','gcalendar',...] for filtering
 * @returns {NavioIntentResult}
 */
function classifyIntent(text, opts = {}) {
  if (!text || typeof text !== 'string') {
    return _emptyResult();
  }

  const key = _cacheKey(text);
  const cached = _cacheGet(key);
  if (cached) return cached;

  const result = _classify(text, opts);
  _cacheSet(key, result);
  return result;
}

function _classify(text, opts) {
  const signals = {};
  const { connectedServices = [] } = opts;
  const connectedSet = new Set(connectedServices.map((s) => s.toLowerCase()));

  // Phase 1: check override patterns (high confidence)
  for (const [intent, patterns] of Object.entries(OVERRIDE_INTENTS)) {
    for (const pat of patterns) {
      if (pat.test(text)) {
        signals[intent] = (signals[intent] || 0) + 2;
        break;
      }
    }
  }

  // Phase 2: standard patterns
  for (const [intent, patterns] of Object.entries(INTENTS)) {
    let matches = 0;
    for (const pat of patterns) {
      if (pat.test(text)) matches++;
    }
    if (matches > 0) {
      signals[intent] = (signals[intent] || 0) + matches;
    }
  }

  // Resolve active intents (threshold: score >= 1)
  const activeIntents = Object.entries(signals)
    .filter(([, score]) => score >= 1)
    .sort(([, a], [, b]) => b - a)
    .map(([intent]) => intent);

  // Determine primary intent
  const primaryIntent = activeIntents[0] || 'direct_answer';

  // Connector prefetch hints — which APIs should be pre-fetched for this turn
  const prefetch = [];
  if ((signals.gmail || signals.gmail_draft || signals.gmail_thread || signals.gmail_attach) &&
      (connectedSet.has('gmail') || connectedSet.has('gmail_2') || connectedSet.size === 0)) {
    prefetch.push('gmail');
  }
  if (signals.drive && (connectedSet.has('gdrive') || connectedSet.size === 0)) {
    prefetch.push('drive');
  }
  if (signals.calendar && (connectedSet.has('gcalendar') || connectedSet.size === 0)) {
    prefetch.push('calendar');
  }

  // Tool hints — suggest specific tools to the main loop
  const toolHints = [];
  if (signals.gmail_thread >= 2) toolHints.push('gmail_get_thread');
  if (signals.gmail_attach >= 2) toolHints.push('gmail_get_attachment');
  if (signals.gmail && !signals.gmail_draft) toolHints.push('gmail_search');
  if (signals.gmail_draft) toolHints.push('gmail_create_reply_draft', 'gmail_create_draft');
  if (signals.drive) toolHints.push('drive_search', 'drive_get_file');
  if (signals.calendar) toolHints.push('calendar_list_events');
  if (signals.pickup) toolHints.push('navigate');
  if (signals.shipping) toolHints.push('navigate', 'read_page');

  const isMulti = activeIntents.filter((i) =>
    ['gmail', 'drive', 'calendar', 'pickup', 'shipping', 'web_search'].includes(i)
  ).length >= 2;

  return {
    primaryIntent,
    activeIntents,
    signals,
    prefetch,
    toolHints: [...new Set(toolHints)],
    isMulti,
    confidence: _computeConfidence(signals, primaryIntent)
  };
}

function _computeConfidence(signals, primaryIntent) {
  const score = signals[primaryIntent] || 0;
  if (score >= 3) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function _emptyResult() {
  return {
    primaryIntent: 'direct_answer',
    activeIntents: [],
    signals: {},
    prefetch: [],
    toolHints: [],
    isMulti: false,
    confidence: 'low'
  };
}

/**
 * Quick boolean check: does this text have email intent?
 */
function hasEmailIntent(text) {
  if (!text) return false;
  const r = classifyIntent(text);
  return r.activeIntents.some((i) => i.startsWith('gmail')) || r.signals.gmail > 0;
}

/**
 * Quick boolean check: does this text have Drive intent?
 */
function hasDriveIntent(text) {
  if (!text) return false;
  const r = classifyIntent(text);
  return r.activeIntents.includes('drive') || r.signals.drive > 0;
}

/**
 * Quick boolean check: does this text have Calendar intent?
 */
function hasCalendarIntent(text) {
  if (!text) return false;
  const r = classifyIntent(text);
  return r.activeIntents.includes('calendar') || r.signals.calendar > 0;
}

/**
 * Quick boolean check: does this text have pickup scheduling intent?
 */
function hasPickupIntent(text) {
  if (!text) return false;
  const r = classifyIntent(text);
  return r.activeIntents.includes('pickup') || r.signals.pickup > 0;
}

/**
 * Quick boolean check: does this text have shipping/freight intent?
 */
function hasShippingIntent(text) {
  if (!text) return false;
  const r = classifyIntent(text);
  return r.activeIntents.includes('shipping') || r.signals.shipping > 0;
}

  return {
    classifyIntent,
    hasEmailIntent,
    hasDriveIntent,
    hasCalendarIntent,
    hasPickupIntent,
    hasShippingIntent
  };
}); // end factory
