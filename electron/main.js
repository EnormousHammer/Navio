const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, MenuItem, globalShortcut, nativeTheme, clipboard, net, webContents: electronWebContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const secureConfig = require('./secure-config');
const { NAVIO_PARTITION_INCOGNITO } = require('./navio-partitions');
const { clearRendererCodeCachesIfDev } = require('./clear-code-cache-dev');
const { resolveTranslateTargetLang } = require('./translate-locale');
const { createStore } = require('./navio-store');
const {
  setupSessionInfrastructure,
  recordNavioPopupBlocked,
  navioPrimeGlobalShortcutsIfFocused
} = require('./session-setup');
const sitePerms = require('./site-permissions');
const { loadConfig, saveConfig } = require('./config-store');
const { registerBookmarksIpc } = require('./bookmarks-ipc');
const { registerHistoryIpc } = require('./history-ipc');
const { registerWebviewActionsIpc } = require('./webview-actions-ipc');
const { registerExtensionsIpc, loadPersistedExtensionsOnStartup } = require('./extensions-ipc');
const { registerSyncIpc, startNavioCloudSync } = require('./navio-sync-ipc');
const { registerProfilesIpc } = require('./navio-profiles-ipc');
const { registerAgentPlanIpc } = require('./navio-agent-ipc');
const { navioIsExternalProtocolUrl, navioExtractHttpsFromBrowserHandoffUrl, navioNormalizeTabOpenUrl } = require('./navio-url-utils');
const { registerMemoryIpc, loadMemory, saveMemory, buildMemoryBlock, buildProfileBlock, extractAndSaveMemory } = require('./memory-ipc');
const { registerReadingListIpc } = require('./reading-list-ipc');
const { registerPasswordsIpc, maybeImportOemStremioCredentials } = require('./passwords-ipc');
const { registerBrowserImportIpc } = require('./browser-import-ipc');
const { registerContextMenuIpc } = require('./context-menu-ipc');
const { registerSearchSuggestionsIpc } = require('./search-suggestions-ipc');
const { NAVIO_TOOLS, toOpenAITools, toAnthropicTools, toGeminiTools } = require('./navio-tools');
const { getAccessibilityTree, clickByRef, typeByRef, selectByRef, getRefMap, clearRefMap, registerPersistentSession, unregisterPersistentSession } = require('./a11y-tree');
const { snapshotPage, verifyAction, dismissOverlay, waitForIdle } = require('./navio-agent-verify');
const { startMonitoring, getConsoleMessages, getNetworkRequests, stopMonitoring } = require('./cdp-inspector');
const { loadWorkflow, saveWorkflow, listWorkflows, deleteWorkflow } = require('./navio-workflows');
const { getMcpTools, callMcpTool, isMcpTool, initFromConfig: initMcpFromConfig, registerMcpIpc } = require('./navio-mcp');
const { getSiteIntelForUrl, extractActiveUrl } = require('./navio-site-intel');
const { initScheduler, registerSchedulerIpc, stopAll: stopAllSchedulers } = require('./navio-scheduler');
const { shouldBlockWebPopup, isStreamingVideoOpenerOrigin } = require('./ad-block-patterns');
const { redactPII } = require('./pii-redact');
const navioCrashReporter = require('./navio-crash-reporter');
const { wcCanGoBack, wcCanGoForward } = require('./wc-nav-history');
const { ensureGuestWebviewKeyboardFocus } = require('./agent-input-focus');
const { BINARY_MAX_BYTES, shouldDownloadAndExtract, extractDriveFileText } = require('./drive-file-text');
const { tabManager } = require('./tab-manager');

function getProfileIdFromLaunch() {
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith('--navio-profile='));
  if (a) return a.slice('--navio-profile='.length).trim();
  return (process.env.NAVIO_PROFILE || '').trim();
}

// Per-profile user data: --navio-profile=<id> or NAVIO_PROFILE=<id> uses
// <default userData>/profiles/<id>/ as the active data directory.
const NAVIO_PROFILES_BASE = (() => {
  const base = app.getPath('userData');
  const prof = getProfileIdFromLaunch();
  if (prof && prof !== 'default' && /^[a-zA-Z0-9_-]{1,64}$/.test(prof)) {
    app.setPath('userData', path.join(base, 'profiles', prof));
  }
  return base;
})();

/** One process per userData dir so Windows global hotkeys + disk caches are not contended. */
const navioGotSingleInstanceLock = app.requestSingleInstanceLock();
if (!navioGotSingleInstanceLock) {
  console.warn('[navio] Another instance is already running for this profile (same user data). Exiting.');
  app.quit();
  process.exit(0);
}

/** Surface main-process failures and renderer exits in logs (especially when no dev terminal). */
function installNavioProductionDiagnostics() {
  process.on('uncaughtException', (err) => {
    console.error('[navio] uncaughtException:', err && err.stack ? err.stack : String(err));
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack : String(reason);
    console.error('[navio] unhandledRejection:', msg);
  });
}
installNavioProductionDiagnostics();

// Disable browser-level COOP/COEP enforcement so sites like Gmail and Google
// services load correctly in Electron webviews. Without this, Chromium 130+
// (Electron 33+) rejects the navigation with ERR_BLOCKED_BY_RESPONSE BEFORE
// our onHeadersReceived handler can strip the Cross-Origin-Opener-Policy header.
app.commandLine.appendSwitch(
  'disable-features',
  'CrossOriginOpenerPolicy,CrossOriginEmbedderPolicy,CrossOriginEmbedderPolicyCredentialless'
);

const INTRO_VIDEO_PATH = path.join(__dirname, '..', 'public', 'intro_video', 'intro_final.mp4');

let mainWindow = null;
let store = null;
// Tracked across the session so Settings → "Install update" knows when there is
// a downloaded installer ready to apply on quit.
let navioUpdateState = {
  status: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'not-available' | 'error'
  version: null,
  downloadPercent: 0,
  message: '',
  checkedAt: 0
};
function navioEmitUpdateState() {
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('update-status-changed', { ...navioUpdateState });
    }
  } catch { /* ignore */ }
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function messageContentToPlainString(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (!p) return '';
      if (p.type === 'text') return String(p.text || '');
      if (p.type === 'image_url') return '[image]';
      if (p.type === 'navio_pdf') return `[PDF: ${p.filename || 'file.pdf'}]`;
      if (p.type === 'navio_inline') return `[File: ${p.filename || 'file'}]`;
      return '';
    })
    .join('\n');
}

/** OpenAI Chat Completions file part (vision-capable models: PDF text + page images). See FileContentPart in API reference. */
function openAiFilePartFromPdfBase64(filename, base64) {
  return {
    type: 'file',
    file: {
      filename: filename || 'document.pdf',
      file_data: `data:application/pdf;base64,${base64}`
    }
  };
}

/** OpenAI / custom chat: map internal multimodal parts to Chat Completions schema. */
function normalizeMessagesForOpenAI(messages) {
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const next = [];
    for (const part of m.content) {
      if (!part) continue;
      if (part.type === 'navio_pdf') {
        if (part.base64) {
          next.push(openAiFilePartFromPdfBase64(part.filename || 'document.pdf', part.base64));
        } else {
          next.push({
            type: 'text',
            text: `[Attached PDF: ${part.filename || 'document.pdf'}] (file data was not available — try attaching again.)`
          });
        }
        continue;
      }
      if (part.type === 'navio_inline' && part.base64) {
        const mt = part.mimeType || 'application/octet-stream';
        if (mt.startsWith('image/')) {
          next.push({
            type: 'image_url',
            image_url: { url: `data:${mt};base64,${part.base64}`, detail: 'high' }
          });
        } else if (mt === 'application/pdf') {
          next.push(openAiFilePartFromPdfBase64(part.filename || 'document.pdf', part.base64));
        } else {
          next.push({
            type: 'text',
            text:
              `[Attached: ${part.filename || 'file'}] (${mt}) This OpenAI chat path only sends images and PDFs as bytes. For other file types, switch **Settings → AI** to **Anthropic** or **Google**, or paste text.`
          });
        }
        continue;
      }
      next.push(part);
    }
    if (next.length === 0) return { ...m, content: '' };
    if (next.length === 1 && next[0].type === 'text') return { ...m, content: next[0].text || '' };
    return { ...m, content: next };
  });
}

/** Anthropic expects `image` + `document` blocks, not OpenAI `image_url`. */
function normalizeMessagesForAnthropic(messages) {
  return messages.map((m) => {
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) return m;
    const blocks = [];
    for (const part of m.content) {
      if (!part) continue;
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text || '' });
      } else if (part.type === 'image_url' && part.image_url?.url) {
        const u = part.image_url.url;
        const dm = u.match(/^data:([^;]+);base64,(.+)$/);
        if (dm) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: dm[1], data: dm[2] }
          });
        }
      } else if (part.type === 'navio_pdf' && part.base64) {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.base64
          }
        });
      } else if (part.type === 'navio_inline' && part.base64) {
        const mt = part.mimeType || 'application/octet-stream';
        if (mt.startsWith('image/')) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mt, data: part.base64 }
          });
        } else if (mt === 'application/pdf') {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: part.base64 }
          });
        } else {
          const maxB64 = 450000;
          const b64 = part.base64.length > maxB64 ? `${part.base64.slice(0, maxB64)}\n… [truncated]` : part.base64;
          blocks.push({
            type: 'text',
            text: `[Attached file: ${part.filename || 'file'}] (${mt})\n\`\`\`\n${b64}\n\`\`\``
          });
        }
      }
    }
    if (!blocks.length) return { ...m, content: '' };
    return { ...m, content: blocks };
  });
}

function hashContext(messages) {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => messageContentToPlainString(m.content))
    .join('\n');
  return crypto.createHash('sha256').update(sys.slice(0, 4000)).digest('hex').slice(0, 20);
}

const RISKY_BROWSER_ACTIONS = new Set(['navigate', 'click', 'type']);

/** Detect login / OAuth URLs after navigation (agent should pause for user). */
const AUTH_GATE_URL_RE =
  /\/(login|signin|sign-in|auth|account\/login|session\/new|oauth|sso)\b|accounts\.google\.com\/(signin|ServiceLogin)|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com/i;

/** After a click, wait for navigation if it starts within timeoutMs; else resolve when timeout elapses. */
function waitForOptionalNavigationAfterClick(wc, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try {
        wc.removeListener('did-finish-load', onLoad);
      } catch {
        /* ignore */
      }
      resolve();
    };
    const onLoad = () => {
      setTimeout(done, 400);
    };
    const t = setTimeout(done, timeoutMs);
    wc.once('did-finish-load', onLoad);
  });
}

/** Full navigation + settle (deep research, restore tab URL). */
function navigateWebContentsAndWait(wc, targetUrl) {
  return new Promise((resolve, reject) => {
    const MAX_WAIT = 12000;
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onLoad);
      wc.removeListener('did-fail-load', onFail);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => settle(), MAX_WAIT);
    const onLoad = () => setTimeout(() => settle(), 800);
    const onFail = (_, code, desc) => {
      if (code === -3) setTimeout(() => settle(), 800);
      else settle(new Error(`Navigation failed: ${desc} (${code})`));
    };
    wc.once('did-finish-load', onLoad);
    wc.once('did-fail-load', onFail);
    wc.loadURL(targetUrl).catch((e) => {
      if (e.message?.includes('ERR_ABORTED') || e.message?.includes('-3')) {
        /* redirect */
      } else {
        settle(e);
      }
    });
  });
}

/** Hidden window for deep research (persist:navio session); caller must destroy(). */
function createResearchWindow() {
  const navioSession = session.fromPartition('persist:navio');
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: navioSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  return win;
}

function workflowsJsonPath() {
  return path.join(app.getPath('userData'), 'navio-workflows.json');
}

function readWorkflowsFile() {
  try {
    const p = workflowsJsonPath();
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.workflows) ? j.workflows : [];
  } catch {
    return [];
  }
}

function writeWorkflowsFile(list) {
  fs.writeFileSync(workflowsJsonPath(), JSON.stringify({ workflows: list }, null, 2), 'utf8');
}

/** Command palette + assistant need one merged list (legacy JSON + per-file tool workflows). */
function listWorkflowsMergedForIpc() {
  const legacy = readWorkflowsFile();
  const navioConverted = [];
  try {
    for (const s of listWorkflows()) {
      const full = loadWorkflow(s.name);
      if (!full || !Array.isArray(full.steps)) continue;
      const id = `navio_${crypto.createHash('sha256').update(String(full.name || s.name)).digest('hex').slice(0, 16)}`;
      const steps = full.steps.map((step) => {
        if (step && typeof step.tool === 'string') {
          return `${step.tool}:${JSON.stringify(step.args || {})}`;
        }
        return String(step);
      });
      navioConverted.push({
        id,
        name: full.name || s.name,
        steps,
        createdAt: full.created || full.updated || new Date().toISOString()
      });
    }
  } catch (e) {
    console.warn('[navio] workflow list (navio files):', e.message);
  }
  return { workflows: [...legacy, ...navioConverted] };
}

// ── Email write-action protection ─────────────────────────────────────────────
// The AI may create/update/delete drafts and send **via Gmail API** (gmail_send_draft) when tools allow; send always waits for an in-app confirmation IPC.
// What is blocked here is **automating the provider’s Send button in the web UI** (Gmail/Outlook/etc.):
// mis-clicks can dispatch irreversible mail. This guard is enforced at the IPC layer regardless of prompts.
const EMAIL_PROTECTED_DOMAINS = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'app.tuta.com',
  'app.fastmail.com',
  'mail.zoho.com'
];

// Only the final Send action is blocked — the AI IS allowed to open compose,
// click Reply, type draft body, and save drafts. It must never click Send.
// Selectors are matched loosely so Gmail/Outlook/Yahoo/etc. are all covered.
const EMAIL_SEND_SELECTORS = [
  'text=send',
  'aria=send',
  'text=send email',
  'text=send message',
  'text=send now',
  'aria=send email',
  'aria=send message',
  // Gmail's exact send button aria-label includes "send" but also "(Ctrl-Enter)"
  // so we match on the word "send" alone to catch all variants
];

function isEmailProtectedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return EMAIL_PROTECTED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function isEmailWriteAction(action, params) {
  // Only block clicking the Send button — composing, replying, typing drafts are all allowed
  if (action !== 'click') return false;
  const selector = (params?.selector || '').toLowerCase().trim();
  return EMAIL_SEND_SELECTORS.some((s) => selector === s || selector.startsWith(s + ' '));
}

// ── Authoritative system prompts ─────────────────────────────────────────────
// Tool-calling mode uses the main prompt; legacy mode uses the legacy prompt.
let NAVIO_SYSTEM_PROMPT = '';
let NAVIO_SYSTEM_PROMPT_LEGACY = '';
try {
  NAVIO_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'navio-system-prompt.txt'), 'utf8');
} catch (e) {
  console.error('[Navio] Could not load navio-system-prompt.txt:', e.message);
  NAVIO_SYSTEM_PROMPT = 'You are Navio, a helpful AI browser assistant.';
}
try {
  NAVIO_SYSTEM_PROMPT_LEGACY = fs.readFileSync(path.join(__dirname, 'navio-system-prompt-legacy.txt'), 'utf8');
} catch {
  NAVIO_SYSTEM_PROMPT_LEGACY = NAVIO_SYSTEM_PROMPT;
}

// ── Conditional prompt blocks (loaded once, injected on demand) ───────────────
const PROMPT_BLOCKS = {};
const PROMPT_BLOCKS_DIR = path.join(__dirname, 'prompt-blocks');
for (const [key, file] of [
  ['shipping', 'shipping.txt'],
  ['pickup', 'pickup.txt'],
  ['gmail', 'gmail.txt'],
  ['connector-setup', 'connector-setup.txt'],
]) {
  try {
    PROMPT_BLOCKS[key] = fs.readFileSync(path.join(PROMPT_BLOCKS_DIR, file), 'utf8');
  } catch (e) {
    console.warn(`[Navio] Could not load prompt block "${key}":`, e.message);
    PROMPT_BLOCKS[key] = '';
  }
}

/**
 * Given the current messages array, decide which specialty blocks to inject.
 * Returns an object { shipping, gmail, 'connector-setup' } with boolean values.
 */
function _detectPromptBlocks(messages) {
  let activeUrl = '';
  let userText = '';

  for (const m of messages) {
    if (!m) continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') {
      const match = content.match(/\[Active tab[^\]]*\]\s*[:\-–]?\s*(https?:\/\/[^\s\]]+)/i);
      if (match) activeUrl = match[1].toLowerCase();
    }
    if (m.role === 'user') {
      userText = content.toLowerCase();
    }
  }

  const SHIPPING_URL =
    /purolator|fedex|ups\.(com|ca)|dhl\.com|tql\.com|freightquote|coyote|echo\.|ufreightcom|xpo\.com|saia\.com|estes-express|rdfs\.com|daytonfreight|rlcarriers|forwarding|broker|dayross|manitoulin|mtrans\.com|odfl\.com|abf\.com|yrc\.com/i;
  const SHIPPING_WORDS =
    /\b(ship|freight|ltl|ftl|carrier|tracking|parcel|courier|pallet|waybill|bill of lading|pickup\s*request|get\s*a\s*quote|shipping\s*(quote|rate|cost)|fedex|purolator|ups|dhl|tql|broker|day\s*&?\s*ross|dayross|manitoulin|mtrans|tql\s*freight)\b/i;

  const GMAIL_URL = /mail\.google\.com/i;
  const GMAIL_WORDS =
    /\b(email|inbox|gmail|unread|draft|reply|compose|send\s+(an?\s+)?email|check\s+(my\s+)?mail|messages?\s+from|bounce|ndr|delivery\s+failure)\b/i;

  const CONNECTOR_URL =
    /console\.cloud\.google\.com|portal\.azure\.com|github\.com\/settings\/(applications|apps|developer)|dropbox\.com\/developers|api\.slack\.com|developers\.notion\.com|app\.slack\.com\/apps/i;
  const CONNECTOR_WORDS =
    /\b(oauth|client\s*id|client\s*secret|redirect\s*(uri|url)|api\s*key|connect\s+(google|gmail|drive|dropbox|slack|notion|github|microsoft|outlook|azure)|set\s*up\s+(the\s+)?(connector|integration|oauth|google|gmail)|google\s*cloud\s*console|developer\s*console|credential)\b/i;

  const PICKUP_URL =
    /purolator\.com\/(en|fr)\/shipping\/schedule|eshiponline\.purolator|fedex\.com\/(en-ca|en-us)\/shipping\/schedule-manage-pickups|ups\.com\/(pickup|ca\/en\/shipping\/schedule)|mydhl\.express\.dhl|canadapost.*pickup|dayross\.com\/(en\/shipping\/book|pickup)|manitoulintransport\.com.*pickup|tql\.com\/get-a-quote|echo\.com\/shippers|coyote\.com.*shippers/i;
  const PICKUP_WORDS =
    /\b(schedule\s+a?\s*pickup|book\s+a?\s*pickup|arrange\s+(a\s+)?(collection|pickup)|request\s+(a\s+)?pickup|pickup\s+request|pickup\s+(date|time|window|address|confirmation)|carrier\s+pickup|driver\s+(pickup|collection)|pick\s*up\s+(my\s+)?(package|shipment|parcel|skid|pallet|freight|order)|when\s+(is|will)\s+(the\s+)?pickup|set\s+up\s+(a\s+)?pickup|(fedex|ups|purolator|dhl|dayross|day\s*&?\s*ross|manitoulin|tql|echo|coyote)\s+(pickup|will\s+pick\s*up|coming\s+to\s+pick))\b/i;

  return {
    shipping: SHIPPING_URL.test(activeUrl) || SHIPPING_WORDS.test(userText),
    pickup: PICKUP_URL.test(activeUrl) || PICKUP_WORDS.test(userText),
    gmail: GMAIL_URL.test(activeUrl) || GMAIL_WORDS.test(userText),
    'connector-setup': CONNECTOR_URL.test(activeUrl) || CONNECTOR_WORDS.test(userText),
  };
}

// ── Markdown → HTML converter (used for Google Docs rich-text paste) ─────────
// Converts simple markdown (headings, bold, italic, bullets, hr) to HTML so that
// when pasted into Google Docs via Ctrl+V the content arrives with real formatting.

function _escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _inlineFormat(str) {
  str = _escHtml(str);
  str = str.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  str = str.replace(/__(.+?)__/g, '<strong>$1</strong>');
  str = str.replace(/\*(.+?)\*/g, '<em>$1</em>');
  str = str.replace(/_(.+?)_/g, '<em>$1</em>');
  return str;
}

function markdownToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;

  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      closeList();
      out.push('<br>');
      continue;
    }
    if (t === '---' || t === '***' || t === '___') {
      closeList();
      out.push('<hr>');
    } else if (t.startsWith('### ')) {
      closeList();
      out.push(`<h3>${_inlineFormat(t.slice(4))}</h3>`);
    } else if (t.startsWith('## ')) {
      closeList();
      out.push(`<h2>${_inlineFormat(t.slice(3))}</h2>`);
    } else if (t.startsWith('# ')) {
      closeList();
      out.push(`<h1>${_inlineFormat(t.slice(2))}</h1>`);
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${_inlineFormat(t.slice(2))}</li>`);
    } else if (/^\d+\.\s/.test(t)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${_inlineFormat(t.replace(/^\d+\.\s/, ''))}</li>`);
    } else {
      closeList();
      out.push(`<p>${_inlineFormat(t)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

// ── <navio-actions> block converter ──────────────────────────────────────────
// The system prompt asks the model to output a <navio-actions> block at the end
// of its response. This function converts that block into [[ACTION:type:params]]
// tokens that the renderer's formatMessage() can parse and display as cards.
// This runs in main.js (Node.js, no bytecode cache) so it always uses fresh code.

function convertNavioActionsBlock(text) {
  if (!text) return text;

  // Convert <navio-plan> block into a [[PLAN:...]] token the renderer can display
  text = text.replace(/<navio-plan>([\s\S]*?)<\/navio-plan>/gi, (_, body) => {
    const steps = body.split('\n').map(l => l.trim()).filter(Boolean);
    if (!steps.length) return '';
    // Encode steps as pipe-separated, wrapped in a PLAN token
    const encoded = steps.map(s => s.replace(/^Step\s*\d+:\s*/i, '').trim()).join('||');
    return `[[PLAN:${encoded}]]`;
  });

  // Convert <navio-actions> block into [[ACTION:type:params]] tokens.
  // insertText is special: its content may span many lines, so we collect
  // everything after "insertText:" until the next action keyword or end of block.
  text = text.replace(/<navio-actions>([\s\S]*?)<\/navio-actions>/gi, (_, body) => {
    const valid = new Set([
      'navigate',
      'click',
      'type',
      'inserttext',
      'scroll',
      'goback',
      'goforward',
      'presskey',
      'screenshot',
      'gmailcreatereplydraft',
      'wait',
      'waitfortext',
      'select',
      'appendtext'
    ]);
    const normMap = {
      goback: 'goBack',
      goforward: 'goForward',
      inserttext: 'insertText',
      presskey: 'pressKey',
      screenshot: 'screenshot',
      gmailcreatereplydraft: 'gmailCreateReplyDraft',
      waitfortext: 'waitForText',
      appendtext: 'appendText'
    };

    const tokens = [];
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }
      const colon = line.indexOf(':');
      if (colon < 0) { i++; continue; }
      const rawType = line.slice(0, colon).trim().toLowerCase();
      if (!valid.has(rawType)) { i++; continue; }
      const type = normMap[rawType] || rawType;

      if (rawType === 'inserttext') {
        // Collect first-line content + all following lines that are NOT a new action keyword
        const contentLines = [line.slice(colon + 1)];
        i++;
        while (i < lines.length) {
          const next = lines[i].trim();
          const nc = next.indexOf(':');
          // Stop if this looks like a new action line (keyword:...)
          if (nc > 0 && valid.has(next.slice(0, nc).toLowerCase())) break;
          contentLines.push(lines[i]); // preserve original indentation
          i++;
        }
        // Decode literal \n sequences from AI output, then join real lines with \n
        const raw = contentLines.join('\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim();
        tokens.push(`[[ACTION:${type}:${raw}]]`);
      } else if (rawType === 'gmailcreatereplydraft') {
        const msgId = line.slice(colon + 1).trim();
        const bodyLines = [];
        i++;
        while (i < lines.length) {
          const next = lines[i].trim();
          const nc = next.indexOf(':');
          if (nc > 0 && valid.has(next.slice(0, nc).toLowerCase())) break;
          bodyLines.push(lines[i]);
          i++;
        }
        const bodyText = bodyLines.join('\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim();
        const payload = Buffer.from(JSON.stringify({ id: msgId, body: bodyText }), 'utf8').toString('base64');
        tokens.push(`[[ACTION:gmailCreateReplyDraft:${payload}]]`);
      } else {
        const params = line.slice(colon + 1).trim();
        tokens.push(`[[ACTION:${type}:${params}]]`);
        i++;
      }
    }
    return tokens.join('\n');
  });

  return text;
}

function aiResponseHasBrokenActions(text) {
  if (!text) return false;
  if (/\[\[ACTION:\w+:[\s\S]*?\]\]/.test(text)) return false; // has real tokens — fine
  if (/<navio-actions>/i.test(text)) return false;             // has our new block format
  return /\bACTION[\s_]?\d\b/i.test(text);                   // broken numbered labels
}

// Memory functions and IPC handlers moved to ./memory-ipc.js.
registerMemoryIpc(ipcMain, { loadConfig });

// Replaces ONLY the first system message with NAVIO_SYSTEM_PROMPT + memory + profile.
// Other system messages (page context, selection, tab list, etc.) are preserved.
// Called in every IPC handler so the cached renderer's stale system prompt is ignored.
function buildPredictaAppendix(cfg) {
  let base = String(cfg.predictaBaseUrl || 'https://predicta-bet.vercel.app').trim().replace(/\/+$/, '');
  if (!base || !/^https?:\/\//i.test(base)) return '';
  const exBetting = `${base}/?view=betting&sport=nba&board=all-games`;
  const exLive = `${base}/?view=betting&sport=nba&board=live`;
  const exOpenGame = `${base}/?view=betting&sport=nba&board=live&event=ESPN_EVENT_ID`;
  const exNews = `${base}/?view=news`;
  const exCal = `${base}/?view=calendar`;
  return (
    '\n\n---\n**PREDICTA_LINKS** (user sports hub — apply **only** when the gated **SPORTS** rules in the main prompt apply)\n' +
    `- **Base URL:** ${base}\n` +
    '- Build tabs with **open_tab** using query params on that base (no path; trailing slash on base is stripped).\n' +
    '- **view** — main area: `betting` (Games: live scoreboards, box scores, team stats, streams), `calendar` (schedule), `news` (feed), `dashboard`, `live`, `draftkings`, `multi-source`, `tracker`, `calculator`.\n' +
    '- **sport** (when `view` is `betting` or omitted): nfl, nba, mlb, nhl, ufc, raf, boxing, cfb, cbb, wnba, epl, laliga, seriea, bundesliga, ligue1, mls, ucl, uel, all\n' +
    '- **board** (Games sub-tab): `all-games` | `schedule` | `standings` | `live` (aliases: `games`, `tab=games` → all-games).\n' +
    '- **event** (optional) — ESPN scoreboard `event` id: opens that matchup (stream, box score). Same id as in site.api URLs.\n' +
    `- Examples: NBA games \`${exBetting}\` · live board \`${exLive}\` · open one game \`${exOpenGame}\` · News \`${exNews}\` · Schedule \`${exCal}\`\n` +
    '- For **[FOLLOWUP]** object chips on sports turns, **prefer these Predicta URLs** before generic ESPN. If the tab fails to load, suggest checking the site or setting **predictaBaseUrl** in navio-config.json (e.g. `http://localhost:5173` for local Predicta).\n' +
    '---\n'
  );
}

function injectSystemPrompt(messages) {
  const memBlock = buildMemoryBlock(loadConfig);
  const profileBlock = buildProfileBlock(loadConfig);
  const cfg = loadConfig();
  const predictaAppendix = buildPredictaAppendix(cfg);
  let basePrompt = cfg.aiUseToolCalling !== false ? NAVIO_SYSTEM_PROMPT : NAVIO_SYSTEM_PROMPT_LEGACY;

  // Resolve conditional prompt blocks — replace {{BLOCK:x}} with block content
  // when the request context matches, or remove the placeholder when it doesn't.
  const activeBlocks = _detectPromptBlocks(messages);
  basePrompt = basePrompt.replace(/\{\{BLOCK:([a-z-]+)\}\}/g, (_match, key) => {
    if (activeBlocks[key] && PROMPT_BLOCKS[key]) {
      return '\n' + PROMPT_BLOCKS[key] + '\n';
    }
    return '';
  });

  // Auto-inject site intelligence pack when the active tab matches a known site
  const activeUrl = extractActiveUrl(messages);
  const siteIntel = getSiteIntelForUrl(activeUrl);

  const fullPrompt =
    basePrompt + memBlock + profileBlock + predictaAppendix + (siteIntel ? '\n' + siteIntel + '\n' : '');
  let replaced = false;
  const result = messages.map((m) => {
    if (!replaced && m.role === 'system') {
      replaced = true;
      return { role: 'system', content: fullPrompt };
    }
    return m;
  });
  if (!replaced) {
    result.unshift({ role: 'system', content: fullPrompt });
  }
  return result;
}

