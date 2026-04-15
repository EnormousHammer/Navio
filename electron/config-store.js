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
  /** Folder synced by OneDrive / Google Drive / Dropbox; Navio writes navio-sync.navbak here. */
  syncFolderPath: '',
  /** Last applied or pushed profile exportedAt (ms); used for pull/push ordering. */
  syncLastSeenExportedAt: 0,
  readingModeFontScale: 1,
  formAutofillAssist: true,
  onboardingComplete: false,
  /** When false, startup skips the full-screen intro video (after first dismiss or Settings). */
  showLaunchIntro: true,
  userName: '',
  lastProactiveSuggestionAt: 0,
  showBookmarkBar: true,
  tabLayout: 'horizontal',
  memoryRetentionDays: 0,
  adBlockEnabled: true,
  /** When true, block unsolicited pop-ups (independent of ad list blocking). */
  popupBlockerEnabled: true,
  /** When true (and pop-up blocking on), also block small / blank script pop-ups unless URL looks like OAuth/SSO. */
  adStrictPopupBlock: true,
  /** When true, each download opens a system Save dialog (pick folder and name). When false, saves to Downloads automatically. */
  downloadAskWhere: false,
  /** When true, open File Explorer to the file after a successful download. Off by default to avoid interrupting browsing. */
  downloadRevealInFolder: false,
  /** Google Translate "translate to" language (e.g. en, es, zh-cn). Empty = use OS locale. */
  translateTargetLang: '',
  aiAutoExecute: false,
  aiAutoScreenshotAfterNavigate: false,
  aiAgentStepMode: false,
  /** Max agent loop iterations (50-500). Higher = bulk Gmail/API jobs less likely to stop early. */
  aiAgentMaxToolSteps: 200,
  aiUseToolCalling: true,
  /** Perplexity web search in assistant: auto = keyword intent, always = every message (if key), never = off */
  assistantConnectorWeb: 'auto',
  /** Gmail (and mail connector prefetch): auto = natural intent, always = include inbox context when connected, never = off */
  assistantConnectorMail: 'auto',
  /** When true, assistant receives short text excerpts from each open tab (capped). */
  assistantTabDigest: false,
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
  // Existing installs: don't force the intro again for users who already finished onboarding
  // before this flag existed (new installs still get DEFAULT_CONFIG.showLaunchIntro true).
  if (
    merged.onboardingComplete === true &&
    !Object.prototype.hasOwnProperty.call(file, 'showLaunchIntro')
  ) {
    merged.showLaunchIntro = false;
  }
  if (merged.aiDataScope === undefined || merged.aiDataScope === null) {
    merged.aiDataScope = merged.aiIncludePageContext === false ? 'none' : 'excerpt';
  }
  const _steps = Number(merged.aiAgentMaxToolSteps);
  merged.aiAgentMaxToolSteps = Number.isFinite(_steps) ? Math.min(500, Math.max(50, Math.round(_steps))) : 200;
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
