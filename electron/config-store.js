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
  /**
   * What Ctrl+T (and links opened into a new tab without a URL) show:
   *   'home' — full dashboard: AI search, shortcuts, Markets + Live sports by default (chips / Settings for Inbox or News).
   *   'chat' — chat-first: large AI prompt + keep shortcut tiles (Live Sports, Movies, etc.), hide widgets.
   *   'blank' — empty page; users land straight in the omnibox.
   */
  newTabMode: 'home',
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
  /** When true and NAVIO_SENTRY_DSN is set at runtime, send crash/diagnostic events to Sentry. */
  crashReportingEnabled: false,
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
  /** Read AI replies aloud (sidebar + compatible surfaces). */
  ttsEnabled: false,
  /** OpenAI speech voice id (see `navio-tts-voice-catalog.js`). */
  ttsVoice: 'nova',
  /** When true, each download opens a system Save dialog (pick folder and name). When false, saves to Downloads automatically (Chrome default). */
  downloadAskWhere: false,
  /** When true, open File Explorer to the file after a successful download. Off by default to avoid interrupting browsing. */
  downloadRevealInFolder: false,
  /** 0 = off. After N minutes inactive, background http(s) tabs unload to about:blank to free memory (Chrome-style discard).
   *  Default 30: pinned, incognito, agent, chat, and audible tabs are excluded in tabs.js so active work is never surprise-reloaded.
   *  Users who previously saved tabDiscardIdleMinutes: 0 keep that value (loadConfig merges saved file over defaults). */
  tabDiscardIdleMinutes: 30,
  /** Google Translate "translate to" language (e.g. en, es, zh-cn). Empty = use OS locale. */
  translateTargetLang: '',
  aiAutoExecute: false,
  aiAutoScreenshotAfterNavigate: false,
  aiAgentStepMode: false,
  /** Max agent loop iterations (50-500). Higher = browsing/research less likely to stop mid-task. */
  aiAgentMaxToolSteps: 300,
  aiUseToolCalling: true,
  /** Perplexity web search in assistant: auto = keyword intent, always = every message (if key), never = off */
  assistantConnectorWeb: 'auto',
  /** Gmail (and mail connector prefetch): auto = natural intent, always = include inbox context when connected, never = off */
  assistantConnectorMail: 'auto',
  /** When true, assistant receives short text excerpts from each open tab (capped). */
  assistantTabDigest: false,
  /** User-defined NTP shortcuts (array of { title, url }). Empty → fallback defaults in ntp.js. */
  ntpShortcuts: [],
  /**
   * Home dashboard (2×2): TL = mail, TR = news, BL = markets, BR = live sports.
   * Each: inbox | news | stocks | sports | none. Legacy Left/Right migrated if quad keys absent.
   */
  ntpWidgetTL: 'inbox',
  ntpWidgetTR: 'news',
  ntpWidgetBL: 'stocks',
  ntpWidgetBR: 'sports',
  /** Reddit hot feed when the News widget is shown (subreddit name only, no /r/). */
  ntpNewsSubreddit: 'worldnews',
  /**
   * Predicta sports hub URL. Navio's AI appendix uses this for deep links (?view=betting&sport=nba&board=live).
   * Default: hosted app. Override in navio-config.json for local dev (e.g. http://localhost:5173).
   */
  predictaBaseUrl: 'https://predicta-bet.vercel.app'
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

  function coerceBool(v, fallback) {
    if (v === true || v === 'true' || v === 1) return true;
    if (v === false || v === 'false' || v === 0) return false;
    return fallback;
  }
  merged.downloadAskWhere = coerceBool(merged.downloadAskWhere, DEFAULT_CONFIG.downloadAskWhere);
  merged.downloadRevealInFolder = coerceBool(merged.downloadRevealInFolder, DEFAULT_CONFIG.downloadRevealInFolder);

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
  merged.aiAgentMaxToolSteps = Number.isFinite(_steps) ? Math.min(500, Math.max(50, Math.round(_steps))) : 300;

  const WIDGET_SLOTS = new Set(['inbox', 'news', 'stocks', 'sports', 'none']);
  const QUAD_KEYS = ['ntpWidgetTL', 'ntpWidgetTR', 'ntpWidgetBL', 'ntpWidgetBR'];
  const hasQuad = QUAD_KEYS.some((k) => Object.prototype.hasOwnProperty.call(file, k));
  if (!hasQuad) {
    const coerceLegacy = (v, fb) => {
      const w = String(v || '').trim().toLowerCase();
      return WIDGET_SLOTS.has(w) ? w : fb;
    };
    let L = coerceLegacy(merged.ntpWidgetLeft, 'inbox');
    let R = coerceLegacy(merged.ntpWidgetRight, 'news');
    if (L === R && L !== 'none') {
      const alt = ['inbox', 'news', 'stocks', 'sports'].find((t) => t !== L);
      R = alt || 'news';
    }
    const used = new Set([L, R].filter((x) => x !== 'none'));
    const fillNext = () => {
      for (const t of ['stocks', 'sports', 'inbox', 'news', 'none']) {
        if (!used.has(t)) {
          used.add(t);
          return t;
        }
      }
      return 'none';
    };
    merged.ntpWidgetTL = L;
    merged.ntpWidgetTR = R;
    merged.ntpWidgetBL = fillNext();
    merged.ntpWidgetBR = fillNext();
  }
  for (const key of QUAD_KEYS) {
    const w = String(merged[key] || '').trim().toLowerCase();
    merged[key] = WIDGET_SLOTS.has(w) ? w : key.endsWith('TL') ? 'inbox' : key.endsWith('TR') ? 'news' : key.endsWith('BL') ? 'stocks' : 'sports';
  }
  (function dedupeNtpQuad() {
    const used = new Set();
    for (const key of QUAD_KEYS) {
      let v = merged[key];
      if (v !== 'none' && used.has(v)) v = 'none';
      if (v !== 'none') used.add(v);
      merged[key] = v;
    }
  })();
  /* Prefer Reddit news top-right and ESPN sports bottom-right (common mistaken swap). */
  if (merged.ntpWidgetTR === 'sports' && merged.ntpWidgetBR === 'news') {
    merged.ntpWidgetTR = 'news';
    merged.ntpWidgetBR = 'sports';
  }
  const sub = String(merged.ntpNewsSubreddit || 'worldnews')
    .trim()
    .toLowerCase()
    .replace(/^r\//, '');
  merged.ntpNewsSubreddit = /^[a-z0-9_]{2,24}$/.test(sub) ? sub : 'worldnews';
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
  delete merged.crashReportingAvailable;
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

  const rest = { ...partial };
  delete rest.apiKey;
  delete rest.hasApiKey;
  delete rest.crashReportingAvailable;
  const next = { ...file, ...rest };
  delete next.apiKey;
  delete next.hasApiKey;
  delete next.crashReportingAvailable;
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