/** Collapse multiple system messages into one so Gemini/Anthropic/OpenAI receive full context (not only the first block). */
function systemContentToString(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((p) => {
      if (!p) return '';
      if (p.type === 'text') return String(p.text || '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function consolidateSystemMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const systems = messages.filter((m) => m && m.role === 'system');
  if (systems.length <= 1) return messages;
  const merged = systems.map((m) => systemContentToString(m.content)).join('\n\n---\n\n');
  const out = [];
  let placed = false;
  for (const m of messages) {
    if (m && m.role === 'system') {
      if (!placed) {
        out.push({ role: 'system', content: merged });
        placed = true;
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

function buildActionFixMessages(originalMessages, brokenResponse) {
  return [
    ...originalMessages,
    { role: 'assistant', content: brokenResponse },
    {
      role: 'user',
      content: '[SYSTEM FIX: Your previous response used "ACTION0", "ACTION1" etc. as plain-text placeholders. Use a <navio-actions> block instead. Example:\nI\'ll search YouTube.\n<navio-actions>\nnavigate:https://www.youtube.com/results?search_query=breaking+world+news\nclick:text=first video\n</navio-actions>\nRewrite your complete response now with a proper <navio-actions> block.]'
    }
  ];
}

function navioOpenerOriginFromGuest(guestContents) {
  try {
    const u = (guestContents && guestContents.getURL && guestContents.getURL()) || '';
    if (/^https?:/i.test(u)) return new URL(u).origin;
  } catch {
    /* ignore */
  }
  return '';
}

// navioIsExternalProtocolUrl, navioExtractHttpsFromBrowserHandoffUrl, navioNormalizeTabOpenUrl
// are now imported from ./navio-url-utils at the top of this file.

/** Parse width= / height= from window.open(..., 'features') for popup heuristics. */
function navioPopupDimsFromFeatures(feat) {
  const f = typeof feat === 'string' ? feat : '';
  const wM = /(?:^|[,;\s])width\s*=\s*(\d+)/i.exec(f);
  const hM = /(?:^|[,;\s])height\s*=\s*(\d+)/i.exec(f);
  return {
    width: wM ? parseInt(wM[1], 10) : undefined,
    height: hM ? parseInt(hM[1], 10) : undefined
  };
}

/** One setWindowOpenHandler per guest webContents (did-attach + web-contents-created may both run). */
const navioGuestWindowOpenBound = new WeakSet();
let navioWebviewGuestPopupRoutingInstalled = false;
let navioGuestAssistantShortcutForwardInstalled = false;
let navioGuestZoomShortcutForwardInstalled = false;

/**
 * When a page tab (<webview>) has focus, Ctrl/Cmd+Shift+A does not reach the shell
 * renderer, so globalShortcut alone is unreliable. Forward the same accelerator from
 * guest webContents to the main window (deduped in AssistantManager.toggle).
 */
function installNavioGuestAssistantShortcutForward() {
  if (navioGuestAssistantShortcutForwardInstalled) return;
  navioGuestAssistantShortcutForwardInstalled = true;

  const sendToggleAssistantShortcut = () => {
    try {
      const mw = mainWindow;
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('shortcut', 'toggle-assistant');
      }
    } catch {
      /* ignore */
    }
  };

  const isAssistantAccelerator = (input) => {
    if (!input || input.type !== 'keyDown') return false;
    const key = (input.key || '').toLowerCase();
    if (key !== 'a' || !input.shift) return false;
    return !!(input.control || input.meta);
  };

  app.on('web-contents-created', (_event, wc) => {
    try {
      if (typeof wc.getType !== 'function' || wc.getType() !== 'webview') return;
    } catch {
      return;
    }
    wc.on('before-input-event', (event, input) => {
      if (!isAssistantAccelerator(input)) return;
      event.preventDefault();
      sendToggleAssistantShortcut();
    });
  });
}

/**
 * When a page tab (<webview>) has focus, Ctrl/Cmd +/−/0 do not reach the shell
 * renderer, so page zoom never updates. Forward the same shortcuts to the main
 * window (renderer applies TabManager zoom or NTP zoom, matching the omnibox path).
 */
function installNavioGuestZoomShortcutForward() {
  if (navioGuestZoomShortcutForwardInstalled) return;
  navioGuestZoomShortcutForwardInstalled = true;

  const sendZoomShortcut = (action) => {
    try {
      const mw = mainWindow;
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('shortcut', action);
      }
    } catch {
      /* ignore */
    }
  };

  const classifyZoomShortcut = (input) => {
    if (!input || input.type !== 'keyDown') return null;
    if (!(input.control || input.meta)) return null;
    if (input.alt) return null;
    const key = String(input.key || '');
    const code = String(input.code || '');
    // Windows/layout variants: `key` may be "Minus" / "Equal"; `code` is more stable (Minus, Equal, …).
    if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'zoom-reset';
    if (
      key === '-' ||
      key === '_' ||
      key === 'Minus' ||
      key === 'Subtract' ||
      code === 'Minus' ||
      code === 'NumpadSubtract'
    ) {
      return 'zoom-out';
    }
    if (key === '+' || key === '=' || key === 'Plus' || key === 'Equal' || code === 'NumpadAdd' || code === 'Equal') {
      return 'zoom-in';
    }
    return null;
  };

  app.on('web-contents-created', (_event, wc) => {
    try {
      if (typeof wc.getType !== 'function' || wc.getType() !== 'webview') return;
    } catch {
      return;
    }
    wc.on('before-input-event', (event, input) => {
      const action = classifyZoomShortcut(input);
      if (!action) return;
      event.preventDefault();
      sendZoomShortcut(action);
    });
  });
}

/**
 * Guest <webview> focus: shell `document` never receives Ctrl/Cmd+F, so the find bar never opens.
 * Forward like zoom / assistant, and let the main renderer open our find-in-page UI.
 */
function installNavioGuestFindShortcutForward() {
  const sendFind = () => {
    try {
      const mw = mainWindow;
      if (mw && !mw.isDestroyed()) {
        mw.webContents.send('shortcut', 'find-in-page');
      }
    } catch {
      /* ignore */
    }
  };

  const isFindInPage = (input) => {
    if (!input || input.type !== 'keyDown') return false;
    const key = String(input.key || '').toLowerCase();
    if (key !== 'f') return false;
    return !!(input.control || input.meta) && !input.alt;
  };

  app.on('web-contents-created', (_event, wc) => {
    try {
      if (typeof wc.getType !== 'function' || wc.getType() !== 'webview') return;
    } catch {
      return;
    }
    wc.on('before-input-event', (event, input) => {
      if (!isFindInPage(input)) return;
      event.preventDefault();
      sendFind();
    });
  });
}

/**
 * Route guest <webview> window.open / target=_blank into Navio tabs instead of a
 * standalone BrowserWindow (Drive "new window", Gmail account switch, OAuth).
 * Must register on the guest as early as possible: did-attach-webview alone is
 * not reliable on current Electron, so we also use app 'web-contents-created'.
 */
function bindNavioGuestWindowOpenOnce(guestContents) {
  if (!guestContents || navioGuestWindowOpenBound.has(guestContents)) return;
  navioGuestWindowOpenBound.add(guestContents);

  const handoffNavigate = (event, navigationUrl) => {
    const inner = navioExtractHttpsFromBrowserHandoffUrl(navigationUrl);
    if (!inner) return;
    event.preventDefault();
    setImmediate(() => {
      try {
        if (guestContents.isDestroyed()) return;
        guestContents.loadURL(inner);
      } catch {
        /* ignore */
      }
    });
  };
  guestContents.on('will-navigate', handoffNavigate);
  guestContents.on('will-redirect', handoffNavigate);

  guestContents.setWindowOpenHandler((details) => {
    let url = (details && details.url) || '';
    const ho = navioExtractHttpsFromBrowserHandoffUrl(url);
    if (ho) url = ho;
    if (navioIsExternalProtocolUrl(url)) {
      try {
        shell.openExternal(url);
      } catch {
        /* ignore */
      }
      return { action: 'deny' };
    }
    const cfg = loadConfig();
    const { width, height } = navioPopupDimsFromFeatures(details && details.features);
    const openerOrigin = navioOpenerOriginFromGuest(guestContents);
    let siteAllowsPopups = false;
    try {
      siteAllowsPopups =
        !!openerOrigin && sitePerms.get(app.getPath('userData'), openerOrigin, 'popups') === true;
    } catch {
      siteAllowsPopups = false;
    }
    const block = shouldBlockWebPopup({
      url,
      disposition: (details && details.disposition) || 'default',
      optionsWidth: width,
      optionsHeight: height,
      features: (details && details.features) || '',
      hasPostBody: !!(details && details.postBody),
      siteAllowsPopups,
      openerOrigin,
      cfg: {
        adBlockEnabled: cfg.adBlockEnabled !== false,
        popupBlockerEnabled: cfg.popupBlockerEnabled !== false,
        adStrictPopupBlock: cfg.adStrictPopupBlock !== false
      }
    });
    if (block) {
      recordNavioPopupBlocked();
      try {
        const win = mainWindow;
        if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
          win.webContents.send('navio-popup-blocked', {
            blockedUrl: url,
            openerOrigin,
            openerUrl: (() => {
              try {
                return guestContents.getURL() || '';
              } catch {
                return '';
              }
            })()
          });
        }
      } catch {
        /* ignore */
      }
      return { action: 'deny' };
    }

    let incognito = false;
    try {
      incognito = guestContents.session === session.fromPartition(NAVIO_PARTITION_INCOGNITO);
    } catch {
      incognito = false;
    }
    const openUrl = navioNormalizeTabOpenUrl(url);
    if (!openUrl) {
      return { action: 'deny' };
    }
    const mw = mainWindow;
    if (!mw || (typeof mw.isDestroyed === 'function' && mw.isDestroyed())) {
      return { action: 'deny' };
    }
    try {
      // Popups from streaming sites are often ads or helpers; opening in the foreground steals focus
      // from the player — user must click again. Open in background so the stream tab stays active.
      const background = isStreamingVideoOpenerOrigin(openerOrigin);
      mw.webContents.send('open-url-in-new-tab', {
        url: openUrl,
        incognito,
        background,
        /** Renderer registers this guest for download-shell auto-close (Chrome-style). */
        guestWindowOpen: true
      });
    } catch {
      /* ignore */
    }
    return { action: 'deny' };
  });
}

/**
 * Chromium "automatic dark theme" for web page content (CDP), aligned with app theme.
 * Keeps body/text contrast readable vs. only toggling prefers-color-scheme on light sites.
 *
 * Important: NEVER attach the CDP debugger when we don't actually need it.
 * Sites can detect that the debugger is attached (a few APIs change behavior,
 * Chromium shows a warning bar in some configurations, and certain widgets on
 * carrier / banking / DRM-protected portals refuse to render). Previously this
 * function attached `dbg.attach('1.3')` for every guest webContents — even
 * opted-out carrier sites with `enabled: false` — which broke many flows.
 *
 * Now:
 *   - `enabled === true`: attach (if needed) and send the override.
 *   - `enabled === false` and debugger NOT attached: do nothing (the page is
 *     already in its native rendering mode; no override is needed).
 *   - `enabled === false` and debugger IS attached (we previously enabled it
 *     for this same wc): clear the override so the page returns to native.
 */
function navioApplyAutoDarkModeToWebContents(contents, enabled) {
  if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
  try {
    const dbg = contents.debugger;
    const wasAttached = (() => {
      try { return dbg.isAttached(); } catch { return false; }
    })();
    if (!enabled && !wasAttached) {
      // Opted-out site, no prior override → leave Chromium completely alone.
      return;
    }
    if (!wasAttached) {
      try { dbg.attach('1.3'); } catch { /* attach failed — bail without crashing */ return; }
    }
    dbg
      .sendCommand('Emulation.setAutoDarkModeOverride', { enabled: !!enabled })
      .catch(() => {});
  } catch {
    /* DevTools may already be attached; ignore */
  }
}

/**
 * Carrier / logistics portals (WebForms, legacy ASP.NET, etc.) often mis-render or lose
 * interactive controls when Chromium auto-dark is forced via CDP — opt those guests out.
 */
function navioGuestUrlShouldOptOutAutoDark(urlStr) {
  try {
    const u = new URL(String(urlStr || '').trim());
    const host = (u.hostname || '').toLowerCase();
    if (!host) return false;
    return (
      host.includes('purolator') ||
      host.includes('fedex') ||
      host === 'ups.com' ||
      host.endsWith('.ups.com') ||
      host === 'ups.ca' ||
      host.endsWith('.ups.ca') ||
      host === 'dhl.com' ||
      host.endsWith('.dhl.com') ||
      host.includes('canadapost') ||
      host.includes('postescanada') ||
      host === 'usps.com' ||
      host.endsWith('.usps.com') ||
      host.includes('ontrac') ||
      host.includes('shipstation') ||
      host.includes('freightcom') ||
      host.includes('tforce') ||
      host.includes('xpo.com') ||
      host.includes('odfl.com') ||
      host.includes('estes') ||
      host.includes('rlcarriers')
    );
  } catch {
    return /\b(purolator|fedex|ups\.com|dhl|canadapost|usps|ontrac|shipstation)\b/i.test(String(urlStr || ''));
  }
}

function navioGuestAutoDarkEnabledForWebContents(contents) {
  const cfg = loadConfig();
  if (cfg.theme === 'light') return false;
  let url = '';
  try {
    url = contents.getURL() || '';
  } catch {
    url = '';
  }
  if (navioGuestUrlShouldOptOutAutoDark(url)) return false;
  return true;
}

function navioApplyGuestAutoDarkFromContents(contents) {
  navioApplyAutoDarkModeToWebContents(contents, navioGuestAutoDarkEnabledForWebContents(contents));
}

function navioSyncAllGuestWebAutoDarkMode() {
  try {
    for (const wc of electronWebContents.getAllWebContents()) {
      try {
        if (typeof wc.getType !== 'function' || wc.getType() !== 'webview') continue;
        navioApplyGuestAutoDarkFromContents(wc);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function installNavioWebviewGuestPopupRouting() {
  if (navioWebviewGuestPopupRoutingInstalled) return;
  navioWebviewGuestPopupRoutingInstalled = true;
  app.on('web-contents-created', (_event, contents) => {
    try {
      if (typeof contents.getType === 'function' && contents.getType() === 'webview') {
        bindNavioGuestWindowOpenOnce(contents);
        const syncGuestAutoDark = () => {
          try {
            navioApplyGuestAutoDarkFromContents(contents);
          } catch {
            /* ignore */
          }
        };
        queueMicrotask(syncGuestAutoDark);
        contents.on('did-finish-load', syncGuestAutoDark);
        contents.on('did-navigate', syncGuestAutoDark);
        contents.on('did-navigate-in-page', syncGuestAutoDark);
      }
    } catch {
      /* ignore */
    }
  });
}

function createMainWindow() {
  const config = loadConfig();
  const isDark = config.theme !== 'light';
  nativeTheme.themeSource = isDark ? 'dark' : 'light';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    backgroundColor: isDark ? '#080c18' : '#f4f5f7',
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: true
    }
  });

  // Phase 1 WCV migration — TabManager owns all tab WebContents.
  tabManager.init(mainWindow, {
    preloadPath: path.join(__dirname, 'webview-preload.js'),
    // Apply the same popup-routing and auto-dark hooks that classic <webview>
    // tabs receive via did-attach-webview / web-contents-created, but for WCV.
    onWcvWebContentsCreated(wc) {
      // Popup routing: window.open, target=_blank, external protocols, popup blocking
      bindNavioGuestWindowOpenOnce(wc);

      // Auto-dark mode: align page color scheme with app theme
      const syncDark = () => {
        try { navioApplyGuestAutoDarkFromContents(wc); } catch { /* ignore */ }
      };
      queueMicrotask(syncDark);
      wc.on('did-finish-load', syncDark);
      wc.on('did-navigate', syncDark);
      wc.on('did-navigate-in-page', syncDark);

      // Keyboard shortcut forwarding — classic webviews get this via
      // installNavioGuestZoomShortcutForward / ...FindShortcutForward / ...AssistantShortcutForward,
      // but those filter getType()==='webview'. WCV type is 'window', so we wire them here.
      wc.on('before-input-event', (event, input) => {
        if (!input || input.type !== 'keyDown') return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const modKey = !!(input.control || input.meta);
        if (!modKey || input.alt) return;
        const key = String(input.key || '');
        const code = String(input.code || '');

        // Zoom: Ctrl/Cmd +/-/0
        let zoomAction = null;
        if (key === '0' || code === 'Digit0' || code === 'Numpad0') zoomAction = 'zoom-reset';
        else if (key === '-' || key === '_' || key === 'Minus' || key === 'Subtract' ||
                 code === 'Minus' || code === 'NumpadSubtract') zoomAction = 'zoom-out';
        else if (key === '+' || key === '=' || key === 'Plus' || key === 'Equal' ||
                 code === 'NumpadAdd' || code === 'Equal') zoomAction = 'zoom-in';
        if (zoomAction) {
          event.preventDefault();
          try { mainWindow.webContents.send('shortcut', zoomAction); } catch { /* ignore */ }
          return;
        }

        // Find: Ctrl/Cmd+F
        if ((key === 'f' || key === 'F') && !input.shift) {
          event.preventDefault();
          try { mainWindow.webContents.send('shortcut', 'find-in-page'); } catch { /* ignore */ }
          return;
        }

        // Assistant: Ctrl/Cmd+Shift+A
        if ((key === 'a' || key === 'A') && input.shift) {
          event.preventDefault();
          try { mainWindow.webContents.send('shortcut', 'toggle-assistant'); } catch { /* ignore */ }
        }
      });
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
    // globalShortcut is only registered while the window is focused; cold start often misses
    // the early setImmediate in session-setup (window not focused yet). Prime after show.
    queueMicrotask(() => navioPrimeGlobalShortcutsIfFocused());
    setTimeout(() => navioPrimeGlobalShortcutsIfFocused(), 400);
  });
  mainWindow.on('focus', () => navioPrimeGlobalShortcutsIfFocused());

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  if (process.env.NAVIO_E2E === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'navio-e2e-ready'),
          String(Date.now()),
          'utf8'
        );
      } catch (e) {
        console.error('[navio] e2e ready flag write failed:', e && e.message ? e.message : String(e));
      }
    });
  }

  if (process.env.NAVIO_E2E_ASSISTANT === '1') {
    const e2eConsole = [];
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      try {
        e2eConsole.push({ level, message: String(message || '').slice(0, 600) });
        if (e2eConsole.length > 80) e2eConsole.shift();
      } catch {
        /* ignore */
      }
    });
    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        const outPath = path.join(app.getPath('userData'), 'navio-e2e-assistant.json');
        const result = { ok: false, error: null, details: null, consoleTail: e2eConsole };
        try {
          navioPrimeGlobalShortcutsIfFocused();
          let probe = null;
          for (let attempt = 0; attempt < 80; attempt++) {
            await new Promise((r) => setTimeout(r, 250));
            navioPrimeGlobalShortcutsIfFocused();
            probe = await mainWindow.webContents.executeJavaScript(`(() => {
              const panel = document.getElementById('assistant-panel');
              const btn = document.getElementById('btn-toggle-assistant');
              const sp = document.getElementById('shell-prelude');
              return {
                href: String(location.href || ''),
                readyState: document.readyState,
                hasPanel: !!panel,
                hasBtn: !!btn,
                hasToggleApi: typeof window.__navioToggleAssistant === 'function',
                preludeAriaHidden: sp ? sp.getAttribute('aria-hidden') : null,
                bodyShellPreludeActive: document.body.classList.contains('shell-prelude-active'),
                openBefore: !!(panel && panel.classList.contains('open'))
              };
            })()`);
            if (probe && probe.hasToggleApi) break;
          }
          if (!probe || !probe.hasToggleApi) {
            result.error = 'window.__navioToggleAssistant missing after wait (assistant.js not loaded or crashed)';
            result.details = probe;
          } else {
            await mainWindow.webContents.executeJavaScript('window.__navioToggleAssistant()');
            await new Promise((r) => setTimeout(r, 600));
            const open1 = await mainWindow.webContents.executeJavaScript(
              `document.getElementById('assistant-panel').classList.contains('open')`
            );
            await mainWindow.webContents.executeJavaScript('window.__navioToggleAssistant()');
            await new Promise((r) => setTimeout(r, 400));
            const open2 = await mainWindow.webContents.executeJavaScript(
              `document.getElementById('assistant-panel').classList.contains('open')`
            );
            result.ok = !!probe.hasPanel && !!probe.hasBtn && open1 === true && open2 === false;
            result.details = { ...probe, openAfterFirstToggle: !!open1, openAfterSecondToggle: !!open2 };
            if (!result.ok) result.error = 'toggle did not open/close panel as expected';
          }
        } catch (e) {
          result.error = e && e.message ? e.message : String(e);
        }
        try {
          fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
        } catch (e2) {
          console.error('[navio] e2e assistant write failed', e2);
        }
        app.quit();
      })();
    });
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      '[navio] render-process-gone:',
      details && details.reason,
      'exitCode=',
      details && details.exitCode
    );
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[navio] main window webContents became unresponsive');
  });

  // Prefer Electron tab routing over Chromium's native paired BrowserWindow for
  // window.open when this key still exists on the guest webPreferences object.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    try {
      if (webPreferences && 'nativeWindowOpen' in webPreferences) {
        webPreferences.nativeWindowOpen = false;
      }
    } catch {
      /* ignore */
    }
  });

  mainWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    bindNavioGuestWindowOpenOnce(guestContents);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state-changed', 'maximized');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state-changed', 'normal');
  });
}

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.on('navio-shell-log', (_, message) => {
  console.log(typeof message === 'string' ? message : String(message));
});

ipcMain.handle('get-config', () => {
  const c = loadConfig();
  return {
    ...c,
    crashReportingAvailable: navioCrashReporter.isCrashReportingAvailable()
  };
});
ipcMain.handle('navio-internal-chat-page-url', () => {
  try {
    const p = path.join(__dirname, '..', 'src', 'pages', 'navio-chat-tab.html');
    return pathToFileURL(p).href;
  } catch {
    return '';
  }
});
ipcMain.handle('save-config', (event, partial) => {
  saveConfig(partial);
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'theme')) {
    navioSyncAllGuestWebAutoDarkMode();
  }
  try {
    navioCrashReporter.applyCrashReportingFromConfig(loadConfig());
  } catch (_) {
    /* ignore */
  }
  return true;
});

let _navioDiagReportLast = 0;
ipcMain.handle('navio-report-diagnostics', (_event, payload) => {
  if (!payload || typeof payload.message !== 'string') return { ok: false, reason: 'bad-payload' };
  const now = Date.now();
  if (now - _navioDiagReportLast < 4000) return { ok: false, reason: 'rate' };
  _navioDiagReportLast = now;
  return navioCrashReporter.captureRendererDiagnostics(payload);
});

// Wires electron-updater listeners exactly once per session. Safe to call
// multiple times — we mark the module object so we don't stack duplicate
// handlers (which would fire renderer IPC events N times each).
function navioEnsureAutoUpdaterWired() {
  if (!app.isPackaged) return null;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    return null;
  }
  if (autoUpdater.__navioWired) return autoUpdater;
  autoUpdater.__navioWired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    navioUpdateState = { ...navioUpdateState, status: 'checking', message: 'Checking for updates…', checkedAt: Date.now() };
    navioEmitUpdateState();
  });
  autoUpdater.on('update-available', (info) => {
    navioUpdateState = {
      status: 'downloading',
      version: (info && info.version) || null,
      downloadPercent: 0,
      message: `Downloading v${(info && info.version) || '?'}…`,
      checkedAt: Date.now()
    };
    navioEmitUpdateState();
  });
  autoUpdater.on('update-not-available', () => {
    navioUpdateState = { ...navioUpdateState, status: 'not-available', message: 'You are on the latest version.', checkedAt: Date.now() };
    navioEmitUpdateState();
  });
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0)));
    navioUpdateState = { ...navioUpdateState, status: 'downloading', downloadPercent: pct, message: `Downloading update… ${pct}%` };
    navioEmitUpdateState();
  });
  autoUpdater.on('update-downloaded', (info) => {
    navioUpdateState = {
      status: 'ready',
      version: (info && info.version) || navioUpdateState.version,
      downloadPercent: 100,
      message: `Update v${(info && info.version) || '?'} is ready to install.`,
      checkedAt: Date.now()
    };
    navioEmitUpdateState();
  });
  autoUpdater.on('error', (err) => {
    const msg = (err && err.message) ? err.message : String(err || 'update error');
    navioUpdateState = { ...navioUpdateState, status: 'error', message: msg, checkedAt: Date.now() };
    navioEmitUpdateState();
  });

  return autoUpdater;
}

ipcMain.handle('app-check-for-updates', async () => {
  if (!app.isPackaged) {
    return {
      ok: true,
      message: 'Updates apply to installed releases. This session is a development run.'
    };
  }
  const autoUpdater = navioEnsureAutoUpdaterWired();
  if (!autoUpdater) {
    return { ok: false, message: 'electron-updater is not available in this build.' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result && result.updateInfo;
    const cur = app.getVersion();
    if (info && info.version && info.version !== cur) {
      return {
        ok: true,
        message:
          `Update available: v${info.version} (you have v${cur}). It will download in the background; install it from Settings when ready.`
      };
    }
    return {
      ok: true,
      message: 'You are up to date, or no update feed is configured for this build.'
    };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const low = msg.toLowerCase();
    if (low.includes('404') || low.includes('not found') || low.includes('enotfound')) {
      return {
        ok: false,
        message:
          'No update feed responded for this build. The publisher must configure electron-updater (e.g. publish URL in the packaged app metadata).'
      };
    }
    return { ok: false, message: msg };
  }
});

ipcMain.handle('app-get-update-status', () => {
  return {
    ok: true,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    state: { ...navioUpdateState }
  };
});

ipcMain.handle('app-install-update', () => {
  if (!app.isPackaged) {
    return { ok: false, message: 'Updates apply only to installed releases.' };
  }
  const autoUpdater = navioEnsureAutoUpdaterWired();
  if (!autoUpdater) {
    return { ok: false, message: 'electron-updater is not available in this build.' };
  }
  if (navioUpdateState.status !== 'ready') {
    return { ok: false, message: 'No update has finished downloading yet.' };
  }
  try {
    // isSilent=false, isForceRunAfter=true — most polished UX on Windows/macOS.
    setImmediate(() => {
      try { autoUpdater.quitAndInstall(false, true); }
      catch (e) { console.warn('[navio] quitAndInstall failed:', e && e.message); }
    });
    return { ok: true, message: 'Installing update…' };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('get-api-key-for-settings', () => {
  return secureConfig.getApiKey(app.getPath('userData'));
});

ipcMain.handle('infer-ai-provider-from-key', (_, key) => {
  const { inferAiProviderFromApiKey } = require('./infer-ai-provider');
  return inferAiProviderFromApiKey(typeof key === 'string' ? key : '');
});

ipcMain.handle('get-intro-video-url', () => {
  try {
    const cfg = loadConfig();
    if (cfg.showLaunchIntro === false) return null;
    if (!fs.existsSync(INTRO_VIDEO_PATH)) return null;
    return pathToFileURL(INTRO_VIDEO_PATH).href;
  } catch (e) {
    return null;
  }
});

/** Absolute file URL for guest `<webview preload>` (login capture, autofill, chat tab bridge). */
ipcMain.handle('navio-webview-guest-preload-href', () => {
  try {
    return pathToFileURL(path.join(__dirname, 'webview-preload.js')).href;
  } catch {
    return '';
  }
});

/**
 * Per-site Compatibility Mode (kill switch for in-page Navio injections).
 * Used by the guest preload (sync IPC at startup) to fully bail out for
 * specific origins where Navio's instrumentation breaks the site (carrier
 * portals, banking, gov forms, Cloudflare-protected SPAs, etc.).
 */
const navioSiteCompat = require('./site-compat');

/** Synchronous probe used by webview-preload.js at the very top of execution. */
ipcMain.on('navio-site-compat-is-enabled-sync', (event, payload) => {
  try {
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    event.returnValue = !!navioSiteCompat.isCompat(app.getPath('userData'), url);
  } catch {
    event.returnValue = false;
  }
});

ipcMain.handle('navio-site-compat-list', () => {
  try {
    return { ok: true, origins: navioSiteCompat.listOrigins(app.getPath('userData')) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('navio-site-compat-get', (_, payload) => {
  try {
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    const origin = navioSiteCompat.originFromUrl(url);
    return {
      ok: true,
      origin,
      enabled: !!navioSiteCompat.isCompat(app.getPath('userData'), url)
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('navio-site-compat-set', (_, payload) => {
  try {
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    const enabled = !!(payload && payload.enabled);
    return navioSiteCompat.setCompat(app.getPath('userData'), url, enabled);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('navio-site-compat-toggle', (_, payload) => {
  try {
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    return navioSiteCompat.toggleCompat(app.getPath('userData'), url);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('clear-browsing-data', async () => {
  try {
    const ses = session.fromPartition('persist:navio');
    await ses.clearStorageData({
      storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-memory-info', () => {
  try {
    const mu = process.memoryUsage();
    return {
      heapUsed: mu.heapUsed,
      heapTotal: mu.heapTotal,
      rss: mu.rss
    };
  } catch (e) {
    return null;
  }
});

ipcMain.handle('open-devtools-active', (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (wc) {
      wc.openDevTools({ mode: 'detach' });
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: false, error: 'WebContents not found' };
});

/**
 * Resolve provider-specific reasoning / extended-thinking parameters from the
 * configured `aiReasoningEffort` and the active model's known capabilities.
 *
 * Returns one of:
 *   { provider: 'openai',    reasoning_effort: 'low'|'medium'|'high' }
 *   { provider: 'anthropic', thinking: { type: 'enabled', budget_tokens: N }, beta?: 'interleaved-thinking-2025-05-14' }
 *   { provider: 'google',    thinkingConfig: { thinkingBudget: N, includeThoughts: false } }
 *   null (no reasoning params should be sent — model does not support thinking,
 *         provider is unknown, or the user explicitly chose 'off')
 *
 * Capability detection is **conservative by name pattern** so we never send a
 * param that 400s the request. New model families that follow existing prefixes
 * (gpt-5*, o-series, claude-opus/sonnet/haiku-4*, claude-3-7*, gemini-2.5/3.x)
 * are auto-eligible. Unknown / older models silently get no reasoning params.
 */
function navioReasoningParamsForRequest(cfg, model) {
  const provider = cfg.aiProvider || 'openai';
  let effort = String(cfg.aiReasoningEffort || 'auto').toLowerCase();
  if (effort === 'off') return null;
  if (!['auto', 'low', 'medium', 'high'].includes(effort)) effort = 'auto';

  const m = String(model || '').toLowerCase();

  // ── OpenAI / custom OpenAI-compatible (Chat Completions reasoning_effort) ──
  if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
    const isOSeries = /^o[1-9]/.test(m);
    const isGpt5 = /^gpt-?5/.test(m);
    if (!isOSeries && !isGpt5) return null;
    let chosen = effort === 'auto' ? 'medium' : effort;
    return { provider: 'openai', reasoning_effort: chosen };
  }

  // ── Anthropic extended thinking ──
  if (provider === 'anthropic') {
    const supports =
      /^claude-opus-4/.test(m) ||
      /^claude-sonnet-4/.test(m) ||
      /^claude-haiku-4/.test(m) ||
      /^claude-3-7-sonnet/.test(m) ||
      /^claude-4/.test(m);
    if (!supports) return null;
    const budget =
      effort === 'low' ? 2000 :
      effort === 'high' ? 16000 :
      8000; // 'medium' or 'auto'
    return {
      provider: 'anthropic',
      thinking: { type: 'enabled', budget_tokens: budget },
      // Interleaved thinking lets Claude reason between tool calls — much
      // better agentic behavior. Beta header is harmless on non-tool calls.
      beta: 'interleaved-thinking-2025-05-14'
    };
  }

  // ── Gemini thinkingConfig (2.5+ only; 2.0-flash and 1.5 don't support it) ──
  if (provider === 'google') {
    const supports =
      /^gemini-2\.5/.test(m) ||
      /^gemini-2\.6/.test(m) ||
      /^gemini-3/.test(m) ||
      /^gemini-pro-3/.test(m);
    if (!supports) return null;
    const budget =
      effort === 'low' ? 2048 :
      effort === 'high' ? 24576 :
      8192; // 'medium' or 'auto'
    return {
      provider: 'google',
      thinkingConfig: { thinkingBudget: budget, includeThoughts: false }
    };
  }

  return null;
}

async function performAiFetch(cfg, apiKey, messages, useStream, fetchOpts = {}) {
  const provider = cfg.aiProvider || 'openai';
  const model = cfg.aiModel || 'gpt-5.4';
  const endpoint = cfg.customEndpoint || '';
  const ntpBrief = !!fetchOpts.ntpBrief;
  // NTP brief stays a fast non-reasoning path; everywhere else honors aiReasoningEffort.
  const reasoning = ntpBrief ? null : navioReasoningParamsForRequest(cfg, model);

  let url;
  let headers;
  let body;

  if (provider === 'openai' || provider === 'custom') {
    messages = normalizeMessagesForOpenAI(messages);
    url = endpoint || 'https://api.openai.com/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    const isOSeries = /^o[1-9]/i.test(model || '');
    const isGpt5 = /^gpt-?5/i.test(model || '');
    const completionCap = ntpBrief ? 900 : (isGpt5 ? 16384 : 8192);
    const bodyObj = {
      model: model || 'gpt-5.4',
      messages,
      max_completion_tokens: completionCap,
      stream: !!useStream
    };
    if (fetchOpts.tools && !ntpBrief) {
      bodyObj.tools = toOpenAITools(fetchOpts.tools);
      bodyObj.tool_choice = 'auto';
    }
    if (isOSeries) {
      delete bodyObj.temperature;
    } else if (ntpBrief) {
      bodyObj.temperature = 0.55;
    }
    // OpenAI chat/completions currently rejects GPT-5 tool calls when
    // reasoning_effort is present; keep tools working by omitting it there.
    const hasTools = !!(fetchOpts.tools && !ntpBrief);
    if (reasoning && reasoning.provider === 'openai' && !(hasTools && isGpt5)) {
      bodyObj.reasoning_effort = reasoning.reasoning_effort;
    }
    body = JSON.stringify(bodyObj);
  } else if (provider === 'anthropic') {
    messages = normalizeMessagesForAnthropic(messages);
    url = 'https://api.anthropic.com/v1/messages';
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMsgs = messages.filter((m) => m.role !== 'system');
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    const anthropicBody = {
      model: model || 'claude-opus-4-5',
      max_tokens: ntpBrief ? 900 : 16384,
      system: systemMsg?.content || '',
      messages: chatMsgs,
      stream: !!useStream
    };
    if (fetchOpts.tools && !ntpBrief) {
      anthropicBody.tools = toAnthropicTools(fetchOpts.tools);
    }
    if (reasoning && reasoning.provider === 'anthropic') {
      anthropicBody.thinking = reasoning.thinking;
      // Thinking requires temperature=1 and disallows top_p/top_k.
      // Navio doesn't set those, so this is just a defensive cleanup.
      delete anthropicBody.temperature;
      delete anthropicBody.top_p;
      delete anthropicBody.top_k;
      // Budget must leave room for the model reply on top of thinking.
      const need = (anthropicBody.thinking.budget_tokens || 0) + 1024;
      if ((anthropicBody.max_tokens || 0) < need) {
        anthropicBody.max_tokens = need;
      }
      if (reasoning.beta) {
        headers['anthropic-beta'] = reasoning.beta;
      }
    }
    body = JSON.stringify(anthropicBody);
  } else if (provider === 'google') {
    const googleEndpoint = useStream ? 'streamGenerateContent' : 'generateContent';
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:${googleEndpoint}?key=${apiKey}${useStream ? '&alt=sse' : ''}`;
    headers = { 'Content-Type': 'application/json' };
    function toGeminiParts(content) {
      if (typeof content === 'string') return [{ text: content }];
      if (!Array.isArray(content)) return [{ text: '' }];
      const parts = [];
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'text') parts.push({ text: part.text || '' });
        else if (part.type === 'image_url' && part.image_url?.url) {
          const u = part.image_url.url;
          const m = u.match(/^data:([^;]+);base64,(.+)$/);
          if (m) {
            parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
          }
        } else if (part.type === 'navio_pdf' && part.base64) {
          parts.push({
            inlineData: { mimeType: 'application/pdf', data: part.base64 }
          });
        } else if (part.type === 'navio_inline' && part.base64) {
          parts.push({
            inlineData: {
              mimeType: part.mimeType || 'application/octet-stream',
              data: part.base64
            }
          });
        }
      }
      return parts.length ? parts : [{ text: '' }];
    }
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(m.content)
      }));
    const systemInstruction = messages.find((m) => m.role === 'system');
    const geminiBody = {
      contents,
      systemInstruction: systemInstruction
        ? { parts: toGeminiParts(systemInstruction.content) }
        : undefined
    };
    if (fetchOpts.tools && !ntpBrief) {
      geminiBody.tools = toGeminiTools(fetchOpts.tools);
    }
    if (ntpBrief) {
      geminiBody.generationConfig = { maxOutputTokens: 900, temperature: 0.55 };
    } else {
      geminiBody.generationConfig = { maxOutputTokens: 16384 };
    }
    if (reasoning && reasoning.provider === 'google') {
      geminiBody.generationConfig.thinkingConfig = reasoning.thinkingConfig;
    }
    body = JSON.stringify(geminiBody);
  } else if (provider === 'ollama') {
    // Ollama exposes an OpenAI-compatible API on localhost — no key required.
    messages = normalizeMessagesForOpenAI(messages);
    url = 'http://localhost:11434/v1/chat/completions';
    headers = { 'Content-Type': 'application/json' };
    const bodyObj = {
      model: model || 'llama3.2',
      messages,
      stream: !!useStream
    };
    if (fetchOpts.tools && !ntpBrief) {
      bodyObj.tools = toOpenAITools(fetchOpts.tools);
      bodyObj.tool_choice = 'auto';
    }
    body = JSON.stringify(bodyObj);
  } else {
    return { error: `Unknown provider: ${provider}` };
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: fetchOpts.signal
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || fetchOpts.signal?.aborted)) {
      return { error: 'Stopped', aborted: true };
    }
    throw e;
  }

  if (useStream) {
    if (!response.ok) {
      const errText = await response.text();
      return { error: errText || response.statusText };
    }
    return { stream: response.body, provider };
  }

  const data = await response.json();
  if (!response.ok) {
    return { error: data.error?.message || JSON.stringify(data) };
  }

  let content = '';
  let toolCalls = [];
  let rawAssistantMessage = null;

  if (provider === 'anthropic') {
    const blocks = data.content || [];
    content = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
    if (toolCalls.length) rawAssistantMessage = data;
  } else if (provider === 'google') {
    const parts = data.candidates?.[0]?.content?.parts || [];
    content = parts.filter((p) => p.text).map((p) => p.text).join('');
    toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `gemini_${i}`,
        name: p.functionCall.name,
        arguments: p.functionCall.args || {}
      }));
    if (toolCalls.length) rawAssistantMessage = data.candidates?.[0]?.content;
  } else {
    const msg = data.choices?.[0]?.message;
    content = msg?.content || '';
    if (msg?.tool_calls?.length) {
      toolCalls = msg.tool_calls.map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep empty */ }
        return { id: tc.id, name: tc.function.name, arguments: args };
      });
      rawAssistantMessage = msg;
    }
  }

  return { content, toolCalls, rawAssistantMessage, provider };
}

// ── Tool-calling agentic loop ────────────────────────────────────────────────

/**
 * Append the assistant's tool-call response to the message history in the
 * correct provider format so the next API call includes the tool invocation.
 */
function appendAssistantToolCalls(messages, result, provider) {
  if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
    return [...messages, result.rawAssistantMessage];
  } else if (provider === 'anthropic') {
    return [...messages, { role: 'assistant', content: result.rawAssistantMessage.content }];
  } else if (provider === 'google') {
    return [...messages, { role: 'model', parts: result.rawAssistantMessage.parts }];
  }
  return messages;
}

/**
 * Append a tool result to the message history in the correct provider format.
 */
function appendToolResult(messages, toolCall, result, provider) {
  // Multi-tile full-page screenshots (scroll to top, then viewport strips top→bottom)
  const multiImages =
    result &&
    Array.isArray(result.images) &&
    result.images.length &&
    !result.error &&
    result.images.every((im) => im && im.image && im.mimeType);

  if (multiImages) {
    const textPart = JSON.stringify({
      success: true,
      fullPage: true,
      scrollHeight: result.scrollHeight,
      viewportHeight: result.viewportHeight,
      tileCount: result.images.length,
      note:
        'Full-page screenshots from the TOP of the page downward (tile 1 = header/top). Plan from the first tiles before mid-page content. Use for layout, nav, and where to start.'
    });
    if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
      const content = [{ type: 'text', text: textPart }];
      for (const im of result.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${im.mimeType};base64,${im.image}`, detail: 'high' }
        });
      }
      return [...messages, { role: 'tool', tool_call_id: toolCall.id, content }];
    }
    if (provider === 'anthropic') {
      const blocks = [{ type: 'text', text: textPart }];
      for (const im of result.images) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: im.mimeType, data: im.image }
        });
      }
      return [...messages, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: blocks }]
      }];
    }
    if (provider === 'google') {
      const parts = [{ functionResponse: { name: toolCall.name, response: { content: textPart } } }];
      for (const im of result.images) {
        parts.push({ inlineData: { mimeType: im.mimeType, data: im.image } });
      }
      return [...messages, { role: 'function', parts }];
    }
  }

  // Detect screenshot / image results and format as multimodal content
  const hasImage = result && result.image && result.mimeType;

  if (hasImage) {
    const dataUri = `data:${result.mimeType};base64,${result.image}`;
    const textPart = JSON.stringify({ success: true, note: 'Screenshot captured. Analyze the image to understand the page layout and identify click targets by xy coordinates.' });

    if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
      return [...messages, {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: [
          { type: 'text', text: textPart },
          { type: 'image_url', image_url: { url: dataUri, detail: 'high' } }
        ]
      }];
    } else if (provider === 'anthropic') {
      return [...messages, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: [
            { type: 'text', text: textPart },
            { type: 'image', source: { type: 'base64', media_type: result.mimeType, data: result.image } }
          ]
        }]
      }];
    } else if (provider === 'google') {
      return [...messages, {
        role: 'function',
        parts: [
          { functionResponse: { name: toolCall.name, response: { content: textPart } } },
          { inlineData: { mimeType: result.mimeType, data: result.image } }
        ]
      }];
    }
  }

  const resultStr = JSON.stringify(result).slice(0, 50000);
  if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
    return [...messages, { role: 'tool', tool_call_id: toolCall.id, content: resultStr }];
  } else if (provider === 'anthropic') {
    return [...messages, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: resultStr }]
    }];
  } else if (provider === 'google') {
    return [...messages, {
      role: 'function',
      parts: [{ functionResponse: { name: toolCall.name, response: { content: result } } }]
    }];
  }
  return messages;
}

/**
 * Screenshot bytes are only for the live model request — do not ship base64 in agent logs or UI IPC.
 */
function sanitizeToolResultForLog(toolName, result) {
  if (!result || typeof result !== 'object' || result.error) return result;
  if (toolName === 'run_workflow' && Array.isArray(result.step_preview)) {
    return {
      success: result.success,
      workflow_name: result.workflow_name,
      steps: result.steps,
      step_preview_truncated: result.step_preview_truncated,
      step_preview_in_message: result.step_preview.length,
      step_preview_omitted_from_log: true
    };
  }
  if (toolName !== 'screenshot') return result;
  if (Array.isArray(result.images) && result.images.length) {
    return {
      scrollHeight: result.scrollHeight,
      viewportHeight: result.viewportHeight,
      viewportWidth: result.viewportWidth,
      tileCount: result.tileCount,
      note: result.note,
      images: result.images.map((im) =>
        im && typeof im === 'object'
          ? { mimeType: im.mimeType, label: im.label, imageBytesOmitted: true }
          : { imageBytesOmitted: true }
      )
    };
  }
  if (typeof result.image === 'string') {
    return {
      mimeType: result.mimeType,
      note: result.note,
      fullPage: result.fullPage,
      imageBytesOmitted: true
    };
  }
  return result;
}

/**
 * Inject post-navigate auto-screenshots into the message list (no matching tool_call).
 */
