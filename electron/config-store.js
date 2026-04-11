'use strict';

const { app, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const secureConfig = require('./secure-config');

function getConfigPath() {
  return path.join(app.getPath('userData'), 'navio-config.json');
}

const DEFAULT_CONFIG = {
  aiProvider: 'openai',
  aiModel: 'gpt-5.4',
  aiPlannerModel: 'gpt-5.4-mini',
  customEndpoint: '',
  theme: 'dark',
  searchEngine: 'https://www.google.com/search?q=',
  homepage: 'https://www.google.com',
  sidebarWidth: 240,
  assistantWidth: 420,
  startupMode: 'new-tab',
  defaultZoom: 1,
  aiIncludePageContext: true,
  aiDataScope: 'excerpt',
  aiRedactPII: true,
  aiKillSwitch: false,
  aiStreamResponses: true,
  aiProactivity: 'off',
  shortcuts: {},
  extensionsAllowAI: false,
  mcpEnabled: false,
  mcpServers: [],
  syncEnabled: false,
  readingModeFontScale: 1,
  formAutofillAssist: true,
  onboardingComplete: false,
  userName: '',
  lastProactiveSuggestionAt: 0,
  showBookmarkBar: true,
  tabLayout: 'horizontal',
  memoryRetentionDays: 0,
  adBlockEnabled: true,
  /** When true (and ad blocking on), also block small / blank script pop-ups unless URL looks like OAuth/SSO. */
  adStrictPopupBlock: true,
  aiAutoExecute: false,
  aiAutoScreenshotAfterNavigate: false,
  aiAgentStepMode: false,
  aiUseToolCalling: true,
  /**
   * New tab page — bottom SPORTS ticker: curated streamed.pk slugs (id = /matches/{id}).
   * Edit in navio-config.json to add/remove/reorder. Empty array [] falls back to app defaults in ntp.js.
   */
  ntpLiveSportsCatalog: [
    { id: 'football', name: 'Football' },
    { id: 'basketball', name: 'NBA' },
    { id: 'american-football', name: 'NFL / NCAA FB' },
    { id: 'hockey', name: 'Hockey' },
    { id: 'baseball', name: 'Baseball' },
    { id: 'fight', name: 'UFC / Boxing' },
    { id: 'tennis', name: 'Tennis' },
    { id: 'motor-sports', name: 'Motorsports' }
  ]
};

function readConfigFile() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {
    console.error('readConfigFile', e.message);
  }
  return {};
}

function writeConfigFile(obj) {
  const clean = { ...obj };
  delete clean.apiKey;
  delete clean.hasApiKey;
  fs.writeFileSync(getConfigPath(), JSON.stringify(clean, null, 2));
}

function loadConfig() {
  const userData = app.getPath('userData');
  let file = readConfigFile();

  if (file.apiKey && typeof file.apiKey === 'string' && file.apiKey.length > 0) {
    secureConfig.setApiKey(userData, file.apiKey);
    delete file.apiKey;
    writeConfigFile(file);
  }

  const merged = { ...DEFAULT_CONFIG, ...file };
  if (merged.aiDataScope === undefined || merged.aiDataScope === null) {
    merged.aiDataScope = merged.aiIncludePageContext === false ? 'none' : 'excerpt';
  }
  // Drop retired GPT-4o defaults for direct OpenAI usage (replaced by GPT-5.4 family).
  const LEGACY_OPENAI_GPT4 = new Set(['gpt-4o', 'gpt-4o-mini']);
  if (merged.aiProvider === 'openai') {
    if (LEGACY_OPENAI_GPT4.has(merged.aiModel)) merged.aiModel = 'gpt-5.4';
    if (LEGACY_OPENAI_GPT4.has(merged.aiPlannerModel)) merged.aiPlannerModel = 'gpt-5.4-mini';
    if (merged.aiPlannerModel === 'gpt-5.4-nano') merged.aiPlannerModel = 'gpt-5.4-mini';
  }
  const key = secureConfig.getApiKey(userData);
  merged.hasApiKey = !!key;
  delete merged.apiKey;
  return merged;
}

function saveConfig(partial) {
  const userData = app.getPath('userData');
  const file = readConfigFile();

  if (Object.prototype.hasOwnProperty.call(partial, 'apiKey')) {
    const k = partial.apiKey;
    if (k === '' || k == null) {
      secureConfig.setApiKey(userData, '');
    } else if (typeof k === 'string') {
      secureConfig.setApiKey(userData, k);
    }
  }

  const { apiKey, hasApiKey, ...rest } = partial;
  const next = { ...file, ...rest };
  delete next.apiKey;
  delete next.hasApiKey;
  writeConfigFile(next);

  if (partial.theme) {
    nativeTheme.themeSource = partial.theme === 'light' ? 'light' : 'dark';
  }
  return true;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfigPath,
  readConfigFile,
  writeConfigFile,
  loadConfig,
  saveConfig
};
