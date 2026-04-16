const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, MenuItem, globalShortcut, nativeTheme, clipboard, webContents: electronWebContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const secureConfig = require('./secure-config');
const { NAVIO_PARTITION_INCOGNITO } = require('./navio-partitions');
const { clearRendererCodeCachesIfDev } = require('./clear-code-cache-dev');
const { resolveTranslateTargetLang } = require('./translate-locale');
const { createStore } = require('./navio-store');
const { setupSessionInfrastructure, recordNavioPopupBlocked } = require('./session-setup');
const sitePerms = require('./site-permissions');
const { loadConfig, saveConfig } = require('./config-store');
const { registerBookmarksIpc } = require('./bookmarks-ipc');
const { registerHistoryIpc } = require('./history-ipc');
const { registerWebviewActionsIpc } = require('./webview-actions-ipc');
const { registerExtensionsIpc, loadPersistedExtensionsOnStartup } = require('./extensions-ipc');
const { registerSyncIpc, startNavioCloudSync } = require('./navio-sync-ipc');
const { registerProfilesIpc } = require('./navio-profiles-ipc');
const { registerAgentPlanIpc } = require('./navio-agent-ipc');
const { NAVIO_TOOLS, toOpenAITools, toAnthropicTools, toGeminiTools } = require('./navio-tools');
const { getAccessibilityTree, clickByRef, typeByRef, selectByRef, getRefMap, clearRefMap } = require('./a11y-tree');
const { startMonitoring, getConsoleMessages, getNetworkRequests, stopMonitoring } = require('./cdp-inspector');
const { loadWorkflow, saveWorkflow, listWorkflows, deleteWorkflow } = require('./navio-workflows');
const { getMcpTools, callMcpTool, isMcpTool, initFromConfig: initMcpFromConfig, registerMcpIpc } = require('./navio-mcp');
const { initScheduler, registerSchedulerIpc, stopAll: stopAllSchedulers } = require('./navio-scheduler');
const { shouldBlockWebPopup } = require('./ad-block-patterns');

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

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function redactPII(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b\d{3}\s?\d{2}\s?\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED-CARD]');
  return t;
}

function messageContentToPlainString(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (!p) return '';
      if (p.type === 'text') return String(p.text || '');
      if (p.type === 'image_url') return '[image]';
      if (p.type === 'navio_pdf') return `[PDF: ${p.filename || 'file.pdf'}]`;
      return '';
    })
    .join('\n');
}

/** OpenAI / custom chat: replace internal parts providers do not understand. */
function normalizeMessagesForOpenAI(messages) {
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const next = [];
    for (const part of m.content) {
      if (!part) continue;
      if (part.type === 'navio_pdf') {
        next.push({
          type: 'text',
          text:
            `[Attached PDF: ${part.filename || 'document.pdf'}] This chat mode does not embed PDF bytes for OpenAI. Switch **Settings → AI** to **Anthropic** or **Google** to analyze PDFs, or paste text from the document.`
        });
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
      sandbox: false
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
// The AI is allowed to READ emails via the connector API (read-only scope tokens)
// but it must NEVER compose, send, reply to, forward, or delete emails —
// even when the user has an email tab open. This blocklist is enforced at the
// IPC level so it holds regardless of system-prompt instructions or auto-execute mode.
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

// ── Browser Memory ───────────────────────────────────────────────────────────
function memoryPath() {
  return path.join(app.getPath('userData'), 'navio-memory.json');
}
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(memoryPath(), 'utf8')); }
  catch { return { facts: [] }; }
}
function saveMemory(data) {
  fs.writeFileSync(memoryPath(), JSON.stringify(data, null, 2), 'utf8');
}

/** Drop facts older than memoryRetentionDays (from config); 0 = keep forever. */
function pruneMemoryByRetention() {
  try {
    const cfg = loadConfig();
    const days = Number(cfg.memoryRetentionDays) || 0;
    if (days <= 0) return;
    const mem = loadMemory();
    const facts = mem.facts || [];
    const cutoff = Date.now() - days * 86400000;
    const next = facts.filter((f) => {
      const t = new Date(f.createdAt || f.timestamp || 0).getTime();
      if (!t || Number.isNaN(t)) return true;
      return t >= cutoff;
    });
    if (next.length !== facts.length) {
      mem.facts = next;
      saveMemory(mem);
    }
  } catch (e) {
    console.warn('pruneMemoryByRetention', e.message);
  }
}

function buildMemoryBlock() {
  try {
    pruneMemoryByRetention();
    const mem = loadMemory();
    if (!mem.facts || mem.facts.length === 0) return '';
    return '\n\nBROWSER MEMORY (remembered facts about this user — use naturally):\n' +
      mem.facts.map((f) => `- ${f.content}${f.sourceUrl ? ` (source: ${f.sourceUrl})` : ''}`).join('\n');
  } catch { return ''; }
}

// ── Learning Profiles ─────────────────────────────────────────────────────────
const PROFILE_EXTENSIONS = {
  default: '',
  developer: '\n\nPROFILE: Developer\n- Prioritize code accuracy, technical depth, and doc links.\n- Use code blocks liberally. Compare tools. Walk through debugging systematically.',
  researcher: '\n\nPROFILE: Researcher\n- Prioritize accuracy, sources, and analytical depth over brevity.\n- Always cite sources. Challenge assumptions. Flag uncertain or contested claims.',
  creator: '\n\nPROFILE: Creator\n- Help with writing, design thinking, and creative tasks.\n- Be generative — offer variations and unexpected angles. Polish tone and clarity.'
};

function buildProfileBlock() {
  try {
    const cfg = loadConfig();
    return PROFILE_EXTENSIONS[cfg.aiProfile] || '';
  } catch { return ''; }
}