function appendAutoScreenshotMessages(messages, screenshotResult, provider) {
  const multi =
    screenshotResult &&
    Array.isArray(screenshotResult.images) &&
    screenshotResult.images.length &&
    !screenshotResult.error &&
    screenshotResult.images.every((im) => im && im.image && im.mimeType);

  const introMulti =
    '[Auto-screenshot after navigation — full-page tiles from top to bottom. Tile 1 is the top of the page; use it to plan where to start.]';

  if (multi) {
    const textPart = JSON.stringify({
      auto: true,
      fullPage: true,
      scrollHeight: screenshotResult.scrollHeight,
      viewportHeight: screenshotResult.viewportHeight,
      tileCount: screenshotResult.images.length,
      note: introMulti
    });
    if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
      const content = [{ type: 'text', text: textPart }];
      for (const im of screenshotResult.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${im.mimeType};base64,${im.image}`, detail: 'high' }
        });
      }
      return [...messages, { role: 'system', content }];
    }
    if (provider === 'anthropic') {
      const blocks = [{ type: 'text', text: textPart }];
      for (const im of screenshotResult.images) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: im.mimeType, data: im.image }
        });
      }
      return [...messages, { role: 'user', content: blocks }];
    }
    if (provider === 'google') {
      const parts = [{ text: textPart }];
      for (const im of screenshotResult.images) {
        parts.push({ inlineData: { mimeType: im.mimeType, data: im.image } });
      }
      return [...messages, { role: 'user', parts }];
    }
  }

  if (screenshotResult && screenshotResult.image && screenshotResult.mimeType) {
    const dataUri = `data:${screenshotResult.mimeType};base64,${screenshotResult.image}`;
    if (provider === 'openai' || provider === 'custom' || provider === 'ollama') {
      return [...messages, {
        role: 'system',
        content: [
          { type: 'text', text: '[Auto-screenshot after navigation — use this to understand the page visually]' },
          { type: 'image_url', image_url: { url: dataUri, detail: 'high' } }
        ]
      }];
    }
    if (provider === 'anthropic') {
      return [...messages, {
        role: 'user',
        content: [
          { type: 'text', text: '[Auto-screenshot after navigation — use this to understand the page visually]' },
          { type: 'image', source: { type: 'base64', media_type: screenshotResult.mimeType, data: screenshotResult.image } }
        ]
      }];
    }
    if (provider === 'google') {
      return [...messages, {
        role: 'user',
        parts: [
          { text: '[Auto-screenshot after navigation — use this to understand the page visually]' },
          { inlineData: { mimeType: screenshotResult.mimeType, data: screenshotResult.image } }
        ]
      }];
    }
  }

  return messages;
}

/**
 * Wait for an IPC ack from the renderer within a timeout.
 * Used for navigate actions that must go through TabManager in the renderer.
 */
function waitForRendererAck(sender, channel, timeoutMs, matchOperationId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      resolve({ error: 'Navigation timed out' });
    }, timeoutMs);
    const handler = (event, result) => {
      if (event.sender !== sender) return;
      if (matchOperationId != null && (!result || result.operationId !== matchOperationId)) return;
      clearTimeout(timer);
      ipcMain.removeListener(channel, handler);
      resolve(result || { success: true });
    };
    ipcMain.on(channel, handler);
  });
}

/** Wait until the guest is not mid-navigation (avoids CDP / executeJS races that surface as ERR_ABORTED / -3). */
async function waitForWebContentsSettled(wc, { timeoutMs = 25000, settleMs = 180, pollMs = 40 } = {}) {
  if (!wc) return;
  try {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
  } catch {
    return;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (!wc.isLoading()) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
}

function navioTransientAiError(msg) {
  const s = String(msg || '');
  return /429|503|502|504|529|timeout|ECONNRESET|ETIMEDOUT|rate limit|too many requests|overloaded|temporarily unavailable|try again|cloudflare|bad gateway/i.test(
    s
  );
}

async function navioSleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * In-flight AI abort controllers keyed by `${webContentsId}:${tabId}` so each tab can run its own
 * stream/tool loop without cancelling another tab's work. Same tab starting new work still aborts
 * the previous run on that tab only.
 */
const aiFetchAbortByKey = new Map();

function registerAiAbortController(sender, tabId = '__default__') {
  const id = sender && sender.id;
  if (typeof id !== 'number') return new AbortController();
  const tid = tabId != null && String(tabId).length ? String(tabId) : '__default__';
  const key = `${id}:${tid}`;
  const prev = aiFetchAbortByKey.get(key);
  if (prev) prev.abort();
  const ac = new AbortController();
  aiFetchAbortByKey.set(key, ac);
  return ac;
}

function releaseAiAbortController(sender, tabId = '__default__') {
  const id = sender && sender.id;
  if (typeof id !== 'number') return;
  const tid = tabId != null && String(tabId).length ? String(tabId) : '__default__';
  const key = `${id}:${tid}`;
  const ac = aiFetchAbortByKey.get(key);
  if (!ac) {
    aiFetchAbortByKey.delete(key);
    return;
  }
  for (const [k, v] of [...aiFetchAbortByKey.entries()]) {
    if (v === ac && k.startsWith(`${id}:`)) aiFetchAbortByKey.delete(k);
  }
}

/** Same AbortController as `fromTabId` is also reachable as `toTabId` (e.g. solo tab id → group storage key). */
function aliasAiAbortControllerTabId(sender, fromTabId, toTabId) {
  const id = sender && sender.id;
  if (typeof id !== 'number') return;
  const fromT = fromTabId != null && String(fromTabId).length ? String(fromTabId) : '';
  const toT = toTabId != null && String(toTabId).length ? String(toTabId) : '';
  if (!fromT || !toT || fromT === toT) return;
  const fromKey = `${id}:${fromT}`;
  const toKey = `${id}:${toT}`;
  const ac = aiFetchAbortByKey.get(fromKey);
  if (ac) aiFetchAbortByKey.set(toKey, ac);
}

function navioGmailApiTransientError(msg) {
  const s = String(msg || '');
  return /429|503|502|resource has been exhausted|rateLimitExceeded|userRateLimitExceeded|backendError|internal error|unavailable/i.test(
    s
  );
}

/** Retry performAiFetch on transient provider/network errors so one hiccup does not kill the whole agent run. */
async function performAiFetchResilient(cfg, apiKey, messages, fetchOpts, attempts = 4) {
  if (fetchOpts?.signal?.aborted) {
    return { error: 'Stopped', aborted: true };
  }
  let last;
  for (let i = 0; i < attempts; i++) {
    if (fetchOpts?.signal?.aborted) {
      return { error: 'Stopped', aborted: true };
    }
    last = await performAiFetch(cfg, apiKey, messages, false, fetchOpts);
    if (!last.error) return last;
    if (last.aborted) return last;
    if (!navioTransientAiError(last.error)) return last;
    await navioSleep(500 * Math.pow(2, i));
  }
  return last;
}

/**
 * The main agentic tool-calling loop.  Calls performAiFetch with tools, executes
 * any tool_calls the model returns, feeds results back, and repeats until the
 * model produces a text-only response or we hit the step limit.
 *
 * Navigate actions are handled specially: a 'tool-navigate' event is sent to the
 * renderer (which calls TabManager.navigateActive), and we wait for an ack.
 */
async function executeToolLoop(cfg, apiKey, messages, wc, sender, maxSteps, opts = {}) {
  const signal = opts && opts.signal;
  const tabId = opts.tabId != null ? String(opts.tabId) : '__default__';
  const tp = (p) => sender.send('tool-progress', { ...p, tabId });
  const tr = (p) => sender.send('tool-reasoning', { ...p, tabId });
  const configured = Number(cfg.aiAgentMaxToolSteps);
  maxSteps = Math.min(500, Math.max(50, Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 300));
  // Merge native tools with any connected MCP tools
  const mcpTools = cfg.mcpEnabled !== false ? getMcpTools() : [];
  const tools = [...NAVIO_TOOLS, ...mcpTools];
  const toolLog = [];
  let currentMessages = [...messages];
  const provider = cfg.aiProvider || 'openai';
  let activeWc = wc; // mutable — tab tools can change the target webContents
  /** After successful draft/send mutations, open Gmail for the user once the run completes (read-only API runs skip this). */
  let gmailDeferredView = null; // 'sent' | 'drafts'

  const finishAgentRun = (payload) => {
    if (gmailDeferredView) {
      payload.gmailOpenWhenDone = {
        url:
          gmailDeferredView === 'sent'
            ? 'https://mail.google.com/mail/u/0/#sent'
            : 'https://mail.google.com/mail/u/0/#drafts',
        view: gmailDeferredView
      };
    }
    return payload;
  };

  const recordGmailMutationForDeferredNav = (toolName, toolResult) => {
    if (!toolResult || toolResult.error) return;
    if (toolName === 'gmail_send_draft' && toolResult.success) {
      gmailDeferredView = 'sent';
      return;
    }
    if (
      toolName === 'gmail_create_draft' ||
      toolName === 'gmail_create_reply_draft' ||
      toolName === 'gmail_update_draft' ||
      toolName === 'gmail_delete_draft'
    ) {
      if (gmailDeferredView !== 'sent') gmailDeferredView = 'drafts';
    }
  };

  try {
    await waitForWebContentsSettled(activeWc, { settleMs: 80 });
    await startMonitoring(activeWc);
  } catch {
    /* non-fatal */
  }

  const TAB_TOOLS = new Set(['open_tab', 'close_tab', 'switch_tab', 'list_tabs', 'split_tabs']);

  /**
   * Stall detector: track the last few tool calls and auto-inject an error
   * result when the model repeats the exact same tool+args ≥ STALL_THRESHOLD
   * times in a row. Without this the model can spin forever doing e.g.
   *   read_page(filter=interactive) → empty → read_page(filter=interactive) → empty → …
   * The injected error is short and action-oriented so the model's next token
   * picks a different strategy rather than giving up.
   */
  const STALL_THRESHOLD = 3; // consecutive identical calls before intervention
  const stallTrack = []; // { sig: string, count: number }

  /**
   * Returns a stall-intervention tool result string when the same sig has been
   * seen >= STALL_THRESHOLD times in a row, otherwise null.
   * Resets the streak when a different sig arrives.
   */
  function navioCheckStall(toolName, args) {
    // Build a compact signature: tool name + first 180 chars of JSON args.
    const sig = toolName + '|' + JSON.stringify(args || {}).slice(0, 180);
    const last = stallTrack[stallTrack.length - 1];
    if (last && last.sig === sig) {
      last.count++;
      if (last.count >= STALL_THRESHOLD) {
        // Specific recovery hints per tool family
        let hint = 'You must change your approach. Do NOT repeat this call.';
        if (toolName === 'read_page') {
          const curFilter = (args && args.filter) || '';
          const next = curFilter === 'all' ? '"interactive" or use screenshot instead' : '"all"';
          hint = `read_page returned the same result ${last.count} times. ` +
            `Try filter=${next}, or call screenshot to get visual context, or navigate to a more specific URL. ` +
            `Do NOT call read_page with the same filter again.`;
        } else if (toolName === 'navigate') {
          hint = `navigate to the same URL has been called ${last.count} times. ` +
            `The page is likely already loaded. Call read_page or screenshot to see what's there, ` +
            `or navigate to a DIFFERENT, more specific URL. Do NOT navigate here again.`;
        } else if (toolName === 'web_search') {
          hint = `web_search with the same query has run ${last.count} times. ` +
            `Rephrase the query with different keywords, add a year (2026), or try a different source.`;
        } else if (toolName === 'click') {
          hint = `click on the same element has been called ${last.count} times — it is not working. ` +
            `Try a different ref, use click with text= instead of ref=, or call screenshot to find the right target.`;
        } else if (toolName === 'screenshot') {
          hint = `screenshot has been called ${last.count} times without making progress. ` +
            `Use the coordinates from the screenshot to click something, scroll down, or navigate elsewhere.`;
        }
        return { error: `[STALL DETECTED] ${hint}` };
      }
    } else {
      stallTrack.length = 0; // reset on any different call
      stallTrack.push({ sig, count: 1 });
    }
    return null;
  }

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return finishAgentRun({ content: '**Stopped.**', cancelled: true, toolLog });
    }
    const result = await performAiFetchResilient(cfg, apiKey, currentMessages, { tools, signal });

    if (result.error) {
      if (result.aborted || result.error === 'Stopped') {
        return finishAgentRun({ content: '**Stopped.**', cancelled: true, toolLog });
      }
      let errMsg = result.error;
      if (navioTransientAiError(errMsg)) {
        errMsg = `${errMsg}\n\nIf this was a short-lived network or rate-limit issue, wait a few seconds and say **continue** to retry.`;
      }
      return finishAgentRun({ error: errMsg, toolLog });
    }

    // Emit any intermediate reasoning text the model produced alongside tool calls.
    // step === 0 text is the model's initial acknowledgment — surface it as a chat bubble, not a buried activity step.
    if (result.content && result.toolCalls && result.toolCalls.length) {
      tr({ step, text: result.content, bubble: step === 0 });
    }

    if (!result.toolCalls || !result.toolCalls.length) {
      if (result.content) extractAndSaveMemory(result.content);
      return finishAgentRun({ content: result.content || '', toolLog });
    }

    currentMessages = appendAssistantToolCalls(currentMessages, result, provider);

    for (const tc of result.toolCalls) {
      console.log(`[navio] tool-loop step ${step}: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 120)})`);

      // Stall guard: if the model is spinning on the exact same tool+args,
      // short-circuit with an action-oriented error rather than running again.
      // Only applies to browser/search tools that commonly loop (not Gmail, Drive,
      // Calendar, tab management or MCP which have different idempotency profiles).
      const STALL_GUARDED = new Set([
        'read_page', 'navigate', 'web_search', 'click', 'screenshot',
        'get_page_text', 'scroll', 'go_back', 'go_forward', 'type_text'
      ]);
      if (STALL_GUARDED.has(tc.name)) {
        const stallResult = navioCheckStall(tc.name, tc.arguments);
        if (stallResult) {
          console.warn(`[navio] stall-guard fired at step ${step}: ${tc.name}`);
          currentMessages = appendToolResult(currentMessages, tc, stallResult, provider);
          toolLog.push({ tool: tc.name, args: tc.arguments, result: stallResult, stall_guard: true });
          tp({ step, tool: tc.name, result: stallResult });
          continue;
        }
      } else {
        // Reset stall tracker whenever a non-guarded tool fires — the agent is
        // making different kinds of progress.
        stallTrack.length = 0;
      }

      // Web search — Perplexity when connected (best citations), else fall back
      // to the active LLM provider's native web-search tool so users never need
      // a second paid key just to get cited answers.
      if (tc.name === 'web_search') {
        const query = (tc.arguments && tc.arguments.query) || '';
        let toolResult;
        try {
          const connMap = loadConnectorKeys();
          const encKey = connMap['perplexity'];
          const perplexityKey = encKey ? decryptConnectorKey(encKey) : null;

          let searchRes = null;
          let source = null;
          if (perplexityKey) {
            searchRes = await queryPerplexity(perplexityKey, query);
            source = 'perplexity';
            if (searchRes && searchRes.error) {
              console.warn(`[navio] Perplexity web_search failed, falling back to provider: ${searchRes.error}`);
              searchRes = null;
            }
          }
          if (!searchRes) {
            searchRes = await queryProviderWebSearch(cfg, apiKey, query);
            source = cfg.aiProvider || 'openai';
          }

          if (searchRes.error) {
            toolResult = { error: searchRes.error };
          } else {
            toolResult = {
              answer: searchRes.answer || '',
              citations: searchRes.citations || [],
              model: searchRes.model || '',
              source
            };
          }
        } catch (e) {
          toolResult = { error: `Web search failed: ${e.message}` };
        }
        currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, toolResult) });
        tp({ step, tool: tc.name, result: toolResult });
        continue;
      }

      // Email safety: block clicking send buttons on mail hosts
      if (tc.name === 'click') {
        const clickText = tc.arguments.text || '';
        if (isEmailWriteAction('click', { selector: `text=${clickText}` })) {
          const toolResult = { error: 'Blocked: Navio cannot click Send on email services. Only drafts are allowed.' };
          currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
          toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, toolResult), blocked: true });
          tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, toolResult) });
          continue;
        }
      }

      // Navigate: must go through the renderer for NTP overlay handling
      if (tc.name === 'navigate') {
        const navUrl = (tc.arguments && tc.arguments.url) || '';
        const allowGmailWebUi = !!(tc.arguments && tc.arguments.gmail_browser_takeover);
        const gmIntercept = await maybeLoadGmailMessageUrlViaApi('navigate', navUrl, { allowGmailWebUi });
        if (gmIntercept) {
          const toolResult = gmIntercept.result;
          currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
          toolLog.push({ tool: 'navigate', args: tc.arguments, result: sanitizeToolResultForLog('navigate', toolResult), gmail_api_intercept: true });
          tp({ step, tool: tc.name, result: sanitizeToolResultForLog('navigate', toolResult) });
          continue;
        }
        const browseIntercept = await maybeInterceptGmailBrowseNavForAgent(navUrl, { allowGmailWebUi });
        if (browseIntercept) {
          const toolResult = browseIntercept.result;
          currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
          toolLog.push({
            tool: 'navigate',
            args: tc.arguments,
            result: sanitizeToolResultForLog('navigate', toolResult),
            gmail_api_intercept: true,
            gmail_browse_intercept: true
          });
          tp({ step, tool: tc.name, result: sanitizeToolResultForLog('navigate', toolResult) });
          continue;
        }
        const navOpId = crypto.randomUUID();
        sender.send('tool-navigate', { url: tc.arguments.url, stepIndex: step, tabId, operationId: navOpId });
        const navResult = await waitForRendererAck(sender, 'tool-navigate-ack', 60000, navOpId);
        currentMessages = appendToolResult(currentMessages, tc, navResult, provider);
        toolLog.push({ tool: 'navigate', args: tc.arguments, result: sanitizeToolResultForLog('navigate', navResult) });
        tp({ step, tool: tc.name, result: sanitizeToolResultForLog('navigate', navResult) });

        if (!navResult.error && activeWc) {
          await waitForWebContentsSettled(activeWc);
        }

        // Auto-screenshot after navigation for visual context
        if (cfg.aiAutoScreenshotAfterNavigate && !navResult.error && activeWc) {
          try {
            await new Promise(r => setTimeout(r, 500));
            const autoScreenshot = await toolExecutors.screenshot(activeWc, {});
            if (autoScreenshot.images?.length || autoScreenshot.image) {
              tp({ step, tool: 'screenshot', result: { success: true, auto: true } });
              currentMessages = appendAutoScreenshotMessages(currentMessages, autoScreenshot, provider);
            }
          } catch { /* non-fatal */ }
        }
        continue;
      }

      // Planning mode: propose_plan pauses execution and awaits user approval
      if (tc.name === 'propose_plan') {
        const planOpId = crypto.randomUUID();
        sender.send('tool-propose-plan', { ...(tc.arguments || {}), tabId, operationId: planOpId });
        const planResult = await waitForRendererAck(sender, 'tool-propose-plan-ack', 300000, planOpId); // 5 min timeout
        currentMessages = appendToolResult(currentMessages, tc, planResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, planResult) });
        tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, planResult) });
        if (planResult.cancelled) {
          return finishAgentRun({ content: 'Plan was cancelled by the user.', toolLog });
        }
        continue;
      }

      // Tab management tools: go through the renderer's TabManager
      if (TAB_TOOLS.has(tc.name)) {
        if (tc.name === 'open_tab') {
          const openUrl = tc.arguments?.url || '';
          const allowGmailWebUiOt = !!(tc.arguments && tc.arguments.gmail_browser_takeover);
          const gmIntercept = await maybeLoadGmailMessageUrlViaApi('open_tab', openUrl, { allowGmailWebUi: allowGmailWebUiOt });
          if (gmIntercept) {
            const toolResult = gmIntercept.result;
            currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
            toolLog.push({ tool: 'open_tab', args: tc.arguments, result: sanitizeToolResultForLog('open_tab', toolResult), gmail_api_intercept: true });
            tp({ step, tool: tc.name, result: sanitizeToolResultForLog('open_tab', toolResult) });
            continue;
          }
          const browseIntercept = await maybeInterceptGmailBrowseNavForAgent(openUrl, { allowGmailWebUi: allowGmailWebUiOt });
          if (browseIntercept) {
            const toolResult = browseIntercept.result;
            currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
            toolLog.push({
              tool: 'open_tab',
              args: tc.arguments,
              result: sanitizeToolResultForLog('open_tab', toolResult),
              gmail_api_intercept: true,
              gmail_browse_intercept: true
            });
            tp({ step, tool: tc.name, result: sanitizeToolResultForLog('open_tab', toolResult) });
            continue;
          }
        }
        const tabResult = await executeTabTool(tc, sender, tabId);
        // switch_tab returns a new webContentsId — update activeWc
        if (tc.name === 'switch_tab' && tabResult.webContentsId) {
          const newWc = electronWebContents.fromId(tabResult.webContentsId);
          if (newWc) activeWc = newWc;
        }
        if (tc.name === 'open_tab' && tabResult.webContentsId) {
          const newWc = electronWebContents.fromId(tabResult.webContentsId);
          if (newWc) activeWc = newWc;
        }
        if (tc.name === 'split_tabs' && tabResult.webContentsId) {
          const splitWc = electronWebContents.fromId(tabResult.webContentsId);
          if (splitWc) activeWc = splitWc;
        }
        if (!tabResult.error && (tc.name === 'open_tab' || tc.name === 'switch_tab' || tc.name === 'split_tabs') && activeWc) {
          await waitForWebContentsSettled(activeWc);
        }
        currentMessages = appendToolResult(currentMessages, tc, tabResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, tabResult) });
        tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, tabResult) });
        continue;
      }

      // MCP tools: proxy to the MCP server
      if (isMcpTool(tc.name)) {
        const mcpResult = await callMcpTool(tc.name, tc.arguments);
        currentMessages = appendToolResult(currentMessages, tc, mcpResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, mcpResult) });
        tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, mcpResult) });
        continue;
      }

      // Gmail API send: always pause for an in-app confirmation (separate from chat wording).
      if (tc.name === 'gmail_send_draft') {
        const draftId = String((tc.arguments && tc.arguments.draft_id) || '').trim();
        let toolResult;
        if (!draftId) {
          toolResult = await toolExecutors.gmail_send_draft(activeWc, tc.arguments);
        } else {
          const sendOpId = crypto.randomUUID();
          sender.send('tool-gmail-send-confirm', {
            draftId,
            tabId,
            operationId: sendOpId
          });
          const confirmResult = await waitForRendererAck(
            sender,
            'tool-gmail-send-confirm-ack',
            300000,
            sendOpId
          );
          const confirmed =
            confirmResult.approved === true &&
            confirmResult.cancelled !== true &&
            !confirmResult.error;
          if (!confirmed) {
            toolResult = {
              error: confirmResult.error
                ? `Send cancelled: ${confirmResult.error}`
                : 'Send cancelled — the user declined the in-app confirmation.',
              cancelled: true
            };
          } else {
            toolResult = await toolExecutors.gmail_send_draft(activeWc, tc.arguments);
          }
        }
        recordGmailMutationForDeferredNav(tc.name, toolResult);
        currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, toolResult) });
        tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, toolResult) });
        continue;
      }

      // All other tools: execute directly against the active webContents
      const executor = toolExecutors[tc.name];
      if (!executor) {
        const toolResult = { error: `Unknown tool: ${tc.name}` };
        currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, toolResult) });
        tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, toolResult) });
        continue;
      }

      const toolResult = await executor(activeWc, tc.arguments);
      recordGmailMutationForDeferredNav(tc.name, toolResult);
      currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
      toolLog.push({ tool: tc.name, args: tc.arguments, result: sanitizeToolResultForLog(tc.name, toolResult) });
      tp({ step, tool: tc.name, result: sanitizeToolResultForLog(tc.name, toolResult) });
    }
  }
  return finishAgentRun({
    content:
      `**Step limit reached** (${maxSteps} tool steps in this run).\n\n` +
        `Work may be incomplete. In chat, say **continue** or **keep going** to resume this task, or increase **Max agent steps** under **Settings → AI** (up to 500).\n\n` +
        `If something kept failing, try a smaller goal or check the **Agent log** for the last error.`,
    toolLog,
    stepLimitReached: true
  });
}

/**
 * Execute a tab management tool by sending an IPC event to the renderer
 * and waiting for an acknowledgement with the result.
 */
async function executeTabTool(tc, sender, tabId) {
  const tid = tabId != null ? String(tabId) : '__default__';
  const channelMap = {
    open_tab:   { send: 'tool-open-tab',   ack: 'tool-open-tab-ack' },
    close_tab:  { send: 'tool-close-tab',  ack: 'tool-close-tab-ack' },
    switch_tab: { send: 'tool-switch-tab', ack: 'tool-switch-tab-ack' },
    list_tabs:  { send: 'tool-list-tabs',  ack: 'tool-list-tabs-ack' },
    split_tabs: { send: 'tool-split-tabs', ack: 'tool-split-tabs-ack' }
  };
  const ch = channelMap[tc.name];
  if (!ch) return { error: `Unknown tab tool: ${tc.name}` };
  const operationId = crypto.randomUUID();
  sender.send(ch.send, { ...(tc.arguments || {}), tabId: tid, operationId });
  const ackMs = tc.name === 'open_tab' ? 60000 : tc.name === 'split_tabs' ? 45000 : 30000;
  return await waitForRendererAck(sender, ch.ack, ackMs, operationId);
}

ipcMain.handle('ai-request', async (event, payload) => {
  const { messages, ntpBrief } = payload || {};
  const cfg = loadConfig();
  if (cfg.aiKillSwitch) {
    return { error: 'AI is turned off (kill switch). Enable it in Settings → AI.' };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey && cfg.aiProvider !== 'ollama') {
    return { error: 'No API key configured. Add one in Settings → AI.' };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (!ntpBrief) {
    processed = injectSystemPrompt(processed);
    processed = consolidateSystemMessages(processed);
  }
  if (cfg.aiRedactPII !== false) {
    processed = processed.map((m) => {
      if (typeof m.content === 'string') return { ...m, content: redactPII(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((part) =>
            part && part.type === 'text' ? { ...part, text: redactPII(part.text || '') } : part
          )
        };
      }
      return m;
    });
  }

  if (store) {
    store.appendLedger({
      type: 'ai_request',
      provider: cfg.aiProvider,
      model: cfg.aiModel,
      messageCount: processed.length,
      contextFingerprint: hashContext(processed)
    });
  }

  try {
    let result = await performAiFetch(cfg, apiKey, processed, false, { ntpBrief });
    if (result.stream) return { error: 'Internal error: unexpected stream' };

    if (!ntpBrief) {
      // Convert <navio-actions> block to [[ACTION:...]] tokens
      if (!result.error && result.content) {
        result = { ...result, content: convertNavioActionsBlock(result.content) };
      }

      // Fallback: if model still wrote ACTION0/ACTION1 placeholders, silently retry once
      if (!result.error && aiResponseHasBrokenActions(result.content)) {
        console.log('[navio] ACTION0 pattern detected — auto-retrying with format fix');
        const fixed = await performAiFetch(cfg, apiKey, buildActionFixMessages(processed, result.content), false);
        if (!fixed.error && fixed.content) {
          result = { ...fixed, content: convertNavioActionsBlock(fixed.content) };
        }
      }

      if (!result.error && result.content) {
        extractAndSaveMemory(result.content);
      }
    }

    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('ai-abort', async (event, payload) => {
  const id = event.sender && event.sender.id;
  if (typeof id !== 'number') return { ok: true };
  const tabId = payload && payload.tabId != null ? String(payload.tabId) : null;
  if (tabId) {
    const key = `${id}:${tabId}`;
    const ac = aiFetchAbortByKey.get(key);
    if (ac) ac.abort();
  } else {
    for (const [key, ac] of aiFetchAbortByKey) {
      if (key.startsWith(`${id}:`) && ac) ac.abort();
    }
  }
  return { ok: true };
});

ipcMain.handle('ai-abort-tab-id-alias', async (event, payload) => {
  const id = event.sender && event.sender.id;
  if (typeof id !== 'number') return { ok: true };
  const fromTabId = payload && payload.fromTabId != null ? String(payload.fromTabId) : '';
  const toTabId = payload && payload.toTabId != null ? String(payload.toTabId) : '';
  aliasAiAbortControllerTabId(event.sender, fromTabId, toTabId);
  return { ok: true };
});

ipcMain.handle('ai-request-stream', async (event, { messages, tabId: streamTabId }) => {
  const cfg = loadConfig();
  const sender = event.sender;
  const tid = streamTabId != null && String(streamTabId).length ? String(streamTabId) : '__default__';
  const ac = registerAiAbortController(sender, tid);
  if (cfg.aiKillSwitch) {
    releaseAiAbortController(sender, tid);
    sender.send('ai-stream-error', { tabId: tid, message: 'AI is turned off (kill switch).' });
    return { ok: false };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey && cfg.aiProvider !== 'ollama') {
    releaseAiAbortController(sender, tid);
    sender.send('ai-stream-error', { tabId: tid, message: 'No API key configured.' });
    return { ok: false };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  processed = injectSystemPrompt(processed);
  processed = consolidateSystemMessages(processed);
  if (cfg.aiRedactPII !== false) {
    processed = processed.map((m) => {
      if (typeof m.content === 'string') return { ...m, content: redactPII(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((part) =>
            part && part.type === 'text' ? { ...part, text: redactPII(part.text || '') } : part
          )
        };
      }
      return m;
    });
  }

  if (store) {
    store.appendLedger({
      type: 'ai_request_stream',
      provider: cfg.aiProvider,
      model: cfg.aiModel,
      messageCount: processed.length,
      contextFingerprint: hashContext(processed)
    });
  }

  // Helper: collect an SSE stream from performAiFetch into a plain string
  const collectStream = async (fetchResult) => {
    if (fetchResult.aborted) return { content: '', aborted: true };
    if (fetchResult.error) return { error: fetchResult.error };
    if (!fetchResult.stream) return { error: 'Streaming unavailable for this provider.' };
    const streamProvider = fetchResult.provider || 'openai';
    const reader = fetchResult.stream.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let fullText = '';
    while (true) {
      if (ac.signal.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return { content: fullText, aborted: true };
      }
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:') && trimmed.startsWith('event:')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const json = JSON.parse(data);

          if (streamProvider === 'anthropic') {
            // Anthropic SSE: event types content_block_delta, content_block_start, etc.
            if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
              fullText += json.delta.text || '';
            }
          } else if (streamProvider === 'google') {
            // Google SSE: each event is a full candidate response chunk
            const parts = json.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              if (p.text) fullText += p.text;
            }
          } else {
            // OpenAI / custom
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) fullText += delta;
          }
        } catch { /* skip keep-alives or parse errors */ }
      }
    }
    return { content: fullText };
  };

  const sendChunksAndDone = (text, cancelled) => {
    const CHUNK = 40;
    for (let i = 0; i < text.length; i += CHUNK) {
      if (ac.signal.aborted) {
        sender.send('ai-stream-done', { cancelled: true, tabId: tid });
        return;
      }
      sender.send('ai-stream-chunk', { tabId: tid, text: text.slice(i, i + CHUNK) });
    }
    sender.send('ai-stream-done', cancelled ? { cancelled: true, tabId: tid } : { tabId: tid });
  };

  try {
    // Collect the full response before sending to renderer so we can check the format
    let currentMessages = processed;
    let finalText = '';
    const MAX_FORMAT_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt++) {
      if (ac.signal.aborted) {
        sender.send('ai-stream-done', { cancelled: true, tabId: tid });
        return { ok: false, stopped: true };
      }
      console.log(`[navio] ai-request-stream attempt ${attempt + 1}, model=${cfg.aiModel}, messages=${currentMessages.length}`);
      const fetchResult = await performAiFetch(cfg, apiKey, currentMessages, true, { signal: ac.signal });
      if (fetchResult.aborted) {
        sender.send('ai-stream-done', { cancelled: true, tabId: tid });
        return { ok: false, stopped: true };
      }
      const collected = await collectStream(fetchResult);

      if (collected.aborted) {
        finalText = convertNavioActionsBlock(collected.content || '');
        sendChunksAndDone(finalText, true);
        return { ok: false, stopped: true };
      }

      if (collected.error) {
        sender.send('ai-stream-error', { tabId: tid, message: collected.error });
        return { ok: false };
      }

      finalText = convertNavioActionsBlock(collected.content);
      console.log(`[navio] raw response (first 200): ${collected.content?.slice(0, 200)}`);
      console.log(`[navio] converted (first 200): ${finalText?.slice(0, 200)}`);

      if (!aiResponseHasBrokenActions(finalText) || attempt === MAX_FORMAT_RETRIES) break;

      console.log(`[navio] ACTION0 pattern detected (attempt ${attempt + 1}) — retrying with format fix`);
      currentMessages = buildActionFixMessages(currentMessages, finalText);
    }

    sendChunksAndDone(finalText, false);
    return { ok: true };
  } catch (err) {
    if (err && (err.name === 'AbortError' || ac.signal.aborted)) {
      sender.send('ai-stream-done', { cancelled: true, tabId: tid });
      return { ok: false, stopped: true };
    }
    sender.send('ai-stream-error', { tabId: tid, message: err.message });
    return { ok: false };
  } finally {
    releaseAiAbortController(sender, tid);
  }
});

ipcMain.handle('extract-page-content', async (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };

    const result = await wc.executeJavaScript(`
      (function() {
        const getMetaContent = (name) => {
          const el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
          return el ? el.getAttribute('content') : '';
        };
        return JSON.stringify({
          title: document.title,
          url: window.location.href,
          description: getMetaContent('description') || getMetaContent('og:description'),
          text: document.body.innerText.substring(0, 15000),
          headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).slice(0, 30).map(h => ({
            level: h.tagName,
            text: h.textContent.trim()
          })),
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
            text: a.textContent.trim().substring(0, 100),
            href: a.href
          })).filter(l => l.text && l.href.startsWith('http')),
          images: Array.from(document.querySelectorAll('img[alt]')).slice(0, 20).map(img => ({
            alt: img.alt,
            src: img.src
          })),
          forms: Array.from(document.querySelectorAll('form')).slice(0, 5).map(f => ({
            action: f.action,
            fields: Array.from(f.querySelectorAll('input, select, textarea')).map(el => ({
              type: el.type || el.tagName.toLowerCase(),
              name: el.name,
              placeholder: el.placeholder,
              id: el.id
            }))
          }))
        });
      })()
    `);
    return JSON.parse(result);
  } catch (err) {
    return { error: err.message };
  }
});

// ── Tool-calling AI request (agentic loop) ──────────────────────────────────
ipcMain.handle('ai-request-with-tools', async (event, { messages, webContentsId, tabId: toolTabId }) => {
  const cfg = loadConfig();
  if (cfg.aiKillSwitch) {
    return { error: 'AI is turned off (kill switch). Enable it in Settings → AI.' };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey && cfg.aiProvider !== 'ollama') {
    return { error: 'No API key configured. Add one in Settings → AI.' };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  processed = injectSystemPrompt(processed);
  processed = consolidateSystemMessages(processed);

  if (cfg.aiRedactPII !== false) {
    processed = processed.map((m) => {
      if (typeof m.content === 'string') return { ...m, content: redactPII(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((part) =>
            part && part.type === 'text' ? { ...part, text: redactPII(part.text || '') } : part
          )
        };
      }
      return m;
    });
  }

  if (store) {
    store.appendLedger({
      type: 'ai_request_with_tools',
      provider: cfg.aiProvider,
      model: cfg.aiModel,
      messageCount: processed.length,
      contextFingerprint: hashContext(processed)
    });
  }

  const wc = webContentsId ? electronWebContents.fromId(webContentsId) : null;
  if (!wc) {
    return { error: 'No active tab — open a page first.' };
  }

  const tid = toolTabId != null && String(toolTabId).length ? String(toolTabId) : '__default__';
  const ac = registerAiAbortController(event.sender, tid);
  try {
    return await executeToolLoop(cfg, apiKey, processed, wc, event.sender, undefined, {
      signal: ac.signal,
      tabId: tid
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || ac.signal.aborted)) {
      return { content: '**Stopped.**', cancelled: true, toolLog: [] };
    }
    return { error: err.message };
  } finally {
    releaseAiAbortController(event.sender, tid);
  }
});

ipcMain.handle('deep-research', async (event, { query }) => {
  const q = (query || '').trim();
  if (!q) return { error: 'Missing query' };

  const cfg = loadConfig();
  if (cfg.aiKillSwitch) return { error: 'AI is turned off (kill switch).' };
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey) return { error: 'No API key configured.' };

  const plannerCfg = { ...cfg, aiModel: cfg.aiPlannerModel || 'gpt-5.4-mini' };

  const planRes = await performAiFetch(
    plannerCfg,
    apiKey,
    [
      {
        role: 'system',
        content:
          'Reply with ONLY a JSON array of 3 to 5 strings. Each string must be a full https URL useful for researching the user topic (Google search URLs with q= are fine). No markdown fences, no explanation, no other text.'
      },
      { role: 'user', content: `Research topic:\n${q}` }
    ],
    false
  );
  if (planRes.error) return { error: planRes.error };

  let urls = [];
  try {
    const m = (planRes.content || '').match(/\[[\s\S]*\]/);
    if (m) urls = JSON.parse(m[0]);
  } catch {
    /* use fallback */
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    urls = [`https://www.google.com/search?q=${encodeURIComponent(q)}`];
  }
  urls = urls
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim()))
    .slice(0, 5)
    .map((u) => u.trim());

  const researchWin = createResearchWindow();
  const wc = researchWin.webContents;

  try {
    const sources = [];
    for (const u of urls) {
      try {
        await navigateWebContentsAndWait(wc, u);
        const raw = await wc.executeJavaScript(`(() => JSON.stringify({
          title: document.title,
          url: location.href,
          text: (document.body && document.body.innerText) ? document.body.innerText.substring(0, 12000) : ''
        }))()`);
        const page = JSON.parse(raw);
        sources.push({
          url: page.url || u,
          title: page.title || '',
          text: page.text || ''
        });
      } catch (e) {
        sources.push({ url: u, title: '(load error)', text: '', error: String(e.message || e) });
      }
    }

    const blob = sources
      .map(
        (s, i) =>
          `### Source ${i + 1}\nURL: ${s.url}\nTitle: ${s.title}\n\n${(s.text || '').slice(0, 12000)}`
      )
      .join('\n\n')
      .slice(0, 80000);

    const reportRes = await performAiFetch(
      cfg,
      apiKey,
      [
        {
          role: 'system',
          content:
            'Write a factual research report. Use inline numeric citations like [1], [2] that match source numbers. End with a ## Sources section listing each URL as a markdown link. Use clear markdown headings.'
        },
        {
          role: 'user',
          content: `Research question: ${q}\n\n--- Compiled extracts from browsed pages ---\n\n${blob}`
        }
      ],
      false
    );
    if (reportRes.error) return { error: reportRes.error };

    return { content: reportRes.content || '', sources };
  } catch (e) {
    return { error: e.message || String(e) };
  } finally {
    try {
      if (!researchWin.isDestroyed()) researchWin.destroy();
    } catch {
      /* ignore */
    }
  }
});

