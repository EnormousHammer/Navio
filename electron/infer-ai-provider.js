'use strict';

/**
 * Guess which first-party AI provider a pasted API key belongs to.
 * @param {string} key
 * @returns {'openai'|'anthropic'|'google'|null}
 */
function inferAiProviderFromApiKey(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  if (k.length < 8) return null;

  // Anthropic (e.g. sk-ant-api03-…)
  if (/^sk-ant-/i.test(k)) return 'anthropic';

  // Google API keys used with Generative Language API (common prefix)
  if (/^AIza[0-9A-Za-z_-]{16,}$/.test(k)) return 'google';

  // OpenAI (sk-proj-… or sk-… but never sk-ant-…)
  if (/^sk-proj-/i.test(k)) return 'openai';
  if (/^sk-(?!ant-)/i.test(k)) return 'openai';

  return null;
}

const DEFAULTS = {
  openai: { aiModel: 'gpt-5-mini', aiPlannerModel: 'gpt-5-mini' },
  anthropic: { aiModel: 'claude-opus-4-5', aiPlannerModel: 'claude-sonnet-4-5' },
  google: { aiModel: 'gemini-2.0-flash', aiPlannerModel: 'gemini-2.0-flash' }
};

function _looksAnthropicModel(x) {
  return /^claude/i.test(x || '') || x === '__custom__';
}
function _looksGoogleModel(x) {
  return /^gemini/i.test(x || '') || x === '__custom__';
}
function _looksOpenAiFamilyModel(x) {
  return /^(gpt|o\d)/i.test(x || '') || x === '__custom__';
}

/**
 * If stored model ids do not match the provider, reset to sane defaults.
 * @param {'openai'|'anthropic'|'google'} provider
 * @param {string} [aiModel]
 * @param {string} [aiPlannerModel]
 */
function coerceModelsForProvider(provider, aiModel, aiPlannerModel) {
  const def = DEFAULTS[provider];
  if (!def) return { aiModel, aiPlannerModel };

  let m = aiModel;
  let p = aiPlannerModel;

  if (provider === 'anthropic' && !_looksAnthropicModel(m)) m = def.aiModel;
  if (provider === 'google' && !_looksGoogleModel(m)) m = def.aiModel;
  if (provider === 'openai' && !_looksOpenAiFamilyModel(m)) m = def.aiModel;

  if (provider === 'anthropic' && !_looksAnthropicModel(p)) p = def.aiPlannerModel;
  if (provider === 'google' && !_looksGoogleModel(p)) p = def.aiPlannerModel;
  if (provider === 'openai' && !_looksOpenAiFamilyModel(p)) p = def.aiPlannerModel;

  return { aiModel: m, aiPlannerModel: p };
}

module.exports = {
  inferAiProviderFromApiKey,
  coerceModelsForProvider
};
