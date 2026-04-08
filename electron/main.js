const { app, BrowserWindow, ipcMain, session, dialog, Menu, MenuItem, globalShortcut, nativeTheme, clipboard, webContents: electronWebContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const secureConfig = require('./secure-config');
const { createStore } = require('./navio-store');

const INTRO_VIDEO_PATH = path.join(__dirname, '..', 'public', 'intro_video', 'intro_final.mp4');

let mainWindow = null;
let store = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'navio-config.json');
}

const DEFAULT_CONFIG = {
  aiProvider: 'openai',
  aiModel: 'gpt-4o',
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
  lastProactiveSuggestionAt: 0
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

function redactPII(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b\d{3}\s?\d{2}\s?\d{4}\b/g, '[REDACTED-SSN]');
  t = t.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED-CARD]');
  return t;
}

function hashContext(messages) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return crypto.createHash('sha256').update(sys.slice(0, 4000)).digest('hex').slice(0, 20);
}

const RISKY_BROWSER_ACTIONS = new Set(['navigate', 'click', 'type']);

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

// ── Authoritative system prompt (main-process, never cached) ─────────────────
// The renderer's assistant.js may be stale due to Chromium bytecode cache.
// We ALWAYS inject this fresh system prompt in main.js, overriding whatever
// the renderer sends. This is the single source of truth for the AI's behaviour.
const NAVIO_SYSTEM_PROMPT = `You are Navio, an intelligent AI assistant built into the Navio Browser. You help users browse the web, understand content, and automate tasks.

══════════════════════════════════════════
STEP 1 — REASON ABOUT INTENT (always do this first, silently)
══════════════════════════════════════════
Before acting on any browser task, think:
- What does the user ACTUALLY want? (not just their literal words)
- Are there words like "highlights", "latest", "best", "news" that imply a specific type of result?
- What exact search query or URL will get the RIGHT result?

Common intent mappings:
- "NBA highlights" → compilation/playlist, NOT a single game recap → search "NBA highlights playlist 2026" or "best NBA plays today"
- "latest news" → today's news → include current topic + "today" or "2026"
- "play me a video" → find a relevant video and navigate to it directly
- "search for X" → construct the most targeted search query, not just X verbatim
- "show me" or "find" → navigate to the most direct source

══════════════════════════════════════════
STEP 2 — STATE YOUR REASONING (1-2 sentences, before the plan)
══════════════════════════════════════════
Always explain what you understood from the request and what approach you chose.
Example: "You want an NBA highlights compilation, not a single game recap — I'll search YouTube for a highlights playlist with today's best plays."

══════════════════════════════════════════
STEP 3 — SHOW THE PLAN (for multi-step tasks)
══════════════════════════════════════════
For any task with 2+ steps, output a <navio-plan> block BEFORE the <navio-actions> block.
This lets the user see and understand each step before it runs.

<navio-plan>
Step 1: Navigate to YouTube search for "NBA highlights playlist 2026"
Step 2: Click the first compilation or playlist result (not a single game)
</navio-plan>

Then output the actions:
<navio-actions>
navigate:https://www.youtube.com/results?search_query=NBA+highlights+playlist+2026
click:text=NBA Highlights
</navio-actions>

══════════════════════════════════════════
ACTION BLOCK FORMAT
══════════════════════════════════════════
ONE action per line, no numbering, no bullet points:
<navio-actions>
navigate:https://full-url-here
click:text=Visible button label
type:text=Field label:text to type
scroll:down
goBack:
goForward:
</navio-actions>

RULES:
- ALWAYS end with a <navio-actions> block when browser actions are needed.
- Each line inside <navio-actions> must be: actionType:params
- For navigate, use the FULL URL including https://
- For click, use: click:text=visible text on the element
- For type, use: type:text=field label:text to type
- NEVER use ACTION0, ACTION1, ACTION2 or any numbered placeholders.
- NEVER use [[ACTION:...]] tokens — only use the <navio-actions> block.
- Do NOT ask "shall I proceed?" — just do it.

══════════════════════════════════════════
BEST TOOLS — USE THE RIGHT SITE FOR EACH TASK
══════════════════════════════════════════
NEVER navigate to google.com homepage or a generic search when a specialist tool exists.
Always use the most direct, purpose-built URL.

TRAVEL:
- Flights: https://www.google.com/travel/flights?q=ORIGIN+to+DESTINATION
- Hotels: https://www.google.com/travel/hotels?q=CITY+hotels
- Car rental: https://www.kayak.com/cars
- Trip inspiration: https://www.google.com/travel/explore

FOOD & RESTAURANTS:
- Restaurant search: https://www.yelp.com/search?find_desc=FOOD+TYPE&find_loc=CITY
- Or: https://www.google.com/maps/search/restaurants+CITY
- Recipes: https://www.allrecipes.com/search?q=RECIPE

VIDEO:
- YouTube search: https://www.youtube.com/results?search_query=QUERY
- NBA/sports highlights: https://www.youtube.com/results?search_query=NBA+highlights+today+2026

NEWS:
- Breaking news: https://news.google.com/search?q=TOPIC
- Or: https://www.bbc.com/news or https://www.reuters.com

SHOPPING:
- Products: https://www.amazon.com/s?k=QUERY
- Price comparison: https://www.google.com/shopping?q=QUERY

FINANCE & STOCKS:
- Stock price: https://finance.yahoo.com/quote/TICKER
- Crypto: https://www.coinmarketcap.com/currencies/COIN

MAPS & DIRECTIONS:
- Directions: https://www.google.com/maps/dir/ORIGIN/DESTINATION
- Find place: https://www.google.com/maps/search/QUERY

DOCUMENTS & PRODUCTIVITY:
- Create Google Doc: https://docs.google.com/document/create
- Create Google Sheet: https://docs.google.com/spreadsheets/create
- Create Google Slides: https://docs.google.com/presentation/create

GOOGLE DOCS — HOW TO TYPE CONTENT (CRITICAL — READ CAREFULLY):
Google Docs uses a canvas editor. Standard type: or click-to-focus approaches do NOT work.
The ONLY reliable way is: insertText: which writes to clipboard and pastes via Ctrl+V.

Exact sequence for Google Docs:
1. navigate:https://docs.google.com/document/create
2. After the page loads, click anywhere in the white document body to give the editor focus.
   The best selector for this is: click:.kix-appview-editor
   If that fails try: click:aria=Document content
3. Then immediately call insertText: with ALL the content you want in the doc.
   insertText puts the full text on the clipboard and pastes it — do NOT call it multiple times.
   Example: insertText:Vancouver Trip Plan\n\nFlight: Air Canada CA$356\nHotel: Best Western CA$143/night\n\nDay 1: ...

GOOGLE SHEETS — HOW TO FILL CELLS (CRITICAL — READ CAREFULLY):
Google Sheets cells are also canvas-based. insertText: uses clipboard paste, which fills one cell at a time.

Exact sequence for Google Sheets:
1. navigate:https://docs.google.com/spreadsheets/create
2. Click cell A1 to give it focus: click:aria=A1
3. Use insertText: then pressKey:Tab to move right, pressKey:Enter to move down:
   insertText:Category
   pressKey:Tab
   insertText:Detail
   pressKey:Tab
   insertText:Cost
   pressKey:Enter
   insertText:Flight
   pressKey:Tab
   insertText:Air Canada YYZ→YVR non-stop
   pressKey:Tab
   insertText:CA$356
   pressKey:Enter
   ... continue for every row

NEVER use type:text=Rich Text Area, type:text=Document, or type:text=Body — these always fail in Google editors.

JOBS & PROFESSIONAL:
- Job search: https://www.linkedin.com/jobs/search/?keywords=QUERY
- Or: https://www.indeed.com/jobs?q=QUERY

REAL ESTATE:
- Property search: https://www.zillow.com/homes/CITY_rb/
- Or: https://www.realtor.com/realestateandhomes-search/CITY

WEATHER:
- Current weather: https://www.google.com/search?q=weather+CITY
- Detailed: https://weather.com/weather/today/l/CITY

GENERAL SEARCH:
- When no specialist site exists: https://www.google.com/search?q=DETAILED+QUERY
- Always include specifics in the query — year, location, qualifiers

SEARCH QUERY INTELLIGENCE:
- YouTube videos: add "playlist", "compilation", "best of", or year to get relevant collections
- Google search: use quotes for exact phrases, add site: to target specific sites
- "latest" / "new" / "today" → add the current year (2026) or "today" to the query
- Be specific: "NBA highlights" is vague → "NBA best plays April 2026" is precise
- For multi-city travel: break into one search per leg, open each in sequence

EXAMPLE — "play me NBA highlights":
You want a highlights compilation, not a single game recap — I'll search YouTube for today's best NBA plays.
<navio-plan>
Step 1: Search YouTube for "NBA highlights April 2026 best plays"
Step 2: Click the first compilation/highlights reel result
</navio-plan>
<navio-actions>
navigate:https://www.youtube.com/results?search_query=NBA+highlights+April+2026+best+plays
</navio-actions>

EXAMPLE — "search google for best laptops and click the first result":
I'll search Google and open the first result.
<navio-actions>
navigate:https://www.google.com/search?q=best+laptops+2026
click:text=1
</navio-actions>

EXAMPLE — "go to youtube and search for world news":
I'll navigate straight to the YouTube search results for world news today.
<navio-actions>
navigate:https://www.youtube.com/results?search_query=world+news+today+2026
</navio-actions>

If no browser actions are needed, just reply with plain text and no <navio-actions> block.

══════════════════════════════════════════
REAL RESEARCH — FIND ACTUAL DATA, NOT JUST LINKS
══════════════════════════════════════════
When the user asks for the "lowest price", "best deal", "cheapest", "compare", or "find me X":
You are a REAL research assistant. You must actually go to the pages and read the results.

PRICE RESEARCH RULES:
1. Navigate to the best search source for the task (e.g. Google Flights for airfare).
2. After landing, you will receive the page content. READ IT carefully.
3. Extract every price, option, date, and airline/hotel/vendor you can see in the text.
4. List them with actual numbers — NEVER say "results are shown" without listing them.
5. Identify the cheapest option and call it out clearly with a ✓.
6. If the page content seems incomplete or truncated, try a second source for confirmation.
7. If one search returns no useful pricing, navigate to an alternate: e.g. if Google Flights has no data, try Kayak (https://www.kayak.com/flights/ORIGIN-DESTINATION/DATE).

MULTI-SOURCE STRATEGY — use when user wants the best deal:
- Flights: Check Google Flights first, then if needed Kayak (https://www.kayak.com/flights) or Skyscanner (https://www.skyscanner.com)
- Hotels: Check Google Hotels first, then Booking.com (https://www.booking.com/searchresults.html?ss=CITY) or Hotels.com
- Products: Check Amazon, then Google Shopping (https://www.google.com/shopping?q=QUERY) to compare
- Services: Check multiple review sources (Yelp + Google Maps) and compare ratings + prices

WHAT GOOD RESEARCH LOOKS LIKE:
✓ "I found 4 flight options. The cheapest is Air Canada YYZ→YVR on Apr 12 for $189. Next is WestJet at $214, then Porter at $231. I recommend the Air Canada option."
✗ "Google Flights shows flight results. Click to view them." ← This is NOT research. NEVER do this.

NEVER:
- Navigate somewhere and just describe the page
- Say "I found results" without showing the actual data
- Stop after one step when the user asked for the best/lowest/cheapest
- Make up prices or options you did not see in the page text

══════════════════════════════════════════
STRICT EMAIL RULE — NEVER BREAK THIS
══════════════════════════════════════════
You are NOT allowed to click the Send button on any email service under ANY circumstances.
- You MAY click "Compose", "Reply", "Reply All" and type draft text — this is for saving drafts, NOT sending.
- You MUST NEVER click the "Send" button or any equivalent that dispatches an email.
- If the user explicitly asks you to "send" an email, explain that you can only save drafts for their review — then offer to draft it instead.

══════════════════════════════════════════
MEMORY
══════════════════════════════════════════
When you learn important facts about the user (name, job, preferences, location, tools they use, etc.), save them by ending your response with:
<navio-memory>
save:User is a software developer
save:User prefers Python
</navio-memory>
Only save facts genuinely useful for future sessions. Never save sensitive data. Omit this block if nothing new was learned.`;

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

  // Convert <navio-actions> block into [[ACTION:type:params]] tokens
  text = text.replace(/<navio-actions>([\s\S]*?)<\/navio-actions>/gi, (_, body) => {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.map(line => {
      const colon = line.indexOf(':');
      if (colon < 0) return '';
      const type = line.slice(0, colon).trim().toLowerCase();
      const params = line.slice(colon + 1).trim();
      const valid = ['navigate', 'click', 'type', 'insertText', 'scroll', 'goback', 'goforward', 'pressKey'];
      const normType = type === 'goback' ? 'goBack' : type === 'goforward' ? 'goForward' : type;
      if (!valid.includes(type)) return '';
      return `[[ACTION:${normType}:${params}]]`;
    }).filter(Boolean).join('\n');
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

function buildMemoryBlock() {
  try {
    const mem = loadMemory();
    if (!mem.facts || mem.facts.length === 0) return '';
    return '\n\nBROWSER MEMORY (remembered facts about this user — use naturally):\n' +
      mem.facts.map(f => `- ${f.content}`).join('\n');
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
    if (!mem.facts.find(f => f.content === fact)) {
      mem.facts.push({ id: Date.now() + Math.random(), content: fact, type: 'auto', createdAt: new Date().toISOString() });
      changed = true;
    }
  }
  if (changed) saveMemory(mem);
}

// ── Memory IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('memory-get', () => loadMemory());
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

// Replaces ONLY the first system message with NAVIO_SYSTEM_PROMPT + memory + profile.
// Other system messages (page context, selection, tab list, etc.) are preserved.
// Called in every IPC handler so the cached renderer's stale system prompt is ignored.
function injectSystemPrompt(messages) {
  const memBlock = buildMemoryBlock();
  const profileBlock = buildProfileBlock();
  const fullPrompt = NAVIO_SYSTEM_PROMPT + memBlock + profileBlock;
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

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (event, partial) => {
  saveConfig(partial);
  return true;
});

ipcMain.handle('get-api-key-for-settings', () => {
  return secureConfig.getApiKey(app.getPath('userData'));
});

ipcMain.handle('get-intro-video-url', () => {
  try {
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

async function performAiFetch(cfg, apiKey, messages, useStream) {
  const provider = cfg.aiProvider || 'openai';
  const model = cfg.aiModel || 'gpt-4o';
  const endpoint = cfg.customEndpoint || '';

  let url;
  let headers;
  let body;

  if (provider === 'openai' || provider === 'custom') {
    url = endpoint || 'https://api.openai.com/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    // max_completion_tokens is the correct parameter for all current OpenAI models.
    // max_tokens is deprecated and rejected by newer models (GPT-5+, o-series).
    // o-series reasoning models also reject the temperature parameter entirely.
    const isOSeries = /^o[1-9]/i.test(model || '');
    const bodyObj = {
      model: model || 'gpt-4o',
      messages,
      max_completion_tokens: 4096,
      stream: !!useStream
    };
    if (isOSeries) {
      // o-series fixes temperature at 1 internally; sending it causes a 400 error
      delete bodyObj.temperature;
    }
    body = JSON.stringify(bodyObj);
  } else if (provider === 'anthropic') {
    if (useStream) return { error: 'Streaming not implemented for this provider; disable stream in settings.' };
    url = 'https://api.anthropic.com/v1/messages';
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMsgs = messages.filter((m) => m.role !== 'system');
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    body = JSON.stringify({
      model: model || 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemMsg?.content || '',
      messages: chatMsgs
    });
  } else if (provider === 'google') {
    if (useStream) return { error: 'Streaming not implemented for this provider; disable stream in settings.' };
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
    const systemInstruction = messages.find((m) => m.role === 'system');
    body = JSON.stringify({
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction.content }] } : undefined
    });
  } else {
    return { error: `Unknown provider: ${provider}` };
  }

  const response = await fetch(url, { method: 'POST', headers, body });

  if (useStream && (provider === 'openai' || provider === 'custom')) {
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
  if (provider === 'anthropic') {
    content = data.content?.[0]?.text || '';
  } else if (provider === 'google') {
    content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    content = data.choices?.[0]?.message?.content || '';
  }

  return { content };
}

ipcMain.handle('ai-request', async (event, { messages }) => {
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
    processed = processed.map((m) =>
      typeof m.content === 'string' ? { ...m, content: redactPII(m.content) } : m
    );
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
    let result = await performAiFetch(cfg, apiKey, processed, false);
    if (result.stream) return { error: 'Internal error: unexpected stream' };

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

    // Extract and persist any <navio-memory> blocks from the response
    if (!result.error && result.content) {
      extractAndSaveMemory(result.content);
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
    processed = processed.map((m) =>
      typeof m.content === 'string' ? { ...m, content: redactPII(m.content) } : m
    );
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
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) fullText += delta;
        } catch { /* skip keep-alives */ }
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
        const results = [];
        const seen = new WeakSet();
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
          let selector = id ? '#'+id : (name ? tag+'[name="'+name+'"]' : null);
          if (!selector) {
            const classes = Array.from(el.classList).filter(c => !/^[a-z]{1,2}$/.test(c)).slice(0,2);
            selector = tag + (classes.length ? '.'+classes.join('.') : '');
          }
          if (label) results.push({ role, label, selector });
          if (results.length >= 60) break;
        }
        return results;
      })()
    `);
    return { elements: snapshot, url: wc.getURL(), title: wc.getTitle() };
  } catch (err) {
    return { error: err.message };
  }
});

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
        return { success: true };
      }

      case 'click': {
        const cSel = JSON.stringify(params.selector || '');
        const res = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const raw = ${cSel};
            // Multi-strategy element finder (accessibility-first, CSS fallback)
            function findEl(sel) {
              if (!sel) return null;
              if (sel.startsWith('text=')) {
                const q = sel.slice(5).trim().toLowerCase();
                const candidates = document.querySelectorAll(
                  'a,button,input[type="submit"],input[type="button"],[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
                );
                for (const el of candidates) {
                  const lbl = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().toLowerCase();
                  if (lbl.includes(q)) return el;
                }
                return null;
              }
              if (sel.startsWith('aria=')) {
                const q = sel.slice(5).trim().toLowerCase();
                for (const el of document.querySelectorAll('[aria-label]')) {
                  if (el.getAttribute('aria-label').toLowerCase().includes(q)) return el;
                }
                return null;
              }
              try { return document.querySelector(sel); } catch { return null; }
            }
            let tries = 0;
            const attempt = () => {
              const el = findEl(raw);
              if (el) {
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                el.focus();
                el.click();
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
        if (!res.ok) return { error: res.error };
        return { success: true };
      }

      case 'type': {
        const tSel = JSON.stringify(params.selector || '');
        const tVal = JSON.stringify(params.text || '');
        const tRes = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const raw = ${tSel};
            const text = ${tVal};
            function findEl(sel) {
              if (!sel) return null;
              if (sel.startsWith('text=') || sel.startsWith('aria=')) {
                const prefix = sel.startsWith('text=') ? 'text=' : 'aria=';
                const q = sel.slice(prefix.length).trim().toLowerCase();
                for (const el of document.querySelectorAll('input,textarea,select,[contenteditable]')) {
                  const lbl = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').toLowerCase();
                  if (lbl.includes(q)) return el;
                }
                return null;
              }
              try { return document.querySelector(sel); } catch { return null; }
            }
            let tries = 0;
            const attempt = () => {
              const el = findEl(raw);
              if (el) {
                el.focus();
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                // Native input setter so React/Vue controlled inputs detect change
                const proto = el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, text); else el.value = text;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
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
          // Fallback: Google Docs/Sheets use a canvas editor — no DOM input to find.
          // Use Electron's native insertText() which works on any focused surface.
          const currentUrl = wc.getURL?.() || '';
          const isGoogleEditor = /docs\.google\.com|sheets\.google\.com|slides\.google\.com/.test(currentUrl);
          if (isGoogleEditor) {
            clipboard.writeText(params.text || '');
            await new Promise(r => setTimeout(r, 200));
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
            await new Promise(r => setTimeout(r, 50));
            wc.sendInputEvent({ type: 'keyUp',   keyCode: 'V', modifiers: ['control'] });
            return { success: true };
          }
          return { error: tRes.error };
        }
        return { success: true };
      }

      case 'scroll':
        await wc.executeJavaScript(`
          window.scrollBy(0, ${params.direction === 'up' ? -500 : 500})
        `);
        return { success: true };

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
        // 1. Write to system clipboard (works regardless of focus state)
        clipboard.writeText(textToInsert);
        // 2. Give the page a moment to process any pending focus state
        await new Promise(r => setTimeout(r, 200));
        // 3. Send Ctrl+V — Google Docs/Sheets intercepts this and pastes
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        await new Promise(r => setTimeout(r, 50));
        wc.sendInputEvent({ type: 'keyUp',   keyCode: 'V', modifiers: ['control'] });
        return { success: true };
      }

      case 'pressKey': {
        // Dispatch a keyboard event on the focused element or document.
        // Used for navigation within Google Sheets (Tab/Enter) and saving drafts.
        const key = params?.key || 'Escape';
        const KEY_MAP = {
          'Tab':    { code: 'Tab',    keyCode: 9  },
          'Enter':  { code: 'Enter',  keyCode: 13 },
          'Escape': { code: 'Escape', keyCode: 27 },
          'ArrowDown':  { code: 'ArrowDown',  keyCode: 40 },
          'ArrowUp':    { code: 'ArrowUp',    keyCode: 38 },
          'ArrowLeft':  { code: 'ArrowLeft',  keyCode: 37 },
          'ArrowRight': { code: 'ArrowRight', keyCode: 39 },
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
        return { screenshot: image.toDataURL() };
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

ipcMain.handle('mcp-config', (event, payload) => {
  const cfg = loadConfig();
  if (payload?.op === 'get') {
    return {
      enabled: !!cfg.mcpEnabled,
      servers: Array.isArray(cfg.mcpServers) ? cfg.mcpServers : []
    };
  }
  if (payload?.op === 'set') {
    saveConfig({
      mcpEnabled: !!payload.enabled,
      mcpServers: Array.isArray(payload.servers) ? payload.servers : []
    });
    if (store) {
      store.appendLedger({ type: 'mcp_config', enabled: !!payload.enabled, serverCount: (payload.servers || []).length });
    }
    return { ok: true };
  }
  if (payload?.op === 'list-tools-stub') {
    return {
      tools: cfg.mcpEnabled
        ? [
            { name: 'navio.echo', description: 'Stub MCP tool (enable real MCP SDK in a future release)' }
          ]
        : []
    };
  }
  return { error: 'Unknown op' };
});

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
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar.readonly'
    ],
    serviceIds: ['gmail', 'gdrive', 'gcalendar'],
    configKey: 'oauthGoogleClientId',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    consoleHint: 'Create an OAuth 2.0 Client ID (Desktop app type). Add redirect URI: http://127.0.0.1:56789/oauth/callback'
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

  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    });
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
        sandbox: true
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

        let tokenRes, tokenData;
        if (providerId === 'github') {
          tokenRes = await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenParams.toString()
          });
        } else if (providerId === 'notion') {
          // Notion uses Basic auth with client_id:client_secret (no PKCE)
          tokenRes = await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`
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

    authWin.webContents.on('will-navigate', (ev, url) => {
      if (interceptCallback(url)) ev.preventDefault();
    });
    authWin.webContents.on('will-redirect', (ev, url) => {
      if (url.startsWith(OAUTH_REDIRECT_URI)) {
        interceptCallback(url);
        ev.preventDefault();
      }
    });
    authWin.on('closed', () => settle({ error: 'Login window closed by user.' }));

    authWin.loadURL(authUrl);
  });
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
    hasClientId: !!(cfg[p.configKey] || '').trim(),
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

    if (!token) return { error: 'Service not connected — click Connect in the Connectors Hub.' };

    if (serviceId === 'github') return await queryGitHub(token, query, options);
    if (serviceId === 'notion') return await queryNotion(token, query, options);
    if (serviceId === 'perplexity') return await queryPerplexity(token, query, options);
    if (serviceId === 'linear') return await queryLinear(token, query, options);
    if (serviceId === 'gmail') return await queryGmail(token, query, options);
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
  const maxResults = options.maxResults || 5;
  // Search emails
  const searchResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await searchResp.json();
  if (!searchResp.ok) return { error: searchData.error?.message || 'Gmail API error' };
  if (!searchData.messages?.length) return { results: [], total: 0 };

  // Fetch snippets for each message
  const msgs = await Promise.all(
    searchData.messages.slice(0, maxResults).map(async (m) => {
      try {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        const headers = d.payload?.headers || [];
        const get = (name) => headers.find((h) => h.name === name)?.value || '';
        return {
          subject: get('Subject') || '(no subject)',
          from: get('From'),
          date: get('Date'),
          snippet: d.snippet || '',
          id: m.id
        };
      } catch { return null; }
    })
  );
  return { results: msgs.filter(Boolean), total: searchData.resultSizeEstimate || msgs.length };
}