// ── Ollama local model detection ─────────────────────────────────────────────
// ── OpenAI Speech-to-Text (Whisper / gpt-4o-transcribe) ──────────────────
ipcMain.handle('navio-stt', async (event, { audio, mimeType, language }) => {
  try {
    const cfg = loadConfig();
    const provider = cfg.aiProvider || 'openai';
    if (provider !== 'openai' && provider !== 'custom') {
      return { ok: false, error: 'STT requires an OpenAI API key (current provider: ' + provider + ')' };
    }
    const apiKey = secureConfig.getApiKey(app.getPath('userData'));
    if (!apiKey) return { ok: false, error: 'No API key configured.' };
    if (!audio) return { ok: false, error: 'No audio data received.' };

    const audioBuffer = Buffer.from(audio, 'base64');
    const mime = mimeType || 'audio/webm';
    // Map MIME to file extension the API accepts
    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';

    // Build multipart/form-data body manually — fully reliable across Node versions
    const boundary = `----NavioSTT${Date.now()}`;
    const CRLF = '\r\n';
    const sttModel = 'gpt-4o-mini-transcribe'; // fast, accurate, 99-language support
    const lang = language || 'en';

    const parts = [
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.${ext}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`),
      audioBuffer,
      Buffer.from(`${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}${sttModel}${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}${lang}${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}json${CRLF}`),
      Buffer.from(`--${boundary}--${CRLF}`),
    ];
    const body = Buffer.concat(parts);

    const endpoint = (cfg.customEndpoint || 'https://api.openai.com').replace(/\/v1.*$/, '') + '/v1/audio/transcriptions';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `STT API ${resp.status}: ${errText.slice(0, 300)}` };
    }

    const data = await resp.json();
    return { ok: true, text: (data.text || '').trim() };
  } catch (e) {
    return { ok: false, error: e.message || 'STT request failed' };
  }
});

// ── OpenAI Text-to-Speech ─────────────────────────────────────────────────
/** Built-in OpenAI speech voices (keep in sync with `src/js/navio-tts-voice-catalog.js`). */
const NAVIO_OPENAI_TTS_VOICE_IDS = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar'
]);

ipcMain.handle('navio-tts', async (event, { text, voice, model, speed }) => {
  try {
    const cfg = loadConfig();
    const provider = cfg.aiProvider || 'openai';
    // TTS only works with OpenAI-compatible providers
    if (provider !== 'openai' && provider !== 'custom') {
      return { ok: false, error: 'TTS requires an OpenAI API key (current provider: ' + provider + ')' };
    }
    const apiKey = secureConfig.getApiKey(app.getPath('userData'));
    if (!apiKey) return { ok: false, error: 'No API key configured. Add your OpenAI key in Settings.' };

    // tts-1 is much lower-latency than tts-1-hd; quality is still strong for assistant read-aloud.
    const ttsModel = model || 'tts-1';
    let ttsVoice = String(voice || cfg.ttsVoice || 'nova')
      .trim()
      .toLowerCase();
    if (!NAVIO_OPENAI_TTS_VOICE_IDS.has(ttsVoice)) ttsVoice = 'nova';
    const inputText = String(text || '').slice(0, 4096).trim();
    if (!inputText) return { ok: false, error: 'Empty text' };

    const fromCfg = typeof cfg.ttsSpeed === 'number' && Number.isFinite(cfg.ttsSpeed) ? cfg.ttsSpeed : NaN;
    const fromArg = speed != null ? Number(speed) : NaN;
    const rawSpeed = Number.isFinite(fromArg) ? fromArg : Number.isFinite(fromCfg) ? fromCfg : 0.94;
    const ttsSpeed = Math.min(4, Math.max(0.25, rawSpeed));

    const endpoint = (cfg.customEndpoint || 'https://api.openai.com').replace(/\/v1.*$/, '') + '/v1/audio/speech';
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: ttsModel,
        input: inputText,
        voice: ttsVoice,
        response_format: 'mp3',
        speed: ttsSpeed
      }),
      signal: AbortSignal.timeout(45000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `TTS API ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const buf = await resp.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    return { ok: true, audio: base64, mimeType: 'audio/mpeg', voice: ttsVoice };
  } catch (e) {
    return { ok: false, error: e.message || 'TTS request failed' };
  }
});

ipcMain.handle('ollama-detect', async () => {
  try {
    const resp = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(4000)
    });
    if (!resp.ok) return { ok: false, error: `Ollama HTTP ${resp.status}` };
    const json = await resp.json();
    const models = (json.models || [])
      .map((m) => m.name || m.model || '')
      .filter(Boolean)
      .sort();
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not reach Ollama' };
  }
});

ipcMain.handle('workflow-save', async (event, { name, steps, meta }) => {
  const isToolSteps =
    Array.isArray(steps) &&
    steps.length > 0 &&
    typeof steps[0] === 'object' &&
    steps[0] !== null &&
    typeof steps[0].tool === 'string';
  if (isToolSteps) {
    try {
      return { ok: true, workflow: saveWorkflow(name, steps, meta || {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  try {
    const list = readWorkflowsFile();
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    list.push({
      id,
      name: (name || 'Workflow').toString().slice(0, 120),
      steps: Array.isArray(steps) ? steps.map((s) => String(s)) : [],
      createdAt: new Date().toISOString()
    });
    writeWorkflowsFile(list);
    return { ok: true, id };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('workflow-list', async () => listWorkflowsMergedForIpc());

ipcMain.handle('workflow-load', async (event, { name }) => {
  try {
    const w = loadWorkflow(name);
    if (w) return { ok: true, workflow: w };
    const list = readWorkflowsFile();
    const found = list.find((wf) => wf.id === name || wf.name === name);
    if (found) return { ok: true, workflow: found };
    return { ok: false, error: `Workflow "${name}" not found` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('workflow-delete', async (event, { name }) => {
  try {
    if (name && deleteWorkflow(name)) return { ok: true };
    const list = readWorkflowsFile();
    const next = list.filter((w) => w.id !== name && w.name !== name);
    if (next.length === list.length) return { ok: false, error: 'Not found' };
    writeWorkflowsFile(next);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('replace-selection-in-page', async (event, { webContentsId, text, html }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { ok: false, error: 'WebContents not found' };
    const payloadText = JSON.stringify(text == null ? '' : String(text));
    const payloadHtml = JSON.stringify(html == null ? '' : String(html));
    const res = await wc.executeJavaScript(`
      (() => {
        const plain = JSON.parse(${payloadText});
        const richHtmlRaw = JSON.parse(${payloadHtml});
        function sanitizeHtml(s) {
          if (!s || typeof s !== 'string') return '';
          try {
            const doc = new DOMParser().parseFromString(s, 'text/html');
            const b = doc.body;
            if (!b) return '';
            b.querySelectorAll('script,style,iframe,object,embed,link').forEach((el) => el.remove());
            b.querySelectorAll('*').forEach((el) => {
              for (const attr of Array.from(el.attributes)) {
                const n = attr.name.toLowerCase();
                const v = String(attr.value || '').toLowerCase();
                if (n.startsWith('on') || v.indexOf('javascript:') >= 0) el.removeAttribute(attr.name);
              }
            });
            return b.innerHTML;
          } catch (e) {
            return '';
          }
        }
        const richHtml = sanitizeHtml(richHtmlRaw);
        /** Selection was wrapped in #navio-inline-sel-bookmark when the user picked text (see webview-preload). */
        function replaceNavioInlineBookmark() {
          const holder = document.getElementById('navio-inline-sel-bookmark');
          if (!holder || !holder.parentNode) return false;
          try {
            if (richHtml) {
              holder.innerHTML = richHtml;
            } else {
              holder.textContent = plain;
            }
            const p = holder.parentNode;
            while (holder.firstChild) {
              p.insertBefore(holder.firstChild, holder);
            }
            p.removeChild(holder);
            const host = p.closest && p.closest('[contenteditable="true"]');
            if (host) {
              try {
                host.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
              } catch (e) {
                host.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
            return true;
          } catch (e) {
            return false;
          }
        }
        function resolveContentEditable() {
          const ae = document.activeElement;
          if (!ae) return null;
          if (ae.isContentEditable || ae.getAttribute('contenteditable') === 'true') return ae;
          if (ae.closest) {
            const c = ae.closest('[contenteditable="true"]');
            if (c) return c;
          }
          return null;
        }
        function tryInsert() {
          if (replaceNavioInlineBookmark()) return true;
          const ae = document.activeElement;
          const ce = resolveContentEditable();
          if (ce && richHtml) {
            try {
              ce.focus();
              if (document.queryCommandSupported && document.queryCommandSupported('insertHTML')) {
                if (ce.ownerDocument.execCommand('insertHTML', false, richHtml)) return true;
              }
            } catch (e) {}
          }
          if (ce) {
            try {
              ce.focus();
              if (ce.ownerDocument.execCommand('insertText', false, plain)) return true;
            } catch (e) {}
          }
          if (!ae) return false;
          if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') {
            try {
              const start = ae.selectionStart, end = ae.selectionEnd;
              if (typeof start === 'number' && typeof end === 'number') {
                const v = ae.value;
                const proto = ae.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                const next = v.slice(0, start) + plain + v.slice(end);
                if (setter) setter.call(ae, next); else ae.value = next;
                const pos = start + plain.length;
                ae.setSelectionRange(pos, pos);
                ae.dispatchEvent(new InputEvent('input', { bubbles: true, data: plain }));
                ae.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            } catch (e) {}
          }
          try {
            return document.execCommand('insertText', false, plain);
          } catch (e) {
            return false;
          }
        }
        return { ok: tryInsert() };
      })()
    `);
    return { ok: !!(res && res.ok) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('webview-paste-clipboard', async (event, { webContentsId }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { ok: false };
    const pasteMods = process.platform === 'darwin' ? ['meta'] : ['control'];
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: pasteMods });
    await new Promise((r) => setTimeout(r, 40));
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: pasteMods });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('extract-page-selection', async (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };
    const text = await wc.executeJavaScript(
      `(() => { try { return window.getSelection().toString() || ''; } catch (e) { return ''; } })()`
    );
    return { selection: typeof text === 'string' ? text : '' };
  } catch (err) {
    return { error: err.message };
  }
});

// Accessibility-first snapshot of interactive elements on the active page
ipcMain.handle('page-snapshot', async (event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };
    const snapshot = await wc.executeJavaScript(`
      (() => {
        const regular = [];
        const priority = []; // submit/next/continue buttons — always appended regardless of limit
        const seen = new WeakSet();
        // Keywords that mark a button as a "priority" element we never want to miss
        const PRIORITY_RE = /\\b(next|continue|submit|save|proceed|confirm|done|finish|complete|create|login|sign.?in|book|order|buy|pay|checkout|apply|ok)\\b/i;
        const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="tab"],[role="option"],[role="switch"],[role="combobox"],[role="searchbox"]';
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? el.type || 'input' : tag);
          const ariaLabel = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const title = el.getAttribute('title') || '';
          const name = el.getAttribute('name') || '';
          const id = el.id || '';
          const visibleText = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80);
          const label = (ariaLabel || visibleText || placeholder || title || name).trim().slice(0,80);
          if (!label) continue;
          let selector = id ? '#'+id : (name ? tag+'[name="'+name+'"]' : null);
          if (!selector) {
            const classes = Array.from(el.classList).filter(c => !/^[a-z]{1,2}$/.test(c)).slice(0,2);
            selector = tag + (classes.length ? '.'+classes.join('.') : '');
          }
          const item = { role, label, selector };
          const isSubmit = (tag === 'button' && /^(submit)?$/.test(el.type || '')) ||
                           (tag === 'input'  && /^(submit|button)$/.test(el.type || '')) ||
                           PRIORITY_RE.test(label);
          if (isSubmit) {
            priority.push(item); // collected separately, never cut off
          } else if (regular.length < 100) {
            regular.push(item);
          }
        }
        // Priority buttons always appended at the end so the AI always sees them
        return [...regular, ...priority];
      })()
    `);
    return { elements: snapshot, url: wc.getURL(), title: wc.getTitle() };
  } catch (err) {
    return { error: err.message };
  }
});

/** Plain-text body from Gmail API `format=full` payload tree (shared: IPC + tools). */
function navioGmailExtractPlainBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  for (const part of payload.parts || []) {
    const found = navioGmailExtractPlainBody(part);
    if (found) return found;
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  return '';
}

/** Strip HTML parts to rough plain text when there is no text/plain part (common in rich drafts). */
function navioGmailExtractHtmlPlainFallback(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    let html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    html = html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
    return navioRepairUtf8Mojibake(html);
  }
  for (const part of payload.parts || []) {
    const found = navioGmailExtractHtmlPlainFallback(part);
    if (found) return found;
  }
  return '';
}

/** Attachment filenames from a full message payload (recursive parts). */
function navioGmailCollectAttachmentFilenames(payload) {
  const names = [];
  (function walk(p) {
    if (!p) return;
    const fn = (p.filename || '').trim();
    if (fn) names.push(fn);
    for (const part of p.parts || []) walk(part);
  })(payload);
  return names;
}

/**
 * Collect attachment metadata including attachment IDs for use with gmail_get_attachment.
 */
function navioGmailCollectAttachmentsWithIds(payload) {
  const attachments = [];
  (function walk(p) {
    if (!p) return;
    const fn = (p.filename || '').trim();
    const aid = p.body?.attachmentId;
    const size = p.body?.size;
    if (fn && aid) {
      attachments.push({
        filename: fn,
        attachment_id: aid,
        mime_type: p.mimeType || '',
        size_bytes: size || 0
      });
    }
    for (const part of p.parts || []) walk(part);
  })(payload);
  return attachments;
}

async function navioGmailGetMessageForTool(token, messageId, maxBodyChars = 32000) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (!r.ok) return { error: d.error?.message || 'Gmail API error' };
  const headers = d.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || '';
  let body = navioGmailExtractPlainBody(d.payload);
  if (!body.trim()) body = navioGmailExtractHtmlPlainFallback(d.payload);
  body = navioRepairUtf8Mojibake(body || '');
  if (body.length > maxBodyChars) {
    body = `${body.slice(0, maxBodyChars)}\n\n… [body truncated by Navio — ask for a follow-up if needed]`;
  }
  const attachments = navioGmailCollectAttachmentsWithIds(d.payload);
  const threadId = d.threadId || '';
  return {
    id: messageId,
    thread_id: threadId,
    subject: get('Subject'),
    from: get('From'),
    to: get('To'),
    cc: get('Cc') || undefined,
    reply_to: get('Reply-To') || undefined,
    date: get('Date'),
    snippet: d.snippet || '',
    body,
    attachments,
    label_ids: d.labelIds || [],
    note: attachments.length > 0
      ? `This message has ${attachments.length} attachment(s). Use gmail_get_attachment with message_id and attachment_id to read them. Use gmail_get_thread with thread_id to read the full conversation.`
      : `Use gmail_get_thread with thread_id "${threadId}" to read the full conversation chain.`
  };
}

/**
 * Gmail per-message links (hash fragment or idr=) often hit ERR_ABORTED (-3) in Electron webviews
 * when Gmail redirects. Extract the API message id so we can fulfill via Gmail API instead.
 */
function extractGmailMessageIdFromNavUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if (!/^mail\.google\.com$/i.test(u.hostname)) return null;
    const h = (u.hash || '').replace(/^#/, '');
    if (h) {
      const segments = h.split('/').filter(Boolean);
      const last = segments[segments.length - 1] || '';
      if (/^[a-fA-F0-9]{10,}$/.test(last)) return last;
    }
    const idr = u.searchParams.get('idr');
    if (idr) {
      const decoded = decodeURIComponent(idr);
      const seg = decoded.split('/').filter(Boolean).pop() || '';
      if (/^[a-fA-F0-9]{10,}$/.test(seg)) return seg;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * If url is a Gmail single-message deep link, load it via API and return { intercept: true, result }.
 * Otherwise return null (caller should navigate / open_tab normally).
 * opts.allowGmailWebUi: skip intercept so the real Gmail tab can load (attachment / UI takeover).
 */
async function maybeLoadGmailMessageUrlViaApi(toolName, url, opts = {}) {
  if (opts.allowGmailWebUi) return null;
  const gmId = extractGmailMessageIdFromNavUrl(url);
  if (!gmId) return null;
  const token = await getValidOAuthToken('google');
  if (!token) {
    return {
      intercept: true,
      result: {
        success: false,
        error:
          'Gmail message URLs cannot be opened in Navio tabs (ERR_ABORTED). Connect Google in Settings → Connected Apps, ' +
          `then call gmail_get_message with message_id "${gmId}".`,
        message_id: gmId
      }
    };
  }
  const msg = await navioGmailGetMessageForTool(token, gmId, 56000);
  if (msg.error) {
    return {
      intercept: true,
      result: {
        success: false,
        error: msg.error,
        message_id: gmId,
        hint: 'Try gmail_get_message with this message_id.'
      }
    };
  }
  return {
    intercept: true,
    result: {
      success: true,
      note:
        `Intercepted ${toolName}: mail.google.com message deep links fail in Navio (ERR_ABORTED). ` +
        'Loaded this message via Gmail API. Do not navigate or open_tab to mail.google.com/#inbox/... again; use gmail_search + gmail_get_message.',
      message_id: gmId,
      requested_url: url,
      subject: msg.subject,
      from: msg.from,
      to: msg.to,
      date: msg.date,
      snippet: msg.snippet,
      body: msg.body
    }
  };
}

// ── Tool executors for the agentic tool-calling loop ─────────────────────────
// Each executor takes (wc, args) where wc is the active webContents and args
// are the parsed tool call arguments.  Executors delegate to existing
// browser-action logic where possible.

/**
 * Scroll to the top, then capture viewport-height tiles top→bottom so the model
 * sees the page from its real start. Restores scroll to top after.
 */
async function captureFullPageScreenshotTiles(wc) {
  try {
    await wc.executeJavaScript('window.scrollTo(0, 0); true');
    await new Promise((r) => setTimeout(r, 90));
    await waitForWebContentsSettled(wc, { settleMs: 140 });

    const dims = await wc.executeJavaScript(`(() => {
      const sh = Math.max(
        document.documentElement.scrollHeight || 0,
        document.body && document.body.scrollHeight || 0,
        document.documentElement.clientHeight || 0,
        window.innerHeight || 1
      );
      const vh = Math.max(1, Math.floor(window.innerHeight));
      const vw = Math.max(1, Math.floor(window.innerWidth));
      return { sh, vh, vw };
    })()`);

    if (!dims || typeof dims.sh !== 'number') {
      return { error: 'Could not read page dimensions for full-page screenshot' };
    }

    const sh = Math.max(1, dims.sh);
    const vh = Math.max(1, dims.vh);
    const maxTiles = 16;
    const tileCount = Math.min(maxTiles, Math.max(1, Math.ceil(sh / vh)));

    const images = [];
    for (let i = 0; i < tileCount; i++) {
      const top = i * vh;
      await wc.executeJavaScript(`window.scrollTo(0, ${top}); true`);
      await new Promise((r) => setTimeout(r, 75));
      const img = await wc.capturePage();
      let b64 = img.toJPEG(68).toString('base64');
      if (b64.length > 200000) {
        const small = img.resize({ width: 1024 });
        b64 = small.toJPEG(60).toString('base64');
      }
      images.push({
        image: b64,
        mimeType: 'image/jpeg',
        label: `Tile ${i + 1}/${tileCount} (scrollY≈${top}px; first tile is page top)`
      });
      if (top + vh >= sh - 4) break;
    }

    await wc.executeJavaScript('window.scrollTo(0, 0); true');
    await new Promise((r) => setTimeout(r, 40));

    return {
      images,
      scrollHeight: sh,
      viewportHeight: vh,
      viewportWidth: dims.vw,
      tileCount: images.length,
      note: 'Full-page screenshots from top to bottom. Tile 1 is the top of the page.'
    };
  } catch (e) {
    return { error: 'Screenshot failed: ' + e.message };
  }
}

const SAVE_LOCAL_FILE_MAX_CHARS = 1_800_000;
const AdmZipLocalSave = require('adm-zip');

function navioEscapeXmlForDocx(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal OOXML package: plain text → paragraphs (Word opens without external styles). */
function navioPlainTextToDocxBuffer(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const paras = lines
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${navioEscapeXmlForDocx(line)}</w:t></w:r></w:p>`)
    .join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    paras +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const wordRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
  const zip = new AdmZipLocalSave();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rels, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(wordRels, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  return zip.toBuffer();
}

function navioSaveDialogParentWindow(wc) {
  try {
    if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed()) {
      const bw = BrowserWindow.fromWebContents(wc);
      if (bw && typeof bw.isDestroyed === 'function' && !bw.isDestroyed()) return bw;
    }
  } catch {
    /* ignore */
  }
  try {
    if (mainWindow && typeof mainWindow.isDestroyed === 'function' && !mainWindow.isDestroyed()) return mainWindow;
  } catch {
    /* ignore */
  }
  return null;
}

const toolExecutors = {
  async read_page(wc, args) {
    try {
      await wc.executeJavaScript('window.scrollTo(0, 0); true');
    } catch {
      /* ignore */
    }
    await waitForWebContentsSettled(wc, { settleMs: 120 });
    const result = await getAccessibilityTree(wc, {
      filter: args.filter || 'interactive',
      refId: args.ref,
      maxChars: args.max_chars || 50000
    });
    if (!result) {
      // CDP unavailable — fallback to existing page-snapshot JS injection
      try {
        const snap = await wc.executeJavaScript(`
          (() => {
            const items = [];
            const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="checkbox"],[role="radio"],[role="tab"],[role="option"],[role="switch"],[role="combobox"],[role="searchbox"],[aria-haspopup]';
            for (const el of document.querySelectorAll(sel)) {
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              const cs = window.getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              const tag = el.tagName.toLowerCase();
              const role = el.getAttribute('role') || tag;
              const label = (el.getAttribute('aria-label') || el.innerText || el.placeholder || '').trim().slice(0,80);
              if (!label) continue;
              items.push(role + ' "' + label + '"');
              if (items.length >= 120) break;
            }
            return items.join('\\n');
          })()
        `);
        return { fallback: true, elements: snap, url: wc.getURL(), title: wc.getTitle() };
      } catch (e) {
        return { error: 'Could not read page: ' + e.message };
      }
    }
    return { tree: result.yaml, url: result.url, title: result.title };
  },

  async get_page_text(wc, args) {
    await waitForWebContentsSettled(wc, { settleMs: 100 });
    try {
      const text = await wc.executeJavaScript(`
        (() => {
          const t = document.body ? document.body.innerText : document.documentElement.innerText;
          return (t || '').trim();
        })()
      `);
      const maxChars = args.max_chars || 20000;
      return { text: (text || '').slice(0, maxChars), url: wc.getURL(), title: wc.getTitle() };
    } catch (e) {
      return { error: 'Could not extract text: ' + e.message };
    }
  },

  async click(wc, args) {
    if (args.ref) {
      // Phase B: pre-action snapshot for verify-after-action
      const before = await snapshotPage(wc).catch(() => null);
      const refResult = await clickByRef(wc, args.ref);
      if (refResult.success) {
        await waitForOptionalNavigationAfterClick(wc, 2000);
        // Post-action diff — return change signal to model
        const verify = before ? await verifyAction(wc, before, { waitForNetworkIdle: false }) : null;
        if (verify && !verify.changed) {
          // No change detected — check for overlay and attempt dismiss
          const dismissResult = await dismissOverlay(wc).catch(() => false);
          return {
            ...refResult,
            changed: false,
            no_change_warning: 'No DOM change detected after click. ' +
              (dismissResult ? 'Dismissed an overlay — try clicking again.' : 'Page may not have reacted. Verify with read_page.')
          };
        }
        if (verify) {
          return { ...refResult, changed: verify.changed, page_change: verify.summary };
        }
      }
      return refResult;
    }
    const selector = args.text ? `text=${args.text}` :
                     args.aria ? `aria=${args.aria}` :
                     args.xy   ? `xy=${args.xy}` : '';
    if (!selector) return { error: 'click requires ref, text, aria, or xy' };
    // Delegate to the existing browser-action click logic via internal call
    return await executeBrowserActionInternal(wc, 'click', { selector });
  },

  async type_text(wc, args) {
    if (args.ref) {
      return await typeByRef(wc, args.ref, args.value || '');
    }
    const fieldLabel = args.text || '';
    if (!fieldLabel) return { error: 'type_text requires ref or text to identify the field' };
    return await executeBrowserActionInternal(wc, 'type', {
      selector: `text=${fieldLabel}`,
      text: args.value || '',
      occurrence: args.occurrence
    });
  },

  async select_option(wc, args) {
    if (args.ref) {
      return await selectByRef(wc, args.ref, args.value || '');
    }
    const fieldSpec = args.text ? `text=${args.text}` : '';
    if (!fieldSpec) return { error: 'select_option requires ref or text' };
    return await executeBrowserActionInternal(wc, 'select', {
      fieldSpec,
      optionValue: args.value || ''
    });
  },

  async scroll(wc, args) {
    const amount = Math.min(args.amount || 600, 3000);
    const scrollDown = args.direction !== 'up';
    try {
      await wc.executeJavaScript(`
        (function() {
          const dir = ${scrollDown ? 1 : -1};
          const amt = ${amount};

          function canScroll(el) {
            if (!el || el === document.documentElement) return false;
            const s = window.getComputedStyle(el);
            return /auto|scroll/.test(s.overflow + s.overflowY) && el.scrollHeight > el.clientHeight + 4;
          }

          const beforeY = window.scrollY;
          window.scrollBy(0, dir * amt);
          if (Math.abs(window.scrollY - beforeY) > 2) return;

          let el = document.activeElement;
          while (el && el !== document.body && el !== document.documentElement) {
            if (canScroll(el)) { el.scrollBy(0, dir * amt); return; }
            el = el.parentElement;
          }

          let best = null, bestArea = 0;
          for (const node of document.querySelectorAll('*')) {
            if (!canScroll(node)) continue;
            const area = node.scrollHeight * node.offsetWidth;
            if (area > bestArea) { best = node; bestArea = area; }
          }
          if (best) best.scrollBy(0, dir * amt);
        })()
      `);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  },

  async press_key(wc, args) {
    return await executeBrowserActionInternal(wc, 'pressKey', { key: args.key || 'Tab' });
  },

  async screenshot(wc, args = {}) {
    const fullPage = !(args && args.full_page === false);
    const encodeViewport = async () => {
      const img = await wc.capturePage();
      const buf = img.toJPEG(70);
      let b64 = buf.toString('base64');
      if (b64.length > 200000) {
        const small = img.resize({ width: 1024 });
        b64 = small.toJPEG(60).toString('base64');
      }
      return { image: b64, mimeType: 'image/jpeg' };
    };

    if (!fullPage) {
      try {
        await wc.executeJavaScript('window.scrollTo(0, 0); true');
        await new Promise((r) => setTimeout(r, 55));
        await waitForWebContentsSettled(wc, { settleMs: 120 });
        return await encodeViewport();
      } catch (e) {
        return { error: 'Screenshot failed: ' + e.message };
      }
    }

    const tiled = await captureFullPageScreenshotTiles(wc);
    if (tiled.error || !tiled.images?.length) {
      try {
        await wc.executeJavaScript('window.scrollTo(0, 0); true');
        await new Promise((r) => setTimeout(r, 55));
        await waitForWebContentsSettled(wc, { settleMs: 120 });
        return await encodeViewport();
      } catch (e) {
        return tiled.error ? tiled : { error: 'Screenshot failed: ' + e.message };
      }
    }
    return tiled;
  },

  async insert_text(wc, args) {
    return await executeBrowserActionInternal(wc, 'insertText', { text: args.text || '' });
  },

  async wait(wc, args) {
    if (args.text) {
      return await executeBrowserActionInternal(wc, 'waitForText', { text: args.text });
    }
    const ms = Math.min(args.ms || 1000, 10000);
    await new Promise((r) => setTimeout(r, ms));
    return { success: true, waited: ms };
  },

  async go_back(wc) {
    try {
      await wc.executeJavaScript('window.history.back()');
      await new Promise((r) => setTimeout(r, 800));
      return { success: true, url: wc.getURL() };
    } catch (e) {
      return { error: e.message };
    }
  },

  async go_forward(wc) {
    try {
      await wc.executeJavaScript('window.history.forward()');
      await new Promise((r) => setTimeout(r, 800));
      return { success: true, url: wc.getURL() };
    } catch (e) {
      return { error: e.message };
    }
  },

  async read_console(wc, args) {
    try {
      await startMonitoring(wc);
      const level = args.level || 'all';
      const limit = Math.min(args.limit || 50, 100);
      const msgs = getConsoleMessages(wc.id, level, limit);
      if (!msgs.length) return { messages: [], note: 'No console messages captured yet. The monitor starts when this tool is first called — interact with the page and call again.' };
      return { messages: msgs, count: msgs.length };
    } catch (e) {
      return { error: 'read_console failed: ' + e.message };
    }
  },

  async list_workflows(_wc, _args) {
    try {
      const workflows = listWorkflows();
      return { workflows, count: workflows.length };
    } catch (e) {
      return { error: 'list_workflows failed: ' + e.message };
    }
  },

  async run_workflow(wc, args) {
    try {
      const { loadWorkflow } = require('./navio-workflows');
      const workflow = loadWorkflow(args.name);
      if (!workflow) return { error: `Workflow "${args.name}" not found. Call list_workflows for names.` };
      const allSteps = Array.isArray(workflow.steps) ? workflow.steps : [];
      const MAX_PREVIEW = 50;
      const MAX_ARG_STR = 4000;
      const truncateVal = (v, depth) => {
        if (depth <= 0) return '[…]';
        if (v === null || typeof v !== 'object') {
          if (typeof v === 'string' && v.length > MAX_ARG_STR) return v.slice(0, MAX_ARG_STR) + '…';
          return v;
        }
        if (Array.isArray(v)) return v.map((x) => truncateVal(x, depth - 1));
        const o = {};
        for (const [k, val] of Object.entries(v)) {
          o[k] = truncateVal(val, depth - 1);
        }
        return o;
      };
      const step_preview = allSteps.slice(0, MAX_PREVIEW).map((s) => ({
        tool: s.tool || '',
        args: truncateVal(s.args || {}, 8)
      }));
      const step_preview_truncated = allSteps.length > MAX_PREVIEW;
      return {
        success: true,
        workflow_name: args.name,
        steps: allSteps.length,
        step_preview,
        step_preview_truncated,
        note:
          'Replay: call the same tools in order with the same arguments (adapt URLs/refs if the page changed). ' +
          'After each navigate or major DOM change, use read_page before click/type.'
      };
    } catch (e) {
      return { error: 'run_workflow failed: ' + e.message };
    }
  },

  async read_network(wc, args) {
    try {
      await startMonitoring(wc);
      const filter = args.filter || 'all';
      const limit = Math.min(args.limit || 30, 60);
      const reqs = getNetworkRequests(wc.id, filter, limit);
      if (!reqs.length) return { requests: [], note: 'No network requests captured yet. The monitor starts when this tool is first called — navigate or interact with the page and call again.' };
      return { requests: reqs, count: reqs.length };
    } catch (e) {
      return { error: 'read_network failed: ' + e.message };
    }
  },

  // ── Gmail API tools ─────────────────────────────────────────────────────────

  async gmail_send_draft(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };
      const draftId = (args.draft_id || '').trim();
      if (!draftId) return { error: 'draft_id is required.' };
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: draftId })
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error?.message || 'Failed to send draft.' };
      return { success: true, messageId: data.id, note: 'Email sent successfully.' };
    } catch (e) {
      return { error: 'gmail_send_draft failed: ' + e.message };
    }
  },

  async gmail_delete_draft(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };
      const draftId = (args.draft_id || '').trim();
      if (!draftId) return { error: 'draft_id is required.' };
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 204 || res.ok) return { success: true, note: 'Draft deleted.' };
      const data = await res.json().catch(() => ({}));
      return { error: data.error?.message || 'Failed to delete draft.' };
    } catch (e) {
      return { error: 'gmail_delete_draft failed: ' + e.message };
    }
  },

  async gmail_update_draft(_wc, args) {
    try {
      const draftId = (args.draft_id || '').trim();
      const body = args.body || '';
      return await gmailUpdateDraftApi(draftId, body, args);
    } catch (e) {
      return { error: 'gmail_update_draft failed: ' + e.message };
    }
  },

  async gmail_search(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };
      const query = (args.query || '').trim();
      if (!query) return { error: 'query is required.' };
      let maxResults = Math.min(Number(args.max_results) > 0 ? Number(args.max_results) : 25, 200);
      // Models often pass tiny max_results for inbox triage; raise floor so bulk tasks don't silently cap at ~6–10.
      if (/in:inbox/i.test(query) && maxResults <= 10) maxResults = 25;
      const bounceBulk =
        /\b(bounce|bounces|undeliverable|mailer-daemon|mailer_daemon|postmaster|delivery status|returned mail|failure notice)\b/i.test(
          query
        );
      if (bounceBulk && maxResults < 100) maxResults = 100;
      let pages = Math.min(Math.max(Number(args.pages) || 1, 1), 8);
      if (bounceBulk && pages < 2) pages = 2;
      const pageToken = (args.page_token || '').trim() || null;
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        data = await queryGmail(token, query, { maxResults, pageToken, pages });
        if (!data.error || !navioGmailApiTransientError(data.error)) break;
        await navioSleep(600 * (attempt + 1));
      }
      if (data.error) {
        if (/insufficient.*scope|scope.*insufficient|Request had insufficient/i.test(data.error)) {
          return { error: navioGmailScopeErrorMessage('generic') };
        }
        return { error: data.error };
      }
      const n = (data.results || []).length;
      const nextTok = data.nextPageToken || null;
      const oauthPid = gmailToolOAuthProviderId(args);
      const acctEmail = gmailConnectedAccountEmail(oauthPid);
      // Stamp an account-correct web URL on every result so the model can cite
      // the email with a link that opens in the right Gmail account (authuser=email)
      // instead of whichever inbox happens to sit in /u/0/ of the browser session.
      const resultsWithUrl = (data.results || []).map((r) => {
        if (!r || !r.id) return r;
        const view =
          Array.isArray(r.labelIds) && r.labelIds.includes('DRAFT')
            ? 'drafts'
            : Array.isArray(r.labelIds) && r.labelIds.includes('SENT')
              ? 'sent'
              : 'inbox';
        return {
          ...r,
          web_url: buildGmailWebUrl(oauthPid, r.id, { view }),
          account: acctEmail || undefined
        };
      });
      return {
        results: resultsWithUrl,
        total: data.total || 0,
        next_page_token: nextTok,
        /** So the shell can open mail.google.com in the same account slot as the API (u/0 vs u/1). */
        gmail_service_id: oauthPid === 'google_2' ? 'gmail_2' : 'gmail',
        connected_account_email: acctEmail || undefined,
        note: `Found ${n} email(s) matching "${query}".${nextTok ? ' More available — call gmail_search again with the same query and page_token set to next_page_token.' : ''} When citing any email, use its "web_url" field verbatim — do not reconstruct mail.google.com URLs.`
      };
    } catch (e) {
      return { error: 'gmail_search failed: ' + e.message };
    }
  },

  async gmail_get_message(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };
      const mid = (args.message_id || args.id || '').trim();
      if (!mid) return { error: 'message_id is required.' };
      const maxC = Math.min(Number(args.max_body_chars) > 0 ? Number(args.max_body_chars) : 32000, 120000);
      let data;
      for (let attempt = 0; attempt < 4; attempt++) {
        data = await navioGmailGetMessageForTool(token, mid, maxC);
        if (!data.error || !navioGmailApiTransientError(data.error)) break;
        await navioSleep(600 * (attempt + 1));
      }
      if (data.error) return data;
      const oauthPid = gmailToolOAuthProviderId(args);
      const acctEmail = gmailConnectedAccountEmail(oauthPid);
      return {
        ...data,
        web_url: buildGmailWebUrl(oauthPid, mid, { view: 'inbox' }),
        account: acctEmail || undefined,
        gmail_service_id: oauthPid === 'google_2' ? 'gmail_2' : 'gmail'
      };
    } catch (e) {
      return { error: 'gmail_get_message failed: ' + e.message };
    }
  },

  async gmail_list_drafts(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };

      let maxList = Math.min(Math.max(Number(args.max_results) > 0 ? Number(args.max_results) : 30, 1), 100);
      const pageToken = (args.page_token || '').trim() || null;
      const maxBodyChars = Math.min(
        Number(args.max_body_chars) > 0 ? Number(args.max_body_chars) : 12000,
        120000
      );

      const listParams = new URLSearchParams({ maxResults: String(maxList) });
      if (pageToken) listParams.set('pageToken', pageToken);

      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/drafts?${listParams}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const listData = await listRes.json();
      if (!listRes.ok) {
        const msg = listData.error?.message || 'Failed to list drafts.';
        if (/insufficient.*scope|scope.*insufficient|Request had insufficient/i.test(msg)) {
          return { error: navioGmailScopeErrorMessage('read_drafts') };
        }
        return { error: msg };
      }

      const draftRefs = listData.drafts || [];
      const nextTok = listData.nextPageToken || null;

      const detailRows = await Promise.all(
        draftRefs.map(async (dr) => {
          const id = dr.id;
          if (!id) return null;
          let r;
          let d;
          for (let attempt = 0; attempt < 3; attempt++) {
            r = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=full`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            d = await r.json();
            if (r.ok || !navioGmailApiTransientError(d.error?.message || '')) break;
            await navioSleep(400 * (attempt + 1));
          }
          if (!r.ok) {
            return { draft_id: id, error: d.error?.message || 'Could not load draft.' };
          }
          const msg = d.message || {};
          const headers = msg.payload?.headers || [];
          const get = (name) =>
            headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || '';
          let body = navioGmailExtractPlainBody(msg.payload);
          if (!body.trim()) body = navioGmailExtractHtmlPlainFallback(msg.payload);
          body = navioRepairUtf8Mojibake(body || '');
          if (body.length > maxBodyChars) {
            body = `${body.slice(0, maxBodyChars)}\n\n… [body truncated by Navio]`;
          }
          const attachment_filenames = navioGmailCollectAttachmentFilenames(msg.payload);
          return {
            draft_id: id,
            message_id: msg.id || '',
            thread_id: msg.threadId || '',
            subject: get('Subject'),
            to: get('To'),
            snippet: msg.snippet || d.snippet || '',
            body,
            attachment_filenames
          };
        })
      );

      const drafts = detailRows.filter(Boolean);
      const n = drafts.length;
      const oauthPid = gmailToolOAuthProviderId(args);
      const acctEmail = gmailConnectedAccountEmail(oauthPid);
      const draftsWithUrl = drafts.map((d) =>
        d && d.message_id
          ? { ...d, web_url: buildGmailWebUrl(oauthPid, d.message_id, { view: 'drafts' }), account: acctEmail || undefined }
          : d
      );
      return {
        drafts: draftsWithUrl,
        count: n,
        next_page_token: nextTok,
        gmail_service_id: oauthPid === 'google_2' ? 'gmail_2' : 'gmail',
        connected_account_email: acctEmail || undefined,
        note:
          `Loaded ${n} draft(s) with bodies and attachment filenames via API (no Gmail UI).` +
          (nextTok
            ? ' More drafts: call gmail_list_drafts again with the same max_results and page_token set to next_page_token.'
            : '') +
          ' When citing any draft, use its "web_url" field verbatim so the link opens in the connected account.'
      };
    } catch (e) {
      return { error: 'gmail_list_drafts failed: ' + e.message };
    }
  },

  async gmail_create_reply_draft(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };

      const mid = (args.message_id || '').trim();
      if (!mid) return { error: 'message_id is required.' };

      let bodyText = navioRepairUtf8Mojibake((args.body || '').trim());
      if (!bodyText) return { error: 'body is required.' };

      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d = await r.json();
      if (!r.ok) return { error: d.error?.message || 'Gmail API error fetching message.' };

      const threadId = d.threadId;
      const headers = d.payload?.headers || [];
      const getHdr = (name) =>
        headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const from = getHdr('From');
      const replyTo = getHdr('Reply-To');
      const subject = getHdr('Subject');
      const msgIdHdr = getHdr('Message-ID') || getHdr('Message-Id');
      const prevRefs = (getHdr('References') || '').trim();

      const toAddr = parseEmailAddressFromHeader(replyTo || from);
      if (!toAddr) return { error: 'Could not determine reply recipient from message headers.' };

      let subjOut = subject || '(no subject)';
      if (!/^re:\s/i.test(subjOut)) subjOut = 'Re: ' + subjOut;

      const refs = [prevRefs, msgIdHdr].filter(Boolean).join(' ').trim();

      const mime = gmailBuildPlainTextMime({
        toAddr,
        subject: subjOut,
        inReplyTo: msgIdHdr || '',
        references: refs,
        bodyText
      });
      const raw = gmailBase64UrlEncode(mime);

      const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: threadId ? { raw, threadId } : { raw } })
      });
      const draftData = await draftRes.json();
      if (!draftRes.ok) {
        const msg = draftData.error?.message || 'Failed to create Gmail draft.';
        if (/insufficient.*scope|scope.*insufficient|Request had insufficient/i.test(msg)) {
          return { error: navioGmailScopeErrorMessage('compose') };
        }
        return { error: msg };
      }

      return {
        success: true,
        draftId: draftData.id,
        to: toAddr,
        subject: subjOut,
        body: bodyText,
        note: `Draft saved. Include this in your reply: [[DRAFT:${Buffer.from(JSON.stringify({ draftId: draftData.id, to: toAddr, subject: subjOut, body: bodyText })).toString('base64')}]]`
      };
    } catch (e) {
      return { error: 'gmail_create_reply_draft failed: ' + e.message };
    }
  },

  async gmail_create_draft(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };

      const toAddr = (args.to || '').trim();
      if (!toAddr) return { error: 'to is required.' };

      const subjOut = (args.subject || '').trim() || '(no subject)';
      let bodyText = navioRepairUtf8Mojibake((args.body || '').trim());
      if (!bodyText) return { error: 'body is required.' };

      const cc = (args.cc || '').trim();
      const bcc = (args.bcc || '').trim();

      const mime = gmailBuildPlainTextMime({
        toAddr,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject: subjOut,
        bodyText
      });
      const raw = gmailBase64UrlEncode(mime);

      const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw } })
      });
      const draftData = await draftRes.json();
      if (!draftRes.ok) {
        const msg = draftData.error?.message || 'Failed to create Gmail draft.';
        if (/insufficient.*scope|scope.*insufficient|Request had insufficient/i.test(msg)) {
          return { error: navioGmailScopeErrorMessage('compose') };
        }
        return { error: msg };
      }

      return {
        success: true,
        draftId: draftData.id,
        to: toAddr,
        cc: cc || undefined,
        bcc: bcc || undefined,
        subject: subjOut,
        body: bodyText,
        note: `Draft saved. Include this in your reply: [[DRAFT:${Buffer.from(JSON.stringify({ draftId: draftData.id, to: toAddr, subject: subjOut, body: bodyText })).toString('base64')}]]`
      };
    } catch (e) {
      return { error: 'gmail_create_draft failed: ' + e.message };
    }
  },

  // ── Gmail thread + attachment tools ─────────────────────────────────────────

  async gmail_get_thread(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };
      const threadId = (args.thread_id || '').trim();
      if (!threadId) return { error: 'thread_id is required.' };
      const maxBodyChars = Math.min(Number(args.max_body_chars) > 0 ? Number(args.max_body_chars) : 16000, 60000);

      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d = await r.json();
      if (!r.ok) {
        const msg = d.error?.message || 'Gmail API error';
        if (/insufficient.*scope/i.test(msg)) return { error: navioGmailScopeErrorMessage('generic') };
        return { error: msg };
      }

      const messages = (d.messages || []).map((msg) => {
        const headers = msg.payload?.headers || [];
        const get = (name) => headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || '';
        let body = navioGmailExtractPlainBody(msg.payload);
        if (!body.trim()) body = navioGmailExtractHtmlPlainFallback(msg.payload);
        body = navioRepairUtf8Mojibake(body || '');
        if (body.length > maxBodyChars) body = `${body.slice(0, maxBodyChars)}\n… [truncated]`;
        const attachments = navioGmailCollectAttachmentsWithIds(msg.payload);
        return {
          id: msg.id,
          thread_id: msg.threadId,
          from: get('From'),
          to: get('To'),
          cc: get('Cc') || undefined,
          date: get('Date'),
          subject: get('Subject'),
          snippet: msg.snippet || '',
          body,
          attachments
        };
      });

      const oauthPid = gmailToolOAuthProviderId(args);
      const acctEmail = gmailConnectedAccountEmail(oauthPid);
      return {
        thread_id: threadId,
        message_count: messages.length,
        messages,
        account: acctEmail || undefined,
        note: `Loaded full thread with ${messages.length} message(s). Attachments list includes attachment_id for use with gmail_get_attachment.`
      };
    } catch (e) {
      return { error: 'gmail_get_thread failed: ' + e.message };
    }
  },

  async gmail_get_attachment(_wc, args) {
    try {
      const { token, error } = await resolveGmailToolToken(args);
      if (!token) return { error };
      const mid = (args.message_id || '').trim();
      const aid = (args.attachment_id || '').trim();
      if (!mid) return { error: 'message_id is required.' };
      if (!aid) return { error: 'attachment_id is required.' };

      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}/attachments/${encodeURIComponent(aid)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const d = await r.json();
      if (!r.ok) return { error: d.error?.message || 'Gmail API error fetching attachment.' };

      const filename = (args.filename || '').toLowerCase();
      // data is base64url-encoded
      const rawData = (d.data || '').replace(/-/g, '+').replace(/_/g, '/');
      const buf = Buffer.from(rawData, 'base64');

      // For text-based formats, decode to string
      const isText = /\.(txt|csv|json|xml|html|htm|md|log|eml|msg)$/.test(filename);
      const isPdf = /\.pdf$/.test(filename);
      const isDoc = /\.(doc|docx|odt|rtf)$/.test(filename);

      if (isText) {
        const text = buf.toString('utf-8').slice(0, 80000);
        return { filename: args.filename, content_type: 'text', text, size_bytes: buf.length };
      }

      if (isPdf) {
        // Return base64 for PDF — model can describe it; for future PDF extraction hook
        return {
          filename: args.filename,
          content_type: 'pdf',
          size_bytes: buf.length,
          base64_preview: rawData.slice(0, 2000),
          note: 'PDF binary. To read contents, open the attachment URL in the browser or use a PDF extraction tool. The raw text may be extractable via the Drive API if the file is in Drive.'
        };
      }

      if (isDoc) {
        return {
          filename: args.filename,
          content_type: 'document',
          size_bytes: buf.length,
          note: 'Binary document format. Download and open in Google Docs for text extraction.'
        };
      }

      // Spreadsheet / other
      return {
        filename: args.filename,
        content_type: 'binary',
        size_bytes: buf.length,
        note: 'Binary attachment. Use gmail_browser_takeover and navigate to Gmail to download, or if this is a spreadsheet, ask the sender to share it in Google Sheets.'
      };
    } catch (e) {
      return { error: 'gmail_get_attachment failed: ' + e.message };
    }
  },

  // ── Google Drive tools ───────────────────────────────────────────────────────

  async drive_search(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const query = (args.query || '').trim();
      if (!query) return { error: 'query is required.' };
      const maxResults = Math.min(Math.max(Number(args.max_results) > 0 ? Number(args.max_results) : 15, 1), 50);
      const fileType = (args.file_type || 'any').toLowerCase();
      const folderId = (args.folder_id || '').trim();

      const mimeMap = {
        document: 'application/vnd.google-apps.document',
        spreadsheet: 'application/vnd.google-apps.spreadsheet',
        presentation: 'application/vnd.google-apps.presentation',
        pdf: 'application/pdf',
        folder: 'application/vnd.google-apps.folder',
        image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
      };

      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const words = query.split(/\s+/).filter((w) => w.length > 0).slice(0, 8);

      let qParts = ['trashed=false'];
      if (words.length === 1) {
        const t = esc(words[0]);
        qParts.push(`(name contains '${t}' or fullText contains '${t}')`);
      } else {
        const namePart = `name contains '${esc(words[0])}'`;
        const fullParts = words.map((w) => `fullText contains '${esc(w)}'`).join(' and ');
        qParts.push(`(${namePart} or (${fullParts}))`);
      }
      if (fileType !== 'any' && mimeMap[fileType]) {
        const mt = mimeMap[fileType];
        if (Array.isArray(mt)) {
          qParts.push(`(${mt.map((m) => `mimeType='${m}'`).join(' or ')})`);
        } else {
          qParts.push(`mimeType='${mt}'`);
        }
      }
      if (folderId) {
        qParts.push(`'${esc(folderId)}' in parents`);
      }

      const qParam = qParts.join(' and ');
      const fields = 'files(id,name,mimeType,modifiedTime,size,webViewLink,parents,description)';
      const url = `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&fields=${encodeURIComponent(fields)}&orderBy=${encodeURIComponent('modifiedTime desc')}&q=${encodeURIComponent(qParam)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;

      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Google Drive API error';
        if (/insufficient.*scope/i.test(msg)) {
          return {
            error:
              'SCOPE_ERROR: Google Drive permission missing. Open **Settings → Connected Apps**, disconnect **Google**, and sign in again so Navio can request Drive read/write (and Docs) access.'
          };
        }
        return { error: msg };
      }

      const mimeLabels = {
        'application/vnd.google-apps.document': 'Google Doc',
        'application/vnd.google-apps.spreadsheet': 'Google Sheet',
        'application/vnd.google-apps.presentation': 'Google Slides',
        'application/vnd.google-apps.folder': 'Folder',
        'application/pdf': 'PDF'
      };

      const results = (data.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        type: mimeLabels[f.mimeType] || (f.mimeType || 'file').split('/').pop(),
        modified: f.modifiedTime,
        size_bytes: f.size ? Number(f.size) : undefined,
        url: driveNavioWebUrl(f),
        description: f.description || undefined
      }));

      return {
        results,
        count: results.length,
        note: `Found ${results.length} file(s) in Google Drive matching "${query}". Use drive_get_file with the id field to read file contents.`
      };
    } catch (e) {
      return { error: 'drive_search failed: ' + e.message };
    }
  },

  async drive_get_file(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const fileId = (args.file_id || '').trim();
      if (!fileId) return { error: 'file_id is required.' };
      const maxChars = Math.min(Number(args.max_chars) > 0 ? Number(args.max_chars) : 40000, 120000);

      // First, get file metadata to determine type
      const metaResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,modifiedTime,size&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const meta = await metaResp.json();
      if (!metaResp.ok) return { error: meta.error?.message || 'Drive API error fetching file metadata.' };

      const mimeType = meta.mimeType || '';
      const fileName = meta.name || fileId;
      const driveOpenUrl =
        meta.webViewLink ||
        (mimeType === 'application/vnd.google-apps.folder'
          ? `https://drive.google.com/drive/folders/${fileId}`
          : `https://drive.google.com/file/d/${fileId}/view`);

      let exportMime = null;
      if (mimeType === 'application/vnd.google-apps.document') exportMime = 'text/plain';
      else if (mimeType === 'application/vnd.google-apps.spreadsheet') exportMime = 'text/csv';
      else if (mimeType === 'application/vnd.google-apps.presentation') exportMime = 'text/plain';
      else if (mimeType.startsWith('text/')) exportMime = null; // direct download

      let text = '';
      let note = '';

      if (exportMime) {
        // Google Workspace file: export as text
        const expResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!expResp.ok) {
          const err = await expResp.text();
          return { error: `Drive export failed: ${err.slice(0, 200)}` };
        }
        text = await expResp.text();
        note = `Exported as ${exportMime}.`;
      } else if (shouldDownloadAndExtract(mimeType, fileName)) {
        const maxB = BINARY_MAX_BYTES;
        const sizeNum = meta.size != null ? Number(meta.size) : NaN;
        if (Number.isFinite(sizeNum) && sizeNum > maxB) {
          return {
            id: fileId,
            name: fileName,
            mime_type: mimeType,
            url: driveOpenUrl,
            note: `File is about ${Math.round(sizeNum / (1024 * 1024))} MB; in-app extraction is limited to ${Math.round(maxB / (1024 * 1024))} MB. Open the URL in Google Drive.`
          };
        }
        const dlResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!dlResp.ok) {
          const err = await dlResp.text().catch(() => '');
          return { error: `Drive file download failed: ${(err || String(dlResp.status)).slice(0, 240)}` };
        }
        const buf = Buffer.from(await dlResp.arrayBuffer());
        if (buf.length > maxB) {
          return {
            id: fileId,
            name: fileName,
            mime_type: mimeType,
            url: driveOpenUrl,
            note: `Downloaded file exceeds ${Math.round(maxB / (1024 * 1024))} MB — open in Google Drive instead.`
          };
        }
        const extracted = await extractDriveFileText({ buffer: buf, mimeType, fileName });
        if (!extracted.ok) {
          return {
            id: fileId,
            name: fileName,
            mime_type: mimeType,
            url: driveOpenUrl,
            note: extracted.note
          };
        }
        text = extracted.text;
        note = extracted.note;
      } else if (
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/csv' ||
        mimeType === 'application/xml' ||
        mimeType === 'text/xml' ||
        mimeType === 'application/javascript' ||
        mimeType === 'application/x-javascript'
      ) {
        // Plain text / markup / JSON: direct download
        const dlResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!dlResp.ok) return { error: 'Drive download failed.' };
        text = await dlResp.text();
        note = 'Direct text download.';
      } else {
        return {
          id: fileId,
          name: fileName,
          mime_type: mimeType,
          url: driveOpenUrl,
          note: `No in-app reader for this type (${mimeType}). Navio reads Google Docs/Sheets/Slides, PDF, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.pptx), RTF, HTML, OpenDocument, EPUB (text), ZIP (file list), and common plain-text/code uploads. Open the URL in Google Drive for anything else (e.g. images, video, legacy .ppt).`
        };
      }

      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [truncated — ${text.length - maxChars} more chars]`;

      return {
        id: fileId,
        name: fileName,
        mime_type: mimeType,
        modified: meta.modifiedTime,
        url: driveOpenUrl,
        content: text,
        chars: text.length,
        note
      };
    } catch (e) {
      return { error: 'drive_get_file failed: ' + e.message };
    }
  },

  async drive_list_folder(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const folderId = (args.folder_id || 'root').trim();
      const maxResults = Math.min(Math.max(Number(args.max_results) > 0 ? Number(args.max_results) : 30, 1), 100);
      const pageToken = (args.page_token || '').trim() || null;

      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const qParam = `'${esc(folderId)}' in parents and trashed=false`;
      const fields = 'files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken';
      const params = new URLSearchParams({
        pageSize: String(maxResults),
        fields,
        orderBy: 'folder,name',
        q: qParam,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      });
      if (pageToken) params.set('pageToken', pageToken);

      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Google Drive API error';
        return { error: msg };
      }

      const mimeLabels = {
        'application/vnd.google-apps.document': 'Google Doc',
        'application/vnd.google-apps.spreadsheet': 'Google Sheet',
        'application/vnd.google-apps.presentation': 'Google Slides',
        'application/vnd.google-apps.folder': 'Folder',
        'application/pdf': 'PDF'
      };

      const files = (data.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        type: mimeLabels[f.mimeType] || (f.mimeType || 'file').split('/').pop(),
        modified: f.modifiedTime,
        size_bytes: f.size ? Number(f.size) : undefined,
        url: driveNavioWebUrl(f)
      }));

      return {
        folder_id: folderId,
        files,
        count: files.length,
        next_page_token: data.nextPageToken || null,
        note: `Listed ${files.length} item(s) in Drive folder. Use drive_get_file with id to read file contents.${data.nextPageToken ? ' More items available — call again with page_token.' : ''}`
      };
    } catch (e) {
      return { error: 'drive_list_folder failed: ' + e.message };
    }
  },

  async drive_create_file(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const name = (args.name || '').trim();
      if (!name) return { error: 'name is required.' };
      const kind = String(args.kind || 'document').toLowerCase().trim();
      const parent = (args.parent_folder_id || 'root').trim() || 'root';
      const content = args.content != null ? String(args.content) : '';

      const mimeByKind = {
        document: 'application/vnd.google-apps.document',
        spreadsheet: 'application/vnd.google-apps.spreadsheet',
        presentation: 'application/vnd.google-apps.presentation',
        text_file: 'text/plain'
      };
      const mimeType = mimeByKind[kind];
      if (!mimeType) {
        return { error: `Invalid kind "${kind}". Use document, spreadsheet, presentation, or text_file.` };
      }

      if (kind === 'text_file') {
        const maxBytes = 4 * 1024 * 1024;
        const buf = Buffer.from(content, 'utf8');
        if (buf.length > maxBytes) return { error: `content too large (max ${maxBytes} bytes for text_file).` };
        const boundary = `navio_drive_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const meta = JSON.stringify({
          name,
          mimeType: 'text/plain',
          parents: parent === 'root' ? ['root'] : [parent]
        });
        const body =
          `--${boundary}\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${meta}\r\n` +
          `--${boundary}\r\n` +
          `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
          `${content}\r\n` +
          `--${boundary}--\r\n`;
        const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body: Buffer.from(body, 'utf8')
        });
        const data = await resp.json();
        if (!resp.ok) {
          const msg = data.error?.message || 'Drive create failed';
          if (/insufficient.*scope/i.test(msg)) {
            return {
              error:
                'SCOPE_ERROR: Google Drive write permission missing. Disconnect and reconnect **Google** in Settings so Drive read/write is granted.'
            };
          }
          return { error: msg };
        }
        return {
          id: data.id,
          name: data.name,
          mime_type: data.mimeType,
          url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
          note: 'Created a new plain-text file in Drive.'
        };
      }

      const resp = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType,
          parents: parent === 'root' ? ['root'] : [parent]
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Drive create failed';
        if (/insufficient.*scope/i.test(msg)) {
          return {
            error:
              'SCOPE_ERROR: Google Drive write permission missing. Disconnect and reconnect **Google** in Settings so Drive read/write is granted.'
          };
        }
        return { error: msg };
      }
      return {
        id: data.id,
        name: data.name,
        mime_type: data.mimeType,
        url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
        note: `Created a new empty ${String(kind).replace(/_/g, ' ')} in Drive. Use drive_update_google_doc (Docs) or open the URL to edit.`
      };
    } catch (e) {
      return { error: 'drive_create_file failed: ' + e.message };
    }
  },

  async drive_update_text_file(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const fileId = (args.file_id || '').trim();
      if (!fileId) return { error: 'file_id is required.' };
      const content = args.content != null ? String(args.content) : '';
      const mimeType = (args.mime_type || 'text/plain').trim() || 'text/plain';

      const metaResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const meta = await metaResp.json();
      if (!metaResp.ok) return { error: meta.error?.message || 'Drive metadata failed.' };
      const mt = meta.mimeType || '';
      if (
        mt === 'application/vnd.google-apps.document' ||
        mt === 'application/vnd.google-apps.spreadsheet' ||
        mt === 'application/vnd.google-apps.presentation'
      ) {
        return {
          error:
            'This file is a native Google Doc/Sheet/Slide. Use **drive_update_google_doc** for Docs, or edit Sheets/Slides in the browser — binary export/import is not applied here.'
        };
      }
      if (!mt.startsWith('text/') && mt !== 'application/json' && mt !== 'application/javascript') {
        return { error: `Refusing to overwrite mime type "${mt}" via text upload. Use a text/* or application/json file.` };
      }
      const maxBytes = 4 * 1024 * 1024;
      const buf = Buffer.from(content, 'utf8');
      if (buf.length > maxBytes) return { error: `content too large (max ${maxBytes} bytes).` };

      const resp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
          body: buf
        }
      );
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Drive media update failed';
        if (/insufficient.*scope/i.test(msg)) {
          return {
            error:
              'SCOPE_ERROR: Google Drive write permission missing. Disconnect and reconnect **Google** in Settings so Drive read/write is granted.'
          };
        }
        return { error: msg };
      }
      return {
        id: data.id,
        name: data.name,
        mime_type: data.mimeType,
        bytes_written: buf.length,
        url: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
        note: 'Replaced the file contents (media upload).'
      };
    } catch (e) {
      return { error: 'drive_update_text_file failed: ' + e.message };
    }
  },

  async drive_update_google_doc(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const fileId = (args.file_id || '').trim();
      const plainText = args.plain_text != null ? String(args.plain_text) : '';
      if (!fileId) return { error: 'file_id is required.' };

      const metaResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType,name`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const meta = await metaResp.json();
      if (!metaResp.ok) return { error: meta.error?.message || 'Drive metadata failed.' };
      if (meta.mimeType !== 'application/vnd.google-apps.document') {
        return {
          error:
            'drive_update_google_doc only supports Google Docs. For .txt / .csv / .json on Drive, use drive_update_text_file.'
        };
      }

      const docResp = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const doc = await docResp.json();
      if (!docResp.ok) {
        const em = doc.error?.message || '';
        return {
          error:
            em ||
            'Google Docs API failed. In Google Cloud Console for this OAuth client, enable **Google Docs API**, then disconnect and reconnect Google in Navio.'
        };
      }

      let endIndex = 1;
      for (const el of doc.body?.content || []) {
        if (typeof el.endIndex === 'number') endIndex = Math.max(endIndex, el.endIndex);
      }

      const requests = [];
      if (endIndex > 2) {
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: 1,
              endIndex: endIndex - 1
            }
          }
        });
      }
      requests.push({ insertText: { location: { index: 1 }, text: plainText } });

      const patchResp = await fetch(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests })
        }
      );
      const patch = await patchResp.json();
      if (!patchResp.ok) {
        const msg = patch.error?.message || 'Docs batchUpdate failed';
        if (/insufficient.*scope/i.test(msg)) {
          return {
            error:
              'SCOPE_ERROR: Google Docs edit permission missing. Disconnect and reconnect **Google** in Settings so the **Documents** scope is granted.'
          };
        }
        return { error: msg };
      }

      return {
        file_id: fileId,
        name: meta.name,
        chars_written: plainText.length,
        note: 'Replaced the Google Doc body with the supplied plain text (previous body and inline formatting were removed).'
      };
    } catch (e) {
      return { error: 'drive_update_google_doc failed: ' + e.message };
    }
  },

  async drive_trash_file(_wc, args) {
    try {
      const auth = await driveOAuthAccess(args);
      if (auth.error) return { error: auth.error };
      const { token } = auth;

      const fileId = (args.file_id || '').trim();
      if (!fileId) return { error: 'file_id is required.' };

      const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Drive trash failed';
        if (/insufficient.*scope/i.test(msg)) {
          return {
            error:
              'SCOPE_ERROR: Google Drive write permission missing. Disconnect and reconnect **Google** in Settings so Drive read/write is granted.'
          };
        }
        return { error: msg };
      }
      return {
        id: data.id,
        name: data.name,
        trashed: !!data.trashed,
        note: 'File moved to Drive trash. The user can restore it from drive.google.com/drive/trash.'
      };
    } catch (e) {
      return { error: 'drive_trash_file failed: ' + e.message };
    }
  },

  async save_local_file(wc, args) {
    const raw = args && args.content != null ? String(args.content) : '';
    if (!raw.length && raw !== '') {
      return { error: 'save_local_file requires `content` (string).' };
    }
    if (raw.length > SAVE_LOCAL_FILE_MAX_CHARS) {
      return {
        error: `Content too large for save_local_file (max ${SAVE_LOCAL_FILE_MAX_CHARS} characters). Split into smaller files or summarize first.`
      };
    }
    const hint = (args && args.format) || '';
    const fmt = hint === 'markdown' || hint === 'word_docx' || hint === 'text' ? hint : 'text';
    let defaultPath = (args && args.default_filename != null ? String(args.default_filename) : '').trim();
    if (defaultPath && !/\.(txt|md|docx)$/i.test(defaultPath)) {
      const ext = fmt === 'markdown' ? '.md' : fmt === 'word_docx' ? '.docx' : '.txt';
      defaultPath = defaultPath.replace(/[/\\]+$/g, '') + ext;
    }
    if (!defaultPath) {
      defaultPath = fmt === 'markdown' ? 'document.md' : fmt === 'word_docx' ? 'document.docx' : 'document.txt';
    }
    const parentWin = navioSaveDialogParentWindow(wc);
    let picked;
    try {
      picked = await dialog.showSaveDialog(parentWin || undefined, {
        title: 'Save file',
        defaultPath,
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Word Document', extensions: ['docx'] }
        ],
        properties: ['createDirectory', 'showOverwriteWarning']
      });
    } catch (e) {
      return { error: 'save_local_file: dialog failed: ' + e.message };
    }
    if (picked.canceled || !picked.filePath) {
      return { canceled: true, note: 'User cancelled the save dialog — nothing was written.' };
    }
    const filePath = path.normalize(picked.filePath);
    const ext = (path.extname(filePath) || '').toLowerCase();
    let useExt = ext;
    if (!useExt) {
      useExt = fmt === 'markdown' ? '.md' : fmt === 'word_docx' ? '.docx' : '.txt';
    }
    const outPath = ext ? filePath : filePath + useExt;
    if (/\.doc$/i.test(outPath) && !/\.docx$/i.test(outPath)) {
      return {
        error:
          'Legacy .doc (binary) is not supported. Choose **.docx** in the save dialog (or pass default_filename ending in .docx).'
      };
    }
    try {
      if (/\.docx$/i.test(outPath)) {
        const buf = navioPlainTextToDocxBuffer(raw);
        fs.writeFileSync(outPath, buf);
        return {
          path: outPath,
          format: 'docx',
          bytes_written: buf.length,
          note: 'Saved as Word (.docx) with plain text only (paragraphs / line breaks).'
        };
      }
      fs.writeFileSync(outPath, raw, 'utf8');
      return {
        path: outPath,
        format: /\.md$/i.test(outPath) ? 'markdown' : 'text',
        bytes_written: Buffer.byteLength(raw, 'utf8'),
        note: 'File saved on disk.'
      };
    } catch (e) {
      return { error: 'save_local_file: write failed: ' + e.message };
    }
  },

  // ── Google Calendar tools ────────────────────────────────────────────────────

  async calendar_list_events(_wc, args) {
    try {
      const token = await getValidOAuthToken('google');
      if (!token) return { error: 'Google Calendar requires Google OAuth. Connect Google in Settings → Connected Apps.' };

      const calendarId = (args.calendar_id || 'primary').trim();
      const maxResults = Math.min(Math.max(Number(args.max_results) > 0 ? Number(args.max_results) : 20, 1), 50);
      const query = (args.query || '').trim();

      const now = new Date();
      let timeMin = args.time_min ? new Date(args.time_min).toISOString() : now.toISOString();
      let timeMax = args.time_max
        ? new Date(args.time_max).toISOString()
        : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      // Validate dates
      if (isNaN(Date.parse(timeMin))) timeMin = now.toISOString();
      if (isNaN(Date.parse(timeMax))) timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const params = new URLSearchParams({
        maxResults: String(maxResults),
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin,
        timeMax
      });
      if (query) params.set('q', query);

      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Google Calendar API error';
        if (/insufficient.*scope/i.test(msg)) return { error: 'SCOPE_ERROR: Calendar read permission missing. Reconnect Google in Settings → Connected Apps.' };
        return { error: msg };
      }

      const events = (data.items || []).map((e) => {
        const start = e.start?.dateTime || e.start?.date || '';
        const end = e.end?.dateTime || e.end?.date || '';
        const attendees = (e.attendees || []).map((a) => a.email || a.displayName || '').filter(Boolean);
        const meetLink = (e.conferenceData?.entryPoints || []).find((ep) => ep.entryPointType === 'video')?.uri || '';
        return {
          id: e.id,
          title: e.summary || '(no title)',
          start,
          end,
          all_day: !e.start?.dateTime,
          location: e.location || undefined,
          description: e.description ? e.description.slice(0, 300) : undefined,
          attendees: attendees.length > 0 ? attendees : undefined,
          meet_link: meetLink || undefined,
          organizer: e.organizer?.email || undefined,
          status: e.status || undefined
        };
      });

      return {
        calendar_id: calendarId,
        time_range: { from: timeMin, to: timeMax },
        event_count: events.length,
        events,
        note: `Found ${events.length} event(s) between ${timeMin.slice(0, 10)} and ${timeMax.slice(0, 10)}.`
      };
    } catch (e) {
      return { error: 'calendar_list_events failed: ' + e.message };
    }
  },

  async calendar_create_event(_wc, args) {
    try {
      const token = await getValidOAuthToken('google');
      if (!token) return { error: 'Google Calendar requires Google OAuth. Connect Google in Settings → Connected Apps.' };

      const title = (args.title || '').trim();
      if (!title) return { error: 'title is required.' };
      const start = (args.start || '').trim();
      if (!start) return { error: 'start is required.' };
      const end = (args.end || '').trim();
      if (!end) return { error: 'end is required.' };

      const calendarId = (args.calendar_id || 'primary').trim();
      const attendeeList = (args.attendees || '').split(',').map((s) => s.trim()).filter(Boolean);

      const eventBody = {
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end },
        location: args.location || undefined,
        description: args.description || undefined,
        attendees: attendeeList.length > 0 ? attendeeList.map((email) => ({ email })) : undefined
      };

      if (args.add_meet_link) {
        eventBody.conferenceData = {
          createRequest: {
            requestId: `navio-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        };
      }

      const params = args.add_meet_link ? '?conferenceDataVersion=1' : '';
      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${params}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(eventBody)
        }
      );
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error?.message || 'Google Calendar API error';
        if (/insufficient.*scope/i.test(msg)) return { error: 'SCOPE_ERROR: Calendar write permission missing. Reconnect Google in Settings → Connected Apps.' };
        return { error: msg };
      }

      const meetLink = (data.conferenceData?.entryPoints || []).find((ep) => ep.entryPointType === 'video')?.uri || '';
      return {
        success: true,
        event_id: data.id,
        title: data.summary,
        start: data.start?.dateTime || data.start?.date,
        end: data.end?.dateTime || data.end?.date,
        url: data.htmlLink || '',
        meet_link: meetLink || undefined,
        note: `Event "${title}" created in Google Calendar.${meetLink ? ` Meet link: ${meetLink}` : ''}`
      };
    } catch (e) {
      return { error: 'calendar_create_event failed: ' + e.message };
    }
  }
};

/**
 * Agent tool loop: opening mail.google.com to “browse” Gmail is fragile (SPA, nested scroll).
 * Route Drafts to gmail_list_drafts; other labels to gmail_search. Single-message #inbox/ID is handled
 * separately by maybeLoadGmailMessageUrlViaApi.
 * If opts.allowGmailWebUi (navigate/open_tab with gmail_browser_takeover), do not intercept — real Gmail UI.
 */
