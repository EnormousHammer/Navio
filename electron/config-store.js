'use strict';

const { app, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const secureConfig = require('./secure-config');
const { inferAiProviderFromApiKey, coerceModelsForProvider } = require('./infer-ai-provider');

function getConfigPath() {
  return path.join(app.getPath('userData'), 'navio-config.json');
}

const DEFAULT_CONFIG = {
  aiProvider: 'openai',
  aiModel: 'gpt-5-mini',
  aiPlannerModel: 'gpt-5-mini',
  customEndpoint: '',
  theme: 'dark',
  /** Accent palette: aurora | ocean | ember | forest | magenta | slate — see css/parts/colorways.css */
  accentColorway: 'aurora',
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
  /**
   * Reasoning / extended-thinking budget passed to the active provider.
   *   'off'    — no reasoning params sent (legacy non-thinking behavior).
   *   'low'    — small thinking budget (faster, cheaper, modest depth).
   *   'medium' — balanced (default for capable models).
   *   'high'   — long thinking budget (best quality, more tokens, slower).
   *   'auto'   — Navio enables 'medium' on reasoning-capable models (GPT-5/o-series,
   *              Claude 4 family + 3.7 Sonnet, Gemini 2.5/3.x); no params on others.
   * Has no effect on the NTP "brief" path (kept fast). Backward-compatible: existing
   * installs default to 'auto'; setting 'off' restores prior behavior exactly.
   */
  aiReasoningEffort: 'auto',
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
  showLaunchIntro: false,
  userName: '',
  lastProactiveSuggestionAt: 0,
  showBookmarkBar: true,
  tabLayout: 'horizontal',
  memoryRetentionDays: 0,
  adBlockEnabled: true,
  /** When true, block unsolicited pop-ups (independent of ad list blocking). */
  popupBlockerEnabled: true,
  /** When true (and pop-up blocking on), also block small / blank script pop-ups unless URL looks like OAuth/SSO. Off by default — fewer false positives; turn on under Privacy for stricter ad-style windows. */
  adStrictPopupBlock: false,
  /** Read AI replies aloud (sidebar + compatible surfaces). */
  ttsEnabled: false,
  /** OpenAI speech voice id (see `navio-tts-voice-catalog.js`). */
  ttsVoice: 'nova',
  /**
   * OpenAI `/v1/audio/transcriptions` model: whisper-1 (classic Whisper), gpt-4o-transcribe,
   * or gpt-4o-mini-transcribe. Custom API bases may only support whisper-1.
   */
  sttModel: 'whisper-1',
  /** When true, each download opens a system Save dialog (pick folder and name). When false, saves to Downloads automatically (Chrome-style). */
  downloadAskWhere: true,
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
  predictaBaseUrl: 'https://predicta-bet.vercel.app',
  /**
   * Hostnames (one string per entry, suffix match) for which Navio does not load the
   * page in the guest webview — it opens the URL in the OS default browser instead.
   * Example: `purolator.com` matches `www.purolator.com`. Optional escape hatch under Privacy.
   */
  defaultBrowserHostLines: []
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

  if (merged.defaultBrowserHostLines != null && !Array.isArray(merged.defaultBrowserHostLines)) {
    if (typeof merged.defaultBrowserHostLines === 'string') {
      merged.defaultBrowserHostLines = merged.defaultBrowserHostLines
        .split(/\r?\n/)
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    } else {
      merged.defaultBrowserHostLines = [];
    }
  }
  if (!Array.isArray(merged.defaultBrowserHostLines)) merged.defaultBrowserHostLines = [];

  function coerceBool(v, fallback) {
    if (v === true || v === 'true' || v === 1) return true;
    if (v === false || v === 'false' || v === 0) return false;
    return fallback;
  }
  merged.downloadAskWhere = coerceBool(merged.downloadAskWhere, DEFAULT_CONFIG.downloadAskWhere);
  merged.downloadRevealInFolder = coerceBool(merged.downloadRevealInFolder, DEFAULT_CONFIG.downloadRevealInFolder);

  // Existing installs: don't force the intro again for users who already finished onboarding
  // before this flag existed (new installs default showLaunchIntro off for fast startup).
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
  const NAVIO_STT_MODELS = new Set(['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
  const sttM = String(merged.sttModel || '').trim();
  merged.sttModel = NAVIO_STT_MODELS.has(sttM) ? sttM : 'whisper-1';
  // Drop retired GPT-4o defaults for direct OpenAI usage; prefer GPT-5 mini tier for cost.
  const LEGACY_OPENAI_GPT4 = new Set(['gpt-4o', 'gpt-4o-mini']);
  if (merged.aiProvider === 'openai') {
    const beforeMain = merged.aiModel;
    const beforePlanner = merged.aiPlannerModel;
    if (LEGACY_OPENAI_GPT4.has(merged.aiModel)) merged.aiModel = 'gpt-5-mini';
    if (LEGACY_OPENAI_GPT4.has(merged.aiPlannerModel)) merged.aiPlannerModel = 'gpt-5-mini';
    if (merged.aiPlannerModel === 'gpt-5.4-nano') merged.aiPlannerModel = 'gpt-5-mini';
    if (merged.aiModel === 'gpt-5.4') merged.aiModel = 'gpt-5-mini';
    if (merged.aiModel === 'gpt-5.4-mini') merged.aiModel = 'gpt-5-mini';
    if (merged.aiPlannerModel === 'gpt-5.4-mini') merged.aiPlannerModel = 'gpt-5-mini';
    if (merged.aiModel !== beforeMain || merged.aiPlannerModel !== beforePlanner) {
      try {
        const disk = readConfigFile();
        disk.aiModel = merged.aiModel;
        disk.aiPlannerModel = merged.aiPlannerModel;
        delete disk.apiKey;
        writeConfigFile(disk);
      } catch (_) {
        /* ignore disk errors */
      }
    }
  }
  const key = secureConfig.getApiKey(userData);
  merged.hasApiKey = !!key;
  delete merged.apiKey;
  delete merged.crashReportingAvailable;

  // Self-heal: stored key shape vs wrong aiProvider (e.g. OpenAI key with Anthropic selected).
  if (
    key &&
    typeof key === 'string' &&
    key.trim().length >= 8 &&
    merged.aiProvider !== 'custom' &&
    merged.aiProvider !== 'ollama'
  ) {
    const inferred = inferAiProviderFromApiKey(key);
    if (inferred && inferred !== merged.aiProvider) {
      merged.aiProvider = inferred;
      const coerced = coerceModelsForProvider(inferred, merged.aiModel, merged.aiPlannerModel);
      merged.aiModel = coerced.aiModel;
      merged.aiPlannerModel = coerced.aiPlannerModel;
      try {
        const disk = readConfigFile();
        disk.aiProvider = merged.aiProvider;
        disk.aiModel = merged.aiModel;
        disk.aiPlannerModel = merged.aiPlannerModel;
        delete disk.apiKey;
        writeConfigFile(disk);
      } catch (_) {
        /* ignore disk errors */
      }
    } else if (inferred === merged.aiProvider) {
      const coerced = coerceModelsForProvider(inferred, merged.aiModel, merged.aiPlannerModel);
      if (coerced.aiModel !== merged.aiModel || coerced.aiPlannerModel !== merged.aiPlannerModel) {
        merged.aiModel = coerced.aiModel;
        merged.aiPlannerModel = coerced.aiPlannerModel;
        try {
          const disk = readConfigFile();
          disk.aiModel = merged.aiModel;
          disk.aiPlannerModel = merged.aiPlannerModel;
          delete disk.apiKey;
          writeConfigFile(disk);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

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

  // When the user saves a non-trivial API key, align provider (and models) with key shape.
  // Never override custom endpoint or Ollama — those are intentional modes.
  if (
    Object.prototype.hasOwnProperty.call(partial, 'apiKey') &&
    typeof partial.apiKey === 'string' &&
    partial.apiKey.trim().length >= 8
  ) {
    const inferred = inferAiProviderFromApiKey(partial.apiKey.trim());
    const prov = next.aiProvider || 'openai';
    if (inferred && prov !== 'custom' && prov !== 'ollama') {
      next.aiProvider = inferred;
      const coerced = coerceModelsForProvider(inferred, next.aiModel, next.aiPlannerModel);
      next.aiModel = coerced.aiModel;
      next.aiPlannerModel = coerced.aiPlannerModel;
    }
  }

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