// ── Parse and save <navio-memory> blocks from AI responses ───────────────────
function extractAndSaveMemory(content) {
  if (!content || typeof content !== 'string') return;
  const match = content.match(/<navio-memory>([\s\S]*?)<\/navio-memory>/i);
  if (!match) return;
  const facts = match[1].split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('save:'))
    .map(l => l.slice(5).trim())
    .filter(Boolean);
  if (facts.length === 0) return;
  const mem = loadMemory();
  if (!mem.facts) mem.facts = [];
  let changed = false;
  for (const fact of facts) {
    let content = fact;
    let sourceUrl = '';
    const urlM = String(fact).match(/\|\s*url\s*=\s*(\S+)/i);
    if (urlM) {
      content = String(fact).replace(/\|\s*url\s*=\s*\S+/i, '').trim();
      sourceUrl = urlM[1];
    }
    if (!mem.facts.find(f => f.content === content)) {
      mem.facts.push({
        id: Date.now() + Math.random(),
        content,
        type: 'auto',
        category: 'general',
        sourceUrl: sourceUrl || undefined,
        createdAt: new Date().toISOString()
      });
      changed = true;
    }
  }
  if (changed) saveMemory(mem);
}

// ── Memory IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('memory-get', () => {
  pruneMemoryByRetention();
  return loadMemory();
});
ipcMain.handle('memory-add', (_, { content }) => {
  const mem = loadMemory();
  if (!mem.facts) mem.facts = [];
  if (!content || mem.facts.find(f => f.content === content)) return { ok: false };
  mem.facts.push({ id: Date.now(), content, type: 'manual', createdAt: new Date().toISOString() });
  saveMemory(mem);
  return { ok: true };
});
ipcMain.handle('memory-delete', (_, { id }) => {
  const mem = loadMemory();
  mem.facts = (mem.facts || []).filter(f => String(f.id) !== String(id));
  saveMemory(mem);
  return { ok: true };
});
ipcMain.handle('memory-clear', () => {
  saveMemory({ facts: [] });
  return { ok: true };
});

ipcMain.handle('memory-search', (_, { query }) => {
  const q = (query || '').toLowerCase().trim();
  pruneMemoryByRetention();
  const mem = loadMemory();
  const facts = mem.facts || [];
  if (!q) return { facts };
  return {
    facts: facts.filter((f) => {
      const blob = `${f.content || ''} ${f.sourceUrl || ''} ${f.category || ''}`.toLowerCase();
      return blob.includes(q);
    })
  };
});