async function maybeInterceptGmailBrowseNavForAgent(url, opts = {}) {
  if (opts.allowGmailWebUi) return null;
  const raw = (url || '').trim();
  if (!raw || (!raw.includes('mail.google.com') && !raw.includes('//mail.google'))) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^mail\.google\.com$/i.test(u.hostname)) return null;
  if (extractGmailMessageIdFromNavUrl(raw)) return null;

  const hashRaw = (u.hash || '').replace(/^#/, '');
  let hashLc = hashRaw.toLowerCase();
  try {
    hashLc = decodeURIComponent(hashLc);
  } catch {
    /* keep hashLc */
  }
  hashLc = hashLc.toLowerCase();

  const isDrafts =
    hashLc.startsWith('drafts') ||
    hashLc.includes('in:drafts') ||
    hashLc.includes('in%3adrafts');

  const token = await getValidOAuthToken('google');
  if (!token) {
    return {
      intercept: true,
      result: {
        error:
          'Connect Google in Navio Settings → Connected Apps. Gmail is handled via API during agent runs — no embedded Gmail browsing until you sign in.',
        navio_gmail_use_api: true
      }
    };
  }

  if (isDrafts) {
    const apiRes = await toolExecutors.gmail_list_drafts(null, { max_results: 50 });
    const extra =
      apiRes.error
        ? ''
        : ' Navio loaded Drafts via the Gmail API instead of opening the Drafts page in the browser.';
    return {
      intercept: true,
      result: {
        ...apiRes,
        note: apiRes.note ? `${apiRes.note}${extra}` : extra.trim()
      }
    };
  }

  return {
    intercept: true,
    result: {
      error:
        'Opening Gmail in the browser is skipped during agent runs. Use **gmail_search** with the right query ' +
        '(e.g. `in:inbox`, `in:sent`, `label:…`) or **gmail_list_drafts** for Drafts. ' +
        'If you created, updated, deleted, or sent a draft via API in this run, Navio will open Gmail to Drafts or Sent when the run finishes.',
      navio_gmail_use_api: true
    }
  };
}

/**
 * Internal helper: execute a browser action on a webContents without going
 * through the IPC layer.  Reuses the same JS injection patterns from the
 * browser-action handler for text=/aria= click, type, pressKey, etc.
 */
async function executeBrowserActionInternal(wc, action, params) {
  try {
    if (action === 'click' || action === 'type' || action === 'pressKey' || action === 'insertText') {
      await ensureGuestWebviewKeyboardFocus(wc);
    }
    switch (action) {
      case 'click': {
        const sel = (params.selector || '').trim();
        const selLower = sel.toLowerCase();
        if (selLower.startsWith('xy=')) {
          const parts = sel.slice(3).split(/[,;\s]+/).map(Number);
          if (Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
            wc.sendInputEvent({ type: 'mouseMove', x: parts[0], y: parts[1] });
            await new Promise((r) => setTimeout(r, 40));
            wc.sendInputEvent({ type: 'mouseDown', x: parts[0], y: parts[1], button: 'left', clickCount: 1 });
            await new Promise((r) => setTimeout(r, 60));
            wc.sendInputEvent({ type: 'mouseUp', x: parts[0], y: parts[1], button: 'left', clickCount: 1 });
            await new Promise((r) => setTimeout(r, 500));
            return { success: true };
          }
          return { error: 'Invalid xy coordinates' };
        }
        if (selLower.startsWith('ref=') || selLower.startsWith('ref_')) {
          const refId = selLower.startsWith('ref=') ? sel.slice(4).trim() : sel;
          const refResult = await clickByRef(wc, refId);
          if (refResult.success) await waitForOptionalNavigationAfterClick(wc, 2000);
          return refResult;
        }
        return navioDeepClickBySelectorCore(wc, sel);
      }

      case 'type': {
        return navioDeepTypeBySelector(wc, params.selector || '', params.text || '');
      }

      case 'pressKey': {
        const key = params.key || 'Tab';
        const keyMap = {
          'Tab': { keyCode: 'Tab', code: 'Tab', key: 'Tab' },
          'Enter': { keyCode: 'Return', code: 'Enter', key: 'Enter' },
          'Escape': { keyCode: 'Escape', code: 'Escape', key: 'Escape' },
          'Backspace': { keyCode: 'Backspace', code: 'Backspace', key: 'Backspace' },
          'ArrowDown': { keyCode: 'Down', code: 'ArrowDown', key: 'ArrowDown' },
          'ArrowUp': { keyCode: 'Up', code: 'ArrowUp', key: 'ArrowUp' },
          'ArrowLeft': { keyCode: 'Left', code: 'ArrowLeft', key: 'ArrowLeft' },
          'ArrowRight': { keyCode: 'Right', code: 'ArrowRight', key: 'ArrowRight' },
          'Space': { keyCode: 'Space', code: 'Space', key: ' ' }
        };
        const mapped = keyMap[key] || { keyCode: key, code: key, key };
        wc.sendInputEvent({ type: 'keyDown', keyCode: mapped.keyCode });
        await new Promise((r) => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp', keyCode: mapped.keyCode });
        return { success: true };
      }

      case 'insertText': {
        const text = params.text || '';
        clipboard.writeText(text);
        const pasteMods = process.platform === 'darwin' ? ['meta'] : ['control'];
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: pasteMods });
        await new Promise((r) => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: pasteMods });
        await new Promise((r) => setTimeout(r, 200));
        return { success: true };
      }

      case 'waitForText': {
        const target = params.text || '';
        if (!target) return { error: 'No text to wait for' };
        const start = Date.now();
        while (Date.now() - start < 12000) {
          try {
            const found = await wc.executeJavaScript(`
              document.body.innerText.includes(${JSON.stringify(target)})
            `);
            if (found) return { success: true, foundAfter: Date.now() - start };
          } catch { /* page navigating */ }
          await new Promise((r) => setTimeout(r, 500));
        }
        return { error: `Text "${target}" not found within 12s` };
      }

      case 'select': {
        const fieldSpec = params.fieldSpec || '';
        const optionValue = params.optionValue || '';
        const fsJson = JSON.stringify(fieldSpec);
        const ovJson = JSON.stringify(optionValue);
        const ok = await wc.executeJavaScript(`
          (() => {
            const spec = ${fsJson};
            const val = ${ovJson};
            let el = null;
            if (spec.startsWith('text=')) {
              const q = spec.slice(5).trim().toLowerCase();
              for (const s of document.querySelectorAll('select')) {
                const lbl = (s.getAttribute('aria-label') || s.getAttribute('name') || '').toLowerCase();
                if (lbl.includes(q)) { el = s; break; }
              }
            }
            if (!el) return false;
            for (const opt of el.options) {
              if (opt.value === val || opt.textContent.trim() === val) {
                opt.selected = true;
                el.dispatchEvent(new Event('change', {bubbles:true}));
                return true;
              }
            }
            return false;
          })()
        `);
        return ok ? { success: true } : { error: `Select/option not found` };
      }

      default:
        return { error: `Unknown internal action: ${action}` };
    }
  } catch (e) {
    return { error: `${action} failed: ${e.message}` };
  }
}

