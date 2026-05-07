/**
 * Navio Skills — Phase C
 *
 * **Integration status:** Not loaded from `electron/main.js`. Product replay path is
 * **saved workflows** (`navio-workflows.js` + UI). See `docs/COMPETITIVE_GAPS_AND_PLAN.md` §2.6.
 *
 * Persistent skill cache: records successful multi-step agent flows and replays
 * them on future runs for the same URL pattern + similar goal.
 *
 * A "skill" is a sequence of {action, fingerprint, value} steps that produced
 * a known success signal (URL match, element appeared, etc.).
 *
 * Skills are stored as JSON files under:
 *   <userData>/navio-skills/<sha256(urlPattern)>.json
 *
 * The replay path:
 *   1. findSkill(goal, currentUrl) → skill | null
 *   2. replaySkill(skill, params) → step list (executed by tool loop in main.js)
 *   3. On success, recordSkill(goal, url, actionLog, successSignal) → saves file
 *
 * Staleness protection:
 *   - Each skill has a `success_signal` (URL regex, element name, or text).
 *   - On replay, after each step the verify module checks the signal.
 *   - If a step fails to match its expected post-state, discard the cached skill.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app } = require('electron');

// ── Storage ───────────────────────────────────────────────────────────────────

function getSkillsDir() {
  try {
    const userData = app.getPath('userData');
    const dir = path.join(userData, 'navio-skills');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function urlPatternKey(urlPattern) {
  return crypto.createHash('sha256').update(urlPattern || '').digest('hex').slice(0, 16);
}

function skillFilePath(urlPattern) {
  const dir = getSkillsDir();
  if (!dir) return null;
  const key = urlPatternKey(urlPattern);
  return path.join(dir, `${key}.json`);
}

// ── URL pattern extraction ────────────────────────────────────────────────────

/**
 * Convert a specific URL into a stable pattern (removes query params, fragments, IDs).
 * Examples:
 *   https://www.expedia.com/Flights-Search?... → https://www.expedia.com/Flights*
 *   https://www.fedex.com/en-ca/shipping/schedule... → https://www.fedex.com/en-ca/shipping*
 */
function extractUrlPattern(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    // Keep first 2 path segments as pattern
    const segments = u.pathname.split('/').filter(Boolean).slice(0, 2);
    const pathPrefix = segments.length > 0 ? '/' + segments.join('/') : '';
    return `${u.protocol}//${host}${pathPrefix}*`;
  } catch {
    return url;
  }
}

// ── Goal similarity ───────────────────────────────────────────────────────────

/**
 * Simple keyword-based similarity between a goal string and a stored skill goal.
 * Returns 0–1. Threshold for "match" is 0.4.
 */
function goalSimilarity(goalA, goalB) {
  if (!goalA || !goalB) return 0;
  const tokenize = (s) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  const tA = new Set(tokenize(goalA));
  const tB = new Set(tokenize(goalB));
  const intersection = new Set([...tA].filter((t) => tB.has(t)));
  const union = new Set([...tA, ...tB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Find a matching skill for the given goal + URL.
 *
 * @param {string} goal - user's natural language goal
 * @param {string} url - current page URL
 * @returns {NavioSkill|null}
 */
function findSkill(goal, url) {
  try {
    const dir = getSkillsDir();
    if (!dir) return null;
    const urlPattern = extractUrlPattern(url);
    const filePath = skillFilePath(urlPattern);
    if (!filePath || !fs.existsSync(filePath)) return null;

    const skill = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Validate freshness (skills older than 7 days are considered stale)
    const age = Date.now() - new Date(skill.last_verified || 0).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return null;

    // Check goal similarity
    const sim = goalSimilarity(goal, skill.goal);
    if (sim < 0.35) return null;

    return skill;
  } catch {
    return null;
  }
}

/**
 * Record a successful agent run as a skill.
 *
 * @param {string} goal - natural language goal
 * @param {string} url - page URL where the skill was performed
 * @param {SkillStep[]} steps - recorded action steps
 * @param {SuccessSignal} successSignal - how to verify replay success
 */
function recordSkill(goal, url, steps, successSignal) {
  try {
    const urlPattern = extractUrlPattern(url);
    const filePath = skillFilePath(urlPattern);
    if (!filePath) return false;

    const skill = {
      goal,
      url_pattern: urlPattern,
      steps: steps.map((s) => ({
        action: s.action,
        fingerprint: s.fingerprint || null,
        value_template: s.value_template || s.value || null,
        ref: s.ref || null
      })),
      success_signal: successSignal,
      last_verified: new Date().toISOString(),
      created_at: new Date().toISOString(),
      version: 1
    };

    fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Invalidate (delete) a cached skill — called when replay fails.
 *
 * @param {string} url
 */
function invalidateSkill(url) {
  try {
    const urlPattern = extractUrlPattern(url);
    const filePath = skillFilePath(urlPattern);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch { /* ignore */ }
}

/**
 * List all cached skills (for the list_workflows tool).
 *
 * @returns {SkillSummary[]}
 */
function listSkills() {
  try {
    const dir = getSkillsDir();
    if (!dir) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return {
          goal: skill.goal,
          url_pattern: skill.url_pattern,
          step_count: (skill.steps || []).length,
          last_verified: skill.last_verified
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Convert a skill's steps into a preview array for list_workflows.
 *
 * @param {NavioSkill} skill
 * @returns {SkillStepPreview[]}
 */
function previewSkill(skill) {
  if (!skill || !skill.steps) return [];
  return skill.steps.map((s, i) => ({
    step: i + 1,
    action: s.action,
    target: s.fingerprint?.name || s.ref || '?',
    value: s.value_template || ''
  }));
}

module.exports = {
  findSkill,
  recordSkill,
  invalidateSkill,
  listSkills,
  previewSkill,
  extractUrlPattern,
  goalSimilarity
};