// Replaces ONLY the first system message with NAVIO_SYSTEM_PROMPT + memory + profile.
// Other system messages (page context, selection, tab list, etc.) are preserved.
// Called in every IPC handler so the cached renderer's stale system prompt is ignored.
function injectSystemPrompt(messages) {
  const memBlock = buildMemoryBlock();
  const profileBlock = buildProfileBlock();
  const cfg = loadConfig();
  const basePrompt = cfg.aiUseToolCalling !== false ? NAVIO_SYSTEM_PROMPT : NAVIO_SYSTEM_PROMPT_LEGACY;
  const fullPrompt = basePrompt + memBlock + profileBlock;
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
 * Route guest <webview> window.open / target=_blank into Navio tabs instead of a
 * standalone BrowserWindow (Drive "new window", Gmail account switch, OAuth).
 * Must register on the guest as early as possible: did-attach-webview alone is
 * not reliable on current Electron, so we also use app 'web-contents-created'.
 */
function bindNavioGuestWindowOpenOnce(guestContents) {
  if (!guestContents || navioGuestWindowOpenBound.has(guestContents)) return;
  navioGuestWindowOpenBound.add(guestContents);

  guestContents.setWindowOpenHandler((details) => {
    const url = (details && details.url) || '';
    if (/^(mailto|tel|sms|callto):/i.test(url)) {
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
    const openUrl = url && url !== '' ? url : 'about:blank';
    const mw = mainWindow;
    if (!mw || (typeof mw.isDestroyed === 'function' && mw.isDestroyed())) {
      return { action: 'deny' };
    }
    try {
      mw.webContents.send('open-url-in-new-tab', { url: openUrl, incognito });
    } catch {
      /* ignore */
    }
    return { action: 'deny' };
  });
}

function installNavioWebviewGuestPopupRouting() {
  if (navioWebviewGuestPopupRoutingInstalled) return;
  navioWebviewGuestPopupRoutingInstalled = true;
  app.on('web-contents-created', (_event, contents) => {
    try {
      if (typeof contents.getType === 'function' && contents.getType() === 'webview') {
        bindNavioGuestWindowOpenOnce(contents);
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
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });


  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

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

ipcMain.handle('get-config', () => loadConfig());
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
  return true;
});

ipcMain.handle('get-api-key-for-settings', () => {
  return secureConfig.getApiKey(app.getPath('userData'));
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

async function performAiFetch(cfg, apiKey, messages, useStream, fetchOpts = {}) {
  const provider = cfg.aiProvider || 'openai';
  const model = cfg.aiModel || 'gpt-5.4';
  const endpoint = cfg.customEndpoint || '';
  const ntpBrief = !!fetchOpts.ntpBrief;

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
    body = JSON.stringify(geminiBody);
  } else {
    return { error: `Unknown provider: ${provider}` };
  }

  const response = await fetch(url, { method: 'POST', headers, body });

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
  if (provider === 'openai' || provider === 'custom') {
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
  // Detect screenshot / image results and format as multimodal content
  const hasImage = result && result.image && result.mimeType;

  if (hasImage) {
    const dataUri = `data:${result.mimeType};base64,${result.image}`;
    const textPart = JSON.stringify({ success: true, note: 'Screenshot captured. Analyze the image to understand the page layout and identify click targets by xy coordinates.' });

    if (provider === 'openai' || provider === 'custom') {
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
  if (provider === 'openai' || provider === 'custom') {
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
 * Wait for an IPC ack from the renderer within a timeout.
 * Used for navigate actions that must go through TabManager in the renderer.
 */
function waitForRendererAck(sender, channel, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      resolve({ error: 'Navigation timed out' });
    }, timeoutMs);
    const handler = (event, result) => {
      if (event.sender === sender) {
        clearTimeout(timer);
        ipcMain.removeListener(channel, handler);
        resolve(result || { success: true });
      }
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

function navioGmailApiTransientError(msg) {
  const s = String(msg || '');
  return /429|503|502|resource has been exhausted|rateLimitExceeded|userRateLimitExceeded|backendError|internal error|unavailable/i.test(
    s
  );
}

/** Retry performAiFetch on transient provider/network errors so one hiccup does not kill the whole agent run. */
async function performAiFetchResilient(cfg, apiKey, messages, fetchOpts, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await performAiFetch(cfg, apiKey, messages, false, fetchOpts);
    if (!last.error) return last;
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
async function executeToolLoop(cfg, apiKey, messages, wc, sender, maxSteps) {
  const configured = Number(cfg.aiAgentMaxToolSteps);
  maxSteps = Math.min(500, Math.max(50, Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 200));
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

  const TAB_TOOLS = new Set(['open_tab', 'close_tab', 'switch_tab', 'list_tabs']);

  for (let step = 0; step < maxSteps; step++) {
    const result = await performAiFetchResilient(cfg, apiKey, currentMessages, { tools });

    if (result.error) return finishAgentRun({ error: result.error, toolLog });

    // Emit any intermediate reasoning text the model produced alongside tool calls
    if (result.content && result.toolCalls && result.toolCalls.length) {
      sender.send('tool-reasoning', { step, text: result.content });
    }

    if (!result.toolCalls || !result.toolCalls.length) {
      if (result.content) extractAndSaveMemory(result.content);
      return finishAgentRun({ content: result.content || '', toolLog });
    }

    currentMessages = appendAssistantToolCalls(currentMessages, result, provider);

    for (const tc of result.toolCalls) {
      console.log(`[navio] tool-loop step ${step}: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 120)})`);

      // Email safety: block clicking send buttons on mail hosts
      if (tc.name === 'click') {
        const clickText = tc.arguments.text || '';
        if (isEmailWriteAction('click', { selector: `text=${clickText}` })) {
          const toolResult = { error: 'Blocked: Navio cannot click Send on email services. Only drafts are allowed.' };
          currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
          toolLog.push({ tool: tc.name, args: tc.arguments, result: toolResult, blocked: true });
          sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
          continue;
        }
      }

      // Navigate: must go through the renderer for NTP overlay handling
      if (tc.name === 'navigate') {
        const navUrl = (tc.arguments && tc.arguments.url) || '';
        const gmIntercept = await maybeLoadGmailMessageUrlViaApi('navigate', navUrl);
        if (gmIntercept) {
          const toolResult = gmIntercept.result;
          currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
          toolLog.push({ tool: 'navigate', args: tc.arguments, result: toolResult, gmail_api_intercept: true });
          sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
          continue;
        }
        const browseIntercept = await maybeInterceptGmailBrowseNavForAgent(navUrl);
        if (browseIntercept) {
          const toolResult = browseIntercept.result;
          currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
          toolLog.push({
            tool: 'navigate',
            args: tc.arguments,
            result: toolResult,
            gmail_api_intercept: true,
            gmail_browse_intercept: true
          });
          sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
          continue;
        }
        sender.send('tool-navigate', { url: tc.arguments.url, stepIndex: step });
        const navResult = await waitForRendererAck(sender, 'tool-navigate-ack', 60000);
        currentMessages = appendToolResult(currentMessages, tc, navResult, provider);
        toolLog.push({ tool: 'navigate', args: tc.arguments, result: navResult });
        sender.send('tool-progress', { step, tool: tc.name, result: navResult });

        if (!navResult.error && activeWc) {
          await waitForWebContentsSettled(activeWc);
        }

        // Auto-screenshot after navigation for visual context
        if (cfg.aiAutoScreenshotAfterNavigate && !navResult.error && activeWc) {
          try {
            await new Promise(r => setTimeout(r, 500));
            const autoScreenshot = await toolExecutors.screenshot(activeWc);
            if (autoScreenshot.image) {
              sender.send('tool-progress', { step, tool: 'screenshot', result: { success: true, auto: true } });
              currentMessages = [...currentMessages, {
                role: provider === 'google' ? 'user' : 'system',
                content: provider === 'openai' || provider === 'custom'
                  ? [
                      { type: 'text', text: '[Auto-screenshot after navigation — use this to understand the page visually]' },
                      { type: 'image_url', image_url: { url: `data:${autoScreenshot.mimeType};base64,${autoScreenshot.image}`, detail: 'high' } }
                    ]
                  : '[Auto-screenshot captured after navigation]'
              }];
            }
          } catch { /* non-fatal */ }
        }
        continue;
      }

      // Planning mode: propose_plan pauses execution and awaits user approval
      if (tc.name === 'propose_plan') {
        sender.send('tool-propose-plan', tc.arguments || {});
        const planResult = await waitForRendererAck(sender, 'tool-propose-plan-ack', 300000); // 5 min timeout
        currentMessages = appendToolResult(currentMessages, tc, planResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: planResult });
        sender.send('tool-progress', { step, tool: tc.name, result: planResult });
        if (planResult.cancelled) {
          return finishAgentRun({ content: 'Plan was cancelled by the user.', toolLog });
        }
        continue;
      }

      // Tab management tools: go through the renderer's TabManager
      if (TAB_TOOLS.has(tc.name)) {
        if (tc.name === 'open_tab') {
          const openUrl = tc.arguments?.url || '';
          const gmIntercept = await maybeLoadGmailMessageUrlViaApi('open_tab', openUrl);
          if (gmIntercept) {
            const toolResult = gmIntercept.result;
            currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
            toolLog.push({ tool: 'open_tab', args: tc.arguments, result: toolResult, gmail_api_intercept: true });
            sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
            continue;
          }
          const browseIntercept = await maybeInterceptGmailBrowseNavForAgent(openUrl);
          if (browseIntercept) {
            const toolResult = browseIntercept.result;
            currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
            toolLog.push({
              tool: 'open_tab',
              args: tc.arguments,
              result: toolResult,
              gmail_api_intercept: true,
              gmail_browse_intercept: true
            });
            sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
            continue;
          }
        }
        const tabResult = await executeTabTool(tc, sender);
        // switch_tab returns a new webContentsId — update activeWc
        if (tc.name === 'switch_tab' && tabResult.webContentsId) {
          const newWc = electronWebContents.fromId(tabResult.webContentsId);
          if (newWc) activeWc = newWc;
        }
        if (tc.name === 'open_tab' && tabResult.webContentsId) {
          const newWc = electronWebContents.fromId(tabResult.webContentsId);
          if (newWc) activeWc = newWc;
        }
        if (!tabResult.error && (tc.name === 'open_tab' || tc.name === 'switch_tab') && activeWc) {
          await waitForWebContentsSettled(activeWc);
        }
        currentMessages = appendToolResult(currentMessages, tc, tabResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: tabResult });
        sender.send('tool-progress', { step, tool: tc.name, result: tabResult });
        continue;
      }

      // MCP tools: proxy to the MCP server
      if (isMcpTool(tc.name)) {
        const mcpResult = await callMcpTool(tc.name, tc.arguments);
        currentMessages = appendToolResult(currentMessages, tc, mcpResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: mcpResult });
        sender.send('tool-progress', { step, tool: tc.name, result: mcpResult });
        continue;
      }

      // All other tools: execute directly against the active webContents
      const executor = toolExecutors[tc.name];
      if (!executor) {
        const toolResult = { error: `Unknown tool: ${tc.name}` };
        currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
        toolLog.push({ tool: tc.name, args: tc.arguments, result: toolResult });
        sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
        continue;
      }

      const toolResult = await executor(activeWc, tc.arguments);
      recordGmailMutationForDeferredNav(tc.name, toolResult);
      currentMessages = appendToolResult(currentMessages, tc, toolResult, provider);
      toolLog.push({ tool: tc.name, args: tc.arguments, result: toolResult });
      sender.send('tool-progress', { step, tool: tc.name, result: toolResult });
    }
  }
  return finishAgentRun({
    content:
      `[Agent step limit (${maxSteps}) reached — work may be incomplete. Say **continue** or **keep going** and Navio will resume (or raise aiAgentMaxToolSteps in navio-config.json, max 500).]`,
    toolLog,
    stepLimitReached: true
  });
}

/**
 * Execute a tab management tool by sending an IPC event to the renderer
 * and waiting for an acknowledgement with the result.
 */
async function executeTabTool(tc, sender) {
  const channelMap = {
    open_tab:   { send: 'tool-open-tab',   ack: 'tool-open-tab-ack' },
    close_tab:  { send: 'tool-close-tab',  ack: 'tool-close-tab-ack' },
    switch_tab: { send: 'tool-switch-tab', ack: 'tool-switch-tab-ack' },
    list_tabs:  { send: 'tool-list-tabs',  ack: 'tool-list-tabs-ack' }
  };
  const ch = channelMap[tc.name];
  if (!ch) return { error: `Unknown tab tool: ${tc.name}` };
  sender.send(ch.send, tc.arguments || {});
  const ackMs = tc.name === 'open_tab' ? 60000 : 30000;
  return await waitForRendererAck(sender, ch.ack, ackMs);
}

ipcMain.handle('ai-request', async (event, payload) => {
  const { messages, ntpBrief } = payload || {};
  const cfg = loadConfig();
  if (cfg.aiKillSwitch) {
    return { error: 'AI is turned off (kill switch). Enable it in Settings → AI.' };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey) {
    return { error: 'No API key configured. Add one in Settings → AI.' };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  if (!ntpBrief) {
    processed = injectSystemPrompt(processed);
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

ipcMain.handle('ai-request-stream', async (event, { messages }) => {
  const cfg = loadConfig();
  const sender = event.sender;
  if (cfg.aiKillSwitch) {
    sender.send('ai-stream-error', 'AI is turned off (kill switch).');
    return { ok: false };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey) {
    sender.send('ai-stream-error', 'No API key configured.');
    return { ok: false };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  processed = injectSystemPrompt(processed);
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
    if (fetchResult.error) return { error: fetchResult.error };
    if (!fetchResult.stream) return { error: 'Streaming unavailable for this provider.' };
    const streamProvider = fetchResult.provider || 'openai';
    const reader = fetchResult.stream.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let fullText = '';
    while (true) {
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

  try {
    // Collect the full response before sending to renderer so we can check the format
    let currentMessages = processed;
    let finalText = '';
    const MAX_FORMAT_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt++) {
      console.log(`[navio] ai-request-stream attempt ${attempt + 1}, model=${cfg.aiModel}, messages=${currentMessages.length}`);
      const fetchResult = await performAiFetch(cfg, apiKey, currentMessages, true);
      const collected = await collectStream(fetchResult);

      if (collected.error) {
        sender.send('ai-stream-error', collected.error);
        return { ok: false };
      }

      finalText = convertNavioActionsBlock(collected.content);
      console.log(`[navio] raw response (first 200): ${collected.content?.slice(0, 200)}`);
      console.log(`[navio] converted (first 200): ${finalText?.slice(0, 200)}`);

      if (!aiResponseHasBrokenActions(finalText) || attempt === MAX_FORMAT_RETRIES) break;

      console.log(`[navio] ACTION0 pattern detected (attempt ${attempt + 1}) — retrying with format fix`);
      currentMessages = buildActionFixMessages(currentMessages, finalText);
    }

    // Stream the final (possibly corrected) text to the renderer in chunks
    const CHUNK = 40;
    for (let i = 0; i < finalText.length; i += CHUNK) {
      sender.send('ai-stream-chunk', finalText.slice(i, i + CHUNK));
    }
    sender.send('ai-stream-done', {});
    return { ok: true };
  } catch (err) {
    sender.send('ai-stream-error', err.message);
    return { ok: false };
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
ipcMain.handle('ai-request-with-tools', async (event, { messages, webContentsId }) => {
  const cfg = loadConfig();
  if (cfg.aiKillSwitch) {
    return { error: 'AI is turned off (kill switch). Enable it in Settings → AI.' };
  }
  const apiKey = secureConfig.getApiKey(app.getPath('userData'));
  if (!apiKey) {
    return { error: 'No API key configured. Add one in Settings → AI.' };
  }

  let processed = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  processed = injectSystemPrompt(processed);

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

  try {
    return await executeToolLoop(cfg, apiKey, processed, wc, event.sender);
  } catch (err) {
    return { error: err.message };
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

ipcMain.handle('replace-selection-in-page', async (event, { webContentsId, text }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { ok: false, error: 'WebContents not found' };
    const payload = JSON.stringify(text == null ? '' : String(text));
    const res = await wc.executeJavaScript(`
      (() => {
        const replacement = ${payload};
        function tryInsert() {
          const ae = document.activeElement;
          if (!ae) return false;
          if (ae.isContentEditable || ae.getAttribute('contenteditable') === 'true') {
            try {
              if (ae.ownerDocument.execCommand('insertText', false, replacement)) return true;
            } catch (e) {}
          }
          if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') {
            try {
              const start = ae.selectionStart, end = ae.selectionEnd;
              if (typeof start === 'number' && typeof end === 'number') {
                const v = ae.value;
                const proto = ae.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                const next = v.slice(0, start) + replacement + v.slice(end);
                if (setter) setter.call(ae, next); else ae.value = next;
                const pos = start + replacement.length;
                ae.setSelectionRange(pos, pos);
                ae.dispatchEvent(new InputEvent('input', { bubbles: true, data: replacement }));
                ae.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            } catch (e) {}
          }
          try {
            return document.execCommand('insertText', false, replacement);
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
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    await new Promise((r) => setTimeout(r, 40));
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
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

async function navioGmailGetMessageForTool(token, messageId, maxBodyChars = 32000) {
  const r = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const d = await r.json();
  if (!r.ok) return { error: d.error?.message || 'Gmail API error' };
  const headers = d.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name === name)?.value || '';
  let body = navioGmailExtractPlainBody(d.payload);
  if (body.length > maxBodyChars) {
    body = `${body.slice(0, maxBodyChars)}\n\n… [body truncated by Navio — ask for a follow-up if needed]`;
  }
  return {
    id: messageId,
    subject: get('Subject'),
    from: get('From'),
    to: get('To'),
    date: get('Date'),
    snippet: d.snippet || '',
    body
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
 */
async function maybeLoadGmailMessageUrlViaApi(toolName, url) {
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

const toolExecutors = {
  async read_page(wc, args) {
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
            const sel = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="tab"],[role="option"],[role="switch"],[role="combobox"],[role="searchbox"]';
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
      const refResult = await clickByRef(wc, args.ref);
      if (refResult.success) await waitForOptionalNavigationAfterClick(wc, 2000);
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
      text: args.value || ''
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

  async screenshot(wc) {
    try {
      const img = await wc.capturePage();
      const buf = img.toJPEG(70);
      const b64 = buf.toString('base64');
      // Cap at ~200 KB
      if (b64.length > 200000) {
        const small = img.resize({ width: 1024 });
        const smallBuf = small.toJPEG(60);
        return { image: smallBuf.toString('base64'), mimeType: 'image/jpeg' };
      }
      return { image: b64, mimeType: 'image/jpeg' };
    } catch (e) {
      return { error: 'Screenshot failed: ' + e.message };
    }
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

  async run_workflow(wc, args) {
    try {
      const { loadWorkflow } = require('./navio-workflows');
      const workflow = loadWorkflow(args.name);
      if (!workflow) return { error: `Workflow "${args.name}" not found. Use list_tabs or check saved workflows.` };
      return { success: true, workflow_name: args.name, steps: workflow.steps.length, note: 'Workflow loaded. Execute the steps in order.' };
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
      return {
        results: data.results || [],
        total: data.total || 0,
        next_page_token: nextTok,
        /** So the shell can open mail.google.com in the same account slot as the API (u/0 vs u/1). */
        gmail_service_id: oauthPid === 'google_2' ? 'gmail_2' : 'gmail',
        note: `Found ${n} email(s) matching "${query}".${nextTok ? ' More available — call gmail_search again with the same query and page_token set to next_page_token.' : ''}`
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
      return data;
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
      return {
        drafts,
        count: n,
        next_page_token: nextTok,
        note:
          `Loaded ${n} draft(s) with bodies and attachment filenames via API (no Gmail UI).` +
          (nextTok
            ? ' More drafts: call gmail_list_drafts again with the same max_results and page_token set to next_page_token.'
            : '')
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
  }
};

/**
 * Agent tool loop: opening mail.google.com to “browse” Gmail is fragile (SPA, nested scroll).
 * Route Drafts to gmail_list_drafts; other labels to gmail_search. Single-message #inbox/ID is handled
 * separately by maybeLoadGmailMessageUrlViaApi.
 */
async function maybeInterceptGmailBrowseNavForAgent(url) {
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
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: ['control'] });
        await new Promise((r) => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: ['control'] });
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
 */
async function navioDeepTypeBySelector(wc, selector, text) {
  const tSel = JSON.stringify(selector || '');
  const tVal = JSON.stringify(text || '');
  const tRes = await wc.executeJavaScript(`
    new Promise((resolve) => {
      const raw = ${tSel};
      const text = ${tVal};
      function findElInDoc(doc, sel) {
        if (!sel || !doc) return null;
        if (sel.startsWith('text=') || sel.startsWith('aria=')) {
          const prefix = sel.startsWith('text=') ? 'text=' : 'aria=';
          const q = sel.slice(prefix.length).trim().toLowerCase();
          for (const el of doc.querySelectorAll('input,textarea,select,[contenteditable]')) {
            const lbl = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').toLowerCase();
            if (lbl.includes(q)) return el;
          }
          if (sel.startsWith('aria=')) {
            for (const el of doc.querySelectorAll('[aria-label]')) {
              if ((el.getAttribute('aria-label') || '').toLowerCase().includes(q)) return el;
            }
          }
          return null;
        }
        try { return doc.querySelector(sel); } catch (e) { return null; }
      }
      function searchTypeDeep(win, depth) {
        if (!win || depth > 14) return null;
        const doc = win.document;
        const el = findElInDoc(doc, raw);
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
              doc.execCommand('selectAll', false, null);
              doc.execCommand('insertText', false, text);
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
          resolve({ ok: false, error: 'Element not found: ' + raw });
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
        return navioDeepTypeBySelector(wc, params.selector || '', params.text || '');
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
        // 3. Send Ctrl+V — Google Docs intercepts this and pastes with formatting
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        await new Promise(r => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp',   keyCode: 'V', modifiers: ['control'] });
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
      'https://www.googleapis.com/auth/drive.readonly',
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
      'https://www.googleapis.com/auth/drive.readonly',
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
      body: params.toString()
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
  // If not expired or no expiry set, return current token
  if (!entry.expiresAt || Date.now() < entry.expiresAt) {
    return decryptOAuthToken(entry.access);
  }
  // Expired — try to refresh
  return await refreshOAuthToken(providerId);
}

/** Gmail agent tools: primary Google vs second-account slot (google_2). */
function gmailToolOAuthProviderId(args) {
  const raw = args && (args.google_account != null ? args.google_account : args.account);
  const s = String(raw == null ? 'primary' : raw).toLowerCase().trim();
  if (s === 'secondary' || s === 'second' || s === '2' || s === 'google_2' || s === 'other') return 'google_2';
  return 'google';
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
    if (providerId === 'google') {
      const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const d = await r.json();
      return { email: d.email || '', name: d.name || '', avatar: d.picture || '' };
    }
    if (providerId === 'microsoft') {
      const r = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` }
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

  const authUrl = `${provider.authUrl}?${params.toString()}`;

  return new Promise((resolve) => {
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
        sandbox: false  // Google sign-in requires web APIs that Electron sandbox blocks
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
ipcMain.handle('oauth-status', () => {
  try {
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
    if (serviceId === 'gmail' || serviceId === 'gmail_2') return await queryGmail(token, query, options);
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
  const pageSize = options.pageSize || 6;
  const q = (query || '').trim();
  const isRecent = !q || q === '__NAVIO_RECENT__';
  const url = isRecent
    ? `https://www.googleapis.com/drive/v3/files?pageSize=${pageSize}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime desc&q=${encodeURIComponent('trashed=false')}`
    : `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`fullText contains '${q.replace(/'/g, "\\'")}'`)}&pageSize=${pageSize}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'Google Drive API error' };
  const results = (data.files || []).map((f) => ({
    name: f.name,
    type: f.mimeType?.split('.').pop() || f.mimeType,
    modified: f.modifiedTime,
    url: f.webViewLink || ''
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

// ── NTP: Stock market data (fetched from main process — no CORS) ──────────
// query1.finance.yahoo.com/v8/finance/chart works without crumb or cookies.
ipcMain.handle('ntp-stocks', async () => {
  const symbols = ['^GSPC', '^DJI', '^IXIC', 'AAPL', 'GOOGL', 'MSFT', 'NVDA', 'TSLA', 'BTC-USD', 'ETH-USD'];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  try {
    const results = await Promise.allSettled(symbols.map(async sym => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
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
    return good.length > 0 ? good : { error: 'No data returned' };
  } catch (e) {
    return { error: e.message };
  }
});

// ── NTP: Sports scores (ESPN unofficial API — free, no key required) ──────
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
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const events = (data?.events || []).slice(0, 6);
      return events.map(ev => {
        const comp = ev.competitions?.[0];
        const teams = comp?.competitors || [];
        const home = teams.find(t => t.homeAway === 'home');
        const away = teams.find(t => t.homeAway === 'away');
        const stateType = comp?.status?.type?.state || 'pre';
        const statusText = comp?.status?.type?.shortDetail || comp?.status?.type?.description || '';
        return {
          league: id,
          home: home?.team?.abbreviation || '',
          homeScore: home?.score ?? '',
          away: away?.team?.abbreviation || '',
          awayScore: away?.score ?? '',
          status: statusText,
          live: stateType === 'in',
          final: stateType === 'post',
        };
      });
    }));
    const games = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(g => g.home && g.away);
    return games.length > 0 ? games : { error: 'No games scheduled today' };
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

    // Fetch inbox message IDs
    const listResp = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=15',
      { headers: { Authorization: `Bearer ${token}` } }
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
            { headers: { Authorization: `Bearer ${token}` } }
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
    return { error: e.message };
  }
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
function gmailBuildPlainTextMime({ toAddr, subject, inReplyTo, references, bodyText }) {
  const headerLines = [`To: ${toAddr}`, `Subject: ${subject || '(no subject)'}`];
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
  const subject = get('Subject');
  const inReplyTo = get('In-Reply-To');
  const references = get('References');

  if (!toAddr) return { error: 'Draft is missing a To: header.' };

  const mime = gmailBuildPlainTextMime({
    toAddr,
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

ipcMain.handle('detect-browsers', async () => {
  const browsers = [];
  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';

  const candidates = [
    { id: 'chrome', name: 'Google Chrome', bookmarks: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks') },
    { id: 'edge', name: 'Microsoft Edge', bookmarks: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks') },
    { id: 'brave', name: 'Brave', bookmarks: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Bookmarks') },
    { id: 'opera', name: 'Opera', bookmarks: path.join(appData, 'Opera Software', 'Opera Stable', 'Bookmarks') },
    { id: 'vivaldi', name: 'Vivaldi', bookmarks: path.join(localAppData, 'Vivaldi', 'User Data', 'Default', 'Bookmarks') }
  ];

  for (const b of candidates) {
    try {
      if (fs.existsSync(b.bookmarks)) {
        const data = JSON.parse(fs.readFileSync(b.bookmarks, 'utf-8'));
        const count = countBookmarks(data.roots);
        browsers.push({ id: b.id, name: b.name, path: b.bookmarks, bookmarkCount: count });
      }
    } catch (e) {
      /* skip */
    }
  }
  return browsers;
});

function countBookmarks(roots) {
  let count = 0;
  function walk(node) {
    if (!node) return;
    if (node.type === 'url') {
      count++;
      return;
    }
    if (node.children) node.children.forEach(walk);
    if (typeof node === 'object' && !node.type && !node.children) {
      Object.values(node).forEach((v) => {
        if (v && typeof v === 'object') walk(v);
      });
    }
  }
  walk(roots);
  return count;
}

ipcMain.handle('import-bookmarks', async (event, browserPath) => {
  try {
    const data = JSON.parse(fs.readFileSync(browserPath, 'utf-8'));
    const bookmarks = [];
    function extract(node, folder) {
      if (!node) return;
      if (node.type === 'url') {
        bookmarks.push({ title: node.name, url: node.url, folder });
        return;
      }
      const folderName = node.name || folder;
      if (node.children) node.children.forEach((c) => extract(c, folderName));
      if (typeof node === 'object' && !node.type && !node.children) {
        Object.values(node).forEach((v) => {
          if (v && typeof v === 'object') extract(v, folder);
        });
      }
    }
    extract(data.roots, 'root');
    return { bookmarks };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-downloads-path', () => app.getPath('downloads'));

ipcMain.handle('show-in-folder', (_, filePath) => {
  try {
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Reading List ───────────────────────────────────────────────────────────
// Entries: [ { url, title, favicon, added, read } ] in <userData>/navio-reading-list.json

function _rlPath() { return path.join(app.getPath('userData'), 'navio-reading-list.json'); }
function _rlLoad() { try { return JSON.parse(fs.readFileSync(_rlPath(), 'utf8')); } catch { return []; } }
function _rlSave(list) { fs.writeFileSync(_rlPath(), JSON.stringify(list, null, 2), 'utf8'); }

ipcMain.handle('reading-list-add', (_, { url, title, favicon }) => {
  try {
    const list = _rlLoad();
    if (list.some(e => e.url === url)) return { ok: true, added: false };
    list.unshift({ url, title: title || url, favicon: favicon || null, added: new Date().toISOString(), read: false });
    if (list.length > 1000) list.splice(1000);
    _rlSave(list);
    return { ok: true, added: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('reading-list-get', () => {
  try { return { ok: true, list: _rlLoad() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('reading-list-remove', (_, { url }) => {
  try {
    _rlSave(_rlLoad().filter(e => e.url !== url));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('reading-list-mark-read', (_, { url }) => {
  try {
    const list = _rlLoad();
    const item = list.find(e => e.url === url);
    if (item) { item.read = true; _rlSave(list); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Password vault ─────────────────────────────────────────────────────────
// Credentials are stored in <userData>/navio-passwords.json.
// Passwords are encrypted with Electron's safeStorage (OS keychain / DPAPI).

function _pwdVaultPath() {
  return path.join(app.getPath('userData'), 'navio-passwords.json');
}

function _pwdLoad() {
  try { return JSON.parse(fs.readFileSync(_pwdVaultPath(), 'utf8')); } catch { return {}; }
}

function _pwdSave(vault) {
  fs.writeFileSync(_pwdVaultPath(), JSON.stringify(vault, null, 2), 'utf8');
}

function _pwdEncrypt(val) {
  const { safeStorage } = require('electron');
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(val).toString('base64');
  return Buffer.from(val, 'utf8').toString('base64');
}

function _pwdDecrypt(enc) {
  const { safeStorage } = require('electron');
  const buf = Buffer.from(enc, 'base64');
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8');
  } catch { return ''; }
}

function _pwdOrigin(url) {
  try { return new URL(url).origin; } catch { return url; }
}

ipcMain.handle('passwords-save', (_, { url, username, password }) => {
  try {
    const vault = _pwdLoad();
    const origin = _pwdOrigin(url);
    if (!vault[origin]) vault[origin] = [];
    const idx = vault[origin].findIndex(e => e.username === username);
    const entry = { username, password: _pwdEncrypt(password), created: new Date().toISOString() };
    if (idx >= 0) vault[origin][idx] = entry; else vault[origin].push(entry);
    _pwdSave(vault);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('passwords-list', () => {
  try {
    const vault = _pwdLoad();
    const entries = [];
    for (const [origin, list] of Object.entries(vault)) {
      for (const e of list) entries.push({ origin, username: e.username, created: e.created });
    }
    return { ok: true, entries };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('passwords-get', (_, { url }) => {
  try {
    const vault = _pwdLoad();
    const origin = _pwdOrigin(url);
    const list = vault[origin] || [];
    return { ok: true, entries: list.map(e => ({ username: e.username, password: _pwdDecrypt(e.password), created: e.created })) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('passwords-delete', (_, { origin, username }) => {
  try {
    const vault = _pwdLoad();
    if (vault[origin]) {
      vault[origin] = vault[origin].filter(e => e.username !== username);
      if (!vault[origin].length) delete vault[origin];
    }
    _pwdSave(vault);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('passwords-export-csv', () => {
  try {
    const vault = _pwdLoad();
    const rows = ['name,url,username,password'];
    for (const [origin, list] of Object.entries(vault)) {
      const site = origin.replace(/^https?:\/\//, '');
      for (const e of list) {
        const pwd = _pwdDecrypt(e.password);
        rows.push(`"${site}","${origin}","${e.username.replace(/"/g, '""')}","${pwd.replace(/"/g, '""')}"`);
      }
    }
    return { ok: true, csv: rows.join('\n') };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('passwords-import-csv', (_, { csv }) => {
  try {
    const vault = _pwdLoad();
    const lines = csv.split('\n');
    let imported = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Minimal RFC-4180 CSV parse
      const parts = [];
      let cur = '', inQ = false;
      for (const ch of line + ',') {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { parts.push(cur); cur = ''; continue; }
        cur += ch;
      }
      if (parts.length < 4) continue;
      // Chrome format: name, url, username, password
      const [, rawUrl, username, password] = parts;
      if (!rawUrl || !username || !password) continue;
      try {
        const origin = _pwdOrigin(rawUrl);
        if (!vault[origin]) vault[origin] = [];
        const idx = vault[origin].findIndex(e => e.username === username);
        const entry = { username, password: _pwdEncrypt(password), created: new Date().toISOString() };
        if (idx >= 0) vault[origin][idx] = entry; else vault[origin].push(entry);
        imported++;
      } catch {}
    }
    _pwdSave(vault);
    return { ok: true, imported };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('show-webview-context-menu', (event, { webContentsId, x, y, params }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return;

    const menu = new Menu();
    const openInNewTabPayload = (url) => {
      if (!url || !mainWindow) return;
      try {
        const incognito = wc.session === session.fromPartition(NAVIO_PARTITION_INCOGNITO);
        mainWindow.webContents.send('open-url-in-new-tab', { url, incognito });
      } catch {
        mainWindow.webContents.send('open-url-in-new-tab', { url, incognito: false });
      }
    };

    if (params.selectionText) {
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', click: () => wc.copy() }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut', role: 'cut', click: () => wc.cut() }));
      menu.append(new MenuItem({ label: 'Copy', role: 'copy', click: () => wc.copy() }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', click: () => wc.paste() }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll', click: () => wc.selectAll() }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.linkURL) {
      menu.append(new MenuItem({
        label: 'Open Link in New Tab',
        click: () => openInNewTabPayload(params.linkURL)
      }));
      menu.append(new MenuItem({
        label: 'Copy Link Address',
        click: () => clipboard.writeText(params.linkURL)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.mediaType === 'image' && params.srcURL) {
      menu.append(new MenuItem({
        label: 'Open Image in New Tab',
        click: () => openInNewTabPayload(params.srcURL)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    try {
      const pageUrl = (params && params.pageURL) || wc.getURL() || '';
      if (/^https?:\/\//i.test(pageUrl)) {
        const tl = resolveTranslateTargetLang(app, loadConfig());
        const trUrl =
          'https://translate.google.com/translate?sl=auto&tl=' +
          encodeURIComponent(tl) +
          '&u=' +
          encodeURIComponent(pageUrl);
        menu.append(
          new MenuItem({
            label: 'Translate page',
            click: () => openInNewTabPayload(trUrl)
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }
    } catch {
      /* ignore */
    }

    menu.append(new MenuItem({ label: 'Back', click: () => { if (wc.canGoBack()) wc.goBack(); }, enabled: wc.canGoBack() }));
    menu.append(new MenuItem({ label: 'Forward', click: () => { if (wc.canGoForward()) wc.goForward(); }, enabled: wc.canGoForward() }));
    menu.append(new MenuItem({ label: 'Reload', click: () => wc.reload() }));
    menu.append(new MenuItem({
      label: 'Print…',
      click: () => wc.print({ silent: false, printBackground: true })
    }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Inspect Element', click: () => wc.openDevTools({ mode: 'detach' }) }));

    menu.popup({ window: mainWindow });
  } catch (e) {
    console.error('context-menu error:', e.message);
  }
});

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

  setupSessionInfrastructure({
    app,
    getMainWindow: () => mainWindow,
    loadConfig,
    saveConfig
  });

  installNavioWebviewGuestPopupRouting();
  installNavioGuestAssistantShortcutForward();

  createMainWindow();

  startNavioCloudSync(app, loadConfig, saveConfig, () => mainWindow);

  registerAgentPlanIpc(ipcMain, { store });
  registerMcpIpc(ipcMain, loadConfig, saveConfig);
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
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch (e) {
      console.warn('[navio] electron-updater not available:', e.message);
    }
  }
}).catch((err) => {
  console.error('[navio] whenReady failed:', err);
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