/** CDP fallback for Gmail when top-frame + same-origin iframe search misses (isolated iframes). */
async function tryGmailClickViaDebugger(wc, selectorRaw) {
  const rawJson = JSON.stringify(selectorRaw || '');
  const expression = `
    (function() {
      const raw = ${rawJson};
      function findElInDoc(doc) {
        if (!raw || !doc) return null;
        if (raw.startsWith('text=')) {
          const q = raw.slice(5).trim().toLowerCase();
          const candidates = doc.querySelectorAll(
            'a,button,[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
          );
          for (const el of candidates) {
            const lbl = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().toLowerCase();
            if (lbl.includes(q)) return el;
          }
        }
        if (raw.startsWith('aria=')) {
          const q = raw.slice(5).trim().toLowerCase();
          for (const el of doc.querySelectorAll('[aria-label]')) {
            if ((el.getAttribute('aria-label') || '').toLowerCase().includes(q)) return el;
          }
        }
        try { return doc.querySelector(raw); } catch (e) { return null; }
      }
      const el = findElInDoc(document);
      if (!el) return { ok: false };
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      el.click();
      const r = el.getBoundingClientRect();
      let cx = r.left + r.width / 2;
      let cy = r.top + r.height / 2;
      let w = el.ownerDocument.defaultView;
      while (w && w !== w.top) {
        const fe = w.frameElement;
        if (!fe) break;
        const fr = fe.getBoundingClientRect();
        cx += fr.left;
        cy += fr.top;
        w = fe.ownerDocument.defaultView;
      }
      return { ok: true, cx: Math.round(cx), cy: Math.round(cy) };
    })()
  `;
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    await wc.debugger.sendCommand('Page.enable');
    const { frameTree } = await wc.debugger.sendCommand('Page.getFrameTree');
    const frames = [];
    const walk = (n) => {
      if (n.frame) frames.push(n.frame);
      (n.childFrames || []).forEach(walk);
    };
    walk(frameTree);
    for (const frame of frames) {
      if (!frame.id) continue;
      let ctxId;
      try {
        const iso = await wc.debugger.sendCommand('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: 'navio_cdp_click',
          grantUniverseAccess: false
        });
        ctxId = iso.executionContextId;
      } catch (e) {
        continue;
      }
      try {
        const ev = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression,
          contextId: ctxId,
          awaitPromise: true,
          returnByValue: true
        });
        const val = ev.result?.value;
        if (val && val.ok) return val;
      } catch (e) {
        /* next frame */
      }
    }
    return { ok: false, error: 'Element not found (CDP frame scan)' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (attachedHere) {
      try {
        wc.debugger.detach();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

/**
 * Deep click (iframes + shadow DOM) — shared by browser-action IPC and agent toolExecutors.
 */
async function navioDeepClickBySelectorCore(wc, selector) {
  const cSel = JSON.stringify(selector || '');
  let res = await wc.executeJavaScript(`
    new Promise((resolve) => {
      const raw = ${cSel};

      function findElInDoc(doc, sel) {
        if (!sel || !doc) return null;
        if (sel.startsWith('text=')) {
          const q = sel.slice(5).trim().toLowerCase();
          const candidates = doc.querySelectorAll(
            'a,button,input[type="submit"],input[type="button"],' +
            '[role="button"],[role="link"],[role="menuitem"],[role="tab"],' +
            '[role="option"],[role="radio"],[role="checkbox"],' +
            'div[class*="button"],span[class*="button"],div[class*="btn"],span[class*="btn"],' +
            'li[class*="item"],div[class*="item"],div[class*="option"],span[role="link"]'
          );
          for (const el of candidates) {
            const lbl = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().toLowerCase();
            if (lbl.includes(q)) return el;
          }
          for (const host of doc.querySelectorAll('*')) {
            if (!host.shadowRoot) continue;
            const shadowCandidates = host.shadowRoot.querySelectorAll(
              'a,button,[role="button"],[role="menuitem"],[role="link"]'
            );
            for (const el of shadowCandidates) {
              const lbl = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().toLowerCase();
              if (lbl.includes(q)) return el;
            }
          }
          return null;
        }
        if (sel.startsWith('aria=')) {
          const q = sel.slice(5).trim().toLowerCase();
          for (const el of doc.querySelectorAll('[aria-label]')) {
            if ((el.getAttribute('aria-label') || '').toLowerCase().includes(q)) return el;
          }
          return null;
        }
        try { return doc.querySelector(sel); } catch (e) { return null; }
      }

      function absCenter(el) {
        const r = el.getBoundingClientRect();
        let cx = r.left + r.width / 2;
        let cy = r.top + r.height / 2;
        let w = el.ownerDocument.defaultView;
        while (w && w !== w.top) {
          const fe = w.frameElement;
          if (!fe) break;
          const fr = fe.getBoundingClientRect();
          cx += fr.left;
          cy += fr.top;
          w = fe.ownerDocument.defaultView;
        }
        return { cx: Math.round(cx), cy: Math.round(cy) };
      }

      function fireFullClick(el) {
        const VW = el.ownerDocument.defaultView;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        const rect = el.getBoundingClientRect();
        const base = {
          bubbles: true, cancelable: true, view: VW,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          screenX: 0,
          screenY: 0,
          buttons: 1,
          button: 0
        };
        const ptr = { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
        el.dispatchEvent(new VW.PointerEvent('pointerover', { ...ptr }));
        el.dispatchEvent(new VW.PointerEvent('pointerenter', { ...ptr, bubbles: false }));
        el.dispatchEvent(new VW.MouseEvent('mouseover', base));
        el.dispatchEvent(new VW.MouseEvent('mouseenter', { ...base, bubbles: false }));
        el.dispatchEvent(new VW.PointerEvent('pointermove', { ...ptr }));
        el.dispatchEvent(new VW.MouseEvent('mousemove', base));
        el.dispatchEvent(new VW.PointerEvent('pointerdown', { ...ptr }));
        el.dispatchEvent(new VW.MouseEvent('mousedown', base));
        el.dispatchEvent(new VW.PointerEvent('pointerup', { ...ptr }));
        el.dispatchEvent(new VW.MouseEvent('mouseup', base));
        el.dispatchEvent(new VW.MouseEvent('click', base));
        el.click();
      }

      function searchDeep(win, depth) {
        if (!win || depth > 14) return null;
        const doc = win.document;
        const el = findElInDoc(doc, raw);
        if (el) return el;
        const iframes = doc.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
          try {
            const iw = iframes[i].contentWindow;
            if (!iw || !iw.document) continue;
            const hit = searchDeep(iw, depth + 1);
            if (hit) return hit;
          } catch (e) { /* cross-origin */ }
        }
        return null;
      }

      let tries = 0;
      const attempt = () => {
        const el = searchDeep(window, 0);
        if (el) {
          fireFullClick(el);
          const { cx, cy } = absCenter(el);
          resolve({ ok: true, cx, cy });
        } else if (++tries < 14) {
          setTimeout(attempt, 250);
        } else {
          resolve({ ok: false, error: 'Element not found: ' + raw });
        }
      };
      attempt();
    })
  `);

  if (!res.ok && /mail\\.google\\.com/.test(wc.getURL?.() || '')) {
    res = await tryGmailClickViaDebugger(wc, selector || '');
  }
  if (!res.ok) return { error: res.error };

  if (res.cx != null && res.cy != null) {
    const { cx, cy } = res;
    wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
    await new Promise((r) => setTimeout(r, 40));
    wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 60));
    wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
  }

  await waitForOptionalNavigationAfterClick(wc, 2000);
  return { success: true };
}

/**
 * Deep type into inputs / contenteditable (iframes) — shared by IPC and agent tools.
 * Resolves labels from input.labels, label[for], and aria-labelledby (MUI/React freight forms).
 * Skips invisible/hidden fields; supports occurrence for duplicate labels (e.g. two "Postal code").
 */
async function navioDeepTypeBySelector(wc, selector, text, occurrence) {
  const tSel = JSON.stringify(selector || '');
  const tVal = JSON.stringify(text || '');
  let occ = parseInt(occurrence, 10);
  if (!Number.isFinite(occ) || occ < 1) occ = 1;
  occ = Math.min(occ, 20);
  const tOcc = occ;
  const tRes = await wc.executeJavaScript(`
    new Promise((resolve) => {
      const raw = ${tSel};
      const text = ${tVal};
      const wantOcc = ${tOcc};

      function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = el.ownerDocument.defaultView.getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) return false;
        return true;
      }

      function getFieldLabelText(el) {
        if (!el) return '';
        const parts = [];
        const push = (s) => {
          if (s == null) return;
          const t = String(s).replace(/\\s+/g, ' ').trim();
          if (t) parts.push(t);
        };
        push(el.getAttribute('aria-label'));
        push(el.getAttribute('placeholder'));
        push(el.getAttribute('name'));
        push(el.getAttribute('title'));
        if (el.id && typeof CSS !== 'undefined' && CSS.escape) {
          try {
            const esc = CSS.escape(el.id);
            const lab = el.ownerDocument.querySelector('label[for=\"' + esc + '\"]');
            if (lab) push(lab.textContent);
          } catch (e) {}
        }
        try {
          if (el.labels && el.labels.length) {
            for (let i = 0; i < el.labels.length; i++) {
              push(el.labels[i].textContent);
            }
          }
        } catch (e) {}
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const root = el.ownerDocument;
          for (const id of labelledBy.split(/\\s+/)) {
            if (!id) continue;
            const node = root.getElementById(id);
            if (node) push(node.textContent);
          }
        }
        return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      }

      function scoreMatch(full, q) {
        if (!full || !q) return 0;
        if (full === q) return 100;
        if (full.startsWith(q + ' ') || full.startsWith(q + ':')) return 85;
        if (full.startsWith(q)) return 80;
        const words = full.split(/\\s+/);
        for (let i = 0; i < words.length; i++) {
          if (words[i] === q) return 75;
        }
        if (q.length < 5) {
          return 0;
        }
        if (full.includes(q)) return 50;
        return 0;
      }

      function collectMatchesInDoc(doc, sel) {
        if (!sel || !doc) return [];
        const out = [];
        if (sel.startsWith('text=') || sel.startsWith('aria=')) {
          const prefix = sel.startsWith('text=') ? 'text=' : 'aria=';
          const q = sel.slice(prefix.length).trim().toLowerCase();
          if (!q) return [];
          let idx = 0;
          for (const el of doc.querySelectorAll('input,textarea,select,[contenteditable="true"]')) {
            if (!isVisible(el)) continue;
            const tag = el.tagName;
            if (tag === 'INPUT') {
              const t = (el.type || '').toLowerCase();
              if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') continue;
            }
            let full = '';
            if (sel.startsWith('aria=')) {
              full = (el.getAttribute('aria-label') || '').trim().toLowerCase();
            } else {
              full = getFieldLabelText(el);
            }
            const sc = scoreMatch(full, q);
            if (sc > 0) {
              out.push({ el, sc, idx: idx++ });
            }
          }
          out.sort((a, b) => {
            if (b.sc !== a.sc) return b.sc - a.sc;
            return a.idx - b.idx;
          });
          return out.map((x) => x.el);
        }
        try {
          const one = doc.querySelector(sel);
          return one ? [one] : [];
        } catch (e) {
          return [];
        }
      }

      function findElInDoc(doc, sel) {
        const arr = collectMatchesInDoc(doc, sel);
        if (!arr.length) return null;
        const i = wantOcc - 1;
        if (i >= arr.length) return null;
        return arr[i];
      }

      function searchTypeDeep(win, depth) {
        if (!win || depth > 14) return null;
        const doc = win.document;
        let el = findElInDoc(doc, raw);
        if (el) return el;
        for (const iframe of doc.querySelectorAll('iframe')) {
          try {
            const iw = iframe.contentWindow;
            if (!iw || !iw.document) continue;
            const hit = searchTypeDeep(iw, depth + 1);
            if (hit) return hit;
          } catch (e) { /* cross-origin */ }
        }
        return null;
      }
      let tries = 0;
      const attempt = () => {
        const el = searchTypeDeep(window, 0);
        if (el) {
          el.focus();
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const tag = el.tagName;
          const isCE = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
          if (isCE) {
            el.focus();
            const doc = el.ownerDocument;
            if (doc.execCommand) {
              let host = '';
              try {
                host = (doc.location && doc.location.hostname) || '';
              } catch (e) {
                host = '';
              }
              const gmailHost = host === 'mail.google.com' || host === 'inbox.google.com';
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              const gEditable = el.getAttribute('g_editable') === 'true';
              const gmailCompose = gmailHost && (gEditable || aria.indexOf('message body') !== -1);
              if (gmailCompose) {
                const quote = el.querySelector('.gmail_quote');
                const sig = el.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]');
                const boundary =
                  quote && el.contains(quote) ? quote : sig && el.contains(sig) ? sig : null;
                const range = doc.createRange();
                const win = doc.defaultView;
                range.setStart(el, 0);
                if (boundary) {
                  range.setEndBefore(boundary);
                } else {
                  range.selectNodeContents(el);
                }
                const sel = win.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                doc.execCommand('insertText', false, text);
              } else {
                doc.execCommand('selectAll', false, null);
                doc.execCommand('insertText', false, text);
              }
            } else {
              el.textContent = text;
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
          } else {
            const proto = tag === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, text); else el.value = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          resolve({ ok: true });
        } else if (++tries < 14) {
          setTimeout(attempt, 250);
        } else {
          const hint = wantOcc > 1 ? ' (try type_text occurrence=' + wantOcc + ' or a ref from read_page)' : '';
          resolve({ ok: false, error: 'Element not found: ' + raw + hint });
        }
      };
      attempt();
    })
  `);
  if (!tRes.ok) {
    const currentUrl = wc.getURL?.() || '';
    const isGoogleEditor = /docs\.google\.com|sheets\.google\.com|slides\.google\.com/.test(currentUrl);
    if (isGoogleEditor) {
      clipboard.writeText(text || '');
      await new Promise((r) => setTimeout(r, 200));
      const pasteMods = process.platform === 'darwin' ? ['meta'] : ['control'];
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: pasteMods });
      await new Promise((r) => setTimeout(r, 50));
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: pasteMods });
      return { success: true };
    }
    return { error: tRes.error };
  }
  return { success: true };
}

ipcMain.handle('browser-action', async (event, { webContentsId, action, params, userConfirmed }) => {
  try {
    if (RISKY_BROWSER_ACTIONS.has(action) && !userConfirmed) {
      return { error: 'This action requires user confirmation in the UI.' };
    }
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'WebContents not found' };

    // ── Email write-action hard block ────────────────────────────────────────
    // Prevent the AI from composing, sending, replying to, or modifying emails
    // regardless of user-confirmed or auto-execute mode. The AI can only read
    // emails via the connector API (read-only tokens).
    if (isEmailProtectedUrl(wc.getURL?.() || '') && isEmailWriteAction(action, params)) {
      return {
        error: 'Blocked: the AI cannot compose, send, or reply to emails. ' +
               'Email connectors are read-only — use them to search and read your inbox.'
      };
    }

    if (store) {
      store.appendLedger({
        type: 'browser_action',
        action,
        userConfirmed: !!userConfirmed,
        url: wc.getURL?.() || ''
      });
    }

    switch (action) {
      case 'navigate': {
        // Wait for the page to fully load, not just navigation start.
        // did-finish-load fires once the HTML + resources are done; we add a
        // short extra wait so JS-rendered UIs (React, etc.) have time to paint.
        await new Promise((resolve, reject) => {
          const MAX_WAIT = 12000;
          let settled = false;
          const settle = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wc.removeListener('did-finish-load', onLoad);
            wc.removeListener('did-fail-load', onFail);
            if (err) reject(err); else resolve();
          };
          const timer = setTimeout(() => settle(), MAX_WAIT);
          const onLoad = () => setTimeout(() => settle(), 800);
          const onFail = (_, code, desc) => {
            if (code === -3) setTimeout(() => settle(), 800); // redirect — still ok
            else settle(new Error(`Navigation failed: ${desc} (${code})`));
          };
          wc.once('did-finish-load', onLoad);
          wc.once('did-fail-load', onFail);
          wc.loadURL(params.url).catch((e) => {
            if (e.message?.includes('ERR_ABORTED') || e.message?.includes('-3')) {
              // redirect in-flight — did-finish-load / did-fail-load will settle us
            } else {
              settle(e);
            }
          });
        });
        const finalUrl = wc.getURL?.() || '';
        const pageTitle = (await wc.executeJavaScript('document.title').catch(() => '')).toLowerCase();
        const authGate =
          AUTH_GATE_URL_RE.test(finalUrl) ||
          /\bsign.?in\b|log.?in\b|authenticate\b/i.test(pageTitle);
        return { success: true, authGate, url: finalUrl };
      }

      case 'wait': {
        const ms = Math.min(10000, Math.max(0, parseInt(params?.ms ?? params?.delay ?? '500', 10) || 500));
        await new Promise((r) => setTimeout(r, ms));
        return { success: true };
      }

      case 'waitForText': {
        const needle = (params?.text || params?.substring || '').trim();
        if (!needle) return { error: 'waitForText: missing text to wait for' };
        const needleJson = JSON.stringify(needle);
        const found = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const q = ${needleJson}.toLowerCase();
            function collect(win, depth) {
              if (!win || depth > 14) return '';
              let t = '';
              try {
                t += (win.document.body && win.document.body.innerText) || '';
              } catch (e) {}
              try {
                for (const iframe of win.document.querySelectorAll('iframe')) {
                  try {
                    if (iframe.contentWindow) t += '\\n' + collect(iframe.contentWindow, depth + 1);
                  } catch (e) {}
                }
              } catch (e) {}
              return t;
            }
            let tries = 0;
            const maxTries = 48;
            const tick = () => {
              const blob = collect(window, 0).toLowerCase();
              if (blob.includes(q)) {
                resolve({ ok: true });
              } else if (++tries >= maxTries) {
                resolve({ ok: false, error: 'waitForText: timeout waiting for: ' + ${needleJson} });
              } else {
                setTimeout(tick, 250);
              }
            };
            tick();
          })
        `);
        if (!found.ok) return { error: found.error };
        return { success: true };
      }

      case 'click': {
        const selRaw = (params.selector || '').trim();
        if (selRaw.toLowerCase().startsWith('xy=')) {
          const rest = selRaw.slice(3).trim();
          const parts = rest.split(/[,;\s]+/).filter(Boolean).map((x) => parseFloat(x));
          const cx = parts[0];
          const cy = parts[1];
          if (Number.isFinite(cx) && Number.isFinite(cy)) {
            wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
            await new Promise((r) => setTimeout(r, 40));
            wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
            await new Promise((r) => setTimeout(r, 60));
            wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
            await waitForOptionalNavigationAfterClick(wc, 2000);
            return { success: true };
          }
          return { error: 'Invalid xy= coordinates — use e.g. click:xy=400,520' };
        }

        // ref= click via CDP accessibility tree ref_id
        if (selRaw.toLowerCase().startsWith('ref=') || selRaw.toLowerCase().startsWith('ref_')) {
          const refId = selRaw.startsWith('ref=') ? selRaw.slice(4).trim() : selRaw.trim();
          const refResult = await clickByRef(wc, refId);
          if (refResult.success) {
            await waitForOptionalNavigationAfterClick(wc, 2000);
          }
          return refResult;
        }

        return navioDeepClickBySelectorCore(wc, params.selector || '');
      }

      case 'select': {
        const spec = (params.selector || params.field || '').trim();
        const optNeedle = (params.option || params.value || '').trim();
        if (!spec || !optNeedle) {
          return { error: 'select: use field selector and option (e.g. text=Country|United States)' };
        }
        const sSpec = JSON.stringify(spec);
        const sOpt = JSON.stringify(optNeedle);
        const sRes = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const fieldSpec = ${sSpec};
            const want = ${sOpt}.toLowerCase().trim();
            function findSelectInDoc(doc, sel) {
              if (!sel || !doc) return null;
              if (sel.startsWith('text=') || sel.startsWith('aria=')) {
                const prefix = sel.startsWith('text=') ? 'text=' : 'aria=';
                const q = sel.slice(prefix.length).trim().toLowerCase();
                for (const el of doc.querySelectorAll('select')) {
                  const id = (el.id || '').toLowerCase();
                  const name = (el.getAttribute('name') || '').toLowerCase();
                  const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
                  if (lbl.includes(q) || name.includes(q) || id.includes(q)) return el;
                }
                return null;
              }
              try { return doc.querySelector(sel); } catch (e) { return null; }
            }
            function searchSelectDeep(win, depth) {
              if (!win || depth > 14) return null;
              const doc = win.document;
              const el = findSelectInDoc(doc, fieldSpec);
              if (el && el.tagName === 'SELECT') return el;
              for (const iframe of doc.querySelectorAll('iframe')) {
                try {
                  const iw = iframe.contentWindow;
                  if (!iw || !iw.document) continue;
                  const hit = searchSelectDeep(iw, depth + 1);
                  if (hit) return hit;
                } catch (e) {}
              }
              return null;
            }
            let tries = 0;
            const attempt = () => {
              const selEl = searchSelectDeep(window, 0);
              if (!selEl) {
                if (++tries < 14) {
                  setTimeout(attempt, 250);
                  return;
                }
                resolve({ ok: false, error: 'select: <select> not found for ' + fieldSpec });
                return;
              }
              const opts = Array.from(selEl.options || []);
              let hit = opts.find((o) => (o.value || '').toLowerCase() === want);
              if (!hit) hit = opts.find((o) => (o.text || '').toLowerCase().trim().includes(want));
              if (!hit) {
                if (++tries < 14) {
                  setTimeout(attempt, 250);
                  return;
                }
                resolve({ ok: false, error: 'select: option not found: ' + want });
                return;
              }
              selEl.value = hit.value;
              selEl.dispatchEvent(new Event('input', { bubbles: true }));
              selEl.dispatchEvent(new Event('change', { bubbles: true }));
              resolve({ ok: true });
            };
            attempt();
          })
        `);
        if (!sRes.ok) return { error: sRes.error };
        return { success: true };
      }

      case 'appendText': {
        const aText = params?.text || '';
        const useFocus = !params?.selector || String(params.selector).trim() === '';
        const aSel = JSON.stringify(useFocus ? '' : String(params.selector).trim());
        const aVal = JSON.stringify(aText);
        const aRes = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const raw = ${aSel};
            const append = ${aVal};
            const useActive = !raw;
            function findElInDoc(doc, sel) {
              if (!sel || !doc) return null;
              if (sel.startsWith('text=') || sel.startsWith('aria=')) {
                const prefix = sel.startsWith('text=') ? 'text=' : 'aria=';
                const q = sel.slice(prefix.length).trim().toLowerCase();
                for (const el of doc.querySelectorAll('input,textarea,[contenteditable]')) {
                  const lbl = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').toLowerCase();
                  if (lbl.includes(q)) return el;
                }
                return null;
              }
              try { return doc.querySelector(sel); } catch (e) { return null; }
            }
            function searchDeep(win, depth) {
              if (!win || depth > 14) return null;
              const doc = win.document;
              const el = findElInDoc(doc, raw);
              if (el) return el;
              for (const iframe of doc.querySelectorAll('iframe')) {
                try {
                  const iw = iframe.contentWindow;
                  if (!iw || !iw.document) continue;
                  const hit = searchDeep(iw, depth + 1);
                  if (hit) return hit;
                } catch (e) {}
              }
              return null;
            }
            let tries = 0;
            const attempt = () => {
              let el = null;
              if (useActive) {
                const ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) el = ae;
              } else {
                el = searchDeep(window, 0);
              }
              if (el) {
                el.focus();
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                const isCE = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
                if (isCE) {
                  const doc = el.ownerDocument;
                  const cur = (el.innerText || el.textContent || '').trimEnd();
                  if (doc.execCommand) {
                    el.focus();
                    const range = doc.createRange();
                    range.selectNodeContents(el);
                    range.collapse(false);
                    const sel = doc.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    doc.execCommand('insertText', false, append);
                  } else {
                    el.textContent = cur + append;
                  }
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: append }));
                } else {
                  const tag = el.tagName;
                  const proto = tag === 'TEXTAREA'
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  const next = (el.value || '') + append;
                  if (setter) setter.call(el, next); else el.value = next;
                  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: append }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                resolve({ ok: true });
              } else if (++tries < 14) {
                setTimeout(attempt, 250);
              } else {
                resolve({ ok: false, error: 'appendText: element not found: ' + raw });
              }
            };
            attempt();
          })
        `);
        if (!aRes.ok) return { error: aRes.error };
        return { success: true };
      }

      case 'type': {
        return navioDeepTypeBySelector(wc, params.selector || '', params.text || '', params.occurrence);
      }

      case 'scroll': {
        const scrollDir = params.direction === 'up' ? -1 : 1;
        const scrollAmt = 650;
        await wc.executeJavaScript(`
          (function() {
            const dir = ${scrollDir};
            const amt = ${scrollAmt};

            // Strategy 1: scroll the window
            const beforeY = window.scrollY;
            window.scrollBy(0, dir * amt);
            if (Math.abs(window.scrollY - beforeY) > 2) return; // window moved — done

            // Strategy 2: walk up from the focused element looking for a scrollable ancestor
            function canScroll(el) {
              if (!el || el === document.documentElement) return false;
              const s = window.getComputedStyle(el);
              return /auto|scroll/.test(s.overflow + s.overflowY) && el.scrollHeight > el.clientHeight + 4;
            }
            let el = document.activeElement;
            while (el && el !== document.body && el !== document.documentElement) {
              if (canScroll(el)) { el.scrollBy(0, dir * amt); return; }
              el = el.parentElement;
            }

            // Strategy 3: largest scrollable element on the page
            let best = null, bestArea = 0;
            for (const node of document.querySelectorAll('*')) {
              if (!canScroll(node)) continue;
              const area = node.scrollHeight * node.offsetWidth;
              if (area > bestArea) { best = node; bestArea = area; }
            }
            if (best) best.scrollBy(0, dir * amt);
          })()
        `);
        return { success: true };
      }

      case 'goBack':
        wc.goBack();
        return { success: true };

      case 'goForward':
        wc.goForward();
        return { success: true };

      // insertText — writes text to system clipboard and pastes via Ctrl+V.
      // This is the ONLY reliable way to inject text into Google Docs/Sheets
      // because their canvas editor requires a real paste event, not a DOM
      // value setter or insertText() call.
      case 'insertText': {
        const textToInsert = params?.text || '';
        // On Google Docs the model often clicks a document-tab sidebar item (e.g.
        // "Tab 1") instead of the editor canvas, so the canvas loses focus before
        // we paste.  Always click .kix-appview-editor first to guarantee focus.
        const insertUrl = wc.getURL?.() || '';
        const isGoogleDocInsert = /docs\.google\.com\/document/.test(insertUrl);
        const isGmailInsert = /mail\.google\.com/.test(insertUrl);
        if (isGoogleDocInsert) {
          await wc.executeJavaScript(`
            (function() {
              const editor = document.querySelector('.kix-appview-editor');
              if (editor) { editor.click(); }
            })()
          `).catch(() => {});
          await new Promise(r => setTimeout(r, 200));
        }
        if (isGmailInsert) {
          await wc.executeJavaScript(`
            (function() {
              function focusComposeBody(win, depth) {
                if (!win || depth > 14) return false;
                const doc = win.document;
                const cand = doc.querySelector(
                  '[contenteditable="true"][g_editable="true"], ' +
                  'div[aria-label="Message Body"][contenteditable="true"], ' +
                  '[contenteditable="true"].Am.Al.editable, ' +
                  'div[contenteditable="true"][role="textbox"]'
                );
                if (cand) { cand.focus(); cand.click(); return true; }
                for (const iframe of doc.querySelectorAll('iframe')) {
                  try {
                    if (iframe.contentWindow && focusComposeBody(iframe.contentWindow, depth + 1)) return true;
                  } catch (e) {}
                }
                return false;
              }
              focusComposeBody(window, 0);
            })()
          `).catch(() => {});
          await new Promise(r => setTimeout(r, 220));
        }
        // 1. Write to clipboard — use HTML for Google Docs so formatting is preserved
        //    (headings, bold, bullets from markdown are rendered as real Doc styles).
        //    For all other pages fall back to plain text.
        if (isGoogleDocInsert) {
          const htmlBody = markdownToHtml(textToInsert);
          clipboard.write({
            text: textToInsert,
            html: `<html><body>${htmlBody}</body></html>`
          });
        } else {
          clipboard.writeText(textToInsert);
        }
        // 2. Give the page a moment to process any pending focus state
        await new Promise(r => setTimeout(r, 200));
        // 3. Paste — use Cmd+V on macOS (matches Google Docs fallback elsewhere).
        const pasteMods = process.platform === 'darwin' ? ['meta'] : ['control'];
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: pasteMods });
        await new Promise(r => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: pasteMods });
        return { success: true };
      }

      case 'pressKey': {
        // OS-level keys for common navigation; JS KeyboardEvent as fallback for others.
        const key = params?.key || 'Escape';
        const NATIVE_KEYS = new Set(['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']);
        const ELECTRON_KEYCODE = {
          Tab: 'Tab',
          Enter: 'Return',
          Escape: 'Escape',
          ArrowDown: 'Down',
          ArrowUp: 'Up',
          ArrowLeft: 'Left',
          ArrowRight: 'Right'
        };
        if (NATIVE_KEYS.has(key)) {
          const kc = ELECTRON_KEYCODE[key];
          wc.sendInputEvent({ type: 'keyDown', keyCode: kc });
          await new Promise((r) => setTimeout(r, 30));
          wc.sendInputEvent({ type: 'keyUp', keyCode: kc });
        }
        const KEY_MAP = {
          Tab: { code: 'Tab', keyCode: 9 },
          Enter: { code: 'Enter', keyCode: 13 },
          Escape: { code: 'Escape', keyCode: 27 },
          ArrowDown: { code: 'ArrowDown', keyCode: 40 },
          ArrowUp: { code: 'ArrowUp', keyCode: 38 },
          ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
          ArrowRight: { code: 'ArrowRight', keyCode: 39 }
        };
        const km = KEY_MAP[key] || { code: key, keyCode: 0 };
        await wc.executeJavaScript(`
          (function() {
            const target = document.activeElement || document.body;
            ['keydown', 'keypress', 'keyup'].forEach(type => {
              target.dispatchEvent(new KeyboardEvent(type, {
                key: ${JSON.stringify(key)},
                code: ${JSON.stringify(km.code)},
                keyCode: ${km.keyCode},
                which: ${km.keyCode},
                bubbles: true,
                cancelable: true
              }));
            });
          })()
        `);
        return { success: true };
      }

      case 'screenshot': {
        const image = await wc.capturePage();
        return { success: true, screenshot: image.toDataURL() };
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('context-graph', (event, payload) => {
  if (!store) return { error: 'Store not ready' };
  const g = store.loadGraph();
  const op = payload?.op;
  if (op === 'get') {
    return { graph: g };
  }
  if (op === 'pinTab') {
    const id = payload.tabId;
    if (id && !g.pinnedTabIds.includes(id)) g.pinnedTabIds.push(id);
    store.saveGraph(g);
    return { graph: g };
  }
  if (op === 'unpinTab') {
    g.pinnedTabIds = (g.pinnedTabIds || []).filter((x) => x !== payload.tabId);
    store.saveGraph(g);
    return { graph: g };
  }
  if (op === 'addTurn') {
    g.turns = g.turns || [];
    g.turns.push({
      id: `turn-${Date.now()}`,
      at: Date.now(),
      role: payload.role,
      summary: (payload.summary || '').slice(0, 500),
      tabId: payload.tabId || null,
      url: payload.url || ''
    });
    if (g.turns.length > 200) g.turns = g.turns.slice(-200);
    store.saveGraph(g);
    return { graph: g };
  }
  if (op === 'addGraphNote') {
    g.notes = g.notes || [];
    g.notes.push({
      id: `n-${Date.now()}`,
      text: payload.text || '',
      tabId: payload.tabId || null,
      at: Date.now()
    });
    store.saveGraph(g);
    return { graph: g };
  }
  return { error: 'Unknown op' };
});

ipcMain.handle('assistant-chat-load', () => {
  if (!store) return { version: 3, byKey: {}, sidebarSessionOrder: [] };
  try {
    return store.loadAssistantChat();
  } catch (e) {
    console.error('[navio] assistant-chat-load', e.message);
    return { version: 3, byKey: {}, sidebarSessionOrder: [] };
  }
});

ipcMain.handle('assistant-chat-save', (_, payload) => {
  if (!store) return { ok: false };
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    return { ok: store.saveAssistantChat(p) };
  } catch (e) {
    console.error('[navio] assistant-chat-save', e.message);
    return { ok: false };
  }
});

ipcMain.handle('workspace', (event, payload) => {
  if (!store) return { error: 'Store not ready' };
  const w = store.loadWorkspace();
  const op = payload?.op;
  if (op === 'get') return { workspace: w };
  if (op === 'save') {
    const next = { ...w, ...payload.workspace, version: 1 };
    store.saveWorkspace(next);
    return { workspace: next };
  }
  if (op === 'addProject') {
    w.projects = w.projects || [];
    w.projects.push({
      id: `p-${Date.now()}`,
      name: payload.name || 'Untitled',
      tabIds: payload.tabIds || []
    });
    store.saveWorkspace(w);
    return { workspace: w };
  }
  if (op === 'addTask') {
    w.tasks = w.tasks || [];
    w.tasks.push({
      id: `t-${Date.now()}`,
      title: payload.title || '',
      done: false,
      projectId: payload.projectId || null,
      sourceUrl: payload.sourceUrl || ''
    });
    store.saveWorkspace(w);
    return { workspace: w };
  }
  if (op === 'toggleTask') {
    const t = (w.tasks || []).find((x) => x.id === payload.taskId);
    if (t) t.done = !t.done;
    store.saveWorkspace(w);
    return { workspace: w };
  }
  if (op === 'addWorkspaceNote') {
    w.notes = w.notes || [];
    w.notes.push({
      id: `wn-${Date.now()}`,
      body: payload.body || '',
      tabUrl: payload.tabUrl || '',
      at: Date.now()
    });
    store.saveWorkspace(w);
    return { workspace: w };
  }
  return { error: 'Unknown op' };
});

// MCP config handled by navio-mcp.js — registered in app.whenReady()

ipcMain.handle('proactive-tick', (event, payload) => {
  const cfg = loadConfig();
  if (cfg.aiProactivity === 'off' || !cfg.hasApiKey) {
    return { suggestion: null };
  }
  const now = Date.now();
  const last = cfg.lastProactiveSuggestionAt || 0;
  const minGap = cfg.aiProactivity === 'active' ? 120000 : 600000;
  if (now - last < minGap) return { suggestion: null };
  saveConfig({ lastProactiveSuggestionAt: now });
  return { suggestion: { fire: true, id: `sug-${now}` } };
});

ipcMain.handle('live-connector-data', (event, payload) => {
  const dataPath = path.join(app.getPath('userData'), 'live-connector-data.json');
  try {
    if (payload?.op === 'get') {
      if (fs.existsSync(dataPath)) {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        return { data: JSON.parse(raw) };
      }
      return { data: { liveConfig: {}, styleMemory: {} } };
    }
    if (payload?.op === 'set' && payload.data) {
      fs.writeFileSync(dataPath, JSON.stringify(payload.data, null, 2));
      return { ok: true };
    }
  } catch (e) {
    return { error: e.message };
  }
  return { error: 'Unknown op' };
});

ipcMain.handle('ledger-export', () => {
  if (!store || !fs.existsSync(store.ledgerPath)) return '';
  try {
    return fs.readFileSync(store.ledgerPath, 'utf-8');
  } catch {
    return '';
  }
});

// ─── OAuth 2.0 System ───────────────────────────────────────────────────────
// PKCE-based OAuth for all services. User clicks "Sign in with Google / Microsoft
// / etc." → a popup BrowserWindow opens the provider's real login page → user
// approves → Electron intercepts the redirect callback URL before it hits the
// network → exchanges the auth code for tokens → stores tokens encrypted via
// safeStorage. Zero token pasting, zero API keys to copy anywhere.
//
// One-time setup required (done by the developer / app owner):
//   • Register NavioBrowser in each provider's developer console
//   • Add the client_id for each provider in Settings → Connected Apps
//   • Redirect URI to register: http://127.0.0.1:56789/oauth/callback
// ─────────────────────────────────────────────────────────────────────────────

const OAUTH_REDIRECT_URI = 'http://127.0.0.1:56789/oauth/callback';

const OAUTH_PROVIDERS = {
  google: {
    name: 'Google',
    buttonLabel: 'Sign in with Google',
    buttonColor: '#fff',
    buttonTextColor: '#3c4043',
    buttonBorder: '1px solid #dadce0',
    logo: 'https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: [
      'openid', 'email', 'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/calendar.readonly'
    ],
    serviceIds: ['gmail', 'gdrive', 'gcalendar'],
    configKey: 'oauthGoogleClientId',
    secretKey: 'oauthGoogleClientSecret',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    consoleHint: 'Create an OAuth 2.0 Client ID (Desktop app type). Add redirect URI: http://127.0.0.1:56789/oauth/callback'
  },
  google_2: {
    name: 'Google (2nd account)',
    buttonLabel: 'Sign in with Google (2nd account)',
    buttonColor: '#fff',
    buttonTextColor: '#3c4043',
    buttonBorder: '1px solid #dadce0',
    logo: 'https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: [
      'openid', 'email', 'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/calendar.readonly'
    ],
    serviceIds: ['gmail_2'],
    configKey: 'oauthGoogleClientId',
    secretKey: 'oauthGoogleClientSecret',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    consoleHint: 'Same Desktop OAuth client as the first Google connection. Use this only for a second Gmail/workspace login.'
  },
  microsoft: {
    name: 'Microsoft',
    buttonLabel: 'Sign in with Microsoft',
    buttonColor: '#2f2f2f',
    buttonTextColor: '#fff',
    logo: null,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    revokeUrl: null,
    scopes: ['offline_access', 'openid', 'profile', 'email', 'Mail.Read', 'Files.Read', 'Calendars.Read'],
    serviceIds: ['outlook', 'onedrive'],
    configKey: 'oauthMicrosoftClientId',
    secretKey: 'oauthMicrosoftClientSecret',
    consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade',
    consoleHint: 'Register a new app, select "Personal Microsoft accounts only", add redirect URI http://127.0.0.1:56789/oauth/callback (type: Web)'
  },
  dropbox: {
    name: 'Dropbox',
    buttonLabel: 'Connect Dropbox',
    buttonColor: '#0061ff',
    buttonTextColor: '#fff',
    logo: null,
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    revokeUrl: null,
    scopes: ['files.metadata.read', 'files.content.read'],
    serviceIds: ['dropbox'],
    configKey: 'oauthDropboxAppKey',
    secretKey: 'oauthDropboxAppSecret',
    consoleUrl: 'https://www.dropbox.com/developers/apps',
    consoleHint: 'Create an app, choose "Scoped access" + "Full Dropbox", add http://127.0.0.1:56789/oauth/callback as redirect URI'
  },
  slack: {
    name: 'Slack',
    buttonLabel: 'Sign in with Slack',
    buttonColor: '#4a154b',
    buttonTextColor: '#fff',
    logo: null,
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: null,
    scopes: ['channels:read', 'search:read', 'users:read'],
    serviceIds: ['slack'],
    configKey: 'oauthSlackClientId',
    secretKey: 'oauthSlackClientSecret',
    consoleUrl: 'https://api.slack.com/apps',
    consoleHint: 'Create an app, add OAuth redirect URL http://127.0.0.1:56789/oauth/callback, request scopes: channels:read, search:read'
  },
  github: {
    name: 'GitHub',
    buttonLabel: 'Sign in with GitHub',
    buttonColor: '#24292e',
    buttonTextColor: '#fff',
    logo: null,
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    revokeUrl: null,
    scopes: ['repo', 'read:user'],
    serviceIds: ['github'],
    configKey: 'oauthGithubClientId',
    secretKey: 'oauthGithubClientSecret',
    consoleUrl: 'https://github.com/settings/applications/new',
    consoleHint: 'Register a new OAuth App. Homepage URL: http://localhost, Callback URL: http://127.0.0.1:56789/oauth/callback'
  },
  notion: {
    name: 'Notion',
    buttonLabel: 'Connect Notion',
    buttonColor: '#fff',
    buttonTextColor: '#111',
    buttonBorder: '1px solid #e5e5e5',
    logo: null,
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    revokeUrl: null,
    scopes: [],
    serviceIds: ['notion'],
    configKey: 'oauthNotionClientId',
    secretKey: 'oauthNotionClientSecret',
    consoleUrl: 'https://www.notion.so/my-integrations',
    consoleHint: 'Create an integration, set type to "Public", add redirect URI http://127.0.0.1:56789/oauth/callback'
  }
};

// ── PKCE helpers ──────────────────────────────────────────────────────────
function _oauthGenerateVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function _oauthGenerateChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── Token storage (shares safeStorage with connector keys) ────────────────
function oauthTokensPath() {
  return path.join(app.getPath('userData'), 'navio-oauth-tokens.json');
}

function loadOAuthTokens() {
  const p = oauthTokensPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

function saveOAuthTokens(map) {
  fs.writeFileSync(oauthTokensPath(), JSON.stringify(map, null, 2));
}

function encryptOAuthToken(val) {
  const { safeStorage } = require('electron');
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(val).toString('base64');
  return Buffer.from(val, 'utf8').toString('base64');
}

function decryptOAuthToken(b64) {
  const { safeStorage } = require('electron');
  const buf = Buffer.from(b64, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8');
  } catch { return ''; }
}

function storeOAuthTokenData(providerId, data) {
  const map = loadOAuthTokens();
  map[providerId] = {
    access: encryptOAuthToken(data.access_token || ''),
    refresh: encryptOAuthToken(data.refresh_token || ''),
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 - 60000 : 0,
    email: data.email || '',
    name: data.name || '',
    avatar: data.avatar || ''
  };
  saveOAuthTokens(map);
}

function getOAuthAccessToken(providerId) {
  const map = loadOAuthTokens();
  const entry = map[providerId];
  if (!entry) return null;
  return decryptOAuthToken(entry.access);
}

async function refreshOAuthToken(providerId) {
  const map = loadOAuthTokens();
  const entry = map[providerId];
  if (!entry) return null;

  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider || !provider.tokenUrl) return null;

  const refreshToken = decryptOAuthToken(entry.refresh);
  if (!refreshToken) return null;

  const cfg = loadConfig();
  const clientId = cfg[provider.configKey] || '';
  if (!clientId) return null;
  const clientSecret = provider.secretKey ? (cfg[provider.secretKey] || '') : '';

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    });
    if (clientSecret) params.set('client_secret', clientSecret);
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(25000)
    });
    const data = await res.json();
    if (data.access_token) {
      map[providerId].access = encryptOAuthToken(data.access_token);
      if (data.refresh_token) map[providerId].refresh = encryptOAuthToken(data.refresh_token);
      map[providerId].expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 - 60000 : 0;
      saveOAuthTokens(map);
      return data.access_token;
    }
  } catch {}
  return null;
}

async function getValidOAuthToken(providerId) {
  const map = loadOAuthTokens();
  const entry = map[providerId];
  if (!entry) return null;
  let token;
  // If not expired or no expiry set, return current token
  if (!entry.expiresAt || Date.now() < entry.expiresAt) {
    token = decryptOAuthToken(entry.access);
  } else {
    token = await refreshOAuthToken(providerId);
  }
  if (!token) return null;
  // Never block the token path (NTP Inbox, Gmail API, tools) on profile backfill.
  // Backfill runs in the background; next load may have email for `?authuser=`.
  void backfillGoogleOAuthProfileIfMissing(providerId).catch(() => {});
  return token;
}

/** Gmail agent tools: primary Google vs second-account slot (google_2). */
function gmailToolOAuthProviderId(args) {
  const raw = args && (args.google_account != null ? args.google_account : args.account);
  const s = String(raw == null ? 'primary' : raw).toLowerCase().trim();
  if (s === 'secondary' || s === 'second' || s === '2' || s === 'google_2' || s === 'other') return 'google_2';
  return 'google';
}

/** Open URL for a Drive file/folder when `webViewLink` is missing from the API. */
function driveNavioWebUrl(fileLike) {
  if (!fileLike || typeof fileLike !== 'object') return '';
  const w = fileLike.webViewLink;
  if (w && typeof w === 'string' && w.trim()) return w.trim();
  const id = typeof fileLike.id === 'string' ? fileLike.id : '';
  if (!id) return '';
  const mt = String(fileLike.mimeType || '');
  if (mt === 'application/vnd.google-apps.folder') {
    return `https://drive.google.com/drive/folders/${id}`;
  }
  return `https://drive.google.com/file/d/${id}/view`;
}