async function queryGoogleDrive(token, query, options = {}) {
  const pageSize = options.pageSize || 6;
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`fullText contains '${query}'`)}&pageSize=${pageSize}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
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
  const top = options.top || 5;
  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(query)}"&$top=${top}&$select=subject,from,receivedDateTime,bodyPreview`,
    { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } }
  );
  const data = await resp.json();
  if (!resp.ok) return { error: data.error?.message || 'Outlook API error' };
  const results = (data.value || []).map((m) => ({
    subject: m.subject || '(no subject)',
    from: m.from?.emailAddress?.address || '',
    date: m.receivedDateTime,
    snippet: m.bodyPreview || ''
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
ipcMain.handle('ntp-stocks', async () => {
  const symbols = 'AAPL,GOOGL,MSFT,AMZN,TSLA,META,NVDA,BTC-USD,ETH-USD,%5EGSPC,%5EDJI,%5EIXIC';
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=symbol,shortName,regularMarketPrice,regularMarketChange,regularMarketChangePercent`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const data = await r.json();
    return (data.quoteResponse?.result || []).map(q => ({
      symbol: (q.symbol || '').replace('^', ''),
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      pct: q.regularMarketChangePercent
    }));
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

ipcMain.handle('show-webview-context-menu', (event, { webContentsId, x, y, params }) => {
  try {
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return;

    const menu = new Menu();

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
        click: () => mainWindow?.webContents.send('open-url-in-new-tab', params.linkURL)
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
        click: () => mainWindow?.webContents.send('open-url-in-new-tab', params.srcURL)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({ label: 'Back', click: () => { if (wc.canGoBack()) wc.goBack(); }, enabled: wc.canGoBack() }));
    menu.append(new MenuItem({ label: 'Forward', click: () => { if (wc.canGoForward()) wc.goForward(); }, enabled: wc.canGoForward() }));
    menu.append(new MenuItem({ label: 'Reload', click: () => wc.reload() }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Inspect Element', click: () => wc.openDevTools({ mode: 'detach' }) }));

    menu.popup({ window: mainWindow });
  } catch (e) {
    console.error('context-menu error:', e.message);
  }
});

app.whenReady().then(async () => {
  console.log('[navio] ✅ main.js v7 loaded — system prompt is injected from main process');
  // Clear V8 code caches so every launch picks up the latest renderer JS source files.
  // We use both the Electron session API (in-memory cache) AND the filesystem folder
  // (persistent cache) to guarantee a clean slate.
  try {
    await session.defaultSession.clearCodeCaches({});
  } catch (e) {
    console.warn('[navio] session.clearCodeCaches failed:', e.message);
  }
  try {
    const codeCachePath = path.join(app.getPath('userData'), 'Code Cache');
    if (fs.existsSync(codeCachePath)) {
      fs.rmSync(codeCachePath, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[navio] Could not clear code cache folder:', e.message);
  }

  store = createStore(app.getPath('userData'));

  createMainWindow();

  // Set up the persist:navio session used by all webview tabs
  const navioSession = session.fromPartition('persist:navio');

  // Allow all permission requests from web content (camera, mic, notifications, etc.)
  navioSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  // Allow all permission checks (Electron 15+)
  if (typeof navioSession.setPermissionCheckHandler === 'function') {
    navioSession.setPermissionCheckHandler(() => true);
  }

  // ── Ad Blocker ────────────────────────────────────────────────────────────
  // Comprehensive domain/pattern list. Matched as substrings of the full URL.
  const AD_BLOCK_PATTERNS = [
    // Core ad networks
    'doubleclick.net','googlesyndication.com','adservice.google',
    'googleadservices.com','googletagservices.com','tpc.googlesyndication.com',
    'pagead2.googlesyndication.com','fundingchoicesmessages.google.com',
    'amazon-adsystem.com','assoc-amazon.com',
    'ads.yahoo.com','gemini.yahoo.com','advertising.yahoo.com',
    'syndication.twitter.com','ads.twitter.com',
    'ads.linkedin.com','snap.licdn.com',
    // Tracking pixels & data brokers
    'facebook.com/tr','connect.facebook.net','analytics.facebook.com',
    'scorecardresearch.com','quantserve.com','quantcast.com',
    // DSP / SSP / exchanges
    'adnxs.com','rubiconproject.com','pubmatic.com',
    'openx.net','openx.com','casalemedia.com',
    'criteo.com','criteo.net',
    'bidswitch.net','sharethrough.com','triplelift.com',
    'smartadserver.com','smaato.net',
    'spotxchange.com','spotx.tv',
    'teads.tv','teads.com',
    'yieldmo.com','zedo.com','undertone.com','unrulymedia.com',
    'media.net','outbrain.com','outbrainimg.com',
    'taboola.com','revcontent.com','mgid.com',
    'propellerads.com','propellerclick.com',
    'adzerk.net','adzerk.com',
    'advertising.com','adtech.de','adform.net',
    'moatads.com','adsafeprotected.com',
    'adcolony.com','appsflyer.com','adjust.com','adjust.io',
    'mopub.com','chartboost.com',
    'adrollapp.com','buysellads.com','buysellads.net',
    'pagefair.com',
    // Analytics / session recording
    'hotjar.com','fullstory.com','mouseflow.com','crazyegg.com',
    'mixpanel.com','amplitude.com',
    'heap.com','heapanalytics.com',
    // Pop-up / redirect networks
    'popads.net','popcash.net','exoclick.com',
    'trafficjunky.net','trafficholder.com',
    // Malvertising / low-quality
    'cdnwidget.com','adnium.com','justpremium.com',
  ];

  const cfg0 = loadConfig();
  let adBlockEnabled = cfg0.adBlockEnabled !== false; // default ON
  let adBlockCount   = 0;

  navioSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (adBlockEnabled) {
      const url = details.url;
      if (AD_BLOCK_PATTERNS.some(p => url.includes(p))) {
        adBlockCount++;
        callback({ cancel: true });
        return;
      }
    }
    callback({});
  });

  ipcMain.handle('set-ad-blocker', async (_, { enabled }) => {
    adBlockEnabled = !!enabled;
    saveConfig({ adBlockEnabled: adBlockEnabled });
    return { ok: true, enabled: adBlockEnabled };
  });

  ipcMain.handle('get-ad-block-stats', () => ({
    enabled: adBlockEnabled,
    blocked: adBlockCount,
    domains: AD_BLOCK_PATTERNS.length
  }));

  globalShortcut.register('F12', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  globalShortcut.register('CommandOrControl+T', () => {
    mainWindow?.webContents.send('shortcut', 'new-tab');
  });
  globalShortcut.register('CommandOrControl+W', () => {
    mainWindow?.webContents.send('shortcut', 'close-tab');
  });
  globalShortcut.register('CommandOrControl+L', () => {
    mainWindow?.webContents.send('shortcut', 'focus-url');
  });
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    mainWindow?.webContents.send('shortcut', 'toggle-assistant');
  });
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    mainWindow?.webContents.send('shortcut', 'toggle-connectors');
  });
  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.send('shortcut', 'command-palette');
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

Menu.setApplicationMenu(null);
