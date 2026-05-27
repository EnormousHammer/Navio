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
  openai: { aiModel: 'gpt-4.1', aiPlannerModel: 'gpt-4.1' },
  anthropic: { aiModel: 'claude-opus-4-5', aiPlannerModel: 'claude-sonnet-4-5' },
  google: { aiModel: 'gemini-2.5-flash', aiPlannerModel: 'gemini-2.5-flash' }
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

/**
 * Retired / downgraded OpenAI chat presets → gpt-5 (full model, not mini).
 * gpt-5-mini is also upgraded here so existing installs automatically get the
 * smarter default without requiring a manual Settings change.
 * Does not touch STT/TTS (`sttModel`, `ttsVoice`, etc.).
 */
/**
 * Retired / legacy OpenAI chat models → gpt-4.1 (current default: 1M context, $2/$8).
 * All prior interim defaults are normalised here so existing installs auto-update
 * without a manual Settings change.
 * Does not touch STT/TTS (`sttModel`, `ttsVoice`, etc.).
 */
const LEGACY_OPENAI_CHAT_UPGRADE = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-5', 'gpt-5.4-mini']);

function normalizeLegacyOpenAiChatModels(aiProvider, aiModel, aiPlannerModel) {
  if (aiProvider !== 'openai') {
    return { aiModel, aiPlannerModel };
  }
  let m = aiModel;
  let p = aiPlannerModel;
  if (LEGACY_OPENAI_CHAT_UPGRADE.has(m)) m = 'gpt-4.1';
  if (LEGACY_OPENAI_CHAT_UPGRADE.has(p)) p = 'gpt-4.1';
  return { aiModel: m, aiPlannerModel: p };
}

module.exports = {
  inferAiProviderFromApiKey,
  coerceModelsForProvider,
  normalizeLegacyOpenAiChatModels
};