/** Google Drive / Docs agent tools — same account slots as Gmail (`google_account`). */
async function driveOAuthAccess(args) {
  const pid = gmailToolOAuthProviderId(args || {});
  const token = await getValidOAuthToken(pid);
  if (!token) {
    return {
      error:
        pid === 'google_2'
          ? 'Google Drive (second account): connect **Gmail (2nd account)** in Navio Settings, or pass google_account **primary** if the file is on the first account.'
          : 'Google Drive requires Google OAuth. Connect Google in Settings → Connected Apps (same as Gmail). If write tools fail with a scope error, disconnect and sign in again so Drive read/write is granted.'
    };
  }
  return { token, pid };
}

/**
 * Look up the stored email for a connected OAuth provider (used to build
 * account-correct Gmail web URLs — `?authuser=<email>` routes to the right
 * inbox regardless of which slot `/u/N/` picks in the user's browser session).
 */
function gmailConnectedAccountEmail(providerId) {
  try {
    const map = loadOAuthTokens();
    const entry = map[providerId];
    const email = entry && entry.email ? String(entry.email).trim() : '';
    return email && email.includes('@') ? email : '';
  } catch {
    return '';
  }
}

/**
 * Build the Gmail web URL for a single message that opens in the **connected**
 * account, not whatever account the signed-in browser session happens to have
 * in slot 0. Uses `?authuser=<email>` when we know the OAuth email; otherwise
 * falls back to a slot-based URL.
 *   providerId: 'google' | 'google_2'
 *   messageId: Gmail API message id
 *   opts.view: 'inbox' (default) | 'drafts' | 'sent' | 'all'
 */
function buildGmailWebUrl(providerId, messageId, opts = {}) {
  const mid = String(messageId || '').trim();
  if (!mid) return '';
  const slot = providerId === 'google_2' ? 1 : 0;
  const view = opts.view === 'drafts' || opts.view === 'sent' || opts.view === 'all'
    ? opts.view
    : 'inbox';
  const email = gmailConnectedAccountEmail(providerId);
  const frag = `#${view}/${encodeURIComponent(mid)}`;
  if (email) {
    const base = new URL('https://mail.google.com/mail/u/0/');
    base.searchParams.set('authuser', email);
    return `${base.origin}${base.pathname}?${base.searchParams.toString()}${frag}`;
  }
  return `https://mail.google.com/mail/u/${slot}/${frag}`;
}

/**
 * Gmail API unavailable — OAuth missing or expired. Keep the `not_signed_in` prefix so
 * renderers can detect it; body is shown to the user and to the model verbatim.
 */
function navioGmailNotConnectedMessage(providerId) {
  const head = 'not_signed_in';
  if (providerId === 'google_2') {
    return (
      `${head}\n\n` +
      '**Second Google account** is not connected in Navio, so the **Gmail API** cannot use that mailbox.\n\n' +
      "**What's wrong:** There is no valid OAuth token for the **second Gmail** slot — search, read, and draft tools cannot run for that account.\n\n" +
      '**Fix:** Open **Settings** → **Connectors** (or **AI → Connected Apps**) → connect **Gmail (2nd account)** and approve Gmail access.\n\n' +
      '**Or:** If your **primary** Google account is already connected, pass `google_account: "primary"` (or the equivalent) so tools use that mailbox.\n\n' +
      '**Alternative:** Say **take over** or **use the browser** — Navio can drive **mail.google.com** in a tab instead (no Gmail API; slower but works).'
    );
  }
  return (
    `${head}\n\n` +
    '**Gmail (Google) is not connected** — the **Gmail API** is not set up for this Navio profile, so inbox search, reading messages, and API drafts cannot run.\n\n' +
    "**What's wrong:** Google OAuth with Gmail scopes has not been completed (or the token expired) under **Connected Apps**.\n\n" +
    '**Fix:** **Settings** → **Connectors** (or **AI → Connected Apps**) → **Connect Google** → sign in and **allow Gmail** when prompted.\n\n' +
    '**Alternative:** Say **take over** or **use the browser** — I can **operate Gmail in the website** for you (tab automation; no API required).'
  );
}

/** Missing Gmail OAuth scopes after connect — user must disconnect/reconnect. */
function navioGmailScopeErrorMessage(kind) {
  const tail =
    '\n\n**Alternative:** If you prefer not to change permissions yet, say **take over** — I can use the Gmail website in a tab instead (browser automation).';
  if (kind === 'compose') {
    return (
      'SCOPE_ERROR: Your Google account is connected but **gmail.compose** (and related) permission is missing, so Navio cannot create or update drafts via the API.\n\n' +
      '**Fix:** **Settings** → **Connected Apps** → **Disconnect** Google → **Save** → connect again and approve **Gmail** when asked.' +
      tail
    );
  }
  if (kind === 'read_drafts') {
    return (
      'SCOPE_ERROR: Gmail needs **read** permission to list drafts. Your connection is missing a required scope.\n\n' +
      '**Fix:** **Settings** → **Connected Apps** → **Disconnect** Google → reconnect and approve full Gmail access.' +
      tail
    );
  }
  return (
    'SCOPE_ERROR: Your Google account is missing **required Gmail API permissions**.\n\n' +
    '**Fix:** **Settings** → **Connected Apps** → **Disconnect** Google → **reconnect** and approve Gmail when prompted.' +
    tail
  );
}

async function resolveGmailToolToken(args) {
  const providerId = gmailToolOAuthProviderId(args || {});
  const token = await getValidOAuthToken(providerId);
  if (!token) {
    return { token: null, error: navioGmailNotConnectedMessage(providerId) };
  }
  return { token, error: null };
}

// Fetch user profile info after connecting (Google, Microsoft, GitHub, etc.)
async function fetchOAuthUserInfo(providerId, accessToken) {
  try {
    // Second Gmail slot uses providerId `google_2` — same userinfo endpoint as primary.
    if (providerId === 'google' || providerId === 'google_2') {
      const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(12000)
      });
      const d = await r.json();
      return { email: d.email || '', name: d.name || '', avatar: d.picture || '' };
    }
    if (providerId === 'microsoft') {
      const r = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(12000)
      });
      const d = await r.json();
      return { email: d.mail || d.userPrincipalName || '', name: d.displayName || '', avatar: '' };
    }
    if (providerId === 'github') {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' }
      });
      const d = await r.json();
      return { email: d.email || d.login || '', name: d.name || d.login || '', avatar: d.avatar_url || '' };
    }
    if (providerId === 'slack') {
      const r = await fetch('https://slack.com/api/users.identity', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const d = await r.json();
      return { email: d.user?.email || '', name: d.user?.name || '', avatar: d.user?.image_72 || '' };
    }
  } catch {}
  return { email: '', name: '', avatar: '' };
}

/**
 * Older builds never called userinfo for `google_2`, so tokens lacked `email`.
 * Without it, Gmail web URLs cannot use `?authuser=<email>` and fall back to `/u/1/`,
 * which follows browser sign-in order (often the wrong inbox).
 */
async function backfillGoogleOAuthProfileIfMissing(providerId) {
  if (providerId !== 'google' && providerId !== 'google_2') return;
  const map = loadOAuthTokens();
  const entry = map[providerId];
  if (!entry) return;
  if (String(entry.email || '').includes('@')) return;
  const token = decryptOAuthToken(entry.access);
  if (!token) return;
  const info = await fetchOAuthUserInfo(providerId, token);
  const em = String(info.email || '').trim();
  if (!em.includes('@')) return;
  map[providerId] = {
    ...entry,
    email: em,
    name: info.name || entry.name || '',
    avatar: info.avatar || entry.avatar || ''
  };
  saveOAuthTokens(map);
}

// ── IPC: oauth-connect ────────────────────────────────────────────────────
// Opens a popup BrowserWindow with the provider's login page.
// Intercepts the redirect callback URL, exchanges code for tokens, stores them.
ipcMain.handle('oauth-connect', async (event, { providerId }) => {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };

  const cfg = loadConfig();
  const clientId = (cfg[provider.configKey] || '').trim();
  const clientSecret = provider.secretKey ? (cfg[provider.secretKey] || '').trim() : '';
  if (!clientId) {
    return {
      error: `No client ID configured for ${provider.name}.`,
      needsClientId: true,
      consoleUrl: provider.consoleUrl,
      consoleHint: provider.consoleHint,
      configKey: provider.configKey,
      providerName: provider.name
    };
  }

  const verifier = _oauthGenerateVerifier();
  const challenge = _oauthGenerateChallenge(verifier);
  const state = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  if (provider.scopes && provider.scopes.length > 0) {
    params.set('scope', provider.scopes.join(' '));
  }

  // Notion and Dropbox need extra params
  if (providerId === 'notion') {
    params.set('owner', 'user');
    params.set('response_type', 'code');
  }
  if (providerId === 'dropbox') {
    params.set('token_access_type', 'offline');
  }

  // Google: second connector must not reuse the OAuth popup's Google cookies from the
  // primary connect — otherwise the same account is authorized twice and Settings shows
  // duplicate emails. Ephemeral session + account picker fixes that.
  if (providerId === 'google' || providerId === 'google_2') {
    params.set('access_type', 'offline');
    if (providerId === 'google_2') {
      params.set('prompt', 'select_account');
    }
  }

  const authUrl = `${provider.authUrl}?${params.toString()}`;

  return new Promise((resolve) => {
    const google2OAuthPartition =
      providerId === 'google_2' ? `oauth_google_2:${crypto.randomBytes(10).toString('hex')}` : '';
    const authWin = new BrowserWindow({
      width: 500,
      height: 680,
      show: true,
      modal: false,
      autoHideMenuBar: true,
      title: `Sign in with ${provider.name}`,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // Google sign-in requires web APIs that Electron sandbox blocks
        ...(google2OAuthPartition ? { session: session.fromPartition(google2OAuthPartition) } : {})
      }
    });

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { if (!authWin.isDestroyed()) authWin.close(); } catch {}
      resolve(result);
    };

    const interceptCallback = async (url) => {
      if (!url.startsWith(OAUTH_REDIRECT_URI)) return false;
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      const returnedState = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');

      if (error) { settle({ error: parsed.searchParams.get('error_description') || error }); return true; }
      if (returnedState !== state) { settle({ error: 'State mismatch — possible CSRF attempt.' }); return true; }
      if (!code) { settle({ error: 'No authorization code received.' }); return true; }

      // Exchange code for tokens
      try {
        const tokenParams = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier
        });
        // Include client_secret when configured (required by Google, GitHub, Slack, Dropbox, Microsoft)
        if (clientSecret) tokenParams.set('client_secret', clientSecret);

        let tokenRes, tokenData;
        if (providerId === 'github') {
          tokenRes = await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString()
          });
        } else if (providerId === 'notion') {
          // Notion uses Basic auth with client_id:client_secret (no PKCE)
          const notionSecret = clientSecret || '';
          tokenRes = await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${Buffer.from(`${clientId}:${notionSecret}`).toString('base64')}`
            },
            body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: OAUTH_REDIRECT_URI })
          });
        } else {
          tokenRes = await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString()
          });
        }

        tokenData = await tokenRes.json();
        if (tokenData.error || !tokenData.access_token) {
          settle({ error: tokenData.error_description || tokenData.error || 'Token exchange failed' });
          return true;
        }

        // Fetch user profile
        const userInfo = await fetchOAuthUserInfo(providerId, tokenData.access_token);
        storeOAuthTokenData(providerId, { ...tokenData, ...userInfo });

        settle({ ok: true, providerId, email: userInfo.email, name: userInfo.name, avatar: userInfo.avatar });
      } catch (e) {
        settle({ error: e.message });
      }
      return true;
    };

    // Only block/intercept navigations that are going to the redirect URI.
    // Do NOT call ev.preventDefault() on other URLs — that was freezing the Google login flow.
    authWin.webContents.on('will-navigate', (ev, url) => {
      if (url.startsWith(OAUTH_REDIRECT_URI)) {
        ev.preventDefault();
        interceptCallback(url);
      }
    });
    authWin.webContents.on('will-redirect', (ev, url) => {
      if (url.startsWith(OAUTH_REDIRECT_URI)) {
        ev.preventDefault();
        interceptCallback(url);
      }
    });
    // Fallback: if the redirect URI navigation fails (ERR_CONNECTION_REFUSED because
    // no local server is running on port 56789), the URL is still available here.
    authWin.webContents.on('did-fail-load', (ev, errCode, errDesc, validatedURL) => {
      if (validatedURL && validatedURL.startsWith(OAUTH_REDIRECT_URI)) {
        interceptCallback(validatedURL);
      }
    });
    // Final safety net: catch the code if the page actually navigates to the callback URL
    authWin.webContents.on('did-navigate', (ev, url) => {
      if (url.startsWith(OAUTH_REDIRECT_URI)) {
        interceptCallback(url);
      }
    });
    authWin.on('closed', () => settle({ error: 'Login window closed by user.' }));

    authWin.loadURL(authUrl);
  });
});

// ── IPC: oauth-get-connected-accounts ────────────────────────────────────
ipcMain.handle('oauth-get-connected-accounts', () => {
  try {
    const map = loadOAuthTokens();
    const result = {};
    for (const [id, entry] of Object.entries(map)) {
      if (entry && entry.email) result[id] = { email: entry.email, name: entry.name || '' };
    }
    return result;
  } catch { return {}; }
});

// ── IPC: oauth-disconnect ─────────────────────────────────────────────────
ipcMain.handle('oauth-disconnect', (event, { providerId }) => {
  try {
    const map = loadOAuthTokens();
    const provider = OAUTH_PROVIDERS[providerId];
    const entry = map[providerId];

    // Best-effort revoke
    if (entry && provider?.revokeUrl) {
      const token = decryptOAuthToken(entry.access);
      fetch(provider.revokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString()
      }).catch(() => {});
    }

    delete map[providerId];
    saveOAuthTokens(map);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ── IPC: oauth-status ─────────────────────────────────────────────────────
// Returns which providers are connected + display info (email, avatar).
// Never exposes actual tokens.
ipcMain.handle('oauth-status', async () => {
  try {
    // Do not await — was blocking the NTP and Settings on slow/failed userinfo fetches.
    void backfillGoogleOAuthProfileIfMissing('google').catch(() => {});
    void backfillGoogleOAuthProfileIfMissing('google_2').catch(() => {});
    const map = loadOAuthTokens();
    const result = {};
    for (const [id, entry] of Object.entries(map)) {
      result[id] = {
        connected: true,
        email: entry.email || '',
        name: entry.name || '',
        avatar: entry.avatar || '',
        expired: entry.expiresAt > 0 && Date.now() > entry.expiresAt
      };
    }
    return result;
  } catch { return {}; }
});

// ── IPC: oauth-providers-config ───────────────────────────────────────────
// Returns provider metadata needed for the UI (no tokens, no secrets).
ipcMain.handle('oauth-providers-config', () => {
  const cfg = loadConfig();
  return Object.entries(OAUTH_PROVIDERS).map(([id, p]) => ({
    id,
    name: p.name,
    buttonLabel: p.buttonLabel,
    buttonColor: p.buttonColor,
    buttonTextColor: p.buttonTextColor,
    buttonBorder: p.buttonBorder || null,
    serviceIds: p.serviceIds,
    configKey: p.configKey,
    secretKey: p.secretKey || null,
    hasClientId: !!(cfg[p.configKey] || '').trim(),
    hasClientSecret: p.secretKey ? !!(cfg[p.secretKey] || '').trim() : false,
    consoleUrl: p.consoleUrl,
    consoleHint: p.consoleHint
  }));
});

// ─── Connector Integrations ─────────────────────────────────────────────────
// Stores per-service API keys encrypted with safeStorage (or base64 fallback).
// Keys are never exposed to the renderer — only a boolean "has key" map is returned.

function connectorKeysPath() {
  return path.join(app.getPath('userData'), 'navio-connector-keys.json');
}

function loadConnectorKeys() {
  const p = connectorKeysPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConnectorKeys(map) {
  fs.writeFileSync(connectorKeysPath(), JSON.stringify(map, null, 2));
}

function encryptConnectorKey(val) {
  const { safeStorage } = require('electron');
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(val).toString('base64');
  }
  return Buffer.from(val, 'utf8').toString('base64');
}

function decryptConnectorKey(b64) {
  const { safeStorage } = require('electron');
  const buf = Buffer.from(b64, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

ipcMain.handle('connector-save-key', (event, { serviceId, apiKey }) => {
  try {
    const map = loadConnectorKeys();
    if (!apiKey) {
      delete map[serviceId];
    } else {
      map[serviceId] = encryptConnectorKey(apiKey);
    }
    saveConnectorKeys(map);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('connector-get-keys', () => {
  try {
    const result = {};
    // Include manually stored API keys
    const map = loadConnectorKeys();
    for (const id of Object.keys(map)) result[id] = !!map[id];

    // Also include services covered by OAuth tokens
    const oauthServiceMap = {
      google: ['gmail', 'gdrive', 'gcalendar'],
      google_2: ['gmail_2'],
      microsoft: ['outlook', 'onedrive'],
      dropbox: ['dropbox'],
      slack: ['slack'],
      github: ['github'],
      notion: ['notion']
    };
    const oauthTokens = loadOAuthTokens();
    for (const [providerId, serviceIds] of Object.entries(oauthServiceMap)) {
      if (oauthTokens[providerId]) {
        for (const svcId of serviceIds) result[svcId] = true;
      }
    }

    // Also include IMAP-connected services (gmail, outlook via email+password)
    const imapCreds = loadImapCreds();
    for (const svcId of Object.keys(imapCreds)) result[svcId] = true;

    return result;
  } catch {
    return {};
  }
});

ipcMain.handle('connector-remove-key', (event, { serviceId }) => {
  try {
    const map = loadConnectorKeys();
    delete map[serviceId];
    saveConnectorKeys(map);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('connector-query', async (event, { serviceId, query, options }) => {
  try {
    // Check OAuth tokens first (Google, Microsoft, Dropbox, Slack, GitHub, Notion)
    const oauthProviderForService = {
      gmail: 'google', gdrive: 'google', gcalendar: 'google',
      gmail_2: 'google_2',
      outlook: 'microsoft', onedrive: 'microsoft',
      dropbox: 'dropbox', slack: 'slack', github: 'github', notion: 'notion'
    };
    const oauthProviderId = oauthProviderForService[serviceId];
    let token = oauthProviderId ? await getValidOAuthToken(oauthProviderId) : null;

    // Fall back to manually stored API key if no OAuth token
    if (!token) {
      const map = loadConnectorKeys();
      if (map[serviceId]) token = decryptConnectorKey(map[serviceId]);
    }

    if (!token) {
      if (serviceId === 'gmail' || serviceId === 'gmail_2') {
        return { error: navioGmailNotConnectedMessage(serviceId === 'gmail_2' ? 'google_2' : 'google') };
      }
      return { error: 'Service not connected — open **Settings → Connectors**, click **Connect** for this service, then try again.' };
    }

    if (serviceId === 'github') return await queryGitHub(token, query, options);
    if (serviceId === 'notion') return await queryNotion(token, query, options);
    if (serviceId === 'perplexity') return await queryPerplexity(token, query, options);
    if (serviceId === 'linear') return await queryLinear(token, query, options);
    if (serviceId === 'gmail' || serviceId === 'gmail_2') {
      const gmailRes = await queryGmail(token, query, options);
      if (gmailRes && Array.isArray(gmailRes.results)) {
        const oauthPid = serviceId === 'gmail_2' ? 'google_2' : 'google';
        const acctEmail = gmailConnectedAccountEmail(oauthPid);
        return {
          ...gmailRes,
          results: gmailRes.results.map((r) =>
            r && r.id
              ? { ...r, web_url: buildGmailWebUrl(oauthPid, r.id, { view: 'inbox' }), account: acctEmail || undefined }
              : r
          ),
          gmail_service_id: serviceId,
          connected_account_email: acctEmail || undefined
        };
      }
      return gmailRes;
    }
    if (serviceId === 'gdrive') return await queryGoogleDrive(token, query, options);
    if (serviceId === 'gcalendar') return await queryGoogleCalendar(token, query, options);
    if (serviceId === 'dropbox') return await queryDropbox(token, query, options);
    if (serviceId === 'onedrive') return await queryOneDrive(token, query, options);
    if (serviceId === 'slack') return await querySlack(token, query, options);
    if (serviceId === 'outlook') return await queryOutlook(token, query, options);
    return { error: `No query handler for service: ${serviceId}` };
  } catch (e) {
    return { error: e.message };
  }
});

async function queryGitHub(token, query, options = {}) {
  const type = options.type || 'issues';
  const perPage = options.perPage || 5;

  let url;
  if (type === 'code') {
    url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  } else if (type === 'repos') {
    url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  } else {
    url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  }

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const data = await resp.json();
  if (!resp.ok) return { error: data.message || 'GitHub API error' };

  const items = (data.items || []).map((item) => ({
    title: item.title || item.name || item.path,
    url: item.html_url,
    body: item.body ? item.body.slice(0, 300) : '',
    state: item.state,
    number: item.number,
    repo: item.repository_url ? item.repository_url.replace('https://api.github.com/repos/', '') : ''
  }));
  return { results: items, total: data.total_count || items.length };
}

async function queryNotion(apiKey, query, options = {}) {
  const resp = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      query,
      page_size: options.pageSize || 5
    })
  });
  const data = await resp.json();
  if (!resp.ok) return { error: data.message || 'Notion API error' };

  const results = (data.results || []).map((item) => {
    const title =
      item.properties?.title?.title?.[0]?.plain_text ||
      item.properties?.Name?.title?.[0]?.plain_text ||
      item.title?.[0]?.plain_text ||
      'Untitled';
    return {
      title,
      url: item.url || '',
      type: item.object,
      lastEdited: item.last_edited_time
    };
  });
  return { results, total: results.length };
}

async function queryPerplexity(apiKey, query, options = {}) {
  const model = options.model || 'sonar';
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: query }],
      return_citations: true,
      return_related_questions: false
    })
  });
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'Perplexity API error' };

  const content = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];
  return { answer: content, citations, model };
}

/**
 * Fallback web search using whatever LLM provider the user already pays for.
 * Avoids forcing a second (Perplexity) API key — each major provider now
 * ships a server-side web-search tool against the same key + token bill.
 *
 *   OpenAI  → /v1/responses with tools:[{type:"web_search"}] (falls back to web_search_preview)
 *   Anthropic → /v1/messages with tools:[{type:"web_search_20250305", name:"web_search"}]
 *   Google  → generateContent with tools:[{google_search:{}}]
 *
 * Returns { answer, citations: [{title,url}], model } on success, { error } on failure.
 * Never throws — all failures are reported as an error string the agent can reason about.
 */
async function queryProviderWebSearch(cfg, apiKey, query) {
  const provider = cfg.aiProvider || 'openai';
  const model = cfg.aiModel || 'gpt-5.4';
  const endpoint = cfg.customEndpoint || '';

  if (!apiKey) {
    return { error: 'No AI API key configured. Add one in Settings → AI.' };
  }
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return { error: 'Empty search query.' };

  // Normalize citation shape to array of URL strings so it matches the existing
  // Perplexity shape consumed by src/js/assistant.js (_appendCitationChips).
  const pushUrl = (arr, seen, u) => {
    if (!u || typeof u !== 'string') return;
    if (seen.has(u)) return;
    seen.add(u);
    arr.push(u);
  };

  try {
    if (provider === 'openai' || provider === 'custom') {
      const base = endpoint
        ? endpoint.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, '')
        : 'https://api.openai.com/v1';
      const url = `${base}/responses`;
      const isGpt5 = /^gpt-?5/i.test(model);
      const toolType = isGpt5 ? 'web_search' : 'web_search_preview';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          input: cleanQuery,
          tools: [{ type: toolType }],
          tool_choice: { type: toolType }
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data?.error?.message || `OpenAI web search HTTP ${resp.status}`;
        return { error: msg };
      }
      let answer = '';
      const citations = [];
      const seen = new Set();
      const items = Array.isArray(data.output) ? data.output : [];
      for (const item of items) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) answer += part.text;
            for (const a of part.annotations || []) {
              if (a.type === 'url_citation') pushUrl(citations, seen, a.url);
            }
          }
        }
      }
      if (!answer && typeof data.output_text === 'string') answer = data.output_text;
      return { answer, citations, model };
    }

    if (provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'claude-opus-4-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: cleanQuery }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data?.error?.message || `Anthropic web search HTTP ${resp.status}`;
        return { error: msg };
      }
      let answer = '';
      const citations = [];
      const seen = new Set();
      for (const block of data.content || []) {
        if (block.type === 'text' && block.text) {
          answer += block.text;
          for (const c of block.citations || []) {
            pushUrl(citations, seen, c.url || c.source?.url);
          }
        } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const hit of block.content) pushUrl(citations, seen, hit.url);
        }
      }
      return { answer, citations, model };
    }

    if (provider === 'google') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: cleanQuery }] }],
          tools: [{ google_search: {} }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data?.error?.message || `Gemini web search HTTP ${resp.status}`;
        return { error: msg };
      }
      const cand = data.candidates?.[0];
      let answer = '';
      for (const part of cand?.content?.parts || []) {
        if (part.text) answer += part.text;
      }
      const citations = [];
      const seen = new Set();
      for (const ch of cand?.groundingMetadata?.groundingChunks || []) {
        pushUrl(citations, seen, ch.web?.uri);
      }
      return { answer, citations, model };
    }

    return { error: `Web search is not available for provider "${provider}". Add a Perplexity key in Settings → Connectors, or switch to OpenAI, Anthropic, or Google in Settings → AI.` };
  } catch (e) {
    return { error: `Provider web search failed: ${e.message}` };
  }
}

async function queryLinear(apiKey, query, options = {}) {
  const gqlQuery = `
    query SearchIssues($query: String!) {
      issueSearch(query: $query, first: 5) {
        nodes {
          id
          title
          description
          state { name }
          priority
          url
          team { name }
        }
      }
    }
  `;
  const resp = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: gqlQuery, variables: { query } })
  });
  const data = await resp.json();
  if (!resp.ok || data.errors) {
    return { error: data.errors?.[0]?.message || 'Linear API error' };
  }
  const items = (data.data?.issueSearch?.nodes || []).map((issue) => ({
    title: issue.title,
    url: issue.url,
    state: issue.state?.name,
    team: issue.team?.name,
    description: issue.description ? issue.description.slice(0, 200) : ''
  }));
  return { results: items, total: items.length };
}
async function queryGmail(token, query, options = {}) {
  const maxResults = options.maxResults || 25;
  const effectiveQuery = (!query || query.trim().length < 3) ? 'in:inbox is:unread' : query.trim();

  const allMessages = [];
  let pageToken = options.pageToken || null;
  let totalEstimate = 0;
  const pagesToFetch = options.pages || 1;

  for (let page = 0; page < pagesToFetch; page++) {
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(effectiveQuery)}&maxResults=${Math.min(maxResults - allMessages.length, 100)}`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const searchResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const searchData = await searchResp.json();
    if (!searchResp.ok) return { error: searchData.error?.message || 'Gmail API error' };
    if (!searchData.messages?.length) break;

    totalEstimate = searchData.resultSizeEstimate || totalEstimate;
    allMessages.push(...searchData.messages);
    pageToken = searchData.nextPageToken || null;

    if (!pageToken || allMessages.length >= maxResults) break;
  }

  if (!allMessages.length) return { results: [], total: 0 };

  const batch = allMessages.slice(0, maxResults);
  const batchSize = 10;
  const msgs = [];
  for (let i = 0; i < batch.length; i += batchSize) {
    const chunk = batch.slice(i, i + batchSize);
    const chunkResults = await Promise.all(
      chunk.map(async (m) => {
        try {
          const r = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const d = await r.json();
          const headers = d.payload?.headers || [];
          const get = (name) => headers.find((h) => h.name === name)?.value || '';
          return {
            subject: get('Subject') || '(no subject)',
            from: get('From'),
            to: get('To'),
            date: get('Date'),
            snippet: d.snippet || '',
            id: m.id,
            threadId: m.threadId || d.threadId || '',
            labelIds: d.labelIds || [],
            hasReply: !!(get('In-Reply-To'))
          };
        } catch { return null; }
      })
    );
    msgs.push(...chunkResults);
  }

  return {
    results: msgs.filter(Boolean),
    total: totalEstimate || msgs.length,
    nextPageToken: pageToken || null
  };
}

async function queryGoogleDrive(token, query, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 15, 1), 50);
  const raw = (query || '').trim();
  const isRecent = !raw || raw === '__NAVIO_RECENT__';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  /** Drive `files.list` q: name OR fullText, trashed excluded */
  let qParam;
  if (isRecent) {
    qParam = 'trashed=false';
  } else {
    const words = raw.split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
    if (words.length === 0) {
      qParam = 'trashed=false';
    } else if (words.length === 1) {
      const t = esc(words[0]);
      qParam = `trashed=false and (name contains '${t}' or fullText contains '${t}')`;
    } else {
      const parts = words.map((w) => `fullText contains '${esc(w)}'`);
      qParam = `trashed=false and (${parts.join(' and ')})`;
    }
  }
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=${pageSize}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=${encodeURIComponent('modifiedTime desc')}&q=${encodeURIComponent(qParam)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'Google Drive API error' };
  const results = (data.files || []).map((f) => ({
    name: f.name,
    type: f.mimeType?.split('.').pop() || f.mimeType,
    modified: f.modifiedTime,
    url: driveNavioWebUrl(f)
  }));
  return { results, total: results.length };
}

async function queryGoogleCalendar(token, query, options = {}) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?q=${encodeURIComponent(query)}&timeMin=${now}&timeMax=${future}&maxResults=5&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'Google Calendar API error' };
  const results = (data.items || []).map((e) => ({
    title: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || '',
    description: e.description ? e.description.slice(0, 150) : ''
  }));
  return { results, total: results.length };
}

async function queryDropbox(token, query, options = {}) {
  const resp = await fetch('https://api.dropboxapi.com/2/files/search_v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      options: { max_results: options.maxResults || 6, file_status: 'active' }
    })
  });
  const data = await resp.json();
  if (!resp.ok || data.error_summary) return { error: data.error_summary || 'Dropbox API error' };
  const results = (data.matches || []).map((m) => {
    const meta = m.metadata?.metadata || m.metadata;
    return {
      name: meta?.name || '',
      path: meta?.path_display || '',
      modified: meta?.server_modified || '',
      type: meta?.['.tag'] || 'file'
    };
  });
  return { results, total: results.length };
}

async function queryOneDrive(token, query, options = {}) {
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/search(q='${encodeURIComponent(query)}')?$top=${options.top || 6}&$select=name,webUrl,lastModifiedDateTime,file,folder`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'OneDrive API error' };
  const results = (data.value || []).map((f) => ({
    name: f.name,
    url: f.webUrl,
    modified: f.lastModifiedDateTime,
    type: f.file ? 'file' : 'folder'
  }));
  return { results, total: results.length };
}

async function querySlack(token, query, options = {}) {
  const resp = await fetch(
    `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=${options.count || 5}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (!data.ok) return { error: data.error || 'Slack API error' };
  const results = (data.messages?.matches || []).map((m) => ({
    text: m.text ? m.text.slice(0, 200) : '',
    user: m.username || m.user || '',
    channel: m.channel?.name || '',
    ts: m.ts,
    permalink: m.permalink || ''
  }));
  return { results, total: data.messages?.total || results.length };
}

async function queryOutlook(token, query, options = {}) {
  const top = options.top || 6;
  // Detect unread/inbox requests and use $filter instead of $search
  const isUnreadRequest = !query || query.trim().length < 3 || /isRead:false/i.test(query);
  let url;
  if (isUnreadRequest) {
    url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false&$orderby=receivedDateTime desc&$top=${top}&$select=subject,from,receivedDateTime,bodyPreview,isRead`;
  } else {
    url = `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(query)}"&$top=${top}&$select=subject,from,receivedDateTime,bodyPreview,isRead`;
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
  });
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'Outlook API error' };
  const results = (data.value || []).map((m) => ({
    subject: m.subject || '(no subject)',
    from: m.from?.emailAddress?.address || '',
    date: m.receivedDateTime,
    snippet: m.bodyPreview || '',
    isRead: m.isRead
  }));
  return { results, total: results.length };
}
// ─── IMAP Email Integration ───────────────────────────────────────────────────
// Direct IMAP connection — no OAuth, no open tab required.
// User enters email + password (or Gmail App Password) once.
// NavioBrowser can then read emails and create drafts anytime in the background.
// ─────────────────────────────────────────────────────────────────────────────

const IMAP_SERVICE_CONFIG = {
  gmail: {
    name: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    inboxFolder: 'INBOX',
    draftFolder: '[Gmail]/Drafts',
    sentFolder: '[Gmail]/Sent Mail',
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    hint: 'Use your Gmail address and an App Password (generate one at myaccount.google.com/apppasswords — takes 60 seconds).'
  },
  outlook: {
    name: 'Outlook',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    inboxFolder: 'INBOX',
    draftFolder: 'Drafts',
    sentFolder: 'Sent Items',
    appPasswordUrl: null,
    hint: 'Use your Microsoft email address and account password.'
  }
};

function imapCredsPath() {
  return path.join(app.getPath('userData'), 'navio-imap-creds.json');
}
function loadImapCreds() {
  const p = imapCredsPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}
function saveImapCreds(map) {
  fs.writeFileSync(imapCredsPath(), JSON.stringify(map, null, 2));
}
function storeImapCreds(serviceId, email, password) {
  const { safeStorage } = require('electron');
  const map = loadImapCreds();
  const encrypt = (v) => safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(v).toString('base64')
    : Buffer.from(v).toString('base64');
  map[serviceId] = { email: encrypt(email), password: encrypt(password) };
  saveImapCreds(map);
}
function getImapCreds(serviceId) {
  const { safeStorage } = require('electron');
  const map = loadImapCreds();
  const entry = map[serviceId];
  if (!entry) return null;
  const decrypt = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch { return ''; }
  };
  return { email: decrypt(entry.email), password: decrypt(entry.password) };
}

async function imapGetClient(serviceId) {
  const { ImapFlow } = require('imapflow');
  const cfg = IMAP_SERVICE_CONFIG[serviceId];
  const creds = getImapCreds(serviceId);
  if (!cfg || !creds) throw new Error(`${serviceId} not connected`);
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: creds.email, pass: creds.password },
    logger: false,
    tls: { rejectUnauthorized: false }
  });
  await client.connect();
  return client;
}

// IPC: test + save IMAP credentials
ipcMain.handle('imap-connect', async (event, { serviceId, email, password }) => {
  try {
    const { ImapFlow } = require('imapflow');
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    if (!cfg) return { error: 'Unknown service' };

    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
      disableAutoIdle: true,
      // Longer timeouts for slower connections
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000
    });

    await client.connect();

    // Verify credentials work by opening INBOX (catches wrong-password errors
    // that only surface after the initial TCP handshake succeeds)
    try {
      await client.mailboxOpen('INBOX', { readOnly: true });
    } catch (innerErr) {
      await client.logout().catch(() => {});
      throw innerErr;
    }

    await client.logout();
    storeImapCreds(serviceId, email, password);
    return { ok: true, email };
  } catch (e) {
    // Parse ImapFlow/IMAP error into actionable guidance
    const raw = (e.message || e.responseText || e.response || '').toLowerCase();
    const code = (e.responseCode || '').toLowerCase();

    if (code === 'authenticationfailed' || raw.includes('authentication') || raw.includes('invalid credentials') || raw.includes('bad credentials') || raw.includes('login failed') || raw.includes('command failed') || raw.includes('invalid login') || raw.includes('login failed') || raw.includes('[authenticationfailed]')) {
      if (serviceId === 'gmail') {
        return { error: 'Wrong password or App Password.\n\nGmail does NOT accept your regular Google password for IMAP. You must use an App Password:\n\n① Enable IMAP in Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP → Save\n② Enable 2-Step Verification at myaccount.google.com/signinoptions/two-step-verification\n③ Create App Password at myaccount.google.com/apppasswords\n   App name: "NavioBrowser" → copy the 16-character password\n\nPaste that App Password into the password field above.' };
      }
      if (serviceId === 'outlook') {
        return { error: 'Authentication failed.\n\nMake sure you\'re using your full email (e.g. you@outlook.com) and your Microsoft account password.\n\nIf you have 2-Factor Authentication enabled, you need to create an App Password at account.microsoft.com/security.' };
      }
      return { error: 'Authentication failed. Check your email and password.' };
    }
    if (raw.includes('connect') || raw.includes('econnrefused') || raw.includes('timeout') || raw.includes('network') || raw.includes('enotfound') || raw.includes('socket')) {
      if (serviceId === 'gmail') {
        return { error: 'Could not connect to Gmail.\n\nCheck your internet connection AND make sure IMAP is enabled:\nGmail → Settings (gear icon) → See all settings → Forwarding and POP/IMAP → Enable IMAP → Save Changes.' };
      }
      return { error: 'Could not connect to mail server. Check your internet connection.' };
    }
    if (raw.includes('certificate') || raw.includes('ssl') || raw.includes('tls')) {
      return { error: 'TLS/SSL error connecting to mail server. This may be a network or firewall issue.' };
    }
    if (raw.includes('unavailable') || raw.includes('imap access') || raw.includes('disabled')) {
      return { error: 'IMAP access is not enabled on this account.\n\nFor Gmail: go to Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP → Save Changes.' };
    }

    // Fall back to the raw message
    return { error: (e.message || 'Connection failed') + (serviceId === 'gmail' ? '\n\nMake sure:\n• IMAP is enabled in Gmail settings\n• You are using an App Password (not your regular password)\n• Follow the 3 steps shown above' : '') };
  }
});

// IPC: disconnect IMAP
ipcMain.handle('imap-disconnect', (event, { serviceId }) => {
  try {
    const map = loadImapCreds();
    delete map[serviceId];
    saveImapCreds(map);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// IPC: get IMAP status (which services are connected + email address)
ipcMain.handle('imap-status', () => {
  const { safeStorage } = require('electron');
  const map = loadImapCreds();
  const result = {};
  const decrypt = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'); }
    catch { return ''; }
  };
  for (const [id, entry] of Object.entries(map)) {
    result[id] = { connected: true, email: decrypt(entry.email) };
  }
  return result;
});

// IPC: fetch unread emails + count (no open tab needed)
ipcMain.handle('imap-get-unread', async (event, { serviceId, limit = 15 }) => {
  try {
    const client = await imapGetClient(serviceId);
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    const lock = await client.getMailboxLock(cfg.inboxFolder);
    try {
      const status = await client.status(cfg.inboxFolder, { unseen: true, messages: true });
      const uids = await client.search({ unseen: true }, { uid: true });
      const recentUids = uids.slice(-limit);
      const messages = [];
      if (recentUids.length > 0) {
        for await (const msg of client.fetch(recentUids, { envelope: true, bodyStructure: true }, { uid: true })) {
          const from = msg.envelope.from?.[0];
          messages.push({
            uid: msg.uid,
            subject: msg.envelope.subject || '(no subject)',
            from: from?.address || '',
            fromName: from?.name || from?.address || '',
            date: msg.envelope.date?.toISOString() || '',
            snippet: ''
          });
        }
      }
      return { unreadCount: status.unseen || 0, messages: messages.reverse() };
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) {
    return { error: e.message };
  }
});

// IPC: search emails
ipcMain.handle('imap-search', async (event, { serviceId, query, limit = 20 }) => {
  try {
    const client = await imapGetClient(serviceId);
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    const lock = await client.getMailboxLock(cfg.inboxFolder);
    try {
      const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
      const recentUids = uids.slice(-limit);
      const messages = [];
      if (recentUids.length > 0) {
        for await (const msg of client.fetch(recentUids, { envelope: true, bodyParts: ['text'], source: false }, { uid: true })) {
          const from = msg.envelope.from?.[0];
          messages.push({
            uid: msg.uid,
            subject: msg.envelope.subject || '(no subject)',
            from: from?.address || '',
            fromName: from?.name || from?.address || '',
            date: msg.envelope.date?.toISOString() || ''
          });
        }
      }
      return { messages: messages.reverse(), total: uids.length };
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) {
    return { error: e.message };
  }
});

// IPC: create a draft in the Drafts folder (real IMAP APPEND)
ipcMain.handle('imap-create-draft', async (event, { serviceId, to, subject, body, inReplyTo }) => {
  try {
    const client = await imapGetClient(serviceId);
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    const creds = getImapCreds(serviceId);
    try {
      // Build RFC 2822 formatted email
      const now = new Date().toUTCString();
      const msgId = `<navio-draft-${Date.now()}@navio.local>`;
      const lines = [
        `From: ${creds.email}`,
        `To: ${to || ''}`,
        `Subject: ${subject || ''}`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        body || ''
      ];
      const raw = lines.join('\r\n');
      await client.append(cfg.draftFolder, raw, ['\\Draft', '\\Seen'], new Date());
      return { ok: true };
    } finally {
      await client.logout();
    }
  } catch (e) {
    return { error: e.message };
  }
});

// IPC: fetch body of a specific email by UID
ipcMain.handle('imap-get-email-body', async (event, { serviceId, uid }) => {
  try {
    const client = await imapGetClient(serviceId);
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    const lock = await client.getMailboxLock(cfg.inboxFolder);
    try {
      let body = '';
      for await (const msg of client.fetch([uid], { bodyParts: ['text'], envelope: true }, { uid: true })) {
        const textPart = msg.bodyParts?.get('text');
        if (textPart) body = Buffer.from(textPart).toString('utf-8');
      }
      return { body };
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) {
    return { error: e.message };
  }
});

// ── IMAP: mark message as read ────────────────────────────────────────────────
ipcMain.handle('imap-mark-read', async (event, { serviceId, uid }) => {
  try {
    const client = await imapGetClient(serviceId);
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    const lock = await client.getMailboxLock(cfg.inboxFolder);
    try {
      await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
      return { ok: true };
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) { return { error: e.message }; }
});

// ── IMAP: delete (move to Trash) ──────────────────────────────────────────────
ipcMain.handle('imap-trash-message', async (event, { serviceId, uid }) => {
  try {
    const client = await imapGetClient(serviceId);
    const cfg = IMAP_SERVICE_CONFIG[serviceId];
    const trashFolder = cfg.trashFolder || 'Trash';
    const lock = await client.getMailboxLock(cfg.inboxFolder);
    try {
      await client.messageMove([uid], trashFolder, { uid: true });
      return { ok: true };
    } catch {
      // Fallback: just flag as deleted
      await client.messageFlagsAdd([uid], ['\\Deleted'], { uid: true });
      return { ok: true };
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (e) { return { error: e.message }; }
});

// ── NTP: Stock quotes (main process — no CORS) — smart row / AI; Markets tile uses TradingView embed in renderer ──
// query1.finance.yahoo.com/v8/finance/chart works without crumb or cookies.
ipcMain.handle('ntp-stocks', async () => {
  const symbols = ['^GSPC', '^DJI', '^IXIC', 'AAPL', 'GOOGL', 'MSFT', 'NVDA', 'TSLA', 'BTC-USD', 'ETH-USD'];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const yahooHeaders = {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: 'https://finance.yahoo.com/'
  };
  const fetchYahooChart = async (sym) => {
    const encoded = encodeURIComponent(sym);
    const urls = [
      `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`,
      `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`
    ];
    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: yahooHeaders, signal: AbortSignal.timeout(14000) });
        if (!r.ok) {
          lastErr = new Error(`HTTP ${r.status}`);
          continue;
        }
        return r.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Yahoo chart fetch failed');
  };
  try {
    const results = await Promise.allSettled(symbols.map(async sym => {
      const data = await fetchYahooChart(sym);
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error('No meta');
      const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
      const prev  = meta.chartPreviousClose ?? meta.previousClose ?? price;
      const change = (price != null && prev != null) ? (price - prev) : 0;
      const pct    = prev ? (change / prev) * 100 : 0;
      return {
        symbol: sym.replace('^', ''),
        name: meta.shortName || meta.longName || sym,
        price,
        change,
        pct
      };
    }));
    const good = results.filter(r => r.status === 'fulfilled' && r.value?.price != null).map(r => r.value);
    if (good.length > 0) return good;
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length === results.length) {
      const msg = failed[0]?.reason?.message || '';
      return { error: msg ? `Markets: ${msg}` : 'Could not load quotes (network).' };
    }
    return { error: 'No data returned' };
  } catch (e) {
    return { error: e.message };
  }
});

// ── NTP: Sports scores (ESPN unofficial API — free, no key required) ──────
// Team logos: `competitor.team.logo` (Predicta `espnCompetitorLogoHref`). Season slug/type → phase label; kickoff → America/New_York.

function _ntpEspnSeasonPhaseLabel(ev) {
  const s = ev && ev.season;
  if (!s || typeof s !== 'object') return '';
  const slug = typeof s.slug === 'string' ? s.slug.toLowerCase() : '';
  const typeObj = s.type && typeof s.type === 'object' ? s.type : null;
  const abbrev = typeof typeObj?.abbreviation === 'string' ? typeObj.abbreviation.toLowerCase() : '';
  const typeName = typeof typeObj?.name === 'string' ? typeObj.name.toLowerCase() : '';
  const hay = `${slug} ${abbrev} ${typeName}`;
  if (hay.includes('preseason') || hay.includes('pre season') || abbrev === 'pre') return 'Preseason';
  if (hay.includes('playoff') || hay.includes('postseason') || abbrev === 'pst' || typeName.includes('playoff')) return 'Playoffs';
  if (hay.includes('final') || hay.includes('championship') || hay.includes('world-series')) return 'Finals';
  if (hay.includes('regular') || abbrev === 'reg' || typeName.includes('regular')) return 'Regular season';
  const tid = typeObj?.id;
  if (tid === 1 || tid === '1') return 'Preseason';
  if (tid === 2 || tid === '2') return 'Regular season';
  if (tid === 3 || tid === '3') return 'Playoffs';
  if (typeObj?.name) return String(typeObj.name);
  return '';
}

function _ntpEspnStartTimeEt(ev) {
  const comp = ev?.competitions?.[0];
  const iso = comp?.date || comp?.startDate || ev?.date;
  if (!iso || typeof iso !== 'string') return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch {
    return '';
  }
}

ipcMain.handle('ntp-sports', async () => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const leagues = [
    { id: 'NFL',  url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
    { id: 'NBA',  url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
    { id: 'MLB',  url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
    { id: 'NHL',  url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard' },
    { id: 'MLS',  url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard' },
  ];
  try {
    const results = await Promise.allSettled(leagues.map(async ({ id, url }) => {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(14000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const events = (data?.events || []).slice(0, 6);
      return events.map(ev => {
        const comp = ev.competitions?.[0];
        const teams = comp?.competitors || [];
        const home = teams.find(t => t.homeAway === 'home');
        const away = teams.find(t => t.homeAway === 'away');
        const stateType = comp?.status?.type?.state || 'pre';
        const st = comp?.status?.type || {};
        const statusText = st.shortDetail || st.description || '';
        const statusDetail = typeof st.detail === 'string' ? st.detail : '';
        const homeAb = home?.team?.abbreviation || home?.team?.shortDisplayName || '';
        const awayAb = away?.team?.abbreviation || away?.team?.shortDisplayName || '';
        const homeName =
          (typeof home?.team?.displayName === 'string' && home.team.displayName.trim()) ||
          (typeof home?.team?.shortDisplayName === 'string' && home.team.shortDisplayName.trim()) ||
          homeAb;
        const awayName =
          (typeof away?.team?.displayName === 'string' && away.team.displayName.trim()) ||
          (typeof away?.team?.shortDisplayName === 'string' && away.team.shortDisplayName.trim()) ||
          awayAb;
        const homeLogo = typeof home?.team?.logo === 'string' ? home.team.logo : '';
        const awayLogo = typeof away?.team?.logo === 'string' ? away.team.logo : '';
        const seasonPhase = _ntpEspnSeasonPhaseLabel(ev);
        const startTimeEt = _ntpEspnStartTimeEt(ev);
        return {
          league: id,
          eventId: ev.id != null && ev.id !== '' ? String(ev.id) : '',
          home: homeAb,
          homeName,
          homeScore: home?.score ?? '',
          away: awayAb,
          awayName,
          awayScore: away?.score ?? '',
          homeLogo,
          awayLogo,
          status: statusText,
          statusDetail,
          seasonPhase,
          startTimeEt,
          live: stateType === 'in',
          final: stateType === 'post',
        };
      });
    }));
    const games = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(g => g.home && g.away);
    if (games.length > 0) return games;
    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.filter(r => r.status === 'rejected').length;
    if (fulfilled === 0 && rejected > 0) {
      const msg = results.find(r => r.status === 'rejected')?.reason?.message || '';
      return { error: msg ? `Scores: ${msg}` : 'Could not reach ESPN. Check your connection.' };
    }
    return { error: 'No games listed right now.' };
  } catch (e) {
    return { error: e.message };
  }
});

// ── streamed.pk API proxy (NTP Live Sports widget — see Predicta docs/streaming-external-site-guide.md)
function _isValidStreamedPkApiPath(p) {
  if (typeof p !== 'string') return false;
  const path = p.trim().replace(/^\/+/, '');
  if (path.includes('..')) return false;
  if (path === 'sports') return true;
  // Allow encoded slugs (e.g. percent-encoding) — keep length bounded
  if (path.startsWith('matches/') && path.length > 8 && path.length < 400) return true;
  if (path.startsWith('stream/') && path.length > 7 && path.length < 500) return true;
  return false;
}

ipcMain.handle('streamed-pk-api', async (_, { path: apiPath }) => {
  if (!_isValidStreamedPkApiPath(apiPath)) {
    return { error: 'invalid_path' };
  }
  const rel = String(apiPath).trim().replace(/^\/+/, '');
  const url = `https://streamed.pk/api/${rel}`;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: 'invalid_json' };
    }
    return { ok: true, data };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed');
    return { error: msg };
  } finally {
    clearTimeout(t);
  }
});

// ── NTP: Gmail inbox via OAuth (used by NTP inbox widget) ─────────────────
ipcMain.handle('ntp-gmail-inbox', async () => {
  try {
    const token = await getValidOAuthToken('google');
    if (!token) return { error: navioGmailNotConnectedMessage('google') };

    // Fetch inbox message IDs (bound network wait — otherwise NTP spins forever on hung TLS/DNS)
    const listResp = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=15',
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(22000) }
    );
    const listData = await listResp.json();
    if (!listResp.ok) return { error: listData.error?.message || 'Gmail API error' };
    if (!listData.messages?.length) return { messages: [], unreadCount: 0 };

    // Fetch metadata for each message in parallel
    const msgs = await Promise.all(
      listData.messages.slice(0, 10).map(async (m) => {
        try {
          const r = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(14000) }
          );
          const d = await r.json();
          const headers = d.payload?.headers || [];
          const get = (name) => headers.find(h => h.name === name)?.value || '';
          const fromRaw = get('From');
          const senderName = fromRaw.replace(/<[^>]+>/, '').trim() || fromRaw;
          const senderEmail = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw;
          return {
            subject: get('Subject') || '(no subject)',
            sender: senderEmail,
            senderName: senderName || senderEmail,
            date: get('Date'),
            snippet: d.snippet || '',
            unread: (d.labelIds || []).includes('UNREAD'),
            id: m.id
          };
        } catch { return null; }
      })
    );

    const messages = msgs.filter(Boolean);
    const unreadCount = messages.filter(m => m.unread).length;
    return { messages, unreadCount };
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.message === 'The operation was aborted');
    return {
      error: isAbort
        ? 'Gmail request timed out. Check your connection or sign in to Google again in Settings → Connectors.'
        : e.message
    };
  }
});

// ── Gmail: modify message labels (mark read, archive, star/unstar) ───────────
ipcMain.handle('gmail-modify-message', async (_, { id, addLabelIds = [], removeLabelIds = [], serviceId }) => {
  try {
    const oauthPid = (serviceId === 'gmail_2' || serviceId === 'google_2') ? 'google_2' : 'google';
    const token = await getValidOAuthToken(oauthPid);
    if (!token) return { error: 'not_signed_in' };
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addLabelIds, removeLabelIds })
      }
    );
    const d = await r.json();
    if (!r.ok) return { error: d.error?.message || 'Gmail API error' };
    return { ok: true, labelIds: d.labelIds || [] };
  } catch (e) { return { error: e.message }; }
});

// ── Gmail: move message to Trash ──────────────────────────────────────────────
ipcMain.handle('gmail-trash-message', async (_, { id, serviceId }) => {
  try {
    const oauthPid = (serviceId === 'gmail_2' || serviceId === 'google_2') ? 'google_2' : 'google';
    const token = await getValidOAuthToken(oauthPid);
    if (!token) return { error: 'not_signed_in' };
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    if (!r.ok) return { error: d.error?.message || 'Gmail API error' };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// ── Gmail message full body (for AI draft reply) ─────────────────────────────
ipcMain.handle('gmail-get-message-body', async (_, payload) => {
  try {
    let id = '';
    if (typeof payload === 'string') id = payload;
    else if (payload && payload.id != null) id = String(payload.id);
    id = id.trim();
    if (!id) return { error: 'Message id is required.' };
    const serviceId = payload && typeof payload === 'object' ? payload.serviceId : undefined;
    const oauthPid =
      serviceId === 'gmail_2' || serviceId === 'google_2'
        ? 'google_2'
        : 'google';
    const token = await getValidOAuthToken(oauthPid);
    if (!token) return { error: navioGmailNotConnectedMessage(oauthPid) };

    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    if (!r.ok) return { error: d.error?.message || 'Gmail API error' };

    const headers = d.payload?.headers || [];
    const get = (name) => headers.find(h => h.name === name)?.value || '';
    return {
      body:    navioGmailExtractPlainBody(d.payload),
      subject: get('Subject'),
      from:    get('From'),
      to:      get('To'),
      date:    get('Date'),
      snippet: d.snippet || '',
    };
  } catch (e) { return { error: e.message }; }
});

/**
 * Fix UTF-8 text that was mis-decoded as Latin-1/byte code units (mojibake), e.g.
 * "We'll" as We + U+00E2 U+0080 U+0099 + ll, or "×" as U+00C3 U+0097.
 */
function navioRepairUtf8Mojibake(s) {
  if (!s || typeof s !== 'string') return s;
  if (!/[ÃÂâ]/.test(s) && !/[\u0080-\u009F]{2}/.test(s)) return s;
  let allByte = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) {
      allByte = false;
      break;
    }
  }
  let t = s;
  if (allByte) {
    try {
      const buf = Buffer.allocUnsafe(t.length);
      for (let i = 0; i < t.length; i++) buf[i] = t.charCodeAt(i);
      const repaired = buf.toString('utf8');
      const ffd = (repaired.match(/\uFFFD/g) || []).length;
      if (ffd <= Math.max(1, Math.ceil(t.length / 35))) {
        const noise = (x) => (x.match(/[ÃÂâ]|[\u0080-\u009F]/g) || []).length;
        if (noise(repaired) < noise(s) || repaired.length < s.length - 2) t = repaired;
      }
    } catch {
      /* keep t */
    }
  }
  t = t
    .replace(/\u00E2\u0080\u0099/g, '\u2019')
    .replace(/\u00E2\u0080\u0098/g, '\u2018')
    .replace(/\u00E2\u0080\u009C/g, '\u201C')
    .replace(/\u00E2\u0080\u009D/g, '\u201D')
    .replace(/\u00E2\u0080\u0094/g, '\u2014')
    .replace(/\u00E2\u0080\u00A6/g, '\u2026')
    .replace(/\u2019\u2019/g, '\u2019')
    .replace(/\u2018\u2018/g, '\u2018')
    .replace(/â€™/g, '\u2019')
    .replace(/â€œ/g, '\u201C')
    .replace(/â€/g, '\u201D')
    .replace(/â€"/g, '\u2014')
    .replace(/â€¦/g, '\u2026');
  return t;
}

function gmailBase64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** RFC 2822 plain-text message: headers, blank line, then body (CRLF). */
function gmailBuildPlainTextMime({ toAddr, cc, bcc, subject, inReplyTo, references, bodyText }) {
  const headerLines = [`To: ${toAddr}`, `Subject: ${subject || '(no subject)'}`];
  if (cc && String(cc).trim()) headerLines.push(`Cc: ${String(cc).trim()}`);
  if (bcc && String(bcc).trim()) headerLines.push(`Bcc: ${String(bcc).trim()}`);
  if (inReplyTo) headerLines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headerLines.push(`References: ${references}`);
  headerLines.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  );
  const normalizedBody = (bodyText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n');
  return headerLines.join('\r\n') + '\r\n\r\n' + normalizedBody;
}

/** Pick the send-as row most likely to hold the user's main signature. */
function gmailPickSendAsRow(sendAsList) {
  const list = (sendAsList || []).filter(Boolean);
  if (!list.length) return null;
  const withSig = list.filter((sa) => (sa.signature || '').trim());
  const pool = withSig.length ? withSig : list;
  return (
    pool.find((sa) => sa.isDefault === true) ||
    pool.find((sa) => sa.isPrimary === true) ||
    pool.find((sa) => sa.verificationStatus === 'accepted') ||
    pool[0]
  );
}

/** Gmail stores signatures as HTML; plain-text drafts need a readable text form. */
function gmailHtmlSignatureToPlain(html) {
  if (!html || typeof html !== 'string') return '';
  let s = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|tr|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<\s*li\s*>/gi, ' • ')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  s = s.replace(/&#(\d+);/g, (m, n) => {
    const c = parseInt(n, 10);
    return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => {
    const c = parseInt(h, 16);
    return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
  });
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return navioRepairUtf8Mojibake(s);
}

async function gmailFetchSendAsSignaturePlainResult(token) {
  if (!token) return { signature: '', error: 'no_token' };
  try {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!r.ok) {
      const msg = d.error?.message || `HTTP ${r.status}`;
      const needsReconnect = r.status === 403 || /insufficient|Permission|accessNotConfigured|authentication/i.test(msg);
      console.warn('[Navio] Gmail settings/sendAs:', msg);
      return { signature: '', error: msg, needsReconnect };
    }
    if (!Array.isArray(d.sendAs) || !d.sendAs.length) {
      console.warn('[Navio] Gmail sendAs list empty');
      return { signature: '', error: 'empty_sendAs' };
    }
    const row = gmailPickSendAsRow(d.sendAs);
    const html = (row && row.signature) || '';
    if (!html.trim()) {
      console.warn('[Navio] Gmail sendAs: no HTML signature on', row?.sendAsEmail || '(row)');
    }
    const signature = gmailHtmlSignatureToPlain(html);
    if (!signature.trim() && html.replace(/<img[^>]*>/gi, '').replace(/<[^>]+>/g, '').trim()) {
      console.warn('[Navio] Gmail signature may be image-only; plain-text draft cannot show it.');
    }
    return { signature, sendAsEmail: row?.sendAsEmail || '' };
  } catch (e) {
    console.warn('[Navio] Gmail sendAs:', e.message);
    return { signature: '', error: e.message };
  }
}

function parseEmailAddressFromHeader(fromVal) {
  if (!fromVal) return '';
  const m = fromVal.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const m2 = fromVal.match(/[\w.+-]+@[\w.-]+\.[A-Za-z0-9-]+/);
  return m2 ? m2[0] : fromVal.trim();
}

/**
 * Rewrite an existing Gmail draft's plain-text body (same threading headers).
 * Used when the user edits the draft in the assistant before Send.
 */
async function gmailUpdateDraftApi(draftId, bodyText, args = {}) {
  const { token, error } = await resolveGmailToolToken(args);
  if (!token) return { error: error || navioGmailNotConnectedMessage(gmailToolOAuthProviderId(args)) };
  const id = (draftId || '').trim();
  if (!id) return { error: 'draft_id is required.' };
  const text = navioRepairUtf8Mojibake((bodyText || '').trim());
  if (!text) return { error: 'body is empty.' };

  const getRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const draft = await getRes.json();
  if (!getRes.ok) {
    return { error: draft.error?.message || 'Could not load draft.' };
  }

  const headers = draft.message?.payload?.headers || [];
  const get = (name) =>
    headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const toAddr = get('To');
  const cc = get('Cc');
  const bcc = get('Bcc');
  const subject = get('Subject');
  const inReplyTo = get('In-Reply-To');
  const references = get('References');

  if (!toAddr) return { error: 'Draft is missing a To: header.' };

  const mime = gmailBuildPlainTextMime({
    toAddr,
    cc,
    bcc,
    subject,
    inReplyTo,
    references,
    bodyText: text
  });
  const raw = gmailBase64UrlEncode(mime);
  const threadId = draft.message?.threadId;

  const updateRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        message: threadId ? { raw, threadId } : { raw }
      })
    }
  );
  const upd = await updateRes.json();
  if (!updateRes.ok) {
    return { error: upd.error?.message || 'Failed to update draft.' };
  }
  return { success: true, draftId: id };
}

// ── Gmail API: send a draft ────────────────────────────────────────────────
ipcMain.handle('gmail-send-draft', async (_, { draftId }) => {
  try {
    const token = await getValidOAuthToken('google');
    if (!token) return { error: navioGmailNotConnectedMessage('google') };
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: draftId })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || 'Failed to send draft.' };
    return { success: true, messageId: data.id };
  } catch (e) { return { error: e.message }; }
});

// ── Gmail API: update draft body (assistant edits before send) ─────────────
ipcMain.handle('gmail-update-draft', async (_, { draftId, body }) => {
  try {
    return await gmailUpdateDraftApi(draftId, body, {});
  } catch (e) {
    return { error: e.message };
  }
});

/** Plain-text signature from Gmail Settings → Send mail as (for assistant draft cards). */
ipcMain.handle('gmail-get-signature-plain', async () => {
  try {
    const token = await getValidOAuthToken('google');
    if (!token) return { error: navioGmailNotConnectedMessage('google') };
    return await gmailFetchSendAsSignaturePlainResult(token);
  } catch (e) {
    return { error: e.message };
  }
});

// ── Gmail API: delete a draft ──────────────────────────────────────────────
ipcMain.handle('gmail-delete-draft', async (_, { draftId }) => {
  try {
    const token = await getValidOAuthToken('google');
    if (!token) return { error: navioGmailNotConnectedMessage('google') };
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 204 || res.ok) return { success: true };
    const data = await res.json().catch(() => ({}));
    return { error: data.error?.message || 'Failed to delete draft.' };
  } catch (e) { return { error: e.message }; }
});

// ── Gmail API: create a threaded reply draft (no UI automation) ─────────────
ipcMain.handle('gmail-create-reply-draft', async (_, { messageId, body: replyBody }) => {
  try {
    const token = await getValidOAuthToken('google');
    if (!token) return { error: navioGmailNotConnectedMessage('google') };

    const mid = (messageId || '').trim();
    if (!mid) return { error: 'Missing Gmail message id' };

    const text = navioRepairUtf8Mojibake((replyBody || '').trim());
    if (!text) return { error: 'Empty reply body' };

    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    if (!r.ok) return { error: d.error?.message || 'Gmail API error' };

    const threadId = d.threadId;
    const headers = d.payload?.headers || [];
    const get = (name) =>
      headers.find((h) => h.name && h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const from = get('From');
    const replyTo = get('Reply-To');
    const subject = get('Subject');
    const msgIdHdr = get('Message-ID') || get('Message-Id');
    const prevRefs = (get('References') || '').trim();

    const toAddr = parseEmailAddressFromHeader(replyTo || from);
    if (!toAddr) return { error: 'Could not determine reply recipient' };

    let subjOut = subject || '(no subject)';
    if (!/^re:\s/i.test(subjOut)) subjOut = 'Re: ' + subjOut;

    const refs = [prevRefs, msgIdHdr].filter(Boolean).join(' ').trim();

    const mime = gmailBuildPlainTextMime({
      toAddr,
      subject: subjOut,
      inReplyTo: msgIdHdr || '',
      references: refs,
      bodyText: text
    });
    const raw = gmailBase64UrlEncode(mime);

    const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: threadId ? { raw, threadId } : { raw }
      })
    });
    const draftData = await draftRes.json();
    if (!draftRes.ok) {
      return { error: draftData.error?.message || 'Failed to create Gmail draft' };
    }

    return {
      success: true,
      draftId: draftData.id,
      messageId: draftData.message?.id,
      threadId: draftData.message?.threadId || threadId
    };
  } catch (e) {
    return { error: e.message };
  }
});

// Update connector-get-keys to also include IMAP-connected services
// (already done above, but also update connector-query to use IMAP)

// ── Inbox scanner — reads email list from open tab via JS injection ──────────
// No tokens or OAuth needed — uses the user's existing logged-in browser session.
ipcMain.handle('scan-email-inbox', async (event, { webContentsId }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { error: 'Tab not found' };

    const url = wc.getURL?.() || '';
    let script;

    if (url.includes('mail.google.com')) {
      // Gmail inbox — reads email rows from the thread list
      script = `(function() {
        try {
          const rows = Array.from(document.querySelectorAll('tr.zA, tr[jsaction*="mousedown"]')).slice(0, 20);
          return rows.map(row => {
            const senderEl = row.querySelector('[email]');
            const sender = senderEl?.getAttribute('email') || senderEl?.innerText?.trim() || '';
            const senderName = senderEl?.getAttribute('name') || senderEl?.innerText?.trim() || '';
            const subjectEl = row.querySelector('.y6, [data-thread-id] .bog, span.bqe');
            const subject = subjectEl?.innerText?.trim() || '';
            const snippetEl = row.querySelector('.y2, .xJNT9');
            const snippet = snippetEl?.innerText?.trim() || '';
            const unread = row.classList.contains('zE') || row.querySelector('.zF')?.parentElement?.classList?.contains('zE') || false;
            const dateEl = row.querySelector('.xW span, .xW');
            const date = dateEl?.getAttribute('title') || dateEl?.innerText?.trim() || '';
            return { sender, senderName, subject, snippet, unread, date };
          }).filter(e => e.subject && e.subject.length > 0);
        } catch(e) { return []; }
      })()`;
    } else if (url.includes('outlook.live.com') || url.includes('outlook.office')) {
      script = `(function() {
        try {
          const items = Array.from(document.querySelectorAll('[role="option"], [data-convid]')).slice(0, 20);
          return items.map(item => {
            const sender = item.querySelector('[class*="sender"], [data-testid*="sender"]')?.innerText?.trim() || '';
            const subject = item.querySelector('[class*="subject"], [data-testid*="subject"]')?.innerText?.trim() || '';
            const snippet = item.querySelector('[class*="preview"], [data-testid*="preview"]')?.innerText?.trim() || '';
            const unread = item.getAttribute('aria-label')?.toLowerCase().includes('unread') || false;
            return { sender, subject, snippet, unread, date: '' };
          }).filter(e => e.subject && e.subject.length > 0);
        } catch(e) { return []; }
      })()`;
    } else {
      return { error: 'Unsupported email service — open Gmail or Outlook first' };
    }

    const emails = await wc.executeJavaScript(script);
    return { emails: Array.isArray(emails) ? emails : [] };
  } catch (e) {
    return { error: e.message };
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// detect-browsers and import-bookmarks moved to ./browser-import-ipc.js
registerBrowserImportIpc(ipcMain);

// Filesystem / download-folder IPCs moved to electron/file-ipc.js.
// The set: get-downloads-path, open-downloads-folder, show-in-folder,
// open-file-path, navio-path-to-file-url.
require('./file-ipc').registerFileIpc(ipcMain, { app, shell });

// Reading list IPC moved to ./reading-list-ipc.js
registerReadingListIpc(ipcMain);

// Password vault IPC moved to ./passwords-ipc.js
// maybeImportOemStremioCredentials is imported from ./passwords-ipc.js and called in app.whenReady().
registerPasswordsIpc(ipcMain);


// Webview context menu moved to ./context-menu-ipc.js
registerContextMenuIpc(ipcMain, { getMainWindow: () => mainWindow, loadConfig, app });

registerBookmarksIpc(ipcMain, { app, loadConfig });
registerHistoryIpc(ipcMain, { app });
registerWebviewActionsIpc(ipcMain, { getMainWindow: () => mainWindow });
registerExtensionsIpc(ipcMain, { app, getMainWindow: () => mainWindow });
registerSyncIpc(ipcMain, { app, loadConfig, saveConfig });
registerProfilesIpc(ipcMain, { profilesBase: NAVIO_PROFILES_BASE });

app.whenReady().then(async () => {
  console.log('[navio] main.js v7 loaded; system prompt injected from main process');
  await clearRendererCodeCachesIfDev(app, session, fs, path);

  store = createStore(app.getPath('userData'));

  try {
    maybeImportOemStremioCredentials();
  } catch (e) {
    console.warn('[navio] OEM Stremio credential import:', e.message);
  }

  try {
    navioCrashReporter.applyCrashReportingFromConfig(loadConfig());
  } catch (_) {
    /* ignore */
  }

  setupSessionInfrastructure({
    app,
    getMainWindow: () => mainWindow,
    loadConfig,
    saveConfig
  });

  installNavioWebviewGuestPopupRouting();
  installNavioGuestAssistantShortcutForward();
  installNavioGuestZoomShortcutForward();
  installNavioGuestFindShortcutForward();

  createMainWindow();

  startNavioCloudSync(app, loadConfig, saveConfig, () => mainWindow);

  registerAgentPlanIpc(ipcMain, { store });
  registerMcpIpc(ipcMain, loadConfig, saveConfig);

  registerSearchSuggestionsIpc(ipcMain);
  registerSchedulerIpc(ipcMain);

  // Initialize MCP connections from persisted config
  const mcpCfg = loadConfig();
  if (mcpCfg.mcpEnabled && Array.isArray(mcpCfg.mcpServers)) {
    initMcpFromConfig(mcpCfg.mcpServers).catch(err => {
      console.error('[navio] MCP init error:', err.message);
    });
  }

  // Start scheduled task timers
  initScheduler();
  await loadPersistedExtensionsOnStartup(app);

  if (app.isPackaged) {
    try {
      const autoUpdater = navioEnsureAutoUpdaterWired();
      if (autoUpdater) {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }
    } catch (e) {
      console.warn('[navio] electron-updater not available:', e.message);
    }
  }
}).catch((err) => {
  console.error('[navio] whenReady failed:', err);
});

app.on('before-quit', () => {
  try {
    navioCrashReporter.shutdownSentry();
  } catch (_) {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  stopAllSchedulers();
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

Menu.setApplicationMenu(null);
