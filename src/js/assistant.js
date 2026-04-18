/**
 * Navio Browser - AI Assistant
 * Policy-scoped context, streaming (OpenAI), context receipt, pin tab / graph.
 */

/** Same pattern as main process — login / OAuth URLs where the agent should pause. */
const NAVIO_AUTH_GATE_URL_RE =
  /\/(login|signin|sign-in|auth|account\/login|session\/new|oauth|sso)\b|accounts\.google\.com\/(signin|ServiceLogin)|login\.microsoftonline\.com|login\.live\.com|signin\.aws\.amazon\.com/i;

/** Natural-language mailbox ask — shared by Gmail + Outlook connector prefetch. */
function navioDetectMailboxIntent(text) {
  const s = (text || '').trim();
  if (s.length < 2) return false;
  if (/\b(send|forward|compose)\s+(an?\s+)?(e-?)?mail\s+to\s+\S+@\S+/i.test(s)) return false;
  // "Notification" alone matched too many non-mail questions; require mail vocabulary with it.
  const notificationAboutMail =
    /\b(notifications?|notify)\b/i.test(s) && /\b(email|e-?mail|gmail|inbox|mailbox|message|mail)\b/i.test(s);
  const mailThing =
    /\b(gmail|google\s*mail|inbox|mailbox|e-?mails?|unread)\b/i.test(s) ||
    /\bmy\s+(e-?mails?|mail|inbox|messages?)\b/i.test(s) ||
    /\b(messages?|mail)\s+from\b/i.test(s) ||
    notificationAboutMail;
  const mailPlusCasual =
    (/\b(e-?mails?|gmail|inbox|mailbox)\b/i.test(s) ||
      /\b(my|the|check|read|see|show)\s+mail\b/i.test(s)) &&
    /\b(check|see|show|read|view|open|look|got|get|gotten|miss|missed|unread|new|latest|any|what|whats|what's|triage|summarize|stuff|came|arrived|waiting|important|anything|something|peek|skim|catch\s*up)\b/i.test(
      s
    );
  const inboxPhrases =
    /\b(check|see|show|read|peek)\s+(at\s+)?(my\s+)?(inbox|mail|gmail)\b/i.test(s) ||
    /\b(what|whats|what's|any)('?s|s| is)?\s+(new|in\s+my\s+inbox|up)\b/i.test(s) ||
    /\b(any|some)thing\s+(new|in\s+my\s+inbox)\b/i.test(s) ||
    (/\b(did|have)\s+i\s+(get|miss|receive)\b/i.test(s) && /\b(mail|e-?mail|message|anything)\b/i.test(s)) ||
    /\b(clear|deal\s+with)\s+(my\s+)?(inbox|mail)\b/i.test(s);
  const threadStuff =
    /\b(thread|attachment|respond|replied|reply|unreplied|unanswered|pending|follow.?up|sent|outbox)\b/i.test(s) &&
    /\b(e-?mail|mail|inbox|gmail|message)\b/i.test(s);
  const mailCasual =
    /\bwho\s+(emailed|wrote|messaged)\s+(me|us)\b/i.test(s) ||
    /\b(anything|what)\s+(i\s+)?(owe|missed|miss|behind\s+on)\b/i.test(s) ||
    /\bcatch\s+up\s+on\s+(my\s+)?(mail|inbox|messages?)\b/i.test(s);
  return !!(mailThing || mailPlusCasual || inboxPhrases || threadStuff || mailCasual);
}

/** User is asking about Google Drive, Calendar, Docs, etc. — not generic web browsing. */
function navioDetectGoogleWorkspaceIntent(text) {
  const s = (text || '').trim().toLowerCase();
  if (s.length < 2) return false;
  return (
    /\b(gdrive|google drive|google calendar|google doc|google sheet|google slides|google meet|gcal)\b/.test(s) ||
    /drive\.google\.|docs\.google\.|sheets\.google|slides\.google|calendar\.google/.test(s) ||
    /\b(my\s+calendar|calendar\s+event|meeting\s+invite|drive\s+folder|file\s+in\s+drive|spreadsheet\s+in\s+drive)\b/.test(s)
  );
}

/**
 * True when this user turn should be treated as mail-related: explicit mailbox wording,
 * or a short follow-up after the previous user message was clearly mail-related.
 */
function navioMailContextActiveForTurn(text, getHistoryFn) {
  const t0 = (text || '').trim();
  // Drive / Calendar / Docs without mail wording — do not extend a Gmail thread from prior turns.
  if (navioDetectGoogleWorkspaceIntent(t0) && !navioDetectMailboxIntent(t0)) return false;
  if (navioDetectMailboxIntent(text)) return true;
  let h = [];
  try {
    h = typeof getHistoryFn === 'function' ? getHistoryFn() : [];
  } catch {
    h = [];
  }
  if (!Array.isArray(h) || h.length === 0) return false;
  let lastUserContent = '';
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].role === 'user' && typeof h[i].content === 'string') {
      lastUserContent = h[i].content;
      break;
    }
  }
  if (!lastUserContent || !navioDetectMailboxIntent(lastUserContent)) return false;
  const t = (text || '').trim();
  if (t.length <= 220) {
    if (
      /^(yes|yeah|yep|no|nope|ok|sure|the|that|this|same|more|next|show|continue|load|which|second|first|third|fourth|fifth|draft|reply|please|go|do it|send|archive|delete|trash|mark|open|forward|star|unread|read|again|thanks|thank you|fine|do that|exactly|go ahead|confirm)\b/i.test(
        t
      )
    ) {
      return true;
    }
  }
  if (
    /\b(email|mail|message|thread|draft|inbox|reply|gmail|unread|sent|from|subject|snippet|sender|attachment|letter|compose|forward|bcc|cc)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** OAuth row from `oauth-status`: connected and token not past expiresAt. */
function navioOAuthSlotActive(entry) {
  return !!(entry && entry.connected && !entry.expired);
}

/** User is asking about the visible page/tab in plain language (no "click"/"navigate" verbs). */
function navioDetectPageFocusIntent(text) {
  const s = (text || '').trim();
  if (s.length < 3) return false;
  return (
    /(?:^|\b)(what'?s\s+on\s+(this\s+)?(page|tab|site)|what\s+is\s+on\s+(this\s+)?(page|tab|site)|summarize\s+(this|the)\s+(page|tab|site)|describe\s+(this|the)\s+(page|site|screen)|what\s+am\s+i\s+looking\s+at|what\s+does\s+this\s+(page|site|tab)\s+(say|show)|here\s+on\s+this\s+(page|site)|this\s+(page|tab|site)\s+(say|shows|says)|content\s+of\s+this\s+(page|tab)|current\s+(page|tab)\s+about)/i.test(
      s
    ) || /\b(explain|explaining)\s+(this|that)\s+(page|site|screen)\b/i.test(s)
  );
}

/** Logs to the shell DevTools console and to the terminal (`npm start`) via `navio.shellLog`. */
function navioAssistantDebug(label, detail) {
  let extra = '';
  if (detail !== undefined) {
    try {
      extra = typeof detail === 'string' ? detail : JSON.stringify(detail);
    } catch {
      extra = String(detail);
    }
  }
  const line = extra ? `${label} ${extra}` : label;
  console.log('[navio-assistant]', line);
  try {
    if (typeof window !== 'undefined' && window.navio && typeof window.navio.shellLog === 'function') {
      window.navio.shellLog(`[navio-assistant] ${line}`);
    }
  } catch {
    /* ignore */
  }
}

const NAVIO_ASSISTANT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const NAVIO_ASSISTANT_PDF_MAX_BYTES = 12 * 1024 * 1024;
const NAVIO_ASSISTANT_TEXT_MAX_CHARS = 180000;
const NAVIO_ASSISTANT_MAX_ATTACHMENTS = 8;
/** Non-text files: send as base64 for models that accept inline bytes (Gemini, etc.). */
const NAVIO_ASSISTANT_INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** Unknown extensions: try UTF-8 decode when under this size (code, configs, odd MIME). */
const NAVIO_ASSISTANT_HEURISTIC_TEXT_MAX_BYTES = 768 * 1024;

/** Legacy persisted chat bucket (single thread). Migrated once into the first active tab per session. */
const NAVIO_PROFILE_CHAT_KEY = '__profile__';

function navioLooksLikePrintableText(s) {
  if (!s || typeof s !== 'string') return false;
  const sample = s.slice(0, Math.min(12000, s.length));
  if (!sample.length) return false;
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl / sample.length < 0.03;
}

function navioIsTextLikeFile(file) {
  const n = (file.name || '').toLowerCase();
  if (file.type && file.type.startsWith('text/')) return true;
  if (/^(application\/(json|xml|javascript|x-javascript|x-httpd-php|sql|graphql)|message\/rfc822)/i.test(file.type || '')) {
    return true;
  }
  return /\.(txt|md|mdx|json|json5|jsonc|csv|tsv|xml|html?|htm|xhtml|css|scss|sass|less|js|mjs|cjs|ts|tsx|jsx|c|h|cpp|hpp|cc|cxx|py|pyi|pyw|java|kt|kts|rs|go|yaml|yml|toml|ini|cfg|conf|config|log|sh|bash|zsh|fish|bat|cmd|ps1|psm1|env|svg|sql|vue|svelte|rb|erb|php|swift|dart|scala|sbt|gradle|clj|cljs|edn|ex|exs|erl|hrl|hs|lhs|ml|mli|fs|fsi|fsx|dockerfile|gitignore|gitattributes|editorconfig|properties|lock|pro|cmake|makefile|mk|dockerignore|graphql|gql|wasm\.wat|ipynb)$/i.test(
    n
  );
}

function navioIsImageFile(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic|heif|jxl)$/i.test(file.name || '');
}

/** When MIME/extension is wrong, detect raster images from magic bytes so vision models still receive them. */
function navioSniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return 'image/tiff';
  }
  return null;
}

async function navioPeekImageMime(file) {
  if (navioIsPdfFile(file)) return null;
  try {
    const peek = await file.slice(0, 32).arrayBuffer();
    return navioSniffImageMime(new Uint8Array(peek));
  } catch {
    return null;
  }
}

function navioFixDataUrlMime(dataUrl, mime) {
  if (!mime || !dataUrl) return dataUrl;
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return dataUrl;
  return `data:${mime};base64,${m[1]}`;
}

function navioIsPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

/** Same logic as main process — fix UTF-8 mojibake in draft bodies before display/send. */
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
      const u8 = new Uint8Array(t.length);
      for (let i = 0; i < t.length; i++) u8[i] = t.charCodeAt(i);
      const repaired = new TextDecoder('utf-8', { fatal: false }).decode(u8);
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

class AssistantManagerClass {
  constructor() {
    this.panel = document.getElementById('assistant-panel');
    this.messagesEl = document.getElementById('assistant-messages');
    this.inputEl = document.getElementById('assistant-input');
    this.scopeSelect = document.getElementById('assistant-data-scope');
    this.receiptEl = document.getElementById('assistant-context-receipt');
    this.isOpen = false;
    /** Tab ids currently running an assistant turn (each tab can have its own task in parallel). */
    this._busyTabs = new Set();
    /** @type {Map<string, Array<{ role: string, content: unknown }>>} */
    this._conversationsByTab = new Map();
    /** @type {Promise<void> | null} */
    this._assistantHistoryLoadPromise = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._assistantPersistTimer = null;
    /** @type {Map<string, Array<() => void>>} */
    this._streamUnsubsByTab = new Map();
    this._autoFollowCount = 0;
    this._emailRefs = new Map();
    /** @type {Map<string, string>} messageId → plain body (Gmail API) */
    this._emailBodyCache = new Map();
    this._lastGmailPageToken = null;
    this._lastGmailQuery = '';
    /** @type {'gmail'|'gmail_2'} Last Gmail connector used (for "load more"). */
    this._lastGmailServiceId = 'gmail';
    this._pendingScreenshotDataUrl = null;
    /** @type {Array<{ id: string, name: string, status: string, kind?: string, dataUrl?: string, base64?: string, text?: string, thumb?: string, error?: string }>} */
    this._attachmentQueue = [];
    /** Snapshot of ready attachments for the in-flight `processMessage` (queue is cleared for UI). */
    this._attachmentsSnapshot = null;
    this._takeoverAbort = null;
    /** @type {(() => void) | null} */
    this._takeoverAuthResume = null;
    this._agentLogEntries = [];
    this._lastProactiveUrlKey = '';
    /** When set, agent activity + final reply render in the full-page chat webview. */
    this._guestChatWebview = null;
    /** URLs from last Perplexity connector call this turn (for citation chips in the assistant bubble). */
    this._pendingConnectorCitations = null;
    /** @type {number | null} performance.now() when the current model turn started */
    this._turnStartedAt = null;
    /** While a turn is in flight, history reads/writes go to this tab id (so tab switches don't mis-file replies). */
    this._turnConversationKey = null;
    /** Sidebar transcript is for this tab id — DOM updates from other in-flight turns are suppressed. */
    this._panelDisplayTabId = null;
    /** When true, `addMessage` always appends (rebuilding history from disk). */
    this._assistantHistoryDomReplay = false;
    /** First tab id that receives a copy of the legacy persisted profile thread (once per session). */
    this._profileChatSeededToTabId = null;
    /** Dedupe toggle when globalShortcut and guest webview forward both fire. */
    this._lastToggleAt = 0;

    // Minimal placeholder — the authoritative prompt is loaded from
    // navio-system-prompt.txt (or -legacy.txt) and injected by
    // injectSystemPrompt() in main.js before every API call.
    this.systemPrompt = 'You are Navio, an intelligent AI browser assistant.';

    this.bindEvents();
    this._assistantHistoryLoadPromise = this._loadPersistedChat();
  }

  /** Re-resolve panel if DOM changed or constructor ran before the node existed. */
  _ensurePanel() {
    if (!this.panel) this.panel = document.getElementById('assistant-panel');
    return this.panel;
  }

  bindEvents() {
    const toggleBtn = document.getElementById('btn-toggle-assistant');
    if (!toggleBtn) {
      navioAssistantDebug('bindEvents: MISSING #btn-toggle-assistant (toolbar AI will not receive clicks here)');
    } else {
      toggleBtn.addEventListener(
        'click',
        (e) => {
          navioAssistantDebug('toolbar AI button: click received', {
            target: e.target && e.target.id,
            defaultPrevented: e.defaultPrevented
          });
          e.preventDefault();
          this.toggle();
        },
        true
      );
    }
    document.getElementById('btn-close-assistant')?.addEventListener('click', () => this.close());
    document.getElementById('btn-clear-chat')?.addEventListener('click', () => this.clearChat());
    document.getElementById('btn-send-message')?.addEventListener('click', () => this.sendMessage());
    document.getElementById('btn-assistant-stop')?.addEventListener('click', () => this.stopGeneration());

    this.inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.inputEl?.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + 'px';
      this._handleAtMention();
    });

    document.querySelectorAll('.quick-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        this.handleQuickAction(action);
      });
    });

    if (this.scopeSelect) {
      this.scopeSelect.addEventListener('change', () => this.persistScopeFromUI());
    }

    const webSel = document.getElementById('assistant-connector-web');
    const mailSel = document.getElementById('assistant-connector-mail');
    const digestCb = document.getElementById('assistant-tab-digest-toggle');
    const persistConnector = async () => {
      const cfg = await window.navio.getConfig();
      if (webSel) cfg.assistantConnectorWeb = webSel.value || 'auto';
      if (mailSel) cfg.assistantConnectorMail = mailSel.value || 'auto';
      if (digestCb) cfg.assistantTabDigest = !!digestCb.checked;
      await window.navio.saveConfig(cfg);
      if (typeof App !== 'undefined') App.config = cfg;
    };
    if (webSel) webSel.addEventListener('change', () => persistConnector());
    if (mailSel) mailSel.addEventListener('change', () => persistConnector());
    if (digestCb) digestCb.addEventListener('change', () => persistConnector());

    const stepToggle = document.getElementById('assistant-step-mode-toggle');
    if (stepToggle) {
      stepToggle.addEventListener('change', async () => {
        const cfg = await window.navio.getConfig();
        cfg.aiAgentStepMode = !!stepToggle.checked;
        await window.navio.saveConfig(cfg);
        if (typeof App !== 'undefined') App.config = cfg;
      });
    }

    const pinBtn = document.getElementById('btn-pin-tab');
    if (pinBtn) {
      pinBtn.addEventListener('click', () => this.pinActiveTab());
    }

    this._bindVoiceMode();
    this._bindAssistantAttachments();
  }

  _bindAssistantAttachments() {
    const area = this.panel?.querySelector('.assistant-input-area');
    const attachBtn = document.getElementById('btn-assistant-attach');
    const fileInput = document.getElementById('assistant-file-input');
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files?.length) {
          this._addFilesFromList(fileInput.files);
          fileInput.value = '';
        }
      });
    }
    if (this.inputEl) {
      this.inputEl.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind === 'file') {
            const f = it.getAsFile();
            if (f && f.size > 0) files.push(f);
          }
        }
        if (files.length) {
          e.preventDefault();
          this._addFilesFromList(files);
        }
      });
    }
    if (area) {
      ['dragenter', 'dragover'].forEach((ev) => {
        area.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          area.classList.add('assistant-input-area--drop');
        });
      });
      area.addEventListener('dragleave', (e) => {
        if (!area.contains(e.relatedTarget)) area.classList.remove('assistant-input-area--drop');
      });
      area.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        area.classList.remove('assistant-input-area--drop');
        const dt = e.dataTransfer?.files;
        if (dt?.length) this._addFilesFromList(dt);
      });
    }
  }

  /**
   * Assistant transcript + API history: one bucket per **ungrouped** tab, or one shared per **tab group**
   * (`g:${groupId}`). Grouped tabs share memory; everything else stays isolated.
   */
  _storageKeyForTab(tab) {
    if (!tab) return NAVIO_PROFILE_CHAT_KEY;
    if (tab.groupId) return `g:${tab.groupId}`;
    return String(tab.id);
  }

  _storageKeyForTabId(tabId) {
    if (tabId == null || tabId === '') return NAVIO_PROFILE_CHAT_KEY;
    if (typeof TabManager === 'undefined' || !TabManager.tabs) return String(tabId);
    const t = TabManager.tabs.find((x) => String(x.id) === String(tabId));
    return t ? this._storageKeyForTab(t) : String(tabId);
  }

  _conversationKey() {
    if (typeof TabManager !== 'undefined' && TabManager.activeTabId) {
      const t = TabManager.getActiveTab();
      return this._storageKeyForTab(t);
    }
    return NAVIO_PROFILE_CHAT_KEY;
  }

  _panelDisplayStorageKey() {
    if (this._panelDisplayTabId == null || this._panelDisplayTabId === '') return null;
    return this._storageKeyForTabId(this._panelDisplayTabId);
  }

  /** Storage key for the in-flight turn (tab- or group-scoped). */
  _domTurnTabId() {
    if (this._turnConversationKey != null) return String(this._turnConversationKey);
    return String(this._conversationKey());
  }

  /** Whether sidebar may show typing/streaming/messages for the current turn (avoids cross-tab DOM pollution). */
  _panelShowsTurnDom() {
    const turnKey = this._domTurnTabId();
    if (turnKey === '__guest__') return true;
    const panelKey = this._panelDisplayStorageKey();
    if (panelKey == null) return true;
    return panelKey === turnKey;
  }

  /** Tab object for the tab that started the current assistant turn (or active tab). */
  _tabForTurnContext() {
    const tid = this._turnConversationKey;
    if (tid && typeof TabManager !== 'undefined') {
      const ts = String(tid);
      if (ts.startsWith('g:')) {
        const gid = ts.slice(2);
        const t = TabManager.tabs.find((x) => x.groupId === gid);
        if (t) return t;
      } else {
        const t = TabManager.tabs.find((x) => String(x.id) === ts);
        if (t) return t;
      }
    }
    return typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
  }

  _ensureConversationEntry(k) {
    if (this._conversationsByTab.has(k)) return;
    const legacy = this._conversationsByTab.get(NAVIO_PROFILE_CHAT_KEY);
    if (legacy && legacy.length && this._profileChatSeededToTabId == null) {
      this._conversationsByTab.set(k, [...legacy]);
      this._profileChatSeededToTabId = k;
    } else {
      this._conversationsByTab.set(k, []);
    }
  }

  async _ensureAssistantHistoryLoaded() {
    if (!this._assistantHistoryLoadPromise) {
      this._assistantHistoryLoadPromise = this._loadPersistedChat();
    }
    await this._assistantHistoryLoadPromise;
  }

  async _loadPersistedChat() {
    try {
      if (!window.navio || typeof window.navio.assistantChatLoad !== 'function') return;
      const data = await window.navio.assistantChatLoad();
      const raw = data && Array.isArray(data.messages) ? data.messages : [];
      const messages = [];
      for (const m of raw) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        if (typeof m.content !== 'string') continue;
        messages.push({ role: m.role, content: m.content });
      }
      if (messages.length) {
        this._conversationsByTab.set(NAVIO_PROFILE_CHAT_KEY, messages);
      }
    } catch (e) {
      console.warn('[navio-assistant] load persisted chat failed', e);
    }
  }

  _schedulePersistAssistantHistory() {
    if (this._assistantPersistTimer) clearTimeout(this._assistantPersistTimer);
    this._assistantPersistTimer = setTimeout(() => {
      this._assistantPersistTimer = null;
      void this._persistAssistantHistoryNow();
    }, 400);
  }

  async _persistAssistantHistoryNow() {
    try {
      if (!window.navio || typeof window.navio.assistantChatSave !== 'function') return;
      const h = this._conversationsByTab.get(this._conversationKey());
      if (!h || !h.length) {
        await window.navio.assistantChatSave({ messages: [] });
        return;
      }
      const messages = h
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }));
      await window.navio.assistantChatSave({ messages });
    } catch (e) {
      console.warn('[navio-assistant] persist chat failed', e);
    }
  }

  /** API message history (per tab, or shared per tab group; legacy profile migrates once into the first bucket). */
  _currentHistory() {
    const k = this._turnConversationKey ?? this._conversationKey();
    this._ensureConversationEntry(k);
    return this._conversationsByTab.get(k);
  }

  /**
   * When the user switches tabs: show that tab’s conversation. Do **not** cancel in-flight work —
   * automation stays on the agent-controlled tab via TabManager; API history stays keyed by the tab
   * that started the turn (`_turnConversationKey`). Sidebar DOM only updates for the tab being viewed
   * (`_panelDisplayTabId`) so another tab’s stream does not append into this transcript.
   */
  onActiveTabChanged(prevTabId, nextTabId) {
    if (!prevTabId || prevTabId === nextTabId) return;
    void this._syncPanelToTab(String(nextTabId));
    navioAssistantDebug('onActiveTabChanged', { prevTabId, nextTabId });
  }

  onTabClosed(tabId, meta = {}) {
    if (!tabId) return;
    const id = String(tabId);
    const gid = meta && meta.groupId != null && meta.groupId !== '' ? String(meta.groupId) : '';
    if (gid) {
      const gk = `g:${gid}`;
      const stillGrouped =
        typeof TabManager !== 'undefined' && TabManager.tabs.some((t) => t.groupId === gid);
      if (!stillGrouped) {
        this._conversationsByTab.delete(gk);
      }
      this._busyTabs.delete(gk);
    } else {
      this._conversationsByTab.delete(id);
      this._busyTabs.delete(id);
    }
  }

  /**
   * User removed a tab from a group (explicit ungroup): fork a copy of the group transcript onto the solo tab.
   */
  onTabLeftGroup(tabId, groupId) {
    if (!tabId || !groupId) return;
    const gk = `g:${groupId}`;
    const id = String(tabId);
    const grp = this._conversationsByTab.get(gk);
    if (grp && grp.length) {
      this._conversationsByTab.set(
        id,
        grp.map((m) => ({ role: m.role, content: m.content }))
      );
    } else {
      this._ensureConversationEntry(id);
    }
  }

  /**
   * Tab joined a group: merge any solo transcript for this tab into the shared group bucket.
   */
  onTabJoinedGroup(tabId, groupId) {
    if (!tabId || !groupId) return;
    const id = String(tabId);
    const gk = `g:${groupId}`;
    const solo = this._conversationsByTab.get(id);
    if (solo && solo.length) {
      const cur = this._conversationsByTab.get(gk) || [];
      this._conversationsByTab.set(gk, [...cur, ...solo]);
    }
    this._conversationsByTab.delete(id);
  }

  _renderDomFromHistoryKey(k) {
    if (!this.messagesEl) return;
    this.messagesEl.innerHTML = '';
    const h = this._conversationsByTab.get(k) || [];
    this._assistantHistoryDomReplay = true;
    try {
      for (const m of h) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        if (typeof m.content !== 'string') continue;
        const text = m.content;
        if (!String(text).trim() && m.role === 'user') continue;
        this.addMessage(m.role, text);
      }
    } finally {
      this._assistantHistoryDomReplay = false;
    }
  }

  /** Rebuild visible bubbles from profile API history (e.g. empty DOM after clear chat). */
  _renderDomFromCurrentHistory() {
    const k = this._turnConversationKey ?? this._conversationKey();
    this._renderDomFromHistoryKey(k);
  }

  /**
   * Swap the sidebar transcript to match `tabId` (conversation + attachments cleared for that view).
   */
  async _syncPanelToTab(tabId) {
    const k = String(tabId || '');
    if (!k) return;
    this._panelDisplayTabId = k;
    const storageKey = this._storageKeyForTabId(k);
    this._ensureConversationEntry(storageKey);
    try {
      this._clearAttachmentQueue();
    } catch {
      /* ignore */
    }
    this.setReceipt('');
    document.getElementById('navio-continue-pill')?.remove();
    const h = this._conversationsByTab.get(storageKey) || [];
    if (h.length) {
      this._renderDomFromHistoryKey(storageKey);
    } else if (this.messagesEl) {
      this.messagesEl.innerHTML = '';
      await this._showGreeting();
    }
  }

  _addFilesFromList(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
    if (!files.length) return;
    const row = document.getElementById('assistant-attachment-row');
    if (row) row.hidden = false;
    for (const file of files) {
      if (this._attachmentQueue.length >= NAVIO_ASSISTANT_MAX_ATTACHMENTS) {
        this.addMessage('assistant', `Maximum ${NAVIO_ASSISTANT_MAX_ATTACHMENTS} attachments per message.`, 'error');
        break;
      }
      const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const entry = {
        id,
        name: file.name || 'file',
        status: 'loading'
      };
      this._attachmentQueue.push(entry);
      this._renderAttachmentChips();
      this._processAttachmentFile(file, entry);
    }
  }

  /**
   * Encode non-text attachments as base64 so providers (e.g. Gemini) can ingest bytes.
   * Oversized files stay as `binary` with a note in the API payload.
   */
  async _attachmentAsInlineOrBinary(file, entry) {
    if (file.size <= NAVIO_ASSISTANT_INLINE_MAX_BYTES) {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error('Could not read file.'));
        r.readAsDataURL(file);
      });
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error('Could not encode file.');
      let mime = (m[1] || file.type || 'application/octet-stream').split(';')[0].trim();
      if ((!mime || mime === 'application/octet-stream') && file.type) {
        mime = String(file.type).split(';')[0].trim();
      }
      entry.status = 'ready';
      entry.kind = 'inline';
      entry.mimeType = mime || 'application/octet-stream';
      entry.base64 = m[2];
      entry.thumb = entry.mimeType.startsWith('image/') ? dataUrl : '';
      return;
    }
    entry.status = 'ready';
    entry.kind = 'binary';
    entry.text = '';
    entry.thumb = '';
  }

  async _processAttachmentFile(file, entry) {
    try {
      const sniffedImg = await navioPeekImageMime(file);
      if (navioIsImageFile(file) || sniffedImg) {
        if (file.size > NAVIO_ASSISTANT_IMAGE_MAX_BYTES) {
          throw new Error('Image too large (max 8 MB).');
        }
        let dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('Could not read image.'));
          r.readAsDataURL(file);
        });
        if (sniffedImg) dataUrl = navioFixDataUrlMime(dataUrl, sniffedImg);
        entry.status = 'ready';
        entry.kind = 'image';
        entry.dataUrl = dataUrl;
        entry.thumb = dataUrl;
      } else if (navioIsPdfFile(file)) {
        if (file.size > NAVIO_ASSISTANT_PDF_MAX_BYTES) {
          throw new Error('PDF too large (max 12 MB).');
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('Could not read PDF.'));
          r.readAsDataURL(file);
        });
        const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
        if (!m) throw new Error('Invalid PDF encoding.');
        entry.status = 'ready';
        entry.kind = 'pdf';
        entry.base64 = m[1];
        entry.thumb = '';
      } else if (navioIsTextLikeFile(file)) {
        if (file.size > NAVIO_ASSISTANT_TEXT_MAX_CHARS * 2) {
          throw new Error('Text file too large.');
        }
        const text = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('Could not read file.'));
          r.readAsText(file, 'UTF-8');
        });
        entry.status = 'ready';
        entry.kind = 'text';
        entry.text = text.length > NAVIO_ASSISTANT_TEXT_MAX_CHARS
          ? `${text.slice(0, NAVIO_ASSISTANT_TEXT_MAX_CHARS)}\n\n… [truncated]`
          : text;
        entry.thumb = '';
      } else if (file.size <= NAVIO_ASSISTANT_HEURISTIC_TEXT_MAX_BYTES) {
        const buf = await file.arrayBuffer();
        let decoded = '';
        try {
          decoded = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        } catch {
          decoded = '';
        }
        if (navioLooksLikePrintableText(decoded)) {
          entry.status = 'ready';
          entry.kind = 'text';
          entry.text =
            decoded.length > NAVIO_ASSISTANT_TEXT_MAX_CHARS
              ? `${decoded.slice(0, NAVIO_ASSISTANT_TEXT_MAX_CHARS)}\n\n… [truncated]`
              : decoded;
          entry.thumb = '';
        } else {
          await this._attachmentAsInlineOrBinary(file, entry);
        }
      } else {
        await this._attachmentAsInlineOrBinary(file, entry);
      }
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message || String(e);
    }
    this._renderAttachmentChips();
  }

  _renderAttachmentChips() {
    const row = document.getElementById('assistant-attachment-row');
    if (!row) return;
    if (!this._attachmentQueue.length) {
      row.innerHTML = '';
      row.hidden = true;
      return;
    }
    row.hidden = false;
    row.innerHTML = this._attachmentQueue
      .map((e) => {
        const safe = this._escapeHtml(e.name);
        if (e.status === 'loading') {
          return `<div class="assistant-att-chip assistant-att-chip--loading" data-id="${e.id}"><span class="assistant-att-spinner"></span>${safe}</div>`;
        }
        if (e.status === 'error') {
          return `<div class="assistant-att-chip assistant-att-chip--err" data-id="${e.id}">${safe}<span class="assistant-att-err" title="${this._escapeHtml(e.error || '')}">!</span><button type="button" class="assistant-att-remove" data-id="${e.id}" aria-label="Remove">×</button></div>`;
        }
        const thumb = e.thumb
          ? `<img class="assistant-att-thumb" src="${e.thumb.replace(/"/g, '&quot;')}" alt="">`
          : `<span class="assistant-att-icon" aria-hidden="true">${e.kind === 'pdf' ? 'PDF' : 'FILE'}</span>`;
        return `<div class="assistant-att-chip" data-id="${e.id}">${thumb}<span class="assistant-att-name">${safe}</span><button type="button" class="assistant-att-remove" data-id="${e.id}" aria-label="Remove">×</button></div>`;
      })
      .join('');
    row.querySelectorAll('.assistant-att-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        this._attachmentQueue = this._attachmentQueue.filter((x) => x.id !== id);
        this._renderAttachmentChips();
      });
    });
  }

  _attachmentsStillLoading() {
    return this._attachmentQueue.some((a) => a.status === 'loading');
  }

  /** Comet-style: tell the model the next user message includes real file bytes, not just browsing context. */
  _maybePushAttachmentSystemHint(messages) {
    const snap = this._attachmentsSnapshot;
    if (!Array.isArray(snap) || !snap.some((a) => a && a.status === 'ready')) return;
    messages.push({
      role: 'system',
      content:
        '[User attachments]\nThe user included file attachments in this message. Their contents appear in the next user message (text, images, PDFs, or other parts). Read and use them as the primary source when answering. Use browser tools only when the task requires live web interaction.'
    });
  }

  /** Gmail API is available (connector and/or Google OAuth) and the user is asking about mail — prefer backend tools, not the Gmail web UI. */
  async _gmailApiMailBackendPreferred(text, config) {
    if (!navioMailContextActiveForTurn(text, () => this._currentHistory())) return false;
    const mailMode = (config && config.assistantConnectorMail) || 'auto';
    if (mailMode === 'never') return false;
    let oauth = false;
    try {
      const st = await window.navio.oauthStatus();
      oauth = !!(st && (navioOAuthSlotActive(st.google) || navioOAuthSlotActive(st.google_2)));
    } catch {
      oauth = false;
    }
    const hasConnector =
      typeof ConnectorsManager !== 'undefined' &&
      (ConnectorsManager.isConnected('gmail') || ConnectorsManager.isConnected('gmail_2'));
    return hasConnector || oauth;
  }

  async _maybePushMailBackendOnlyPolicy(messages, text, config, prefKnown) {
    const use = prefKnown !== undefined ? prefKnown : await this._gmailApiMailBackendPreferred(text, config);
    if (!use) return;
    messages.push({
      role: 'system',
      content:
        '[Mail — API first, browser when needed]\nThe user’s message was detected as mail-related. Gmail is connected in Navio (Settings → Connectors and/or Google sign-in). Prefer **gmail_search**, **gmail_get_message**, **gmail_list_drafts**, and draft tools — they are fast and reliable. **Do not** open Gmail or use mail tools for questions that are not about email/inbox/messages/drafts. **If the API response does not contain what the task requires** (e.g. amounts or text inside an attachment, previews, or anything only visible in the Gmail UI), you MUST NOT stop with “I can’t” — use **navigate** or **open_tab** with **gmail_browser_takeover: true** to open the real Gmail tab, then **read_page**, **click** (open attachment / preview), **screenshot** as needed. Never click Send on email.'
    });
  }

  /**
   * When the turn is not mail/workspace-related, remind the model to stay on task — OAuth does not mean “open Gmail”.
   */
  _maybePushNonMailTaskFocus(messages, userText) {
    const t = userText != null ? String(userText) : '';
    if (navioMailContextActiveForTurn(t, () => this._currentHistory())) return;
    if (navioDetectGoogleWorkspaceIntent(t)) return;
    messages.push({
      role: 'system',
      content:
        '[Task focus]\nThis user message is **not** asking about their inbox or email unless they say so. Help with what they actually asked (code, browsing, research, the page, files, automation, etc.). Do **not** open Gmail, call Gmail tools, or redirect to mail unless they clearly ask for email/inbox/triage or are continuing a mail thread.'
    });
  }

  /** Injects which Google / Microsoft OAuth slots exist — full mail/Drive detail only when the turn is actually Google-workspace or mail-related. */
  async _maybePushGoogleAccountsPolicy(messages, { isQuickAction = false, userText = '' } = {}) {
    if (isQuickAction) return;
    const t = userText != null ? String(userText) : '';
    const mailContext = navioMailContextActiveForTurn(t, () => this._currentHistory());
    const workspaceContext = navioDetectGoogleWorkspaceIntent(t);
    const detailedGoogle = mailContext || workspaceContext;
    let oauthSt = {};
    try {
      oauthSt = (await window.navio.oauthStatus()) || {};
    } catch {
      return;
    }
    const gPri = navioOAuthSlotActive(oauthSt.google);
    const gSec = navioOAuthSlotActive(oauthSt.google_2);
    const ms = navioOAuthSlotActive(oauthSt.microsoft);
    if (!gPri && !gSec && !ms) return;
    const label = (e, fallback) => ((e && e.email) || fallback).trim() || fallback;
    if (gPri && gSec) {
      if (detailedGoogle) {
        messages.push({
          role: 'system',
          content:
            `[Navio — two Google accounts in this profile]\n` +
            `**Primary:** ${label(oauthSt.google, '(signed in)')} — tools use \`google_account: "primary"\` (default).\n` +
            `**Secondary:** ${label(oauthSt.google_2, '(2nd account)')} — tools use \`google_account: "secondary"\`.\n\n` +
            `If the user asks about mail, unread, inbox, triage, "anything new", Drive, or Calendar **without** naming which account, you MUST consider **both** Google slots (run the relevant tool/query twice with primary vs secondary when applicable, then merge). ` +
            `Do not infer from the active browser tab alone.`
        });
      } else {
        messages.push({
          role: 'system',
          content:
            `[Navio — OAuth] Two Google accounts: **${label(oauthSt.google, 'primary')}** (primary) and **${label(oauthSt.google_2, 'secondary')}** (secondary). ` +
            `Use \`google_account\` only when a Google tool (mail, Drive, Calendar, etc.) applies to this task. ` +
            `Do **not** open Gmail or use mail tools for unrelated questions.`
        });
      }
    } else if (gPri) {
      messages.push({
        role: 'system',
        content: detailedGoogle
          ? `[Navio — Google account] **${label(oauthSt.google, 'Primary')}** — use \`google_account: "primary"\` when a tool accepts it.`
          : `[Navio — OAuth] Google signed in as **${label(oauthSt.google, 'Primary')}**. Use Google/mail tools only when this task involves those services — not for unrelated requests.`
      });
    } else if (gSec) {
      messages.push({
        role: 'system',
        content: detailedGoogle
          ? `[Navio — Google account] **${label(oauthSt.google_2, 'Secondary')}** only — use \`google_account: "secondary"\` for Gmail API tools.`
          : `[Navio — OAuth] Google (secondary) **${label(oauthSt.google_2, 'Secondary')}**. Use Google/mail tools only when the task involves those services.`
      });
    }
    if (ms && oauthSt.microsoft?.email) {
      messages.push({
        role: 'system',
        content: detailedGoogle
          ? `[Navio — Microsoft account] **${oauthSt.microsoft.email}** — Outlook / OneDrive connectors use this login when connected.`
          : `[Navio — OAuth] Microsoft **${oauthSt.microsoft.email}** — use Outlook/OneDrive tools only when this task involves Microsoft services.`
      });
    }
  }

  /**
   * Prepended to every outbound user turn so the model keeps the current ask in view
   * (reduces scope drift and random tools in long threads). Not stored in chat history.
   */
  _taskAnchorPrefix() {
    return (
      '[What to do now — only this]\n' +
      'Address **this** user message. Do not start a different goal, topic, or side task. ' +
      'Do not use tools for things they did not ask for in this turn. ' +
      'If they only say something short because the thread is continuing, keep the **same** task as before — do not invent a new one.\n\n'
    );
  }

  _buildAttachmentPayloadForApi(baseText) {
    const imageParts = [];
    const pdfParts = [];
    const inlineParts = [];
    let textExtra = '';
    const ready = (this._attachmentsSnapshot || this._attachmentQueue).filter((a) => a.status === 'ready');
    for (const e of ready) {
      if (e.kind === 'image' && e.dataUrl) {
        imageParts.push({ type: 'image_url', image_url: { url: e.dataUrl, detail: 'high' } });
      } else if (e.kind === 'pdf' && e.base64) {
        pdfParts.push({ type: 'navio_pdf', filename: e.name, base64: e.base64 });
      } else if (e.kind === 'text' && e.text) {
        textExtra += `\n\n--- attached: ${e.name} ---\n\`\`\`\n${e.text}\n\`\`\`\n`;
      } else if (e.kind === 'inline' && e.base64) {
        const mt = e.mimeType || 'application/octet-stream';
        if (mt.startsWith('image/')) {
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${mt};base64,${e.base64}`, detail: 'high' }
          });
        } else if (mt === 'application/pdf') {
          pdfParts.push({ type: 'navio_pdf', filename: e.name, base64: e.base64 });
        } else {
          inlineParts.push({
            type: 'navio_inline',
            mimeType: mt,
            base64: e.base64,
            filename: e.name
          });
        }
      } else if (e.kind === 'binary') {
        textExtra += `\n\n[Attached binary **${e.name}** is over ${Math.round(
          NAVIO_ASSISTANT_INLINE_MAX_BYTES / (1024 * 1024)
        )} MB or could not be encoded — describe what you need, split the file, or convert to a smaller PDF/image if the model must read it.]`;
      }
    }
    const fullText = this._taskAnchorPrefix() + (baseText || '') + textExtra;
    const hasShot = !!this._pendingScreenshotDataUrl;
    if (!imageParts.length && !pdfParts.length && !inlineParts.length && !hasShot) {
      return fullText;
    }
    const parts = [];
    let head = fullText;
    if (hasShot) {
      head +=
        '\n\n[Attached: screenshot of the active browsing tab after the last action. Stay on the task in **What to do now** above. Describe what you see, then pick the next tool (read_page, click, navigate, scroll, screenshot) only as needed for that task — do not stop after one image unless the task is done or blocked.]';
    }
    parts.push({ type: 'text', text: head || '(see attachments)' });
    for (const p of pdfParts) parts.push(p);
    for (const p of inlineParts) parts.push(p);
    for (const p of imageParts) parts.push(p);
    if (hasShot) {
      parts.push({ type: 'image_url', image_url: { url: this._pendingScreenshotDataUrl } });
      this._pendingScreenshotDataUrl = null;
    }
    return parts;
  }

  _historyLabelForAttachments(text) {
    const ready = (this._attachmentsSnapshot || this._attachmentQueue).filter((a) => a.status === 'ready');
    if (!ready.length) return text;
    const tags = ready.map((a) => {
      if (a.kind === 'image') return `[Image: ${a.name}]`;
      if (a.kind === 'pdf') return `[PDF: ${a.name}]`;
      if (a.kind === 'text') return `[File: ${a.name}]`;
      return `[File: ${a.name}]`;
    });
    return `${text || '(attachment)'}\n${tags.join(' ')}`;
  }

  _clearAttachmentQueue() {
    this._attachmentQueue = [];
    this._renderAttachmentChips();
  }

  // ── Voice Mode (Web Speech API) ──────────────────────────────────────────
  _bindVoiceMode() {
    const btn = document.getElementById('btn-voice-mode');
    const hint = document.getElementById('voice-hint');
    if (!btn) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      btn.style.display = 'none';
      return;
    }

    let recognition = null;
    let listening = false;

    const startListening = () => {
      if (listening) return;
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        listening = true;
        btn.classList.add('listening');
        if (hint) hint.textContent = 'Listening... click mic to stop';
      };

      recognition.onresult = (e) => {
        const transcript = Array.from(e.results)
          .map(r => r[0].transcript)
          .join('');
        this.inputEl.value = transcript;
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + 'px';
        if (e.results[e.results.length - 1].isFinal) {
          stopListening();
          if (transcript.trim()) this.sendMessage();
        }
      };

      recognition.onerror = (e) => {
        stopListening();
        if (e.error !== 'no-speech') {
          if (hint) hint.textContent = `Voice error: ${e.error}`;
          setTimeout(() => { if (hint) hint.textContent = 'Enter to send \u00b7 Shift+Enter for new line \u00b7 Paste or attach files'; }, 2500);
        }
      };

      recognition.onend = () => stopListening();
      recognition.start();
    };

    const stopListening = () => {
      listening = false;
      btn.classList.remove('listening');
      if (hint) hint.textContent = 'Enter to send \u00b7 Shift+Enter for new line \u00b7 Paste or attach files';
      if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    };

    btn.addEventListener('click', () => {
      if (listening) stopListening();
      else startListening();
    });
  }

  async persistScopeFromUI() {
    if (!this.scopeSelect) return;
    const cfg = await window.navio.getConfig();
    cfg.aiDataScope = this.scopeSelect.value;
    cfg.aiIncludePageContext = cfg.aiDataScope !== 'none';
    await window.navio.saveConfig(cfg);
    if (typeof App !== 'undefined') App.config = cfg;
  }

  async syncScopeFromConfig() {
    let cfg;
    try {
      cfg = await window.navio.getConfig();
    } catch {
      cfg = null;
    }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    if (this.scopeSelect) {
      const v = cfg.aiDataScope || (cfg.aiIncludePageContext === false ? 'none' : 'excerpt');
      this.scopeSelect.value = ['none', 'selection', 'excerpt', 'full'].includes(v) ? v : 'excerpt';
    }
    const stepToggle = document.getElementById('assistant-step-mode-toggle');
    if (stepToggle) stepToggle.checked = !!cfg.aiAgentStepMode;
  }

  /** Lines for [Open tabs] system messages; includes tab_id for switch_tab and group when grouped. */
  _openTabsAwarenessBlock(allTabs) {
    if (!allTabs.length || typeof TabManager === 'undefined') return '';
    const activeId = TabManager.activeTabId;
    return allTabs
      .map((t) => {
        const title = TabManager.getTabDisplayTitle(t) || t.url;
        const g = TabManager.getTabGroupLabel?.(t);
        const gpart = g ? ` [group: ${g}]` : '';
        const act = t.id === activeId ? ' [active]' : '';
        return `- tab_id=${t.id}${act} — ${title} — ${t.url}${gpart}`;
      })
      .join('\n');
  }

  // ── @tab mention picker ───────────────────────────────────────────────
  // Typing "@" in the input shows a list of open tabs. Clicking one inserts
  // @[Tab Title] into the input. These references are resolved before sending,
  // injecting each tab's content as a system message into the AI context.

  _handleAtMention() {
    const val = this.inputEl.value;
    const cursorPos = this.inputEl.selectionStart || val.length;
    // Find the last @ before cursor without a closing ]
    const before = val.slice(0, cursorPos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1 || before.slice(atIdx).includes(']')) {
      this._hideMentionPicker();
      return;
    }
    const query = before.slice(atIdx + 1).toLowerCase();
    const tabs = typeof TabManager !== 'undefined'
      ? TabManager.tabs.filter(t => t.url && t.url !== 'about:blank')
      : [];
    const matches = query
      ? tabs.filter((t) => {
          const d = TabManager.getTabDisplayTitle(t).toLowerCase();
          return d.includes(query) || (t.title || '').toLowerCase().includes(query) || (t.url || '').toLowerCase().includes(query);
        })
      : tabs;
    if (!matches.length) { this._hideMentionPicker(); return; }
    this._showMentionPicker(matches, atIdx);
  }

  _showMentionPicker(tabs, atIdx) {
    let picker = document.getElementById('at-mention-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'at-mention-picker';
      picker.className = 'at-mention-picker';
      document.body.appendChild(picker);
    }
    // Position above the input using fixed coords so any parent layout doesn't matter
    const rect = this.inputEl.getBoundingClientRect();
    picker.style.left  = rect.left + 'px';
    picker.style.width = rect.width + 'px';
    picker.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    picker.style.top = '';
    picker.innerHTML = tabs.slice(0, 8).map((t, i) => {
      const disp = TabManager.getTabDisplayTitle(t);
      const safe = disp.replace(/"/g, '&quot;');
      return `
      <div class="at-mention-item" data-idx="${i}" data-title="${safe}">
        ${t.favicon ? `<img class="at-mention-favicon" src="${t.favicon}" alt="">` : '<div class="at-mention-favicon-ph"></div>'}
        <div class="at-mention-label">
          <span class="at-mention-title">${disp || t.url}</span>
          <span class="at-mention-url">${(t.url || '').replace(/^https?:\/\//, '').slice(0, 40)}</span>
        </div>
      </div>`;
    }).join('');
    picker.hidden = false;
    picker.querySelectorAll('.at-mention-item').forEach((item, i) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const title = item.dataset.title;
        // Replace the @query with @[Tab Title]
        const val = this.inputEl.value;
        const cursor = this.inputEl.selectionStart || val.length;
        const before = val.slice(0, cursor);
        const atIdx2 = before.lastIndexOf('@');
        const newVal = val.slice(0, atIdx2) + `@[${title}]` + val.slice(cursor);
        this.inputEl.value = newVal;
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + 'px';
        this._hideMentionPicker();
        this.inputEl.focus();
      });
    });
  }

  _hideMentionPicker() {
    const picker = document.getElementById('at-mention-picker');
    if (picker) picker.hidden = true;
  }

  _tabIdsFromAtMentions(text) {
    const ids = new Set();
    const matches = [...text.matchAll(/@\[([^\]]+)\]/g)];
    if (!matches.length || typeof TabManager === 'undefined') return ids;
    const tabs = TabManager.tabs;
    for (const m of matches) {
      const title = m[1];
      const tab = tabs.find((t) => {
        const d = TabManager.getTabDisplayTitle(t);
        return d === title || d.toLowerCase() === title.toLowerCase() || t.title === title || (t.title || '').toLowerCase() === title.toLowerCase();
      });
      if (tab) ids.add(tab.id);
    }
    return ids;
  }

  /**
   * Tabs whose title, page title, or tab-group name appears in the user message (no @ required).
   */
  _inferReferencedTabsFromMessage(text) {
    if (!text || typeof TabManager === 'undefined') return [];
    const low = text.toLowerCase();
    const tabs = TabManager.tabs.filter((t) => t.webview && t.url && !t.url.startsWith('about:'));
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const picked = new Set();

    const tryPick = (id) => {
      if (byId.has(id)) picked.add(id);
    };

    for (const t of tabs) {
      const disp = TabManager.getTabDisplayTitle(t);
      const dlow = disp.toLowerCase().trim();
      if (dlow.length >= 4 && low.includes(dlow)) tryPick(t.id);
      else if (dlow.length >= 3) {
        try {
          const re = new RegExp(`\\b${dlow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          if (re.test(text)) tryPick(t.id);
        } catch {
          /* ignore */
        }
      }
      const pageTitle = (t.title && String(t.title).toLowerCase().trim()) || '';
      if (pageTitle.length >= 4 && pageTitle !== dlow && low.includes(pageTitle)) tryPick(t.id);
    }

    for (const t of tabs) {
      const g = TabManager.getTabGroupLabel?.(t);
      if (!g) continue;
      const gl = g.toLowerCase();
      if (gl.length < 2) continue;
      if (low.includes(gl)) {
        TabManager.tabs.filter((x) => x.groupId === t.groupId).forEach((x) => tryPick(x.id));
      }
    }

    return [...picked]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, 6);
  }

  async _fetchTabContextForTabs(tabs, labelPrefix) {
    const contextMessages = [];
    for (const tab of tabs) {
      if (!tab?.webview) continue;
      const title = TabManager.getTabDisplayTitle(tab);
      try {
        const wc = tab.webview.getWebContentsId();
        const content = await window.navio.extractPageContent(wc);
        if (content && !content.error) {
          const body = (content.text || '').slice(0, 15000);
          const g = TabManager.getTabGroupLabel?.(tab);
          const gline = g ? `\nTab group: ${g}` : '';
          contextMessages.push({
            role: 'system',
            content: `[${labelPrefix}: "${title}"]${gline}\nURL: ${content.url}\nTitle: ${content.title}\n\n${body}`
          });
        }
      } catch {
        /* ignore */
      }
    }
    return contextMessages;
  }

  // Resolve @[Tab Title] references → fetch page content for each → build system messages
  async _resolveAtMentions(text) {
    const matches = [...text.matchAll(/@\[([^\]]+)\]/g)];
    if (!matches.length) return [];
    const tabs = typeof TabManager !== 'undefined' ? TabManager.tabs : [];
    const picked = [];
    for (const m of matches) {
      const title = m[1];
      const tab = tabs.find((t) => {
        const d = TabManager.getTabDisplayTitle(t);
        return d === title || d.toLowerCase() === title.toLowerCase() || t.title === title || (t.title || '').toLowerCase() === title.toLowerCase();
      });
      if (tab) picked.push(tab);
    }
    return this._fetchTabContextForTabs(picked, 'Referenced tab');
  }

  async _resolveImplicitTabContext(text, excludeTabIds) {
    const inferred = this._inferReferencedTabsFromMessage(text);
    const ex = excludeTabIds || new Set();
    const toFetch = inferred.filter((t) => !ex.has(t.id));
    if (!toFetch.length) return [];
    return this._fetchTabContextForTabs(toFetch, 'Matched tab from your message');
  }

  toggle() {
    const now = Date.now();
    if (now - this._lastToggleAt < 100) {
      navioAssistantDebug('toggle: ignored (debounce <100ms)');
      return;
    }
    this._lastToggleAt = now;
    this._ensurePanel();
    const open = this.panel?.classList.contains('open');
    navioAssistantDebug('toggle: branch', { hasPanel: !!this.panel, wasOpen: !!open });
    if (open) this.close();
    else void this.open();
  }

  async open() {
    await this._ensureAssistantHistoryLoaded();
    this._ensurePanel();
    if (!this.panel) {
      navioAssistantDebug('open: ABORT — #assistant-panel not found after _ensurePanel()');
      return;
    }
    this.isOpen = true;
    this.panel.classList.add('open');
    document.body.classList.add('navio-assistant-open');
    navioAssistantDebug('open: classes applied', {
      bodyAssistantOpen: document.body.classList.contains('navio-assistant-open'),
      panelClass: this.panel.className
    });
    try {
      await this.syncScopeFromConfig();
      await this.syncConnectorTogglesFromConfig();
      const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
      if (aid) await this._syncPanelToTab(aid);
    } catch (err) {
      console.warn('[Assistant] open(): config/sync failed', err);
      navioAssistantDebug('open: config/sync threw', err && err.message ? err.message : String(err));
    }
    requestAnimationFrame(() => {
      if (!this.panel) return;
      const cs = getComputedStyle(this.panel);
      navioAssistantDebug('open: after paint (computed)', {
        width: cs.width,
        visibility: cs.visibility,
        opacity: cs.opacity,
        display: cs.display,
        pointerEvents: cs.pointerEvents
      });
    });
    setTimeout(() => this.inputEl?.focus(), 300);
  }

  async syncConnectorTogglesFromConfig() {
    try {
      let cfg;
      try {
        cfg = await window.navio.getConfig();
      } catch {
        cfg = null;
      }
      if (!cfg || typeof cfg !== 'object') cfg = {};
      const webSel = document.getElementById('assistant-connector-web');
      const mailSel = document.getElementById('assistant-connector-mail');
      const digestCb = document.getElementById('assistant-tab-digest-toggle');
      const wm = cfg.assistantConnectorWeb || 'auto';
      const mm = cfg.assistantConnectorMail || 'auto';
      if (webSel && ['auto', 'always', 'never'].includes(wm)) webSel.value = wm;
      if (mailSel && ['auto', 'always', 'never'].includes(mm)) mailSel.value = mm;
      if (digestCb) digestCb.checked = !!cfg.assistantTabDigest;
    } catch {
      /* ignore */
    }
  }

  _connectorOptsFromConfig(cfg) {
    return {
      webMode: cfg.assistantConnectorWeb || 'auto',
      mailMode: cfg.assistantConnectorMail || 'auto'
    };
  }

  async _showGreeting() {
    try {
      const cfg = await window.navio.getConfig();
      const name = cfg.userName ? ` ${cfg.userName.split(' ')[0]}` : '';
      const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
      const pageHint = tab && tab.url && !tab.url.startsWith('about:')
        ? `<p style="font-size:12px;color:var(--text-tertiary);margin-top:6px">On: <span style="color:var(--text-accent)">${TabManager.getTabDisplayTitle(tab)}</span></p>`
        : '';
      this.addMessage('assistant', `Hey${name}! I'm Navio — your AI co-pilot.\n\nJust ask me anything — about the page you're on, the web, your emails, or any task you want automated.${pageHint}`);
    } catch {
      this.addMessage('assistant', "Hey! I'm Navio — your AI co-pilot. How can I help?");
    }
  }

  close() {
    this._ensurePanel();
    this.isOpen = false;
    this.panel?.classList.remove('open');
    document.body.classList.remove('navio-assistant-open');
    navioAssistantDebug('close: assistant dock hidden');
  }

  async sendMessage() {
    await this._ensureAssistantHistoryLoaded();
    const text = this.inputEl.value.trim();
    const hasReadyAttachments = this._attachmentQueue.some((a) => a.status === 'ready');
    if (this._attachmentsStillLoading()) {
      this.addMessage('assistant', 'Wait until attachments finish loading.', 'error');
      return;
    }
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if ((!text && !hasReadyAttachments) || (aid && this._tabIsBusy(aid))) return;

    if (text.startsWith('>>')) {
      if (hasReadyAttachments) {
        this.addMessage('assistant', 'Remove attachments before using **>>** research.', 'error');
        return;
      }
      const q = text.slice(2).trim();
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      if (!q) {
        this.addMessage('assistant', 'Add a topic after **>>** in the omnibar or assistant (e.g. `>> best CRM for small business`).');
        return;
      }
      this.addMessage('user', `>> ${q}`);
      await this.runDeepResearch(q);
      return;
    }

    // Task chain intake mode
    if (this._awaitingTaskChain) {
      if (hasReadyAttachments) {
        this.addMessage('assistant', 'Remove attachments before entering task steps, or cancel the task chain first.', 'error');
        return;
      }
      this._awaitingTaskChain = false;
      const steps = text.split('\n').map(l => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      this.addMessage('user', text);
      if (steps.length === 0) {
        this.addMessage('assistant', 'No steps detected. Please enter at least one task per line.');
        return;
      }
      this.addMessage('assistant', `Starting task chain with **${steps.length} step${steps.length > 1 ? 's' : ''}**. I'll ask for your approval before each step.`);
      this.startTaskChain(steps);
      return;
    }

    this._autoFollowCount = 0; // reset agent loop on new user message
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    const effectiveText = text || (hasReadyAttachments ? 'Please help with the attached file(s).' : '');
    const userDisplay = hasReadyAttachments
      ? {
          text: text || '',
          files: this._attachmentQueue.filter((a) => a.status === 'ready').map((a) => ({
            name: a.name,
            thumb: a.thumb,
            kind: a.kind
          }))
        }
      : text;

    this.addMessage('user', userDisplay);
    this._attachmentsSnapshot = this._attachmentQueue
      .filter((a) => a.status === 'ready')
      .map((a) => ({ ...a }));
    this._clearAttachmentQueue();
    try {
      await this.processMessage(effectiveText, false);
    } finally {
      this._attachmentsSnapshot = null;
    }
  }

  async handleQuickAction(action) {
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if (aid && this._tabIsBusy(aid)) return;
    if (!this.isOpen) this.open();

    if (action === 'all-tabs') {
      await this.handleQuickActionAllTabs();
      return;
    }

    const pageContent = await TabManager.getActivePageContent();
    if (!pageContent || pageContent.error) {
      this.addMessage('user', `[${action}]`);
      this.addMessage('assistant', 'No page content available. Navigate to a web page first, then try again.');
      return;
    }

    let prompt;
    switch (action) {
      case 'deep-research': {
        this.addMessage('user', 'Deep research');
        const seed = `Topic context from current page:\nTitle: ${pageContent.title}\nURL: ${pageContent.url}\n\n${(pageContent.text || '').slice(0, 10000)}`;
        await this.runDeepResearch(
          `Produce a multi-source research report. User started from this page:\n\n${seed}`
        );
        return;
      }
      case 'summarize':
        prompt = `Summarize this web page concisely:\n\nTitle: ${pageContent.title}\nURL: ${pageContent.url}\n\nContent:\n${pageContent.text?.substring(0, 8000)}`;
        break;
      case 'explain':
        prompt = `Explain the main content of this web page in simple terms:\n\nTitle: ${pageContent.title}\nURL: ${pageContent.url}\n\nContent:\n${pageContent.text?.substring(0, 8000)}`;
        break;
      case 'extract':
        prompt = `Extract the key data points, facts, and important information from this page in a structured format:\n\nTitle: ${pageContent.title}\nURL: ${pageContent.url}\n\nContent:\n${pageContent.text?.substring(0, 8000)}`;
        break;
      case 'translate':
        prompt = `Translate the main content of this page to English (if not already in English, otherwise ask what language to translate to):\n\nTitle: ${pageContent.title}\n\nContent:\n${pageContent.text?.substring(0, 5000)}`;
        break;
      case 'task-chain':
        // Show a dialog-like prompt to collect the task list
        this.addMessage('assistant',
          `**Task Chain** lets you define multiple steps for me to execute one by one, with your approval at each step.\n\n` +
          `Type your steps below, one per line. Example:\n\`\`\`\nGo to gmail.com\nSearch for unread emails from Amazon\nSummarize the latest email\n\`\`\`\n\n` +
          `Enter your task steps now:`
        );
        this._awaitingTaskChain = true;
        setTimeout(() => this.inputEl.focus(), 200);
        return;
      default:
        return;
    }

    const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
    this.addMessage('user', `${actionLabel} this page`);
    await this.processMessage(prompt, true, `${actionLabel} this page`);
  }

  async buildPageContextSystemMessage(config, isQuickAction, opts = {}) {
    if (isQuickAction) return null;
    const scope = (this.scopeSelect && this.scopeSelect.value) || config.aiDataScope || 'excerpt';
    if (scope === 'none') {
      this.setReceipt('Context: none (nothing from the page was sent).');
      return null;
    }

    const page = await TabManager.getActivePageContent();
    if (!page || page.error || !page.url) {
      this.setReceipt('No active page context.');
      return null;
    }

    if (
      opts.skipGmailPageExcerpt &&
      typeof EmailAssistant !== 'undefined' &&
      EmailAssistant.isMailUrl(page.url) &&
      /mail\.google\.com/i.test(page.url || '')
    ) {
      this.setReceipt('Gmail API is connected — page excerpt skipped (use API tools, not the web UI).');
      return null;
    }

    if (scope === 'selection') {
      const wv = TabManager.getBrowserTargetWebview?.() || TabManager.getActiveWebview();
      let selText = '';
      if (wv) {
        try {
          const r = await window.navio.extractPageSelection(wv.getWebContentsId());
          selText = (r && r.selection) || '';
        } catch {
          selText = '';
        }
      }
      if (!selText.trim()) {
        this.setReceipt('Scope: selection — no text selected; sent notice only.');
        return { role: 'system', content: '[Selection scope] No text is currently selected in the active tab.' };
      }
      this.setReceipt(`Scope: selection — ${selText.length} characters from selection.`);
      return { role: 'system', content: `[Selected text only]\n${selText.slice(0, 12000)}` };
    }

    if (scope === 'excerpt') {
      const heads = page.headings?.map((h) => `${h.level}: ${h.text}`).join('\n') || '';
      const body = (page.text || '').slice(0, 15000);
      this.setReceipt(`Scope: excerpt — title + headings + ${body.length} chars of body.`);
      return {
        role: 'system',
        content: `[Current page context — excerpt]\nTitle: ${page.title}\nURL: ${page.url}\nDescription: ${page.description || 'N/A'}\nHeadings:\n${heads}\n\nBody (truncated):\n${body}`
      };
    }

    const body = (page.text || '').slice(0, 14000);
    this.setReceipt(`Scope: extended — large extract (${body.length} chars).`);
    return {
      role: 'system',
      content: `[Current page context — extended]\nTitle: ${page.title}\nURL: ${page.url}\n\n${body}`
    };
  }

  setReceipt(text) {
    if (this.receiptEl) this.receiptEl.textContent = text || '';
  }

  /** Abort streaming or tool-loop for the active tab only (other tabs keep running). */
  stopGeneration() {
    try {
      if (window.navio && typeof window.navio.aiAbort === 'function') {
        const t = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
        const sk = t ? this._storageKeyForTab(t) : '';
        void window.navio.aiAbort(sk ? { tabId: sk } : {});
      }
    } catch {
      /* ignore */
    }
  }

  _tabIsBusy(tabId) {
    if (tabId == null) return false;
    const sk = this._storageKeyForTabId(tabId);
    return this._busyTabs.has(sk);
  }

  _setTabBusy(tabId, busy) {
    const k = String(tabId);
    if (busy) this._busyTabs.add(k);
    else this._busyTabs.delete(k);
    this._updateAssistantBusyChrome();
  }

  _updateAssistantBusyChrome() {
    const active = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
    const sk = active ? this._storageKeyForTab(active) : '';
    const busy = !!(active && sk && this._busyTabs.has(sk));
    const stop = document.getElementById('btn-assistant-stop');
    const send = document.getElementById('btn-send-message');
    if (stop) {
      stop.hidden = !busy;
      stop.disabled = !busy;
    }
    if (send) send.hidden = !!busy;
  }

  async pinActiveTab() {
    const tab = TabManager.getActiveTab();
    if (!tab) return;
    try {
      await window.navio.contextGraph({ op: 'pinTab', tabId: tab.id });
      this.addMessage('assistant', `Pinned **${TabManager.getTabDisplayTitle(tab) || 'tab'}** to the context graph for this profile.`);
    } catch (e) {
      this.addMessage('assistant', 'Could not pin tab: ' + (e.message || String(e)));
    }
  }

  _clearStreamListenersForTab(tabId) {
    const k = String(tabId);
    const subs = this._streamUnsubsByTab.get(k);
    if (!subs) return;
    for (const u of subs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this._streamUnsubsByTab.delete(k);
  }

  _clearAllStreamListeners() {
    for (const k of [...this._streamUnsubsByTab.keys()]) {
      this._clearStreamListenersForTab(k);
    }
  }

  async processMessage(text, isQuickAction = false, historyUserLabel = null) {
    await this._ensureAssistantHistoryLoaded();
    const config = await window.navio.getConfig();

    if (config.aiKillSwitch) {
      this.addMessage('assistant', 'AI is turned off (kill switch). Enable it in **Settings → AI → Policy**.');
      return;
    }

    if (!config.hasApiKey) {
      this.addMessage('assistant', 'Please set your API key in **Settings** first.');
      return;
    }

    const turnKey = this._conversationKey();
    this._turnConversationKey = turnKey;
    try {
    this._setTabBusy(turnKey, true);
    if (!isQuickAction) this._actionFormatRetries = 0;
    this.showTypingIndicator();
    this._updateAssistantBusyChrome();

    // ── Tool-calling mode (new agentic path) ────────────────────────────────
    if (config.aiUseToolCalling && !isQuickAction) {
    try {
      await this._processWithTools(text, config, historyUserLabel || this._historyLabelForAttachments(text));
    } catch (err) {
      this.removeTypingIndicator();
      this._turnStartedAt = null;
      this.addMessage('assistant', err.message || 'Tool-calling error', 'error');
    }
      return;
    }
    // ── Legacy <navio-actions> path ──────────────────────────────────────────

    const messages = [{ role: 'system', content: this.systemPrompt }];
    const mailBackendPreferred = await this._gmailApiMailBackendPreferred(text, config);
    const activeUrl = typeof TabManager !== 'undefined' ? TabManager.getActiveTab()?.url || '' : '';

    // ── Browsing surface (when Navio AI tab is focused, use another tab as context) ──
    if (!isQuickAction && typeof TabManager !== 'undefined') {
      const surface = TabManager.getActiveTab();
      const browserTab = TabManager.getBrowserContextTab?.() || surface;
      const onChatSurface = !!(surface && TabManager.isNavioChatTabUrl?.(surface.url || ''));
      if (onChatSurface) {
        messages.push({
          role: 'system',
          content:
            '[Interface]\nThe user is in the **Navio AI** full-page tab. The **browsing context tab** is the page they last used (or their focused web tab) — not the first tab in the strip. Snapshots and tools use that tab unless they switch tabs or you switch_tab.'
        });
      }
      if (browserTab && browserTab.url && !browserTab.url.startsWith('about:')) {
        messages.push({
          role: 'system',
          content: `[Browsing context tab]${browserTab.id === surface?.id ? ' (focused)' : ''}\nTab id: ${browserTab.id}\nTitle: ${TabManager.getTabDisplayTitle(browserTab) || '(untitled)'}${browserTab.customTitle ? ` (page: ${browserTab.title || '—'})` : ''}\nURL: ${browserTab.url}`
        });
      }
    }

    this._maybePushNonMailTaskFocus(messages, text);
    await this._maybePushMailBackendOnlyPolicy(messages, text, config, mailBackendPreferred);
    await this._maybePushGoogleAccountsPolicy(messages, { isQuickAction, userText: text });
    const ctxMsg = await this.buildPageContextSystemMessage(config, isQuickAction, {
      skipGmailPageExcerpt: mailBackendPreferred
    });
    if (ctxMsg) messages.push(ctxMsg);

    if (typeof EmailAssistant !== 'undefined' && EmailAssistant.isMailUrl(activeUrl) && !mailBackendPreferred) {
      const hint = EmailAssistant.contextHint(activeUrl);
      if (hint) messages.push({ role: 'system', content: hint });
    }

    if (config.formAutofillAssist !== false && !isQuickAction) {
      const page = await TabManager.getActivePageContent();
      if (page && !page.error && page.forms && page.forms.length) {
        const short = JSON.stringify(page.forms).slice(0, 2000);
        messages.push({
          role: 'system',
          content: `[Page form metadata — do not submit forms unless user asks]\n${short}`
        });
      }
    }

    // ── Inject all open tabs (awareness like Arc/Comet) ─────────────────────
    if (!isQuickAction && typeof TabManager !== 'undefined') {
      const allTabs = TabManager.tabs.filter(t => t.url && !t.url.startsWith('about:')).slice(0, 20);
      if (allTabs.length > 0) {
        const tabList = this._openTabsAwarenessBlock(allTabs);
        messages.push({
          role: 'system',
          content:
            `[Open tabs (${allTabs.length}) — use tab_id with switch_tab / close_tab]\n${tabList}`
        });
      }
    }

    if (!isQuickAction && config.assistantTabDigest && typeof TabManager !== 'undefined') {
      const digest = await this._buildTabDigestBlock();
      if (digest) messages.push({ role: 'system', content: digest });
    }

    const graphNote = await window.navio.contextGraph({ op: 'get' });
    const pinned = graphNote.graph?.pinnedTabIds || [];
    if (pinned.length && typeof TabManager !== 'undefined') {
      const titles = TabManager.tabs
        .filter((t) => pinned.includes(t.id))
        .map((t) => `- ${TabManager.getTabDisplayTitle(t)} (${t.url || 'no url'})`)
        .join('\n');
      if (titles) {
        messages.push({ role: 'system', content: `[Pinned tabs in workspace]\n${titles}` });
      }
    }

    // @mentions + tabs whose title/group appears in the message (no @ required)
    const mentionMsgs = await this._resolveAtMentions(text);
    const atTabIds = this._tabIdsFromAtMentions(text);
    const implicitTabMsgs = await this._resolveImplicitTabContext(text, atTabIds);
    const tabCtxN = mentionMsgs.length + implicitTabMsgs.length;
    if (tabCtxN) {
      messages.push({
        role: 'system',
        content: `[Multi-tab context — ${tabCtxN} tab(s)${mentionMsgs.length ? ' (@mention and/or wording match)' : ''}]`
      });
      messages.push(...mentionMsgs, ...implicitTabMsgs);
    }

    // Inject connected service context when the query seems to target them
    if (!isQuickAction && typeof ConnectorsManager !== 'undefined') {
      const connectorCtx = await this._buildConnectorContext(text, this._connectorOptsFromConfig(config));
      if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
    }

    // Inject accessibility snapshot for browser control / "what's on this page".
    // Skip for pure mail-triage asks (API Gmail is better than clicking the mail UI) — BUT if the user
    // also asks about the visible page (navioDetectPageFocusIntent), always include the snapshot so
    // mixed questions are not confusing.
    const isMailTriageQuery =
      navioMailContextActiveForTurn(text, () => this._currentHistory()) &&
      /\b(check|show|list|read|summarize|search|draft|reply|unread|any|find|what|whats|what's|how|connected|got|gotten|missed|look|see|view|peek|triage|new|latest|arrived|anything|something|important|came\s+in|waiting)\b/i.test(
        text
      ) &&
      !/\b(click|navigate|fill|type\s+in|press\s+|scroll\s+to|open\s+http|open\s+www)/i.test(text);
    const pageFocusAsk = navioDetectPageFocusIntent(text);
    const actionVerbBrowse =
      /\b(click|go to|open|navigate|visit|search|type|fill|scroll|find|press|submit|play|watch|buy|book|login|sign)\b/i.test(text);
    const browserForcesGmailUi =
      /\b(in the browser|gmail window|this tab|visible gmail|what i see|on my screen|on screen|in gmail\s+tab)\b/i.test(text);
    const suppressGmailUiSnapshot =
      mailBackendPreferred &&
      typeof EmailAssistant !== 'undefined' &&
      EmailAssistant.isMailUrl(activeUrl) &&
      /mail\.google\.com/i.test(activeUrl) &&
      !browserForcesGmailUi &&
      !pageFocusAsk;
    let wantsPageSnapshot = pageFocusAsk || (!isMailTriageQuery && actionVerbBrowse);
    if (suppressGmailUiSnapshot) wantsPageSnapshot = !!pageFocusAsk;
    if (wantsPageSnapshot && !isQuickAction) {
      const snapText = await this._getPageSnapshotText();
      if (snapText) messages.push({ role: 'system', content: snapText });
    }

    messages.push({
      role: 'system',
      content:
        '[Thread discipline]\nThe **latest user message** (see **What to do now** on it) is the only target. ' +
        'Do not do work they did not ask for. Do not switch to a new goal mid-turn. ' +
        'Earlier messages are context only; short replies mean “continue the same task,” not “start something new.”'
    });
    const recentHistory = this._currentHistory().slice(-72);
    messages.push(...recentHistory);
    this._maybePushAttachmentSystemHint(messages);
    const userContent = this._buildAttachmentPayloadForApi(text);
    messages.push({ role: 'user', content: userContent });
    const userHistory = historyUserLabel || this._historyLabelForAttachments(text);

    const useStream = config.aiStreamResponses !== false && (config.aiProvider === 'openai' || config.aiProvider === 'custom');

    try {
      if (useStream) {
        await this._processStream(messages, userHistory);
      } else {
        this._turnStartedAt = performance.now();
        const result = await window.navio.aiRequest({ messages });
        this.removeTypingIndicator();
        const durationMs =
          this._turnStartedAt != null ? Math.round(performance.now() - this._turnStartedAt) : null;
        this._turnStartedAt = null;
        if (result.error) {
          this.addMessage('assistant', result.error, 'error', durationMs != null ? { durationMs } : null);
        } else {
          const cite =
            this._pendingConnectorCitations && this._pendingConnectorCitations.length
              ? { citations: this._pendingConnectorCitations }
              : null;
          const meta = cite ? { ...cite, durationMs } : { durationMs };
          this.addMessage('assistant', result.content, '', meta);
          this._pendingConnectorCitations = null;
          this._checkAndShowActionFormatWarning(result.content, this.messagesEl.querySelector('.assistant-message:last-of-type'));
          if (userHistory) {
            this._currentHistory().push(
              { role: 'user', content: userHistory },
              { role: 'assistant', content: result.content }
            );
          } else {
            // Auto-follow-up: only store the AI turn so context is preserved
            this._currentHistory().push({ role: 'assistant', content: result.content });
          }
          this._trimHistory();
          await window.navio.contextGraph({
            op: 'addTurn',
            role: 'assistant',
            summary: result.content.slice(0, 200),
            tabId: this._tabForTurnContext()?.id,
            url: this._tabForTurnContext()?.url || ''
          });
        }
      }
    } catch (err) {
      this.removeTypingIndicator();
      this._turnStartedAt = null;
      this.addMessage('assistant', err.message, 'error');
    }

    } finally {
      this._turnConversationKey = null;
      this._setTabBusy(turnKey, false);
      this._updateAssistantBusyChrome();
      if (typeof TabManager !== 'undefined' && TabManager.activeTabId) {
        void this._syncPanelToTab(String(TabManager.activeTabId));
      }
    }
  }

  async _guestDeliver(guestWv, msg) {
    if (!guestWv || typeof guestWv.executeJavaScript !== 'function') return;
    const encoded = JSON.stringify(JSON.stringify(msg));
    const js = `void (function(){try{var m=${encoded};if(window.__navioGuestHost&&window.__navioGuestHost.deliver)window.__navioGuestHost.deliver(JSON.parse(m));}catch(e){console.error(e);}})()`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await guestWv.executeJavaScript(js);
        return;
      } catch (e) {
        if (attempt === 3) {
          console.warn('[navio-assistant] guest deliver failed after retries', e && e.message ? e.message : e);
        }
        await new Promise((r) => setTimeout(r, 50 + attempt * 45));
      }
    }
  }

  handleGuestChatHostMessage(tab, guestWv, payload) {
    if (!payload || !guestWv) return;
    if (payload.action === 'planAck') {
      try {
        if (payload.approved) window.navio.toolProposePlanAck({ approved: true, title: payload.title });
        else window.navio.toolProposePlanAck({ cancelled: true, title: payload.title });
      } catch {
        /* ignore */
      }
      return;
    }
    if (payload.action === 'deepResearch') {
      const topic = (payload.topic || payload.text || '').trim();
      if (topic) void this._guestDeepResearch(guestWv, topic);
      return;
    }
    if (payload.action === 'send' && payload.text) {
      void this.processGuestChatMessage(guestWv, String(payload.text).trim());
    }
  }

  async _guestDeepResearch(guestWv, topic) {
    const q = (topic || '').trim();
    if (!q || !guestWv) return;
    this._guestDeliver(guestWv, { type: 'researchStart' });
    try {
      const r = await window.navio.deepResearch({ query: q });
      if (r && r.error) this._guestDeliver(guestWv, { type: 'assistant', error: true, content: r.error });
      else this._guestDeliver(guestWv, { type: 'assistant', content: (r && r.content) || '' });
    } catch (e) {
      this._guestDeliver(guestWv, { type: 'assistant', error: true, content: e.message || String(e) });
    }
  }

  async processGuestChatMessage(guestWv, text) {
    await this._ensureAssistantHistoryLoaded();
    if (!text || !guestWv) return;
    if (this._tabIsBusy('__guest__')) {
      this._guestDeliver(guestWv, { type: 'toast', text: 'Still working on the last message…' });
      return;
    }
    const config = await window.navio.getConfig();
    if (config.aiKillSwitch) {
      this._guestDeliver(guestWv, { type: 'assistant', error: true, content: 'AI is turned off (kill switch). Enable it in Settings → AI → Policy.' });
      return;
    }
    if (!config.hasApiKey) {
      this._guestDeliver(guestWv, { type: 'assistant', error: true, content: 'Add an API key in **Settings → AI** first.' });
      return;
    }
    const prevTurn = this._turnConversationKey;
    this._turnConversationKey = '__guest__';
    this._setTabBusy('__guest__', true);
    this._updateAssistantBusyChrome();
    try {
      if (config.aiUseToolCalling !== false) {
        await this._processWithTools(text, config, this._historyLabelForAttachments(text), guestWv);
      } else {
        await this._processGuestLegacyAi(guestWv, text, config);
      }
    } catch (err) {
      this._guestDeliver(guestWv, { type: 'assistant', error: true, content: err.message || String(err) });
    } finally {
      this._turnConversationKey = prevTurn;
      this._setTabBusy('__guest__', false);
      this._updateAssistantBusyChrome();
    }
  }

  async _processGuestLegacyAi(guestWv, text, config) {
    const messages = [{ role: 'system', content: this.systemPrompt }];
    if (typeof TabManager !== 'undefined') {
      const surface = TabManager.getActiveTab();
      const browserTab = TabManager.getBrowserContextTab?.() || surface;
      const onChatSurface = !!(surface && TabManager.isNavioChatTabUrl?.(surface.url || ''));
      if (onChatSurface) {
        messages.push({
          role: 'system',
          content:
            '[Interface]\nThe user is in the **Navio AI** full-page tab. Browsing context is the page they last used (see [Browsing context tab]), not the leftmost tab.'
        });
      }
      if (browserTab && browserTab.url && !browserTab.url.startsWith('about:')) {
        messages.push({
          role: 'system',
          content: `[Browsing context tab]${browserTab.id === surface?.id ? ' (focused)' : ''}\nTab id: ${browserTab.id}\nTitle: ${TabManager.getTabDisplayTitle(browserTab) || '(untitled)'}\nURL: ${browserTab.url}`
        });
      }
      const allTabs = TabManager.tabs.filter((t) => t.url && !t.url.startsWith('about:')).slice(0, 20);
      if (allTabs.length > 0) {
        const tabList = this._openTabsAwarenessBlock(allTabs);
        messages.push({
          role: 'system',
          content:
            `[Open tabs (${allTabs.length}) — use tab_id with switch_tab / close_tab]\n${tabList}`
        });
      }
    }
    const mailBackendPreferred = await this._gmailApiMailBackendPreferred(text, config);
    this._maybePushNonMailTaskFocus(messages, text);
    await this._maybePushMailBackendOnlyPolicy(messages, text, config, mailBackendPreferred);
    await this._maybePushGoogleAccountsPolicy(messages, { isQuickAction: false, userText: text });
    if (typeof ConnectorsManager !== 'undefined') {
      const connectorCtx = await this._buildConnectorContext(text, this._connectorOptsFromConfig(config));
      if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
    }
    messages.push({
      role: 'system',
      content:
        '[Thread discipline]\nThe **latest user message** (see **What to do now** on it) is the only target. ' +
        'Do not do work they did not ask for. Do not switch to a new goal mid-turn. ' +
        'Earlier messages are context only; short replies mean “continue the same task,” not “start something new.”'
    });
    const recentHistory = this._currentHistory().slice(-72);
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: this._taskAnchorPrefix() + (text || '') });
    const userHistory = this._historyLabelForAttachments(text);

    const gsk = '__guest__';
    this._clearStreamListenersForTab(gsk);
    let buffer = '';
    const unChunk = window.navio.onAiStreamChunk((payload) => {
      let tid = '__default__';
      let chunkText = '';
      if (typeof payload === 'string') {
        chunkText = payload;
      } else if (payload && typeof payload === 'object') {
        tid = payload.tabId != null ? String(payload.tabId) : '__default__';
        chunkText = payload.text != null ? String(payload.text) : '';
      }
      if (tid !== gsk || !chunkText) return;
      buffer += chunkText;
      this._guestDeliver(guestWv, { type: 'streamDelta', text: chunkText });
    });
    const unDone = window.navio.onAiStreamDone(async (payload) => {
      const tid = payload && payload.tabId != null ? String(payload.tabId) : '__default__';
      if (tid !== gsk) return;
      this._clearStreamListenersForTab(gsk);
      if (buffer) {
        const out =
          payload && payload.cancelled ? `${buffer}\n\n*(Stopped)*` : buffer;
        this._currentHistory().push({ role: 'user', content: userHistory }, { role: 'assistant', content: out });
        this._trimHistory();
        this._guestDeliver(guestWv, { type: 'streamFinalize', content: out });
        const graphTab = TabManager.getActiveTab?.() || null;
        await window.navio.contextGraph({
          op: 'addTurn',
          role: 'assistant',
          summary: out.slice(0, 200),
          tabId: graphTab?.id,
          url: graphTab?.url || ''
        });
      }
    });
    const unErr = window.navio.onAiStreamError(async (msg) => {
      const errObj = typeof msg === 'string' ? { tabId: '__default__', message: msg } : msg || {};
      const tid = errObj.tabId != null ? String(errObj.tabId) : '__default__';
      if (tid !== gsk) return;
      this._clearStreamListenersForTab(gsk);
      const errText = errObj.message != null ? String(errObj.message) : String(msg || '');
      if (!buffer) {
        const fallback = await window.navio.aiRequest({ messages });
        if (fallback.error) {
          this._guestDeliver(guestWv, { type: 'assistant', error: true, content: fallback.error || errText });
        } else {
          this._currentHistory().push(
            { role: 'user', content: userHistory },
            { role: 'assistant', content: fallback.content }
          );
          this._trimHistory();
          this._guestDeliver(guestWv, { type: 'assistant', content: fallback.content });
        }
      } else {
        this._currentHistory().push({ role: 'user', content: userHistory }, { role: 'assistant', content: buffer });
        this._trimHistory();
        this._guestDeliver(guestWv, { type: 'streamFinalize', content: buffer });
      }
    });
    this._streamUnsubsByTab.set(gsk, [unChunk, unDone, unErr]);
    await window.navio.aiRequestStream({ messages, tabId: gsk });
  }

  /**
   * Tool-calling path: builds context messages, sets up navigate/progress
   * listeners, calls the main-process agentic loop, and displays results.
   */
  async _processWithTools(text, config, historyUserLabel, guestWv = null) {
    this._guestChatWebview = guestWv || null;
    try {
    const tk = String(this._turnConversationKey || '__default__');
    if (this.inputEl && typeof this.inputEl.blur === 'function') this.inputEl.blur();

    // Build context messages (same as legacy path but without page snapshot —
    // the model will call read_page itself via tools)
    const messages = [{ role: 'system', content: this.systemPrompt }];
    const mailBackendPreferred = await this._gmailApiMailBackendPreferred(text, config);
    const activeUrl = typeof TabManager !== 'undefined' ? TabManager.getActiveTab()?.url || '' : '';

    if (typeof TabManager !== 'undefined') {
      const surface = TabManager.getActiveTab();
      const browserTab = TabManager.getBrowserContextTab?.() || surface;
      const onChatSurface = !!(surface && TabManager.isNavioChatTabUrl?.(surface.url || ''));
      if (onChatSurface) {
        messages.push({
          role: 'system',
          content:
            '[Interface]\nThe user is in the **Navio AI** full-page tab. Browser tools operate on the **browsing context tab** — the page they last used before chat (or their focused http tab), not an arbitrary tab. Use list_tabs if unsure.'
        });
      }
      if (browserTab && browserTab.url && !browserTab.url.startsWith('about:')) {
        messages.push({
          role: 'system',
          content: `[Browsing context tab]${browserTab.id === surface?.id ? ' (focused)' : ''}\nTab id: ${browserTab.id}\nTitle: ${TabManager.getTabDisplayTitle(browserTab) || '(untitled)'}${browserTab.customTitle ? ` (page: ${browserTab.title || '—'})` : ''}\nURL: ${browserTab.url}`
        });
      } else if (browserTab) {
        messages.push({
          role: 'system',
          content: `[Browsing context tab]\nEmpty / new tab — use **navigate** or **open_tab** when you need a URL.\nTab id: ${browserTab.id}`
        });
      }
    }

    this._maybePushNonMailTaskFocus(messages, text);
    await this._maybePushMailBackendOnlyPolicy(messages, text, config, mailBackendPreferred);
    await this._maybePushGoogleAccountsPolicy(messages, { isQuickAction: false, userText: text });
    // Page context scope (selection/excerpt/full) — still useful for non-browsing queries
    const ctxMsg = await this.buildPageContextSystemMessage(config, false, {
      skipGmailPageExcerpt: mailBackendPreferred
    });
    if (ctxMsg) messages.push(ctxMsg);

    // Email hint (skip when Gmail API path is preferred — avoid nudging the model toward the web UI)
    if (typeof EmailAssistant !== 'undefined' && EmailAssistant.isMailUrl(activeUrl) && !mailBackendPreferred) {
      const hint = EmailAssistant.contextHint(activeUrl);
      if (hint) messages.push({ role: 'system', content: hint });
    }

    // Open tabs awareness
    if (typeof TabManager !== 'undefined') {
      const allTabs = TabManager.tabs.filter(t => t.url && !t.url.startsWith('about:')).slice(0, 20);
      if (allTabs.length > 0) {
        const tabList = this._openTabsAwarenessBlock(allTabs);
        messages.push({
          role: 'system',
          content:
            `[Open tabs (${allTabs.length}) — use tab_id with switch_tab / close_tab]\n${tabList}`
        });
      }
    }

    if (config.assistantTabDigest && typeof TabManager !== 'undefined') {
      const digest = await this._buildTabDigestBlock();
      if (digest) messages.push({ role: 'system', content: digest });
    }

    // Pinned tabs from context graph
    const graphNote = await window.navio.contextGraph({ op: 'get' });
    const pinned = graphNote.graph?.pinnedTabIds || [];
    if (pinned.length && typeof TabManager !== 'undefined') {
      const titles = TabManager.tabs
        .filter((t) => pinned.includes(t.id))
        .map((t) => `- ${TabManager.getTabDisplayTitle(t)} (${t.url || 'no url'})`)
        .join('\n');
      if (titles) messages.push({ role: 'system', content: `[Pinned tabs in workspace]\n${titles}` });
    }

    const mentionMsgs = await this._resolveAtMentions(text);
    const atTabIds = this._tabIdsFromAtMentions(text);
    const implicitTabMsgs = await this._resolveImplicitTabContext(text, atTabIds);
    const tabCtxN = mentionMsgs.length + implicitTabMsgs.length;
    if (tabCtxN) {
      messages.push({
        role: 'system',
        content: `[Multi-tab context — ${tabCtxN} tab(s)${mentionMsgs.length ? ' (@mention and/or wording match)' : ''}]`
      });
      messages.push(...mentionMsgs, ...implicitTabMsgs);
    }

    // Connector context
    if (typeof ConnectorsManager !== 'undefined') {
      const connectorCtx = await this._buildConnectorContext(text, this._connectorOptsFromConfig(config));
      if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
    }

    messages.push({
      role: 'system',
      content:
        '[Thread discipline]\nThe **latest user message** (see **What to do now** on it) is the only target. ' +
        'Do not do work they did not ask for. Do not switch to a new goal mid-turn. ' +
        'Earlier messages are context only; short replies mean “continue the same task,” not “start something new.”'
    });

    // Conversation history (skip stale page snapshots)
    const recentHistory = this._currentHistory()
      .slice(-72)
      .filter(m => {
        if (m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Page elements')) return false;
        return true;
      });
    messages.push(...recentHistory);
    this._maybePushAttachmentSystemHint(messages);
    messages.push({ role: 'user', content: this._buildAttachmentPayloadForApi(text) });

    // Agent activity UI — sidebar DOM or guest tab via executeJavaScript
    let activityEl = null;
    let stopBtn = null;
    if (!guestWv && this._panelShowsTurnDom()) {
      activityEl = document.createElement('div');
      activityEl.className = 'navio-agent-activity';
      activityEl.innerHTML =
        '<div class="naa-header"><span class="naa-header-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg></span><span class="naa-header-text"><span class="naa-title">Working</span><span class="naa-sub">Steps run in order</span></span></div><div class="naa-steps"></div>';
      this.messagesEl.appendChild(activityEl);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this._currentActivityEl = activityEl;
    } else if (!guestWv) {
      this._currentActivityEl = null;
    } else {
      this._currentActivityEl = null;
      this._guestDeliver(guestWv, { type: 'activityStart' });
    }

    // Set up navigate handler (tabId + operationId so parallel agent loops don't cross-ack)
    const unNav = window.navio.onToolNavigate(async (payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const url = payload?.url;
      const operationId = payload?.operationId;
      this._appendActivityStep('navigate', `Navigating to ${new URL(url).hostname}...`);
      try {
        const loadResult = await TabManager.navigateForAgentAndWaitForLoad(url);
        const drivenTab =
          TabManager.getAgentControlledTab?.() ||
          TabManager.getBrowserContextTab?.() ||
          TabManager.getActiveTab();
        let drivenUrl = url;
        try {
          drivenUrl = drivenTab?.webview?.getURL?.() || drivenTab?.url || url;
        } catch {
          drivenUrl = drivenTab?.url || url;
        }
        if (!loadResult.ok) {
          window.navio.toolNavigateAck({
            success: false,
            error: loadResult.error || 'load failed',
            url: drivenUrl,
            operationId
          });
          return;
        }
        if (drivenTab?.id) TabManager.setAgentControlledTab?.(drivenTab.id);
        window.navio.toolNavigateAck({
          success: true,
          url: drivenUrl,
          timedOut: !!loadResult.timedOut,
          operationId
        });
      } catch (e) {
        window.navio.toolNavigateAck({ error: e.message, operationId });
      }
    });

    // Set up tab management handlers
    const unOpenTab = window.navio.onToolOpenTab(async (payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { url, operationId } = payload || {};
      let openUrl = url && String(url).trim() ? String(url).trim() : null;
      if (openUrl && typeof App !== 'undefined' && typeof App.resolveNavigationInput === 'function') {
        const resolved = App.resolveNavigationInput(openUrl);
        if (resolved) openUrl = resolved;
      }
      let labelHost = '';
      if (openUrl) {
        try {
          labelHost = new URL(openUrl).hostname;
        } catch {
          labelHost = openUrl.slice(0, 48);
        }
      }
      this._appendActivityStep('open_tab', `Opening new tab${openUrl ? ': ' + labelHost : ''}...`);
      try {
        const loadResult = await TabManager.createTabAndWaitForLoad(openUrl);
        if (!loadResult.ok) {
          window.navio.toolOpenTabAck({ success: false, error: loadResult.error || 'load failed', operationId });
          return;
        }
        const tab = loadResult.tab || TabManager.getActiveTab();
        const wv = tab?.webview;
        if (tab?.id) TabManager.setAgentControlledTab?.(tab.id);
        window.navio.toolOpenTabAck({
          success: true,
          tab_id: tab?.id || '',
          webContentsId: wv?.getWebContentsId?.() || null,
          url: tab?.url || '',
          title: tab ? TabManager.getTabDisplayTitle(tab) : '',
          timedOut: !!loadResult.timedOut,
          operationId
        });
      } catch (e) {
        window.navio.toolOpenTabAck({ error: e.message, operationId });
      }
    });

    const unCloseTab = window.navio.onToolCloseTab(async (payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { tab_id, operationId } = payload || {};
      this._appendActivityStep('close_tab', `Closing tab ${tab_id}`);
      try {
        const agentIdBefore = TabManager.getAgentControlledTab?.()?.id ?? null;
        TabManager.closeTab(tab_id);
        await new Promise(r => setTimeout(r, 300));
        if (agentIdBefore != null && agentIdBefore !== tab_id) {
          TabManager.setAgentControlledTab?.(agentIdBefore);
        } else {
          const active = TabManager.getActiveTab();
          if (active?.id) TabManager.setAgentControlledTab?.(active.id);
        }
        const reportTab = TabManager.getAgentControlledTab?.() || TabManager.getActiveTab();
        window.navio.toolCloseTabAck({
          success: true,
          active_tab_id: reportTab?.id || '',
          webContentsId: reportTab?.webview?.getWebContentsId?.() || null,
          operationId
        });
      } catch (e) {
        window.navio.toolCloseTabAck({ error: e.message, operationId });
      }
    });

    const unSwitchTab = window.navio.onToolSwitchTab(async (payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { tab_id, operationId } = payload || {};
      this._appendActivityStep('switch_tab', `Switching to tab ${tab_id}`);
      try {
        TabManager.switchToTab(tab_id);
        await new Promise(r => setTimeout(r, 500));
        const tab = TabManager.getActiveTab();
        const wv = tab?.webview;
        if (tab?.id) TabManager.setAgentControlledTab?.(tab.id);
        window.navio.toolSwitchTabAck({
          success: true,
          tab_id: tab?.id || '',
          webContentsId: wv?.getWebContentsId?.() || null,
          url: tab?.url || '',
          title: tab ? TabManager.getTabDisplayTitle(tab) : '',
          operationId
        });
      } catch (e) {
        window.navio.toolSwitchTabAck({ error: e.message, operationId });
      }
    });

    const unListTabs = window.navio.onToolListTabs(async (payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { operationId } = payload || {};
      this._appendActivityStep('list_tabs', 'Listing open tabs...');
      try {
        const tabs = TabManager.tabs
          .filter(t => t.url || t.id)
          .map(t => ({
            tab_id: t.id,
            title: TabManager.getTabDisplayTitle(t) || '(untitled)',
            url: t.url || '',
            active: t.id === TabManager.activeTabId,
            webContentsId: t.webview?.getWebContentsId?.() || null,
            group_id: t.groupId || null,
            group_name: TabManager.getTabGroupLabel?.(t) || null
          }));
        window.navio.toolListTabsAck({ success: true, tabs, operationId });
      } catch (e) {
        window.navio.toolListTabsAck({ error: e.message, operationId });
      }
    });

    // Set up reasoning handler (intermediate AI thinking during tool loop)
    const unReasoning = window.navio.onToolReasoning?.((payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { step, text } = payload || {};
      this._appendActivityStep('thinking', text.slice(0, 200) + (text.length > 200 ? '...' : ''));
    });

    // Set up plan approval handler
    const unProposePlan = window.navio.onToolProposePlan?.((payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { title, steps, estimated_time, risks, operationId } = payload || {};
      this._appendActivityStep('propose_plan', `Plan: ${title}`);
      if (guestWv) {
        this._guestDeliver(guestWv, {
          type: 'plan',
          title: title || '',
          steps: steps || [],
          estimated_time: estimated_time || '',
          risks: risks || ''
        });
        return;
      }
      const planEl = document.createElement('div');
      planEl.className = 'navio-plan-card';
      let html = `<div class="npc-title">${this._escapeHtml(title)}</div>`;
      html += '<ol class="npc-steps">';
      for (const s of (steps || [])) {
        html += `<li><strong>${this._escapeHtml(s.action)}</strong>${s.details ? ' — ' + this._escapeHtml(s.details) : ''}</li>`;
      }
      html += '</ol>';
      if (estimated_time) html += `<div class="npc-meta">Estimated: ${this._escapeHtml(estimated_time)}</div>`;
      if (risks) html += `<div class="npc-meta npc-risks">Note: ${this._escapeHtml(risks)}</div>`;
      html += '<div class="npc-actions">';
      html += '<button class="npc-btn npc-approve" type="button">Approve &amp; Run</button>';
      html += '<button class="npc-btn npc-cancel" type="button">Cancel</button>';
      html += '</div>';
      planEl.innerHTML = html;
      this.messagesEl.appendChild(planEl);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

      planEl.querySelector('.npc-approve').addEventListener('click', () => {
        planEl.querySelector('.npc-actions').innerHTML = '<span class="npc-approved">Approved — executing...</span>';
        window.navio.toolProposePlanAck({ approved: true, title, operationId });
      });
      planEl.querySelector('.npc-cancel')?.addEventListener('click', () => {
        planEl.querySelector('.npc-actions').innerHTML = '<span class="npc-cancelled">Cancelled</span>';
        window.navio.toolProposePlanAck({ cancelled: true, title, operationId });
      });
    });

    // Set up progress handler
    const unProgress = window.navio.onToolProgress((payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { step, tool, result } = payload || {};
      if (tool === 'navigate') return; // already shown
      if (tool === 'gmail_search' && result && !result.error) {
        void this._ingestGmailSearchToolResults(result);
      }
      const label = this._toolProgressLabel(tool, result);
      this._appendActivityStep(tool, label);
    });

    // Stop button aborts in-flight AI in main (streaming + tool loop).
    if (activityEl) {
      stopBtn = document.createElement('button');
      stopBtn.className = 'navio-agent-stop-btn';
      stopBtn.type = 'button';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => {
        this.stopGeneration();
      });
      activityEl.querySelector('.naa-header').appendChild(stopBtn);
    }

    if (typeof TabManager !== 'undefined') {
      // Clear stale agent lock so getBrowserTargetWebview() uses browsing context, not an old tab id.
      if (!this._takeoverMode) TabManager.setAgentControlledTab?.(null);
      TabManager.ensureBrowserContextTab?.();
    }
    let toolWv = typeof TabManager !== 'undefined' ? TabManager.getBrowserTargetWebview?.() : null;
    if (typeof TabManager !== 'undefined') {
      let wait = 0;
      const toolWvReady = (wv) => {
        if (!wv || typeof wv.getWebContentsId !== 'function') return false;
        try {
          return wv.getWebContentsId() != null;
        } catch {
          return false;
        }
      };
      while (!toolWvReady(toolWv) && wait < 25) {
        TabManager.ensureBrowserContextTab?.();
        await new Promise((r) => setTimeout(r, 40));
        toolWv = TabManager.getBrowserTargetWebview?.();
        wait++;
      }
      TabManager.setAgentControlledTab?.(TabManager.findTabIdForWebview?.(toolWv));
    }
    this._turnStartedAt = performance.now();
    const response = await window.navio.aiRequestWithTools({
      messages,
      webContentsId: toolWv?.getWebContentsId?.(),
      tabId: tk
    });
    const toolTurnMs =
      this._turnStartedAt != null ? Math.round(performance.now() - this._turnStartedAt) : null;
    this._turnStartedAt = null;

    // Cleanup
    unNav();
    unOpenTab();
    unCloseTab();
    unSwitchTab();
    unListTabs();
    if (unReasoning) unReasoning();
    if (unProposePlan) unProposePlan();
    unProgress();
    this.removeTypingIndicator();

    // After API draft/send work, open Gmail to Drafts or Sent (read-only API runs omit this).
    if (!response.error && response.gmailOpenWhenDone?.url && typeof TabManager !== 'undefined') {
      try {
        await TabManager.navigateForAgentAndWaitForLoad(response.gmailOpenWhenDone.url);
        if (activityEl) {
          const stepsEl = activityEl.querySelector('.naa-steps');
          if (stepsEl) {
            const view = response.gmailOpenWhenDone.view === 'sent' ? 'Sent' : 'Drafts';
            const step = document.createElement('div');
            step.className = 'naa-step';
            const sn = stepsEl.children.length + 1;
            step.innerHTML = `<span class="naa-step-index" aria-hidden="true">${sn}</span><span class="naa-tool">gmail</span><span class="naa-label">Opened Gmail (${this._escapeHtml(view)})</span>`;
            stepsEl.appendChild(step);
          }
        }
      } catch (e) {
        console.warn('[Navio] gmailOpenWhenDone', e);
      }
    }

    // Update activity feed to done state
    if (activityEl) {
      const header = activityEl.querySelector('.naa-header');
      if (header) {
        if (stopBtn) stopBtn.remove();
        const stepsCount = (response.toolLog || []).length;
        header.innerHTML = `<span class="naa-header-icon naa-header-icon--done"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span><span class="naa-header-text"><span class="naa-title">Done${stepsCount ? ` · ${stepsCount} step${stepsCount === 1 ? '' : 's'}` : ''}</span><span class="naa-sub">Reply below</span></span>`;
      }
    } else if (guestWv) {
      this._guestDeliver(guestWv, {
        type: 'activityDone',
        stepsCount: (response.toolLog || []).length
      });
    }

    // Offer to save as workflow if the tool loop had multiple steps
    if (!guestWv && activityEl && response.toolLog && response.toolLog.length >= 2 && !response.error) {
      if (this._workflowRecording) {
        this._recordedSteps = (this._recordedSteps || []).concat(
          response.toolLog.map(t => ({ tool: t.tool, args: t.args }))
        );
      }
      const saveBtn = document.createElement('button');
      saveBtn.className = 'navio-save-workflow-btn';
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save as Workflow';
      saveBtn.addEventListener('click', async () => {
        const name = window.prompt('Name this workflow:');
        if (!name?.trim()) return;
        const steps = response.toolLog.map(t => ({ tool: t.tool, args: t.args }));
        const result = await window.navio.workflowSave({ name: name.trim(), steps, meta: { description: text } });
        if (result?.ok) {
          saveBtn.textContent = 'Saved!';
          saveBtn.disabled = true;
        }
      });
      activityEl.appendChild(saveBtn);
    }

    // Display final response
    if (response.error) {
      if (guestWv) this._guestDeliver(guestWv, { type: 'assistant', error: true, content: response.error });
      else this.addMessage('assistant', response.error, 'error', toolTurnMs != null ? { durationMs: toolTurnMs } : null);
    } else if (response.content) {
      if (guestWv) this._guestDeliver(guestWv, { type: 'assistant', content: response.content });
      else {
        const cite =
          this._pendingConnectorCitations && this._pendingConnectorCitations.length
            ? { citations: this._pendingConnectorCitations }
            : null;
        const meta = cite ? { ...cite } : {};
        if (toolTurnMs != null) meta.durationMs = toolTurnMs;
        this.addMessage('assistant', response.content, '', meta);
        this._pendingConnectorCitations = null;
      }
      const userHistory = historyUserLabel || this._historyLabelForAttachments(text);
      this._currentHistory().push(
        { role: 'user', content: userHistory },
        { role: 'assistant', content: response.content }
      );
      this._trimHistory();
      const graphTab = this._tabForTurnContext();
      await window.navio.contextGraph({
        op: 'addTurn',
        role: 'assistant',
        summary: response.content.slice(0, 200),
        tabId: graphTab?.id,
        url: graphTab?.url || ''
      });
    } else if (guestWv) {
      void this._guestDeliver(guestWv, {
        type: 'assistant',
        error: true,
        content: 'No reply from the model. Open another tab with a page, or try again.'
      });
    }
    } finally {
      this._guestChatWebview = null;
      if (this._turnStartedAt != null) this._turnStartedAt = null;
      if (typeof TabManager !== 'undefined') {
        if (this._takeoverMode) TabManager.setAgentControlledTab?.(TabManager.getTakeoverHighlightTabId?.() ?? null);
        else TabManager.setAgentControlledTab?.(null);
      }
    }
  }

  _appendActivityStep(tool, label) {
    if (!this._panelShowsTurnDom()) return;
    if (this._guestChatWebview) {
      this._guestDeliver(this._guestChatWebview, { type: 'toolStep', tool, label });
      return;
    }
    if (!this._currentActivityEl) return;
    const stepsEl = this._currentActivityEl.querySelector('.naa-steps');
    if (!stepsEl) return;
    const step = document.createElement('div');
    const isThink = tool === 'thinking';
    step.className = isThink ? 'naa-step naa-step--thinking' : 'naa-step';
    const toolShown = isThink ? 'Thinking' : this._escapeHtml(String(tool));
    const n = stepsEl.children.length + 1;
    step.innerHTML = `<span class="naa-step-index" aria-hidden="true">${n}</span><span class="naa-tool">${toolShown}</span><span class="naa-label">${this._escapeHtml(String(label))}</span>`;
    stepsEl.appendChild(step);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  _toolProgressLabel(tool, result) {
    if (result?.error) return `Error: ${result.error}`;
    switch (tool) {
      case 'read_page': return `Read page (${result?.title || 'page'})`;
      case 'get_page_text': return `Extracted text (${((result?.text || '').length / 1000).toFixed(1)}k chars)`;
      case 'click': return `Clicked${result?.success ? '' : ' (failed)'}`;
      case 'type_text': return `Typed text`;
      case 'select_option': return `Selected option`;
      case 'scroll': return `Scrolled`;
      case 'press_key': return `Pressed key`;
      case 'screenshot': return `Captured screenshot`;
      case 'insert_text': return `Pasted text`;
      case 'wait': return `Waited`;
      case 'go_back': return `Went back`;
      case 'go_forward': return `Went forward`;
      case 'open_tab': return `Opened new tab${result?.url ? ': ' + result.url : ''}`;
      case 'close_tab': return `Closed tab`;
      case 'switch_tab': return `Switched to tab${result?.title ? ': ' + result.title : ''}`;
      case 'list_tabs': return `Listed ${result?.tabs?.length || 0} tabs`;
      case 'read_console': return `Read ${result?.count || 0} console messages`;
      case 'read_network': return `Read ${result?.count || 0} network requests`;
      case 'propose_plan': return `Proposed plan${result?.approved ? ' (approved)' : result?.cancelled ? ' (cancelled)' : ''}`;
      case 'list_workflows': return `Workflows: ${result?.count ?? (result?.workflows || []).length ?? 0} saved`;
      case 'run_workflow': {
        const n = result?.steps;
        const prev = Array.isArray(result?.step_preview) ? result.step_preview.length : 0;
        const wf = result?.workflow_name || '';
        if (n != null && prev) return `Workflow "${wf}": ${n} step(s), ${prev} in preview`;
        return `Running workflow: ${wf}`;
      }
      case 'gmail_search': return `Gmail: ${result?.results?.length ?? 0} message(s)`;
      case 'gmail_get_message': return `Gmail: opened message`;
      case 'gmail_list_drafts': return `Gmail: ${result?.count ?? result?.drafts?.length ?? 0} draft(s)`;
      case 'gmail_create_draft': return `Gmail: new draft`;
      default: return tool;
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  async _processStream(messages, userHistory) {
    const sk = String(this._turnConversationKey || this._conversationKey());
    this._clearStreamListenersForTab(sk);
    this._turnStartedAt = performance.now();
    let buffer = '';
    let streamingMsg = null;
    let finalized = false;
    let stallTimer = null;
    let streamCancelled = false;

    // Shared finalize: renders buffer with action cards, saves history.
    // Safe to call from done event, stall timeout, or error handler.
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(stallTimer);
      this._clearStreamListenersForTab(sk);
      this.removeTypingIndicator();

      const elapsed =
        this._turnStartedAt != null ? Math.round(performance.now() - this._turnStartedAt) : null;
      this._turnStartedAt = null;

      if (!buffer) {
        if (streamCancelled) {
          this.addMessage(
            'assistant',
            'Stopped.',
            '',
            elapsed != null ? { durationMs: elapsed } : null
          );
        } else {
          this.addMessage(
            'assistant',
            'No response received. Please try again.',
            'error',
            elapsed != null ? { durationMs: elapsed } : null
          );
        }
        return;
      }

      if (streamCancelled) {
        buffer += '\n\n*(Stopped)*';
      }

      if (streamingMsg) {
        const contentEl = streamingMsg.querySelector('.message-content');
        if (contentEl) {
          contentEl.classList.remove('streaming-content');
          contentEl.innerHTML = this.formatMessage(buffer, true);
          await this._wireActions(contentEl);
          this._checkAndShowActionFormatWarning(buffer, streamingMsg);
        }
        this._attachCopyButtonToMessage(streamingMsg, contentEl);
        if (elapsed != null) this._appendMessageDurationRow(streamingMsg, elapsed);
        if (this._pendingConnectorCitations && this._pendingConnectorCitations.length) {
          this._appendCitationChips(streamingMsg, this._pendingConnectorCitations);
        } else {
          const fromText = this._extractUrlsForCitationChipsFromAssistantText(buffer);
          if (fromText && fromText.length) this._appendCitationChips(streamingMsg, fromText);
        }
        this._pendingConnectorCitations = null;
      }
      this._currentHistory().push(
        { role: 'user', content: userHistory },
        { role: 'assistant', content: buffer }
      );
      this._trimHistory();
      const graphTab = this._tabForTurnContext();
      await window.navio.contextGraph({
        op: 'addTurn',
        role: 'assistant',
        summary: buffer.slice(0, 200),
        tabId: graphTab?.id,
        url: graphTab?.url || ''
      });
    };

    // Stall detector: if no new chunk arrives within 25 s, force-finalize.
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { finalize(); }, 25000);
    };

    const unChunk = window.navio.onAiStreamChunk((payload) => {
      let tid = '__default__';
      let chunkText = '';
      if (typeof payload === 'string') {
        chunkText = payload;
      } else if (payload && typeof payload === 'object') {
        tid = payload.tabId != null ? String(payload.tabId) : '__default__';
        chunkText = payload.text != null ? String(payload.text) : '';
      }
      if (tid !== sk || !chunkText) return;
      buffer += chunkText;
      resetStallTimer();
      if (!this._panelShowsTurnDom()) return;
      if (!streamingMsg) {
        this.removeTypingIndicator();
        streamingMsg = document.createElement('div');
        streamingMsg.className = 'message assistant-message';
        streamingMsg.appendChild(this._messageRoleStrip('assistant'));
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content streaming-content';
        streamingMsg.appendChild(contentEl);
        this.messagesEl.appendChild(streamingMsg);
      }
      const contentEl = streamingMsg.querySelector('.message-content');
      contentEl.innerHTML = this.formatMessage(buffer);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });

    const unDone = window.navio.onAiStreamDone(async (payload) => {
      const tid = payload && payload.tabId != null ? String(payload.tabId) : '__default__';
      if (tid !== sk) return;
      if (payload && payload.cancelled) streamCancelled = true;
      await finalize();
    });

    const unErr = window.navio.onAiStreamError(async (msg) => {
      clearTimeout(stallTimer);
      this._clearStreamListenersForTab(sk);
      if (finalized) return;
      const errObj = typeof msg === 'string' ? { tabId: '__default__', message: msg } : msg || {};
      const tid = errObj.tabId != null ? String(errObj.tabId) : '__default__';
      if (tid !== sk) return;
      const errText = errObj.message != null ? String(errObj.message) : String(msg || '');
      if (errText === 'Stopped' || /abort/i.test(errText)) {
        streamCancelled = true;
        await finalize();
        return;
      }
      if (!buffer) {
        // Nothing received — try a non-streaming fallback
        this.removeTypingIndicator();
        const fallback = await window.navio.aiRequest({ messages });
        const fbMs =
          this._turnStartedAt != null ? Math.round(performance.now() - this._turnStartedAt) : null;
        this._turnStartedAt = null;
        if (fallback.error) {
          this.addMessage('assistant', fallback.error || errText, 'error', fbMs != null ? { durationMs: fbMs } : null);
        } else {
          const cite =
            this._pendingConnectorCitations && this._pendingConnectorCitations.length
              ? { citations: this._pendingConnectorCitations }
              : null;
          const meta = cite ? { ...cite, durationMs: fbMs } : { durationMs: fbMs };
          this.addMessage('assistant', fallback.content, '', meta);
          this._pendingConnectorCitations = null;
          this._checkAndShowActionFormatWarning(
            fallback.content,
            this.messagesEl.querySelector('.assistant-message:last-of-type')
          );
          this._currentHistory().push(
            { role: 'user', content: userHistory },
            { role: 'assistant', content: fallback.content }
          );
          this._trimHistory();
        }
      } else {
        // Partial content — finalize whatever arrived
        await finalize();
      }
    });

    // Start the stall timer immediately (catches case where first chunk never arrives)
    resetStallTimer();

    this._streamUnsubsByTab.set(sk, [unChunk, unDone, unErr]);

    const streamResult = await window.navio.aiRequestStream({ messages, tabId: sk });
    if (streamResult && streamResult.ok === false && !buffer) {
      clearTimeout(stallTimer);
      this.removeTypingIndicator();
      this._turnStartedAt = null;
    }
  }

  _trimHistory() {
    const k = this._turnConversationKey ?? this._conversationKey();
    let h = this._conversationsByTab.get(k);
    if (!h) return;
    if (h.length > 96) {
      h = h.slice(-72);
      this._conversationsByTab.set(k, h);
    }
    const len = h.length;
    for (let i = 0; i < len - 4; i++) {
      const m = h[i];
      if (m.role === 'system' && typeof m.content === 'string') {
        if (m.content.startsWith('[Page elements') || m.content.startsWith('[Page text')) {
          h[i] = { role: 'system', content: '[page context removed — stale]' };
        }
      }
    }
    this._schedulePersistAssistantHistory();
  }

  _appendCitationChips(msgEl, urls) {
    if (!msgEl || !urls || !urls.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'navio-msg-citations';
    const label = document.createElement('div');
    label.className = 'navio-msg-citations-label';
    label.textContent = 'Sources';
    const row = document.createElement('div');
    row.className = 'navio-msg-citations-row';
    let idx = 0;
    urls.slice(0, 8).forEach((u) => {
      const raw = String(u).trim();
      if (!raw) return;
      idx += 1;
      const a = document.createElement('a');
      a.className = 'navio-citation-chip';
      a.href = raw;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      try {
        a.textContent = `${idx}. ${new URL(raw).hostname}`;
      } catch {
        a.textContent = `${idx}. source`;
      }
      row.appendChild(a);
    });
    wrap.appendChild(label);
    wrap.appendChild(row);
    msgEl.appendChild(wrap);
  }

  /**
   * When the model lists sources in markdown but no connector citation array was passed,
   * extract URLs for clickable chips (bounded).
   */
  _extractUrlsForCitationChipsFromAssistantText(content) {
    if (!content || typeof content !== 'string') return [];
    const urls = [];
    const seen = new Set();
    const push = (raw) => {
      let u = String(raw).trim().replace(/[),.;]+$/, '');
      const q = u.indexOf('?');
      if (q > 0 && u.length - q > 200) u = u.slice(0, q);
      if (!/^https?:\/\//i.test(u) || seen.has(u)) return false;
      seen.add(u);
      urls.push(u);
      return urls.length >= 12;
    };
    const sourcesIdx = content.search(/(^|\n)\s*#{1,3}\s*Sources\s*$/im);
    const slice = sourcesIdx >= 0 ? content.slice(sourcesIdx) : content.slice(Math.max(0, content.length - 8000));
    const mdRe = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = mdRe.exec(slice)) !== null) {
      if (push(m[2])) break;
    }
    if (urls.length < 12) {
      const lineRe = /https?:\/\/[^\s)]+/g;
      let m2;
      while ((m2 = lineRe.exec(slice)) !== null) {
        if (push(m2[0])) break;
      }
    }
    return urls.slice(0, 12);
  }

  async _buildTabDigestBlock() {
    if (typeof TabManager === 'undefined' || !TabManager.tabs) return null;
    const tabs = TabManager.tabs.filter((t) => t.url && !t.url.startsWith('about:')).slice(0, 8);
    if (!tabs.length) return null;
    const lines = [];
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (!t.webview) continue;
      try {
        const content = await window.navio.extractPageContent(t.webview.getWebContentsId());
        if (content && !content.error) {
          const title = TabManager.getTabDisplayTitle(t) || content.title || t.url;
          const snippet = (content.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
          lines.push(`${i + 1}. **${title}** (${content.url || t.url})\n   ${snippet}`);
        }
      } catch {
        /* skip tab */
      }
    }
    if (!lines.length) return null;
    return `[Tab digest — ${lines.length} open tab(s); excerpts are truncated for token limits]\n\n${lines.join('\n\n')}`;
  }

  _formatTurnDuration(ms) {
    const n = Math.max(0, Math.round(Number(ms) || 0));
    if (n < 700) return `${n} ms`;
    const s = n / 1000;
    return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
  }

  _messageRoleStrip(role, type = '') {
    const strip = document.createElement('div');
    if (role === 'user') {
      strip.className = 'msg-role-strip msg-role-strip--user';
      strip.innerHTML = '<span class="msg-role-label">You</span>';
      return strip;
    }
    if (type === 'error') {
      strip.className = 'msg-role-strip msg-role-strip--error';
      strip.innerHTML = '<span class="msg-role-label">Couldn’t complete</span>';
      return strip;
    }
    strip.className = 'msg-role-strip msg-role-strip--assistant';
    strip.innerHTML =
      '<span class="msg-role-label">Navio</span><span class="msg-role-badge" aria-hidden="true">AI</span>';
    return strip;
  }

  _appendMessageDurationRow(msgEl, durationMs) {
    if (!msgEl || durationMs == null || msgEl.querySelector('.msg-meta')) return;
    const row = document.createElement('div');
    row.className = 'msg-meta';
    const span = document.createElement('span');
    span.className = 'msg-meta-time';
    span.title = 'Time from your send to this reply';
    span.textContent = this._formatTurnDuration(durationMs);
    row.appendChild(span);
    msgEl.appendChild(row);
  }

  _attachCopyButtonToMessage(msgEl, contentEl) {
    if (!msgEl || !contentEl || msgEl.querySelector('.msg-copy-btn')) return;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = 'Copy message';
    copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    copyBtn.addEventListener('click', () => {
      const raw = contentEl.innerText || contentEl.textContent || '';
      navigator.clipboard.writeText(raw.trim()).then(() => {
        copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        copyBtn.classList.add('msg-copy-ok');
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
          copyBtn.classList.remove('msg-copy-ok');
        }, 1800);
      }).catch(() => {});
    });
    msgEl.insertBefore(copyBtn, contentEl);
  }

  addMessage(role, content, type = '', meta = null) {
    if (!this._assistantHistoryDomReplay && !this._panelShowsTurnDom()) return;
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}-message${type ? ' message-' + type : ''}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    if (role === 'user' && content && typeof content === 'object' && !Array.isArray(content) && content.files) {
      msgEl.appendChild(this._messageRoleStrip('user'));
      const parts = [];
      if (content.text && String(content.text).trim()) {
        parts.push(`<div class="user-msg-text">${this.formatMessage(String(content.text), false)}</div>`);
      }
      const chips = (content.files || [])
        .map((f) => {
          const nm = this._escapeHtml(f.name || 'file');
          if (f.thumb) {
            return `<div class="user-att-preview"><img src="${String(f.thumb).replace(/"/g, '&quot;')}" alt="">${nm}</div>`;
          }
          return `<div class="user-att-preview user-att-preview--file"><span class="user-att-file-label">${f.kind === 'pdf' ? 'PDF' : 'FILE'}</span>${nm}</div>`;
        })
        .join('');
      if (chips) parts.push(`<div class="user-att-row">${chips}</div>`);
      contentEl.innerHTML = parts.length ? parts.join('') : '<div class="user-msg-text">(attachment)</div>';
      msgEl.appendChild(contentEl);
      this.messagesEl.appendChild(msgEl);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      return;
    }

    msgEl.appendChild(this._messageRoleStrip(role, type));

    if (type === 'error') {
      const clean = content.replace(/^\*\*Error:\*\*\s*/i, '').replace(/^\*\*Connection error:\*\*\s*/i, '');
      contentEl.innerHTML = `
        <div class="msg-error-header">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Error
        </div>
        <div class="msg-error-body">${this.formatMessage(clean)}</div>`;
    } else {
      contentEl.innerHTML = this.formatMessage(content, role === 'assistant');
      if (role === 'assistant') this._wireActions(contentEl); // async — fire-and-forget is fine here
    }

    // ── Copy button (assistant + error messages only) ────────────────────
    if (role === 'assistant' || type === 'error') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-copy-btn';
      copyBtn.title = 'Copy message';
      copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      copyBtn.addEventListener('click', () => {
        // Copy plain text — strip HTML tags
        const raw = contentEl.innerText || contentEl.textContent || '';
        navigator.clipboard.writeText(raw.trim()).then(() => {
          copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
          copyBtn.classList.add('msg-copy-ok');
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
            copyBtn.classList.remove('msg-copy-ok');
          }, 1800);
        }).catch(() => {});
      });
      msgEl.appendChild(copyBtn);
    }

    msgEl.appendChild(contentEl);
    if (meta && meta.durationMs != null && (role === 'assistant' || type === 'error')) {
      this._appendMessageDurationRow(msgEl, meta.durationMs);
    }
    let citeUrls =
      meta && Array.isArray(meta.citations) && meta.citations.length ? meta.citations.slice() : null;
    if (role === 'assistant' && type !== 'error' && (!citeUrls || !citeUrls.length)) {
      const extra = this._extractUrlsForCitationChipsFromAssistantText(typeof content === 'string' ? content : '');
      if (extra && extra.length) citeUrls = extra;
    }
    if (role === 'assistant' && citeUrls && citeUrls.length) {
      this._appendCitationChips(msgEl, citeUrls);
    }
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * Extract Gmail message id from a mail.google.com href (fragment may be inbox/id, search/…, etc.).
   */
  /**
   * Gmail multi-account: `/mail/u/0` vs `/u/1` is **browser session order**, not Navio’s OAuth primary/secondary.
   * When we know the Google account email (OAuth), add `?authuser=<email>` so Gmail opens the same inbox as the API.
   */
  _gmailWebInboxUrl(messageId, gmailUSlot, authEmail) {
    const id = String(messageId || '').trim();
    if (!id) return '';
    const slot = gmailUSlot === 1 || gmailUSlot === '1' ? 1 : 0;
    const email =
      typeof authEmail === 'string' && authEmail.includes('@') ? authEmail.trim() : '';
    if (email) {
      const base = new URL('https://mail.google.com/mail/u/0/');
      base.searchParams.set('authuser', email);
      return `${base.origin}${base.pathname}?${base.searchParams.toString()}#inbox/${encodeURIComponent(id)}`;
    }
    return `https://mail.google.com/mail/u/${slot}/#inbox/${encodeURIComponent(id)}`;
  }

  _resolveGmailMessageIdFromMailUrl(href) {
    if (!href || typeof href !== 'string') return null;
    const hashIdx = href.indexOf('#');
    if (hashIdx === -1) return null;
    let frag = href.slice(hashIdx + 1);
    try {
      frag = decodeURIComponent(frag.replace(/\+/g, ' '));
    } catch {
      /* keep frag */
    }
    const parts = frag.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i].split('?')[0];
      if (this._emailRefs?.has(seg)) return seg;
    }
    const last = (parts[parts.length - 1] || '').split('?')[0];
    if (last && /^[a-zA-Z0-9_-]{10,}$/.test(last)) return last;
    return null;
  }

  _buildEmailRefChipHtml(url, msgId, subjectLabel, gmailUSlot) {
    const ref = (msgId && this._emailRefs?.get(msgId)) || {};
    let slot = gmailUSlot;
    if (slot == null && ref.gmailUSlot != null) slot = ref.gmailUSlot;
    if (slot == null && ref.serviceId === 'gmail_2') slot = 1;
    if (slot == null) {
      const m = typeof url === 'string' ? url.match(/\/mail\/u\/(\d+)\//i) : null;
      if (m) slot = parseInt(m[1], 10) || 0;
      else slot = 0;
    }
    const slotN = slot === 1 || slot === '1' ? 1 : 0;
    const authEmail = ref.authEmail;
    const safeUrl = (this._gmailWebInboxUrl(msgId, slotN, authEmail) || url || '').replace(/"/g, '&quot;');
    const display = (subjectLabel || ref.subject || '(no subject)').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeFrom = (ref.from || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeSnippet = (ref.snippet || '').replace(/"/g, '&quot;').slice(0, 500);
    const midAttr = msgId ? ` data-msg-id="${String(msgId).replace(/"/g, '&quot;')}"` : '';
    const uAttr = ` data-gmail-u="${slotN}"`;
    return (
      `<span class="email-ref-chip" data-url="${safeUrl}"${midAttr}${uAttr} data-from="${safeFrom}" data-snippet="${safeSnippet}" role="button" tabindex="0" title="Open in Gmail · hover for body">`
      + `<svg class="erc-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`
      + `<span class="erc-subject">${display}</span>`
      + `<svg class="erc-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`
      + `</span>`
    );
  }

  /**
   * Turn plain-text subject lines (when the model drops markdown links) into the same chips as linked Gmail URLs.
   */
  _enrichPlainEmailSubjects(html) {
    const map = this._emailRefs;
    if (!map || map.size === 0 || typeof html !== 'string' || !html) return html;

    const pairs = [...map.entries()]
      .map(([id, ref]) => {
        const subject = (ref.subject || '').trim();
        return { id, subject, subLower: subject.toLowerCase() };
      })
      .filter((x) => x.subject.length > 4 && x.subject !== '(no subject)');
    pairs.sort((a, b) => b.subject.length - a.subject.length);
    if (!pairs.length) return html;

    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const skipTag = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'BUTTON', 'INPUT', 'TEXTAREA']);
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let el = node.parentElement;
        while (el) {
          if (skipTag.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (el.classList?.contains('email-ref-chip')) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const node of textNodes) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;

      const frags = [];
      let i = 0;
      const textL = text.toLowerCase();
      while (i < text.length) {
        let best = null;
        for (const { id, subject, subLower } of pairs) {
          const idx = textL.indexOf(subLower, i);
          if (idx === -1) continue;
          if (!best || idx < best.idx || (idx === best.idx && subject.length > best.subject.length)) {
            best = { idx, id, subject, matchLen: subject.length };
          }
        }
        if (!best) {
          frags.push({ type: 'text', text: text.slice(i) });
          break;
        }
        if (best.idx > i) frags.push({ type: 'text', text: text.slice(i, best.idx) });
        frags.push({ type: 'chip', id: best.id, subject: best.subject });
        i = best.idx + best.matchLen;
      }

      if (frags.length === 1 && frags[0].type === 'text') continue;

      const parent = node.parentNode;
      if (!parent) continue;
      const refNode = node;
      for (const frag of frags) {
        if (frag.type === 'text') {
          if (frag.text) parent.insertBefore(document.createTextNode(frag.text), refNode);
        } else {
          const ref = map.get(frag.id) || {};
          const slot = ref.gmailUSlot != null ? ref.gmailUSlot : 0;
          const chipUrl = ref.url || this._gmailWebInboxUrl(frag.id, slot, ref.authEmail);
          const wrap = document.createElement('div');
          wrap.innerHTML = this._buildEmailRefChipHtml(chipUrl, frag.id, ref.subject || frag.subject, slot);
          const chip = wrap.firstElementChild;
          if (chip) parent.insertBefore(chip, refNode);
        }
      }
      parent.removeChild(refNode);
    }

    return tpl.innerHTML;
  }

  /** Register Gmail rows from agent gmail_search tool results (same shape as connector). */
  async _ingestGmailSearchToolResults(result) {
    const rows = result?.results;
    if (!Array.isArray(rows)) return;
    let oauthSt = {};
    try {
      oauthSt = (await window.navio.oauthStatus()) || {};
    } catch {
      /* ignore */
    }
    const emailPri = oauthSt.google?.email;
    const emailSec = oauthSt.google_2?.email;
    const svc = result?.gmail_service_id === 'gmail_2' ? 'gmail_2' : 'gmail';
    const slot = svc === 'gmail_2' ? 1 : 0;
    const authEmail = slot === 1 ? emailSec : emailPri;
    for (const r of rows) {
      if (!r?.id) continue;
      const gmailUrl = this._gmailWebInboxUrl(r.id, slot, authEmail);
      this._emailRefs.set(r.id, {
        subject: r.subject || '(no subject)',
        from: r.from || '',
        snippet: r.snippet || '',
        url: gmailUrl,
        serviceId: svc,
        gmailUSlot: slot,
        authEmail: authEmail || undefined
      });
    }
  }

  formatMessage(text, parseActions = false) {
    if (!text) return '';

    // ── 1. Extract action tokens BEFORE any HTML processing ──────────────────
    // Format: [[ACTION:type:params]] — square brackets never appear in plain URLs
    // Also handle legacy <<ACTION:type:params>> tokens from old sessions
    const actionCards = [];
    let processedText = text;

    const extractToken = (_, type, params) => {
      const idx = actionCards.length;
      actionCards.push({ type, params: params || '' });
      return `\x00ACT${idx}\x00`;
    };

    if (parseActions) {
      // [[PLAN:step1||step2||step3]] — plan block from <navio-plan>
      processedText = processedText.replace(/\[\[PLAN:([\s\S]*?)\]\]/g, (_, encoded) => {
        const idx = actionCards.length;
        actionCards.push({ type: 'PLAN', params: encoded });
        return `\x00ACT${idx}\x00`;
      });
      // [[DRAFT:base64json]] — Gmail draft preview card
      processedText = processedText.replace(/\[\[DRAFT:([A-Za-z0-9+/=]+)\]\]/g, (_, b64) => {
        const idx = actionCards.length;
        actionCards.push({ type: 'GMAIL_DRAFT', params: b64 });
        return `\x00ACT${idx}\x00`;
      });
      // [[ACTION:type:params]] — non-greedy, stops at first ]]
      processedText = processedText.replace(/\[\[ACTION:(\w+):([\s\S]*?)\]\]/g, extractToken);
      // Legacy <<ACTION:type:params>> — keep compatible
      processedText = processedText.replace(/<<ACTION:(\w+):([\s\S]*?)>>/g, extractToken);
      // Task chain approval gate: [[TASK_APPROVE:id]]
      processedText = processedText.replace(/\[\[TASK_APPROVE:([\w-]+)\]\]/g, (_, id) => {
        const idx = actionCards.length;
        actionCards.push({ type: 'TASK_APPROVE', params: id });
        return `\x00ACT${idx}\x00`;
      });
    } else {
      processedText = processedText.replace(/\[\[PLAN:[\s\S]*?\]\]/g, '');
      processedText = processedText.replace(/\[\[DRAFT:[A-Za-z0-9+/=]+\]\]/g, '');
      processedText = processedText.replace(/\[\[ACTION:[\s\S]*?\]\]/g, '');
      processedText = processedText.replace(/<<ACTION:[\s\S]*?>>/g, '');
      processedText = processedText.replace(/\[\[TASK_APPROVE:[\s\S]*?\]\]/g, '');
    }

    // ── 2. HTML-escape raw text ───────────────────────────────────────────────
    let html = processedText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // ── 3. Fenced code blocks with language label + copy button ─────────────
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const langAttr = lang ? ` class="lang-${lang}"` : '';
      const langLabel = lang || 'code';
      const codeId = 'code-' + Math.random().toString(36).slice(2, 9);
      return `<div class="msg-code-header"><span class="msg-code-lang">${langLabel}</span><button class="msg-code-copy" data-code-id="${codeId}" onclick="(function(b){var c=document.getElementById('${codeId}');if(c){navigator.clipboard.writeText(c.textContent).then(function(){b.textContent='Copied!';b.classList.add('copied');setTimeout(function(){b.textContent='Copy';b.classList.remove('copied')},1500)})}})(this)">Copy</button></div><pre${langAttr}><code id="${codeId}">${code.trim()}</code></pre>`;
    });

    // ── 4. Horizontal rule ────────────────────────────────────────────────────
    html = html.replace(/^---+$/gm, '<hr>');

    // ── 5. Blockquotes ────────────────────────────────────────────────────────
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/(<\/blockquote>\n?<blockquote>)/g, '\n');

    // ── 6. Headings ───────────────────────────────────────────────────────────
    html = html.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // ── 7. Inline code ────────────────────────────────────────────────────────
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // ── 8. Bold / italic ─────────────────────────────────────────────────────
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/_([^_\s][^_]*)_/g, '<em>$1</em>');

    // ── 9. Links ──────────────────────────────────────────────────────────────
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      // Block dangerous schemes to prevent XSS / open-redirect via model output
      const safe = /^https?:\/\//i.test(url.trim()) || /^mailto:/i.test(url.trim());
      if (!safe) return label;
      return `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">${label}</a>`;
    });

    // ── 9b. Gmail links → professional email reference chips ─────────────────
    html = html.replace(
      /<a\s+href="(https:\/\/mail\.google\.com\/mail\/u\/(\d+)\/[^"]*#[^"]+)"[^>]*>([^<]*)<\/a>/gi,
      (_, url, uStr, subject) => {
        const msgId = this._resolveGmailMessageIdFromMailUrl(url);
        const uSlot = parseInt(uStr, 10) || 0;
        return this._buildEmailRefChipHtml(url, msgId, subject, uSlot);
      }
    );

    // ── 10. Unordered lists ───────────────────────────────────────────────────
    html = html.replace(/^[ \t]*[-•*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)(\n(?!<li>)|$)/g, '$1\n');
    html = html.replace(/((?:<li>[\s\S]*?<\/li>\n?)+)/g, '<ul>$1</ul>');

    // ── 11. Ordered lists ─────────────────────────────────────────────────────
    html = html.replace(/^\d+[.)]\s+(.+)$/gm, '<oli>$1</oli>');
    html = html.replace(/((?:<oli>[\s\S]*?<\/oli>\n?)+)/g, (m) =>
      '<ol>' + m.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>') + '</ol>'
    );

    // ── 12. Paragraphs ────────────────────────────────────────────────────────
    html = html.replace(/\n\n+/g, '\n\n');
    const BLOCK = /^(<\/?(h[2-5]|ul|ol|li|pre|blockquote|hr)[\s>])/;
    const lines = html.split('\n');
    const out = [];
    let buf = [];
    const flushBuf = () => {
      if (buf.length) {
        const t = buf.join('\n').trim();
        if (t) out.push(`<p>${t}</p>`);
        buf = [];
      }
    };
    for (const line of lines) {
      if (BLOCK.test(line.trim())) {
        flushBuf();
        out.push(line);
      } else if (line === '') {
        flushBuf();
      } else {
        buf.push(line);
      }
    }
    flushBuf();
    html = out.join('\n');
    html = html.replace(/<p>\s*<\/p>/g, '');

    // ── 13. Re-inject action cards ───────────────────────────────────────────
    if (actionCards.length) {
      const ACTION_ICONS = {
        navigate: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
        click:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-7 1-4 7z"/></svg>`,
        type:     `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
        scroll:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`,
        goBack:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
        goForward:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
        insertText: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
        pressKey: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8"/></svg>`,
        screenshot: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
        gmailCreateReplyDraft: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
        gmailUpdateDraft: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
        wait: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        waitForText: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
        select: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 3 7-7"/></svg>`,
        appendText: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/><line x1="9" y1="12" x2="15" y2="12"/></svg>`
      };
      const VERBS = {
        navigate: 'Navigate to',
        click: 'Click',
        type: 'Type into',
        scroll: 'Scroll',
        goBack: 'Go back',
        goForward: 'Go forward',
        insertText: 'Paste text',
        pressKey: 'Key',
        screenshot: 'Screenshot',
        gmailCreateReplyDraft: 'Gmail reply draft',
        gmailUpdateDraft: 'Update Gmail draft',
        wait: 'Wait',
        waitForText: 'Wait for text',
        select: 'Select option',
        appendText: 'Append text'
      };

      const EDIT_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

      actionCards.forEach(({ type, params }, idx) => {
        let card;
        if (type === 'GMAIL_DRAFT') {
          let d = {};
          try { d = JSON.parse(atob(params)); } catch { d = {}; }
          const safeBody = navioRepairUtf8Mojibake(d.body || '')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const safeTo = (d.to || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const safeSubj = (d.subject || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          card = `<div class="gmail-draft-card" data-draft-id="${d.draftId || ''}" data-to="${d.to||''}" data-subject="${d.subject||''}">
            <div class="gdc-header">
              <svg class="gdc-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0 1.1.9 2 2 2z"/><polyline points="22,6 12,13 2,6"/></svg>
              <div class="gdc-meta">
                <span class="gdc-to">To: <strong>${safeTo}</strong></span>
                <span class="gdc-subject">${safeSubj}</span>
              </div>
              <span class="gdc-draft-pill" hidden aria-hidden="true"></span>
              <span class="gdc-badge">Ready</span>
            </div>
            <div class="gdc-body-wrap">
              <textarea class="gdc-body" readonly spellcheck="true" rows="6">${safeBody}</textarea>
            </div>
            <div class="gdc-toolbar">
              <button class="gdc-tool gdc-copy" type="button" title="Copy body">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                Copy
              </button>
              <button class="gdc-tool gdc-open" type="button" title="Open Drafts in Gmail">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                Gmail
              </button>
              <button class="gdc-tool gdc-toggle" type="button" aria-expanded="true" title="Compact or full height">Compact</button>
            </div>
            <div class="gdc-actions">
              <button class="gdc-btn gdc-btn-send" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send
              </button>
              <button class="gdc-btn gdc-btn-edit" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit
              </button>
              <button class="gdc-btn gdc-btn-keep" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v14a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Keep
              </button>
              <button class="gdc-btn gdc-btn-discard" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>Discard
              </button>
            </div>
          </div>`;
        } else if (type === 'PLAN') {
          // Render a plan overview card
          const steps = params.split('||').filter(Boolean);
          const stepItems = steps.map((s, i) =>
            `<div class="navio-plan-step" draggable="true">
              <span class="navio-plan-drag" title="Drag to reorder">
                <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/></svg>
              </span>
              <span class="navio-plan-num">${i + 1}</span>
              <span class="navio-plan-text">${s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>
              <button class="navio-plan-del" title="Remove step" type="button">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>`
          ).join('');
          card = `<div class="navio-plan-card">
            <div class="navio-plan-header">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              <span class="navio-plan-title-text">Plan — ${steps.length} step${steps.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="navio-plan-steps">${stepItems}</div>
            <button class="navio-plan-add-btn" type="button">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add step
            </button>
            <div class="navio-plan-agent-footer">
              <button type="button" class="navio-plan-run-agent">Run safe steps (scroll / back / forward / wait)</button>
            </div>
            <div class="navio-plan-agent-progress" hidden></div>
          </div>`;
        } else if (type === 'TASK_APPROVE') {
          card = `<div class="tc-approval-gate" data-approval-id="${params}">
            <span class="tca-label">Ready to execute this step</span>
            <div class="tca-btns">
              <button class="tca-approve" type="button" data-aid="${params}">▶ Run step</button>
              <button class="tca-skip" type="button" data-aid="${params}">Skip</button>
            </div>
          </div>`;
        } else {
          const icon = ACTION_ICONS[type] || ACTION_ICONS.navigate;
          const verb = VERBS[type] || type;
          const safeParams = params.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          let paramDisplay = safeParams;
          if (type === 'navigate') {
            try {
              const u = new URL(params);
              paramDisplay = u.hostname + (u.pathname !== '/' ? u.pathname : '') + (u.search ? '…' : '');
              paramDisplay = paramDisplay.replace(/^www\./, '');
            } catch (_) {}
          } else if (type === 'gmailCreateReplyDraft') {
            try {
              const raw = params.replace(/\s/g, '');
              const p = JSON.parse(atob(raw));
              const id = (p.id || '').toString();
              paramDisplay = id.length > 12 ? `…${id.slice(-10)}` : id || 'message';
            } catch (_) {
              paramDisplay = 'Gmail message + body';
            }
          } else if (type === 'gmailUpdateDraft') {
            paramDisplay = 'Save draft body';
          } else if (type === 'insertText') {
            paramDisplay = params.length > 80 ? params.slice(0, 77) + '…' : params;
          }
          card = `<div class="browser-action-card" data-action="${type}" data-params="${safeParams}">
            <span class="bac-icon">${icon}</span>
            <span class="bac-desc"><strong>${verb}</strong>${params ? `<span class="bac-param" title="${safeParams}">${paramDisplay}</span>` : ''}</span>
            <div class="bac-btns">
              <button class="bac-edit" type="button" title="Edit this step">${EDIT_ICON}</button>
              <button class="bac-run" type="button">Run</button>
              <button class="bac-skip" type="button">Skip</button>
            </div>
          </div>`;
        }
        html = html.replace(`\x00ACT${idx}\x00`, card);
      });
    }

    html = this._enrichPlainEmailSubjects(html);

    return html;
  }

  // ── Takeover mode ────────────────────────────────────────────────────────
  /** Tab strip + banner: show which tab is receiving takeover actions. */
  _syncTakeoverTabHighlight() {
    if (typeof TabManager === 'undefined') return;
    const tid = TabManager.getTakeoverHighlightTabId?.() ?? null;
    TabManager.setAgentControlledTab?.(tid);
    const label = document.querySelector('#navio-takeover-banner .ntb-label');
    if (label && this._takeoverMode) {
      const tab = tid != null ? TabManager.tabs?.find((t) => t.id === tid) : null;
      const name = tab ? TabManager.getTabDisplayTitle(tab) : '';
      label.textContent = name ? `Navio is in control — ${name}` : 'Navio is in control';
    }
  }

  enableTakeover() {
    this._takeoverMode = true;
    this._takeoverAbort = new AbortController();
    this._agentLogEntries = [];
    this._takeoverStepNum = 0;
    this._renderAgentLog();
    if (window.NavioAIBoost) window.NavioAIBoost.setOrbThinking(true);
    // Banner above the input area
    if (!document.getElementById('navio-takeover-banner')) {
      const banner = document.createElement('div');
      banner.id = 'navio-takeover-banner';
      banner.className = 'navio-takeover-banner';
      banner.innerHTML = `
        <span class="ntb-dot"></span>
        <span class="ntb-label">Navio is in control</span>
        <button class="ntb-undo" type="button">Undo</button>
        <button class="ntb-stop" type="button">Stop</button>`;
      banner.querySelector('.ntb-stop').addEventListener('click', () => this.disableTakeover());
      banner.querySelector('.ntb-undo').addEventListener('click', () => this._undoLastNavigation());
      const inputArea = this.panel.querySelector('.assistant-input-area');
      if (inputArea) this.panel.insertBefore(banner, inputArea);
    }
    this._syncTakeoverTabHighlight();
    // Also show the visual agent bar with the animated orb
    if (window.NavioAIBoost) {
      const bar = window.NavioAIBoost.buildAgentTakeoverBar('Agent is working...', '');
      const agentLog = document.getElementById('assistant-agent-log');
      if (agentLog && agentLog.parentNode) {
        agentLog.parentNode.insertBefore(bar, agentLog);
      }
    }
  }

  disableTakeover() {
    if (typeof TabManager !== 'undefined') TabManager.setAgentControlledTab?.(null);
    this._takeoverMode = false;
    this._autoFollowCount = 0;
    if (window.NavioAIBoost) window.NavioAIBoost.setOrbThinking(false);
    if (typeof this._takeoverAuthResume === 'function') {
      try {
        this._takeoverAuthResume();
      } catch {
        /* ignore */
      }
    }
    this._takeoverAuthResume = null;
    try {
      this._takeoverAbort?.abort();
    } catch {
      /* ignore */
    }
    this._takeoverAbort = null;
    document.getElementById('navio-takeover-banner')?.remove();
    document.getElementById('navio-step-pause-pill')?.remove();
    document.getElementById('navio-auth-gate-pill')?.remove();
    document.getElementById('agent-takeover-bar')?.remove();
    const logPanel = document.getElementById('assistant-agent-log');
    if (logPanel) {
      logPanel.hidden = true;
      const body = logPanel.querySelector('.assistant-agent-log-body');
      if (body) body.innerHTML = '';
    }
    this._addContinuePill('Navio stopped. You\'re back in control.');
  }

  _renderAgentLog() {
    const panel = document.getElementById('assistant-agent-log');
    const body = panel?.querySelector('.assistant-agent-log-body');
    if (!panel || !body) return;
    if (!this._takeoverMode) {
      panel.hidden = true;
      body.innerHTML = '';
      return;
    }
    panel.hidden = false;
    if (!this._agentLogEntries.length) {
      body.innerHTML = '<div class="aal-line aal-muted">Waiting for first action…</div>';
    } else {
      body.innerHTML = this._agentLogEntries
        .map(
          (e) =>
            `<div class="aal-line${e.ok === false ? ' aal-err' : ''}"><span class="aal-time">${e.t}</span> <span class="aal-act">${e.action}</span> — ${String(e.detail || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')}</div>`
        )
        .join('');
    }
    const sum = panel.querySelector('.assistant-agent-log-summary');
    if (sum) sum.textContent = `${this._agentLogEntries.length} step(s)`;
  }

  _pushAgentLog(action, detail, ok = true) {
    if (!this._takeoverMode) return;
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this._agentLogEntries.push({ t, action, detail: String(detail || '').slice(0, 200), ok });
    this._renderAgentLog();
  }

  async _maybeAutoScreenshotTakeover(wv) {
    if (!this._takeoverMode || !wv) return;
    try {
      const cfg = await window.navio.getConfig();
      if (!cfg.aiAutoScreenshotAfterNavigate) return;
      const cap = await window.navio.browserAction({
        webContentsId: wv.getWebContentsId(),
        action: 'screenshot',
        params: {},
        userConfirmed: true
      });
      if (cap && cap.screenshot) this._pendingScreenshotDataUrl = cap.screenshot;
    } catch {
      /* ignore */
    }
  }

  _finishAuthGateContinue() {
    document.getElementById('navio-auth-gate-pill')?.remove();
    const fn = this._takeoverAuthResume;
    this._takeoverAuthResume = null;
    if (typeof fn === 'function') fn();
    if (this._takeoverMode) this._syncTakeoverTabHighlight();
  }

  _showAuthGatePill(hostname) {
    document.getElementById('navio-auth-gate-pill')?.remove();
    const pill = document.createElement('div');
    pill.id = 'navio-auth-gate-pill';
    pill.className = 'navio-auth-gate-pill';
    pill.innerHTML =
      '<span class="nag-text">Blocked by login page at <strong>' +
      hostname.replace(/</g, '') +
      '</strong> — sign in, then continue.</span>' +
      '<button type="button" class="nag-continue">Continue</button>';
    pill.querySelector('.nag-continue').addEventListener('click', () => this._finishAuthGateContinue());
    this.messagesEl.appendChild(pill);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async runDeepResearch(query) {
    const q = (query || '').trim();
    if (!q) return;
    const tk =
      typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : NAVIO_PROFILE_CHAT_KEY;
    const prevBusy = this._tabIsBusy(tk);
    this._setTabBusy(tk, true);
    this.showTypingIndicator();
    try {
      const r = await window.navio.deepResearch({ query: q });
      if (r.error) {
        this.addMessage('assistant', r.error, 'error');
        return;
      }
      let body = r.content || '';
      if (r.sources && r.sources.length) {
        body +=
          '\n\n## Sources\n' +
          r.sources
            .map((s) => {
              const title = (s.title || s.url || 'Source').replace(/\]/g, '');
              const url = (s.url || '').trim();
              return url ? `- [${title}](${url})` : `- ${title}`;
            })
            .join('\n');
      }
      this.addMessage('assistant', body);
    } catch (e) {
      this.addMessage('assistant', e.message || String(e), 'error');
    } finally {
      this.removeTypingIndicator();
      if (!prevBusy) this._setTabBusy(tk, false);
      else this._updateAssistantBusyChrome();
    }
  }

  async handleQuickActionAllTabs() {
    if (typeof TabManager === 'undefined' || !TabManager.tabs) {
      this.addMessage('assistant', 'No tabs available.');
      return;
    }
    const parts = [];
    for (const t of TabManager.tabs) {
      const url = t.url || '';
      if (!url || url === 'about:blank' || url.startsWith('data:')) continue;
      if (!t.webview) continue;
      try {
        const content = await window.navio.extractPageContent(t.webview.getWebContentsId());
        if (content && !content.error) {
          parts.push(
            `### Tab: ${TabManager.getTabDisplayTitle(t) || url}\nURL: ${content.url || url}\n\n${(content.text || '').slice(0, 10000)}`
          );
        }
      } catch {
        /* skip tab */
      }
    }
    if (!parts.length) {
      this.addMessage('assistant', 'No loaded pages found in open tabs.');
      return;
    }
    const blob = parts.join('\n\n---\n\n').slice(0, 80000);
    this.addMessage('user', 'Summarize / compare all open tabs');
    await this.processMessage(
      `You have extracts from ALL open browser tabs below. Summarize each briefly, then note overlaps, contradictions, or themes across tabs. Be concise.\n\n${blob}`,
      true,
      'Multi-tab summary'
    );
  }

  maybeProactivePageLoadHint(tab, wv) {
    try {
      const url = (tab && tab.url) || (wv && wv.src) || '';
      if (!url || url === 'about:blank' || url.startsWith('data:')) return;
      const u = url.toLowerCase();
      const title = ((tab && tab.title) || '').toLowerCase();
      let offer = '';
      if (/amazon\.|shopify|\/product\/|\/dp\/|\/item\//i.test(url)) {
        offer = 'Looks like a product page — want me to find lower prices or compare reviews?';
      } else if (/linkedin\.com\/jobs|indeed\.com\/(viewjob|jobs)/i.test(u)) {
        offer = 'Job listing detected — want me to summarize requirements or suggest talking points?';
      } else if (/google\.com\/travel\/flights|kayak\.com\/flights|expedia\.com\/.*[Ff]light/i.test(u)) {
        offer = 'Flight results — want me to compare options or suggest next steps?';
      } else if (/(bbc\.com\/news|reuters\.com|nytimes\.com|theguardian\.com)/i.test(u) && title.length > 8) {
        offer = 'Long article — want a quick summary or key takeaways?';
      }
      if (!offer) return;
      const key = url.slice(0, 160);
      if (this._lastProactiveUrlKey === key) return;
      this._lastProactiveUrlKey = key;
      document.getElementById('navio-proactive-agent-pill')?.remove();
      const pill = document.createElement('div');
      pill.id = 'navio-proactive-agent-pill';
      pill.className = 'navio-proactive-agent-pill';
      const span = document.createElement('span');
      span.className = 'npa-text';
      span.textContent = offer;
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'npa-go';
      go.textContent = 'Ask Navio';
      go.addEventListener('click', () => {
        pill.remove();
        this.open();
        this.inputEl.value = offer.replace(/^[^—]+—\s*/, '').replace(/\?$/, '') + ' ';
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        this.inputEl.focus();
      });
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'npa-dismiss';
      dismiss.textContent = '×';
      dismiss.addEventListener('click', () => pill.remove());
      pill.appendChild(span);
      pill.appendChild(go);
      pill.appendChild(dismiss);
      this.messagesEl.appendChild(pill);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    } catch {
      /* ignore */
    }
  }

  _showSaveWorkflowOffer(contentEl) {
    document.getElementById('navio-workflow-save-offer')?.remove();
    const msg = contentEl?.closest?.('.message');
    if (!msg) return;
    const wrap = document.createElement('div');
    wrap.id = 'navio-workflow-save-offer';
    wrap.className = 'navio-workflow-save-offer';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'nwsf-name';
    inp.placeholder = 'Workflow name';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nwsf-btn';
    btn.textContent = 'Save as workflow';
    btn.addEventListener('click', async () => {
      const cards = msg.querySelectorAll('.browser-action-card');
      const steps = [];
      cards.forEach((c) => {
        const a = c.dataset.action;
        const p = c.dataset.params || '';
        if (!a) return;
        if (a === 'goBack' || a === 'goForward') steps.push(`${a}:`);
        else steps.push(`${a}:${p}`);
      });
      if (!steps.length) {
        wrap.querySelector('.nwsf-err')?.remove();
        const er = document.createElement('span');
        er.className = 'nwsf-err';
        er.textContent = 'No actions to save.';
        wrap.appendChild(er);
        return;
      }
      const name = inp.value.trim() || 'Saved workflow';
      const r = await window.navio.workflowSave({ name, steps });
      if (r.error) {
        wrap.querySelector('.nwsf-err')?.remove();
        const er = document.createElement('span');
        er.className = 'nwsf-err';
        er.textContent = r.error;
        wrap.appendChild(er);
        return;
      }
      wrap.innerHTML = '<span class="nwsf-saved">Workflow saved.</span>';
    });
    wrap.appendChild(inp);
    wrap.appendChild(btn);
    this.messagesEl.appendChild(wrap);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async runWorkflowFromCommandPalette(workflow) {
    if (!workflow || !workflow.steps || !workflow.steps.length) return;
    this.open();
    this.enableTakeover();
    const lines = workflow.steps.map((line) => {
      const i = line.indexOf(':');
      const raw = i >= 0 ? line.slice(0, i).trim() : line.trim();
      const params = i >= 0 ? line.slice(i + 1) : '';
      const low = raw.toLowerCase();
      const map = {
        goback: 'goBack',
        goforward: 'goForward',
        inserttext: 'insertText',
        presskey: 'pressKey',
        waitfortext: 'waitForText',
        appendtext: 'appendText',
        gmailcreatereplydraft: 'gmailCreateReplyDraft',
        gmailupdatedraft: 'gmailUpdateDraft'
      };
      const type = map[low] || raw;
      return `[[ACTION:${type}:${params}]]`;
    });
    const synthetic = lines.join('\n');
    this.addMessage('user', `Run workflow: ${workflow.name || 'Workflow'}`);
    this.addMessage('assistant', synthetic);
  }

  _wirePlanStep(step) {
    const textEl = step.querySelector('.navio-plan-text');
    if (!textEl || step.classList.contains('navio-plan-editing')) return;
    const clone = textEl.cloneNode(true);
    textEl.replaceWith(clone);
    clone.title = 'Click to edit';
    clone.style.cursor = 'pointer';
    clone.addEventListener('click', () => {
      if (step.classList.contains('navio-plan-editing')) return;
      step.classList.add('navio-plan-editing');
      const original = clone.textContent.trim();
      const ta = document.createElement('textarea');
      ta.className = 'navio-plan-edit-input';
      ta.value = original;
      ta.spellcheck = false;
      ta.rows = 1;
      clone.replaceWith(ta);
      // Auto-resize to fit content
      const resize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.addEventListener('input', resize);
      resize();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      let finished = false;
      const finish = (keep) => {
        if (finished) return;
        finished = true;
        step.classList.remove('navio-plan-editing');
        const span = document.createElement('span');
        span.className = 'navio-plan-text';
        span.textContent = keep ? (ta.value.trim() || original) : original;
        ta.replaceWith(span);
        this._wirePlanStep(step);
      };
      // Use a named reference so Escape can remove the blur listener correctly
      const onBlur = () => finish(true);
      ta.addEventListener('blur', onBlur);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); ta.removeEventListener('blur', onBlur); finish(false); }
      });
    });
  }

  // Renumber all .navio-plan-num elements inside a plan card and update header count
  _renumberPlan(card) {
    const steps = Array.from(card.querySelectorAll('.navio-plan-step'));
    steps.forEach((s, i) => {
      const num = s.querySelector('.navio-plan-num');
      if (num) num.textContent = i + 1;
    });
    const titleEl = card.querySelector('.navio-plan-title-text');
    if (titleEl) titleEl.textContent = `Plan — ${steps.length} step${steps.length !== 1 ? 's' : ''}`;
  }

  // Wire a plan card: edit-on-click, drag-to-reorder, add step, delete step
  _wirePlanCard(card) {
    const stepsContainer = card.querySelector('.navio-plan-steps');

    // ── Wire all existing steps ─────────────────────────────────────────
    card.querySelectorAll('.navio-plan-step').forEach(step => this._wirePlanStep(step));

    // ── Drag-to-reorder ─────────────────────────────────────────────────
    let dragSrc = null;

    const onDragStart = (e) => {
      dragSrc = e.currentTarget;
      dragSrc.classList.add('navio-plan-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    };
    const onDragEnd = (e) => {
      e.currentTarget.classList.remove('navio-plan-dragging');
      stepsContainer.querySelectorAll('.navio-plan-step').forEach(s => s.classList.remove('navio-plan-drag-over'));
      this._renumberPlan(card);
    };
    const onDragOver = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.currentTarget;
      if (target === dragSrc) return;
      stepsContainer.querySelectorAll('.navio-plan-step').forEach(s => s.classList.remove('navio-plan-drag-over'));
      target.classList.add('navio-plan-drag-over');
    };
    const onDrop = (e) => {
      e.preventDefault();
      const target = e.currentTarget;
      if (!dragSrc || target === dragSrc) return;
      target.classList.remove('navio-plan-drag-over');
      const steps = Array.from(stepsContainer.querySelectorAll('.navio-plan-step'));
      const srcIdx = steps.indexOf(dragSrc);
      const tgtIdx = steps.indexOf(target);
      if (srcIdx < tgtIdx) {
        target.after(dragSrc);
      } else {
        target.before(dragSrc);
      }
      this._renumberPlan(card);
    };

    const wireStepDrag = (step) => {
      step.setAttribute('draggable', 'true');
      step.addEventListener('dragstart', onDragStart);
      step.addEventListener('dragend', onDragEnd);
      step.addEventListener('dragover', onDragOver);
      step.addEventListener('drop', onDrop);
    };
    card.querySelectorAll('.navio-plan-step').forEach(wireStepDrag);

    // ── Delete step ─────────────────────────────────────────────────────
    const wireDeleteBtn = (step) => {
      const btn = step.querySelector('.navio-plan-del');
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        step.remove();
        this._renumberPlan(card);
      });
    };
    card.querySelectorAll('.navio-plan-step').forEach(wireDeleteBtn);

    // ── Add step ────────────────────────────────────────────────────────
    const addBtn = card.querySelector('.navio-plan-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const newStep = document.createElement('div');
        newStep.className = 'navio-plan-step';
        newStep.setAttribute('draggable', 'true');
        newStep.innerHTML = `
          <span class="navio-plan-drag" title="Drag to reorder">
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/></svg>
          </span>
          <span class="navio-plan-num">?</span>
          <span class="navio-plan-text navio-plan-empty" style="color:var(--text-tertiary)">New step — click to edit</span>
          <button class="navio-plan-del" title="Remove step" type="button">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>`;
        stepsContainer.appendChild(newStep);
        this._renumberPlan(card);
        wireStepDrag(newStep);
        wireDeleteBtn(newStep);
        this._wirePlanStep(newStep);
        // Auto-open edit on the new step's text
        setTimeout(() => newStep.querySelector('.navio-plan-text')?.click(), 30);
      });
    }

    const runAgentBtn = card.querySelector('.navio-plan-run-agent');
    if (runAgentBtn) {
      runAgentBtn.addEventListener('click', () => this._runAgentPlanFromCard(card));
    }
  }

  _parsePlanStepLine(text) {
    const raw = (text || '').trim();
    if (!raw) return null;
    const t = raw.toLowerCase();
    if (/\bgo\s+back\b|^back$/.test(t)) return { action: 'goBack', params: {} };
    if (/\bgo\s+forward\b|^forward$/.test(t)) return { action: 'goForward', params: {} };
    if (/\bscroll\s+up\b|\bup\b/.test(t) && !/\bscroll\s+down\b/.test(t)) {
      return { action: 'scroll', params: { direction: 'up' } };
    }
    if (/\bscroll\b|\bdown\b/.test(t)) {
      return { action: 'scroll', params: { direction: 'down' } };
    }
    const sec = t.match(/wait\s*(?:for\s*)?(\d+)\s*(?:s|sec|secs|seconds)\b/);
    if (sec) return { action: 'wait', params: { ms: Math.min(60000, parseInt(sec[1], 10) * 1000) } };
    const ms = t.match(/wait\s*(?:for\s*)?(\d+)\s*(?:ms)?\b/);
    if (ms) return { action: 'wait', params: { ms: Math.min(60000, parseInt(ms[1], 10)) } };
    if (/\bwait\b|pause|sleep/.test(t)) return { action: 'wait', params: { ms: 800 } };
    return null;
  }

  async _runAgentPlanFromCard(card) {
    const texts = Array.from(card.querySelectorAll('.navio-plan-text'))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    const steps = [];
    for (const line of texts) {
      const a = this._parsePlanStepLine(line);
      if (a) steps.push(a);
    }
    const prog = card.querySelector('.navio-plan-agent-progress');
    const showProg = (msg) => {
      if (!prog) return;
      prog.hidden = false;
      prog.textContent = msg;
    };
    if (!steps.length) {
      showProg('No runnable steps — describe steps using scroll, go back, go forward, or wait.');
      if (typeof _showAppToast === 'function') {
        _showAppToast('Add steps like “Scroll down” or “Wait 2 seconds”.', 'warning');
      }
      return;
    }
    const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    if (!wv || typeof wv.getWebContentsId !== 'function') {
      showProg('No active page.');
      return;
    }
    const webContentsId = wv.getWebContentsId();
    showProg('Running…');
    try {
      const r = await window.navio.agentRunPlan({
        webContentsId,
        steps,
        userConfirmed: true
      });
      if (!r.ok) {
        showProg(`Stopped: ${r.error || 'error'}`);
        return;
      }
      const lines = (r.results || []).map((x, i) => `${i + 1}. ${x.action}${x.error ? ' — ' + x.error : ' ✓'}`);
      showProg(lines.join('\n') || 'Done.');
    } catch (e) {
      showProg(String(e.message || e));
    }
  }

  async _wireActions(contentEl) {
    // ── Gmail draft cards — bundle multiple drafts in one reply for scanning ─
    const draftCards = [...contentEl.querySelectorAll('.gmail-draft-card')];
    if (draftCards.length > 1) {
      const first = draftCards[0];
      const parent = first.parentNode;
      if (parent) {
        const bundle = document.createElement('div');
        bundle.className = 'gmail-drafts-bundle';
        bundle.innerHTML =
          '<div class="gdb-head">' +
          '<span class="gdb-title">Reply drafts</span>' +
          `<span class="gdb-count">${draftCards.length}</span>` +
          '</div>';
        parent.insertBefore(bundle, first);
        draftCards.forEach((c, i) => {
          const pill = c.querySelector('.gdc-draft-pill');
          if (pill) {
            pill.textContent = `${i + 1} / ${draftCards.length}`;
            pill.hidden = false;
          }
          bundle.appendChild(c);
        });
      }
    }

    // ── Gmail draft cards ─────────────────────────────────────────────────
    contentEl.querySelectorAll('.gmail-draft-card').forEach(card => {
      const draftId = card.dataset.draftId;
      const textarea = card.querySelector('.gdc-body');
      const bodyWrap = card.querySelector('.gdc-body-wrap');
      if (textarea) textarea.dataset.initialBody = textarea.value;

      card.querySelector('.gdc-copy')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        try {
          await navigator.clipboard.writeText(textarea.value);
          const prev = btn.innerHTML;
          btn.innerHTML =
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Copied';
          setTimeout(() => { btn.innerHTML = prev; }, 1600);
        } catch { /* ignore */ }
      });

      card.querySelector('.gdc-open')?.addEventListener('click', () => {
        const url = 'https://mail.google.com/mail/u/0/#drafts';
        if (typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
          TabManager.createTab(url);
        } else {
          window.open(url, '_blank');
        }
      });

      const toggleBtn = card.querySelector('.gdc-toggle');
      toggleBtn?.addEventListener('click', () => {
        if (!bodyWrap) return;
        const collapsed = bodyWrap.classList.toggle('gdc-body-wrap--collapsed');
        toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggleBtn.textContent = collapsed ? 'Full view' : 'Compact';
      });

      // Edit — toggle textarea editable; sync to Gmail when leaving edit mode
      card.querySelector('.gdc-btn-edit')?.addEventListener('click', async () => {
        const isEditing = !textarea.readOnly;
        if (isEditing) {
          const body = textarea.value;
          const initial = textarea.dataset.initialBody ?? '';
          const editBtn = card.querySelector('.gdc-btn-edit');
          if (body !== initial && draftId && typeof window.navio.gmailUpdateDraft === 'function') {
            if (editBtn) {
              editBtn.disabled = true;
              editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>Saving…';
            }
            try {
              const up = await window.navio.gmailUpdateDraft({ draftId, body });
              if (up?.error) {
                if (typeof _showAppToast === 'function') _showAppToast(up.error, 'error');
              } else {
                textarea.dataset.initialBody = body;
                if (typeof _showAppToast === 'function') {
                  _showAppToast('Draft updated in Gmail', 'success');
                }
              }
            } catch { /* ignore */ }
            if (editBtn) editBtn.disabled = false;
          }
          textarea.readOnly = true;
          if (editBtn) {
            editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Edit';
          }
          card.classList.remove('gdc-editing');
        } else {
          textarea.readOnly = false;
          textarea.focus();
          card.querySelector('.gdc-btn-edit').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>Done';
          card.classList.add('gdc-editing');
        }
      });

      // Send — sync edited body to Gmail before sending
      card.querySelector('.gdc-btn-send')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!draftId) { btn.textContent = '⚠ No draft ID'; return; }
        btn.disabled = true;
        const body = textarea.value;
        const initial = textarea.dataset.initialBody ?? '';
        const needsSync = body !== initial && typeof window.navio.gmailUpdateDraft === 'function';
        try {
          if (needsSync) {
            btn.textContent = 'Saving…';
            const up = await window.navio.gmailUpdateDraft({ draftId, body });
            if (up?.error) {
              btn.disabled = false;
              btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send';
              if (typeof _showAppToast === 'function') {
                _showAppToast(up.error, 'error');
              }
              return;
            }
            textarea.dataset.initialBody = body;
          }
          btn.textContent = 'Sending…';
          const result = await window.navio.gmailSendDraft(draftId);
          if (result?.success) {
            card.classList.add('gdc-sent');
            const badge = card.querySelector('.gdc-badge');
            if (badge) badge.textContent = 'Sent';
            card.querySelector('.gdc-actions').innerHTML = '<span class="gdc-status-sent"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>Sent</span>';
          } else {
            btn.disabled = false;
            btn.textContent = '⚠ Failed';
            setTimeout(() => { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Send'; }, 2000);
          }
        } catch {
          btn.disabled = false;
          btn.textContent = '⚠ Error';
        }
      });

      // Keep — collapse body, show "saved in Drafts" state
      card.querySelector('.gdc-btn-keep')?.addEventListener('click', () => {
        card.classList.add('gdc-kept');
        const badge = card.querySelector('.gdc-badge');
        if (badge) badge.textContent = 'In Drafts';
        card.querySelector('.gdc-actions').innerHTML = '<span class="gdc-status-kept"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v14a2 2 0 0 1-2 2z"/></svg>Saved in Drafts</span>';
      });

      // Discard
      card.querySelector('.gdc-btn-discard')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Deleting…';
        try {
          if (draftId) await window.navio.gmailDeleteDraft(draftId);
          card.classList.add('gdc-discarded');
          const badge = card.querySelector('.gdc-badge');
          if (badge) badge.textContent = 'Discarded';
          card.querySelector('.gdc-actions').innerHTML = '<span class="gdc-status-discarded">Discarded</span>';
        } catch { btn.disabled = false; btn.textContent = 'Discard'; }
      });
    });

    // ── All <a> links in messages open as new browser tabs ────────────────
    contentEl.querySelectorAll('a[href]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.getAttribute('href');
        if (!url) return;
        if (typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
          TabManager.createTab(url);
        } else {
          window.open(url, '_blank');
        }
      });
    });

    // ── Wire email reference chips (new tab on click; hover shows snippet + full body when available) ──
    const _ectEsc = (s) =>
      String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const _ectPositionTip = (tip, chip) => {
      const chipRect = chip.getBoundingClientRect();
      const tipH = tip.offsetHeight;
      const tipW = tip.offsetWidth;
      let top = chipRect.top - tipH - 8;
      let left = chipRect.left;
      if (top < 8) top = chipRect.bottom + 8;
      if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
      if (left < 8) left = 8;
      tip.style.top = top + 'px';
      tip.style.left = left + 'px';
    };

    contentEl.querySelectorAll('.email-ref-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const msgId = (chip.dataset.msgId || '').trim();
        let uSlot = chip.dataset.gmailU;
        if (uSlot === undefined || uSlot === '') {
          uSlot = '0';
        }
        const isSecond = uSlot === '1' || uSlot === 1;
        if (
          isSecond &&
          typeof ConnectorsManager !== 'undefined' &&
          ConnectorsManager.connectedIds &&
          typeof ConnectorsManager.connectedIds.has === 'function' &&
          !ConnectorsManager.connectedIds.has('gmail_2')
        ) {
          if (typeof _showAppToast === 'function') {
            _showAppToast(
              'That message is from your second Gmail slot. Connect **Gmail (2nd account)** in Settings → Connectors, then click again.',
              'warning'
            );
          }
          return;
        }
        let authEmail = msgId && this._emailRefs?.get ? this._emailRefs.get(msgId)?.authEmail : '';
        if (msgId && (!authEmail || !String(authEmail).includes('@'))) {
          try {
            const oauthSt = (await window.navio.oauthStatus()) || {};
            authEmail = isSecond ? oauthSt.google_2?.email : oauthSt.google?.email;
          } catch {
            /* ignore */
          }
        }
        const openUrl = msgId
          ? this._gmailWebInboxUrl(msgId, isSecond ? 1 : 0, authEmail)
          : (chip.dataset.url || '').trim();
        if (!openUrl) return;
        if (typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
          TabManager.createTab(openUrl);
        } else {
          window.open(openUrl, '_blank');
        }
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.click(); }
      });

      chip.addEventListener('mouseenter', () => {
        const mid = (chip.dataset.msgId || '').trim();
        const from = chip.dataset.from || '';
        const snippet = chip.dataset.snippet || '';
        document.getElementById('email-chip-tooltip')?.remove();

        const tip = document.createElement('div');
        tip.id = 'email-chip-tooltip';
        tip.className = 'email-chip-tooltip';
        if (from) {
          tip.innerHTML += `<div class="ect-from"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>${_ectEsc(from)}</span></div>`;
        }
        if (snippet) {
          tip.innerHTML += `<div class="ect-snippet">${_ectEsc(snippet)}</div>`;
        }

        const bodySlot = document.createElement('div');
        bodySlot.className = 'ect-body-slot';
        tip.appendChild(bodySlot);

        if (mid && typeof window.navio?.gmailGetMessageBody === 'function') {
          const cached = this._emailBodyCache.get(mid);
          const uSlot = chip.dataset.gmailU;
          const svcId = uSlot === '1' || uSlot === 1 ? 'gmail_2' : 'gmail';
          const cacheKey = svcId + ':' + mid;
          const cachedScoped = this._emailBodyCache.get(cacheKey);
          const useCache = cachedScoped || cached;
          if (useCache) {
            bodySlot.innerHTML = `<div class="ect-body">${_ectEsc(useCache.slice(0, 12000))}</div>`;
          } else {
            bodySlot.innerHTML = '<div class="ect-body-loading">Loading full message…</div>';
            const gen = Date.now();
            chip._emailTipGen = gen;
            window.navio.gmailGetMessageBody({ id: mid, serviceId: svcId }).then((res) => {
              if (chip._emailTipGen !== gen || !document.body.contains(tip)) return;
              if (res?.error) {
                bodySlot.innerHTML = `<div class="ect-snippet ect-muted">${_ectEsc(res.error)}</div>`;
              } else {
                const body = (res?.body || '').trim();
                if (body) {
                  this._emailBodyCache.set(cacheKey, body);
                  this._emailBodyCache.set(mid, body);
                }
                const show = body || (res?.snippet || '').trim();
                bodySlot.innerHTML = show
                  ? `<div class="ect-body">${_ectEsc(show.slice(0, 12000))}</div>`
                  : '<div class="ect-snippet ect-muted">No plain-text body for this message.</div>';
              }
              requestAnimationFrame(() => {
                if (document.body.contains(tip)) {
                  _ectPositionTip(tip, chip);
                }
              });
            }).catch(() => {
              if (chip._emailTipGen !== gen || !document.body.contains(tip)) return;
              bodySlot.innerHTML = '<div class="ect-snippet ect-muted">Could not load message body.</div>';
            });
          }
        } else if (mid) {
          bodySlot.innerHTML =
            '<div class="ect-snippet ect-muted">Connect Gmail to load the full message body on hover.</div>';
        } else if (!from && !snippet) {
          bodySlot.innerHTML =
            '<div class="ect-snippet ect-muted">Click to open in Gmail.</div>';
        }

        document.body.appendChild(tip);
        chip._tooltip = tip;
        requestAnimationFrame(() => {
          _ectPositionTip(tip, chip);
          tip.classList.add('ect-visible');
        });
      });
      chip.addEventListener('mouseleave', () => {
        chip._emailTipGen = 0;
        chip._tooltip?.remove();
        delete chip._tooltip;
      });
    });

    // ── Wire plan cards ──────────────────────────────────────────────────
    contentEl.querySelectorAll('.navio-plan-card').forEach(card => this._wirePlanCard(card));

    // Wire task chain approval gates
    contentEl.querySelectorAll('.tca-approve').forEach(btn => {
      btn.addEventListener('click', () => {
        const gate = btn.closest('.tc-approval-gate');
        if (gate) { gate.innerHTML = '<span style="color:var(--text-accent)">Running...</span>'; }
        this.approveTaskStep(btn.dataset.aid);
      });
    });
    contentEl.querySelectorAll('.tca-skip').forEach(btn => {
      btn.addEventListener('click', () => {
        const gate = btn.closest('.tc-approval-gate');
        if (gate) { gate.innerHTML = '<span style="color:var(--text-secondary)">Skipped</span>'; }
        this.skipTaskStep();
      });
    });

    const cards = Array.from(contentEl.querySelectorAll('.browser-action-card'));
    if (!cards.length) return;

    // Check if auto-execute is enabled in settings
    let autoExecute = false;
    try {
      const cfg = await window.navio.getConfig();
      autoExecute = !!cfg.aiAutoExecute;
    } catch { /* ignore — fall back to manual */ }

    if (this._takeoverMode || autoExecute) {
      // Takeover already active or auto-execute setting is on — run immediately
      if (!this._takeoverMode) this.enableTakeover();
      cards.forEach((card) => {
        const btns = card.querySelector('.bac-btns');
        if (btns) btns.innerHTML = '<span class="bac-status bac-pending">Queued…</span>';
      });
      this._executeTakeover(contentEl);
      return;
    }

    // Manual mode — individual Run / Skip / Edit buttons
    // Helper: open inline edit for a card
    const openEdit = (card, action) => {
      if (card.classList.contains('bac-done') || card.classList.contains('bac-error') || card.classList.contains('bac-editing')) return;
      card.classList.add('bac-editing');
      const currentParams = card.dataset.params;
      const descEl = card.querySelector('.bac-desc');
      const btnsEl = card.querySelector('.bac-btns');
      const oldDescHTML = descEl.innerHTML;
      const oldBtnsHTML = btnsEl.innerHTML;

      descEl.innerHTML = `<input class="bac-edit-input" type="text" value="${currentParams.replace(/"/g,'&quot;')}" spellcheck="false">`;
      btnsEl.innerHTML = `<button class="bac-edit-save" type="button">Save</button><button class="bac-edit-cancel" type="button">Cancel</button>`;
      const input = descEl.querySelector('.bac-edit-input');
      input.focus();
      input.select();

      const closeEdit = (saveNew) => {
        card.classList.remove('bac-editing');
        if (saveNew) {
          const newParams = input.value.trim();
          if (newParams) card.dataset.params = newParams;
        }
        descEl.innerHTML = oldDescHTML;
        btnsEl.innerHTML = oldBtnsHTML;
        // Update param display tag
        if (saveNew) {
          const paramTag = card.querySelector('.bac-param');
          if (paramTag) {
            let display = card.dataset.params;
            if (action === 'navigate') {
              try {
                const u = new URL(display);
                display = u.hostname + (u.pathname !== '/' ? u.pathname : '') + (u.search ? '…' : '');
                display = display.replace(/^www\./, '');
              } catch (_) {}
            }
            paramTag.textContent = display;
            paramTag.title = card.dataset.params;
          }
        }
        // Re-wire buttons
        wireCard(card, action);
      };

      btnsEl.querySelector('.bac-edit-save').addEventListener('click', () => closeEdit(true));
      btnsEl.querySelector('.bac-edit-cancel').addEventListener('click', () => closeEdit(false));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') closeEdit(true);
        if (e.key === 'Escape') closeEdit(false);
      });
    };

    const wireCard = (card, action) => {
      // Remove old listeners by cloning and replacing button nodes
      const rewire = (sel, fn) => {
        const el = card.querySelector(sel);
        if (!el) return;
        const fresh = el.cloneNode(true);
        el.replaceWith(fresh);
        fresh.addEventListener('click', fn);
      };
      rewire('.bac-run', () => this._executeAction(action, card.dataset.params, card, false));
      rewire('.bac-skip', () => {
        card.classList.add('bac-skipped');
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status">Skipped</span>';
      });
      rewire('.bac-edit', () => openEdit(card, action));
      // Clicking the param chip also opens edit
      const paramTag = card.querySelector('.bac-param');
      if (paramTag) {
        const fresh = paramTag.cloneNode(true);
        paramTag.replaceWith(fresh);
        fresh.addEventListener('click', () => openEdit(card, action));
      }
    };

    cards.forEach((card) => {
      wireCard(card, card.dataset.action);
    });

    // Single "Let Navio handle this" button at the bottom of the message
    const allowBtn = document.createElement('button');
    allowBtn.className = 'navio-allow-btn';
    allowBtn.type = 'button';
    allowBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      Let Navio handle this automatically`;
    allowBtn.addEventListener('click', () => {
      allowBtn.remove();
      // Re-mark all pending cards as queued
      cards.forEach((card) => {
        if (!card.classList.contains('bac-done') && !card.classList.contains('bac-skipped') && !card.classList.contains('bac-error')) {
          const btns = card.querySelector('.bac-btns');
          if (btns) btns.innerHTML = '<span class="bac-status bac-pending">Queued…</span>';
        }
      });
      this.enableTakeover();
      this._executeTakeover(contentEl);
    });
    contentEl.appendChild(allowBtn);
  }

  async _executeTakeover(contentEl) {
    const cards = Array.from(
      contentEl.querySelectorAll('.browser-action-card:not(.bac-done):not(.bac-skipped):not(.bac-error)')
    );
    let completedAll = true;
    for (const card of cards) {
      if (!this._takeoverMode || this._takeoverAbort?.signal.aborted) break;
      await this._executeAction(card.dataset.action, card.dataset.params, card, true);
      if (card.classList.contains('bac-error')) {
        completedAll = false;
        break;
      }
      if (!this._takeoverMode || this._takeoverAbort?.signal.aborted) break;
      let stepMode = false;
      try {
        const cfg = await window.navio.getConfig();
        stepMode = !!cfg.aiAgentStepMode;
      } catch {
        /* ignore */
      }
      if (stepMode) await this._waitStepContinueOrStop();
      if (!this._takeoverMode) break;
      const gap = card.dataset.action === 'navigate' ? 400 : 600;
      if (this._takeoverMode) await new Promise((r) => setTimeout(r, gap));
    }
    if (this._takeoverMode && !this._takeoverAbort?.signal.aborted && completedAll) {
      this._showSaveWorkflowOffer(contentEl);
    }
    if (this._takeoverMode && !this._takeoverAbort?.signal.aborted) {
      setTimeout(() => this._smartFollowUp(), 1000);
    }
  }

  _waitStepContinueOrStop() {
    return new Promise((resolve) => {
      document.getElementById('navio-step-pause-pill')?.remove();
      const pill = document.createElement('div');
      pill.id = 'navio-step-pause-pill';
      pill.className = 'navio-step-pause-pill';
      pill.innerHTML =
        '<span>Step paused</span>' +
        '<button type="button" class="nsp-continue">Continue</button>' +
        '<button type="button" class="nsp-stop">Stop</button>';
      const finish = () => {
        pill.remove();
        resolve();
      };
      pill.querySelector('.nsp-continue').addEventListener('click', finish);
      pill.querySelector('.nsp-stop').addEventListener('click', () => {
        this.disableTakeover();
        finish();
      });
      this.messagesEl.appendChild(pill);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  async _undoLastNavigation() {
    try {
      const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
      if (!wv) {
        this._addContinuePill('No active tab to go back in.');
        return;
      }
      await window.navio.browserAction({
        webContentsId: wv.getWebContentsId(),
        action: 'goBack',
        params: {},
        userConfirmed: true
      });
      this._addContinuePill('Went back one page.');
    } catch (e) {
      this._addContinuePill('Could not go back: ' + (e.message || String(e)));
    }
  }

  async _executeAction(action, paramsStr, card, fromTakeover = false) {
    const btns = card.querySelector('.bac-btns');
    if (btns) btns.innerHTML = '<span class="bac-status bac-running">Running…</span>';

    if (action === 'gmailCreateReplyDraft') {
      let payload;
      try {
        const raw = (paramsStr || '').replace(/\s/g, '');
        payload = JSON.parse(atob(raw));
      } catch (e) {
        card.classList.add('bac-error');
        if (btns) btns.innerHTML = '<span class="bac-status">Invalid draft data</span>';
        if (fromTakeover) this._pushAgentLog('gmailCreateReplyDraft', 'invalid data', false);
        return;
      }
      try {
        const result = await window.navio.gmailCreateReplyDraft({
          messageId: payload.id,
          body: payload.body || ''
        });
        if (result && result.success) {
          card.classList.add('bac-done');
          if (fromTakeover) this._pushAgentLog('gmailCreateReplyDraft', 'draft saved', true);
          if (btns) {
            btns.innerHTML =
              '<span class="bac-status bac-ok"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>Gmail draft</span>';
          }
          if (!fromTakeover) {
            const msgEl = card.closest('.message');
            const pending = msgEl
              ? msgEl.querySelectorAll('.browser-action-card:not(.bac-done):not(.bac-skipped):not(.bac-error)')
                  .length
              : 0;
            if (pending === 0) setTimeout(() => this._smartFollowUp(), 1800);
          }
        } else {
          card.classList.add('bac-error');
          if (btns) btns.innerHTML = `<span class="bac-status">${result?.error || 'Failed'}</span>`;
          if (fromTakeover) this._pushAgentLog('gmailCreateReplyDraft', result?.error || 'failed', false);
        }
      } catch (err) {
        card.classList.add('bac-error');
        if (btns) btns.innerHTML = `<span class="bac-status">${err.message || 'Error'}</span>`;
        if (fromTakeover) this._pushAgentLog('gmailCreateReplyDraft', err.message || 'error', false);
      }
      return;
    }

    const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    if (!wv) {
      card.classList.add('bac-error');
      if (btns) btns.innerHTML = '<span class="bac-status">No active tab</span>';
      return;
    }

    // ── Navigate: use TabManager.navigateActive() in the renderer ─────────────
    // This correctly hides the Navio new-tab overlay and updates all tab state.
    // Going through the main-process IPC only calls wc.loadURL() which bypasses
    // the overlay-hide logic, leaving the NTP visible on top of the loaded page.
    if (action === 'navigate') {
      try {
        const url = paramsStr;
        if (!TabManager || typeof TabManager.navigateForAgentAndWaitForLoad !== 'function') {
          throw new Error('TabManager unavailable');
        }
        const loadResult = await TabManager.navigateForAgentAndWaitForLoad(url, {
          timeoutMs: 12000,
          settleMs: 600
        });
        if (!loadResult.ok) throw new Error(loadResult.error || 'Navigation failed');

        const wvAfter =
          TabManager.getBrowserTargetWebview?.() || TabManager.getActiveWebview();

        let finalUrl = '';
        try {
          const pg = await TabManager.getActivePageContent();
          finalUrl = pg?.url || '';
        } catch {
          /* ignore */
        }
        if (!finalUrl) {
          const tab = TabManager.getAgentControlledTab?.() || TabManager.getActiveTab();
          finalUrl = tab?.url || '';
        }
        if (fromTakeover && NAVIO_AUTH_GATE_URL_RE.test(finalUrl)) {
          let host = 'this site';
          try {
            host = new URL(finalUrl).hostname;
          } catch {
            /* ignore */
          }
          await new Promise((resolve) => {
            this._takeoverAuthResume = resolve;
            this._showAuthGatePill(host);
          });
          this._takeoverAuthResume = null;
        }

        if (fromTakeover && this._takeoverMode) this._syncTakeoverTabHighlight();

        card.classList.add('bac-done');
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-ok"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>Done</span>';

        if (fromTakeover) this._pushAgentLog('navigate', finalUrl || paramsStr || 'ok', true);

        await this._maybeAutoScreenshotTakeover(wvAfter || wv);

        if (!fromTakeover) {
          const msgEl = card.closest('.message');
          const pending = msgEl
            ? msgEl.querySelectorAll('.browser-action-card:not(.bac-done):not(.bac-skipped):not(.bac-error)').length
            : 0;
          if (pending === 0) setTimeout(() => this._smartFollowUp(), 1800);
        }
      } catch (err) {
        card.classList.add('bac-error');
        card.querySelector('.bac-btns').innerHTML = `<span class="bac-status"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ${err.message || 'Navigation error'}</span>`;
        if (fromTakeover) this._pushAgentLog('navigate', err.message || 'error', false);
      }
      return;
    }

    // ── All other actions: go through main-process IPC ────────────────────────
    try {
      const webContentsId = wv.getWebContentsId();
      let params = {};
      if (action === 'click') {
        params = { selector: paramsStr };
      } else if (action === 'type') {
        const colonIdx = paramsStr.indexOf(':');
        params = colonIdx >= 0
          ? { selector: paramsStr.slice(0, colonIdx), text: paramsStr.slice(colonIdx + 1) }
          : { selector: paramsStr, text: '' };
      } else if (action === 'insertText') {
        // paramsStr IS the full content (may be multi-line)
        params = { text: paramsStr };
      } else if (action === 'pressKey') {
        params = { key: paramsStr };
      } else if (action === 'scroll') {
        params = { direction: paramsStr || 'down' };
      } else if (action === 'screenshot') {
        params = {};
      } else if (action === 'wait') {
        params = { ms: parseInt(paramsStr, 10) || 500 };
      } else if (action === 'waitForText') {
        params = { text: paramsStr };
      } else if (action === 'select') {
        const pipe = (paramsStr || '').indexOf('|');
        if (pipe < 0) {
          card.classList.add('bac-error');
          if (btns) btns.innerHTML = '<span class="bac-status">select: use field|option</span>';
          if (fromTakeover) this._pushAgentLog('select', 'bad format', false);
          return;
        }
        params = {
          selector: paramsStr.slice(0, pipe).trim(),
          option: paramsStr.slice(pipe + 1).trim()
        };
      } else if (action === 'appendText') {
        params = { text: paramsStr };
      }
      const result = await window.navio.browserAction({ webContentsId, action, params, userConfirmed: true });
      if (result && result.success) {
        if (action === 'screenshot' && result.screenshot) {
          this._pendingScreenshotDataUrl = result.screenshot;
        }
        card.classList.add('bac-done');
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-ok"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>Done</span>';
        if (fromTakeover) {
          this._pushAgentLog(action, (paramsStr || '').slice(0, 100), true);
          if (action !== 'screenshot' && action !== 'wait') {
            await this._maybeAutoScreenshotTakeover(wv);
          }
        }
        if (!fromTakeover) {
          const msgEl = card.closest('.message');
          const pending = msgEl
            ? msgEl.querySelectorAll('.browser-action-card:not(.bac-done):not(.bac-skipped):not(.bac-error)').length
            : 0;
          if (pending === 0) setTimeout(() => this._smartFollowUp(), 1800);
        }
      } else {
        card.classList.add('bac-error');
        card.querySelector('.bac-btns').innerHTML = `<span class="bac-status">${result?.error || 'Failed'}</span>`;
        if (fromTakeover) this._pushAgentLog(action, result?.error || 'failed', false);
      }
    } catch (err) {
      card.classList.add('bac-error');
      card.querySelector('.bac-btns').innerHTML = `<span class="bac-status">${err.message || 'Error'}</span>`;
      if (fromTakeover) this._pushAgentLog(action, err.message || 'error', false);
    }
  }

  async _smartFollowUp() {
    const MAX_AUTO_STEPS = 35;
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if ((aid && this._tabIsBusy(aid)) || this._autoFollowCount >= MAX_AUTO_STEPS) {
      if (this._autoFollowCount >= MAX_AUTO_STEPS) {
        this._addContinuePill('Reached step limit. Tell me what to do next.');
        this._autoFollowCount = 0;
        if (this._takeoverMode) this.disableTakeover();
      }
      return;
    }
    this._autoFollowCount++;

    await new Promise((r) => setTimeout(r, 700));

    let pageInfo = '';
    try {
      const page = await TabManager.getActivePageContent();
      if (page && !page.error) {
        pageInfo = `Title: ${page.title}\nURL: ${page.url}\n\nPage content:\n${(page.text || '').slice(0, 20000)}`;
      }
    } catch { /* ignore */ }

    if (!pageInfo) {
      this._addContinuePill('Could not read page — tell me what to do next.');
      return;
    }

    this._addContinuePill('↻ Reading page…');

    // Append accessibility snapshot so AI uses real element labels, not guessed selectors
    const snapText = await this._getPageSnapshotText();

    // Detect Google editor pages so we can give a targeted directive
    let pageUrl = '';
    try { pageUrl = (await TabManager.getActivePageContent())?.url || ''; } catch { /* ignore */ }
    const isGoogleDoc   = /docs\.google\.com\/document/.test(pageUrl);
    const isGoogleSheet = /docs\.google\.com\/spreadsheets/.test(pageUrl);
    const googleEditorDirective = (isGoogleDoc || isGoogleSheet)
      ? `\n\n⚠️ GOOGLE EDITOR DETECTED — CRITICAL INSTRUCTION:\nYou are on a ${isGoogleDoc ? 'Google Doc' : 'Google Sheet'} page. The editor is ready.\nDO NOT output a <navio-plan> or a description. DO NOT say "I will paste" or "I'll now paste".\nYOU MUST output a <navio-actions> block RIGHT NOW with the insertText: action containing the FULL content.\nInclude every section, detail, price, and itinerary you found earlier in the conversation.\nThe content goes directly after "insertText:" on the same or following lines.\nIf you have already composed the content, output it. If not, generate it now from what you know.\nDo it. Don't plan it.`
      : '';

    // Detect developer console / setup pages so AI fills forms confidently
    const isDevConsolePage = /console\.cloud\.google\.com|portal\.azure\.com|github\.com\/settings\/applications|dropbox\.com\/developers|api\.slack\.com\/apps|notion\.so\/my-integrations|developers\.notion\.com|learn\.microsoft\.com.*entra|developers\.google\.com/.test(pageUrl);
    const isOfficialDocsPage = /developers\.google\.com|learn\.microsoft\.com|docs\.github\.com|dropbox\.com\/developers\/documentation|api\.slack\.com\/start|developers\.notion\.com/.test(pageUrl);
    const devConsoleDirective = isDevConsolePage
      ? `\n\n⚠️ DEVELOPER CONSOLE PAGE DETECTED:\nYou are on a developer console or configuration page. Your job is to fill in the required fields and complete this step of the setup.\n- USE the page snapshot elements below to find exact field labels, button text, and aria-labels\n- FILL every visible required field using type:text=LABEL:VALUE — do not ask permission, just do it\n- For dropdowns: click the dropdown first, then click the option\n- For radio buttons/checkboxes: click:text=OPTION_LABEL\n- After filling all fields on this page, click the Save/Continue/Create/Next button\n- Report what you filled in and what button you clicked\n- If a required field label differs from what you expected, use the snapshot to find the real label`
      : isOfficialDocsPage
        ? `\n\n📄 OFFICIAL DOCUMENTATION PAGE DETECTED:\nYou are reading official documentation. Extract the current, correct steps from this page.\nLook for numbered steps, setup instructions, or configuration requirements.\nAfter reading, output the complete verified steps to the user, then begin executing them.`
        : '';

    const setupContinuationRule = (isDevConsolePage || isOfficialDocsPage)
      ? `\n\nSETUP TASK — VERIFY THEN CONTINUE (MANDATORY):
1. VERIFY: Look at the page content above. Did the previous action actually succeed?
   - API enabling: Is the "Enable" button gone? Does the page show a management dashboard or "Disable" button? → ✓ done. Does the page still show "Enable"? → retry.
   - API enabling follow-up: Does the page now show a "Create credentials" prompt? → that is REQUIRED next — do it before moving on.
   - Form save: Does the page show a confirmation banner, advance to next step, or show "Saved"? → ✓ done. Still on the same form with no change? → check for errors, fix, resubmit.
   - Credential creation: Is a Client ID or App Key string now visible on the page? → ✓ EXTRACT IT and tell the user immediately.
   - OAuth consent screen step: Did the page advance to the next wizard section? → ✓ done.
2. IF VERIFIED: Do NOT write a summary. Do NOT pause. IMMEDIATELY output the next <navio-actions> block for the next step.
3. IF NOT VERIFIED: Report exactly what you see, what you expected, and retry or ask.
4. NEVER stop between steps unless you hit a genuine blocker (error, CAPTCHA, unexpected page).
5. The task is NOT complete until the credential is pasted into Navio Settings and the user can connect.`
      : '';

    // If the conversation involves email/Gmail, re-enable connector context on follow-ups
    const emailConversation = this._currentHistory().some(m =>
      /\b(email|gmail|mail|inbox|unreplied|unanswered)\b/i.test(m.content || '')
    );
    const isQuickActionFollowUp = !emailConversation;

    const followUpText = `[Action completed. Current page state follows.

IMPORTANT AGENT RULES:
- If this is a price/deal/flight/hotel/product research page: EXTRACT all visible prices, options, and dates from the page text above. List them clearly. Do NOT just say "I found results" — show the actual data.
- If multiple options are visible, rank them by price and identify the cheapest with a clear callout.
- If the data looks incomplete or the page didn't fully load, navigate to the same URL again or try an alternate source.
- If steps remain in the plan, continue executing them. If all steps are done, give a final summary with the best option found and why.
- NEVER make up prices or results — only report what is actually in the page text above.
- If you were asked about emails (e.g. unreplied, unread, recent), check if the Gmail data shows ALL results or if there are more. If more, tell the user the total and offer to load more.
${googleEditorDirective}${devConsoleDirective}${setupContinuationRule}

${pageInfo}${snapText}`;
    await this.processMessage(followUpText, isQuickActionFollowUp, null);
    document.getElementById('navio-continue-pill')?.remove();
    // _wireActions (called inside processMessage → addMessage) now handles auto-execution
    // in both takeover mode and auto-execute mode, so no extra _executeTakeover call needed here.
  }

  async _getPageSnapshotText() {
    try {
      const wv =
        typeof TabManager !== 'undefined'
          ? TabManager.getBrowserTargetWebview?.() || TabManager.getActiveWebview()
          : null;
      if (!wv) return '';
      const snap = await window.navio.pageSnapshot(wv.getWebContentsId());
      if (!snap || snap.error || !snap.elements?.length) return '';
      const lines = snap.elements.map(e => `  [${e.role}] "${e.label}" → ${e.selector}`);
      return `\n\n[Page elements — use text= or aria= to reference these]\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  /**
   * Returns true if the AI used "ACTION0"/"ACTION1" style labels instead of
   * real [[ACTION:type:params]] tokens.
   */
  _hasBrokenActionFormat(text) {
    if (/\[\[ACTION:\w+:[\s\S]*?\]\]/.test(text)) return false;
    return /\bACTION[\s_]?\d\b/i.test(text);
  }

  /**
   * If the response has broken action labels, automatically retry (up to 2 times)
   * by sending a corrective system message so the model fixes its own output.
   * On the third failure shows a manual error banner instead of retrying infinitely.
   */
  _checkAndShowActionFormatWarning(responseText, msgEl) {
    if (!this._hasBrokenActionFormat(responseText)) return false;

    const MAX_AUTO_RETRIES = 2;
    if ((this._actionFormatRetries || 0) >= MAX_AUTO_RETRIES) {
      // Give up auto-retrying — show a manual error
      const warn = document.createElement('div');
      warn.className = 'navio-action-format-warn';
      warn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>The AI model kept using an invalid action format. Try rephrasing your request or switching to a more capable model.</span>`;
      if (msgEl) msgEl.appendChild(warn);
      else this.messagesEl.appendChild(warn);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this._actionFormatRetries = 0;
      return true;
    }

    this._actionFormatRetries = (this._actionFormatRetries || 0) + 1;

    // Show a small "fixing…" pill then auto-correct
    const pill = document.createElement('div');
    pill.className = 'navio-continue-pill';
    pill.textContent = '↻ Fixing action format automatically…';
    this.messagesEl.appendChild(pill);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    setTimeout(async () => {
      pill.remove();
      const fixPrompt = '[SYSTEM FIX: Your previous response used "ACTION0", "ACTION1" etc. as plain-text labels — those are invalid placeholders that Navio cannot execute. You MUST rewrite your entire response and replace every ACTION placeholder with a real [[ACTION:type:params]] token. Examples: [[ACTION:navigate:https://www.youtube.com/results?search_query=latest+news]] or [[ACTION:click:text=first video]]. Write the full response again now using ONLY [[ACTION:type:params]] tokens for every browser step. Do NOT use ACTION0, ACTION1, numbered labels, or any other placeholder format.]';
      await this.processMessage(fixPrompt, true, null);
    }, 600);

    return true;
  }

  _addContinuePill(text) {
    document.getElementById('navio-continue-pill')?.remove();
    const pill = document.createElement('div');
    pill.id = 'navio-continue-pill';
    pill.className = 'navio-continue-pill';
    pill.textContent = text;
    this.messagesEl.appendChild(pill);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  showTypingIndicator() {
    if (!this._assistantHistoryDomReplay && !this._panelShowsTurnDom()) return;
    const indicator = document.createElement('div');
    indicator.className = 'message assistant-message typing-indicator-wrap';
    indicator.id = 'typing-indicator';
    indicator.innerHTML = `
      <div class="msg-role-strip msg-role-strip--assistant msg-role-strip--typing">
        <span class="msg-role-label">Navio</span><span class="msg-role-badge" aria-hidden="true">AI</span>
      </div>
      <div class="message-content typing-indicator">
        <span class="typing-indicator-label">Composing</span>
        <span class="typing-dots"><span></span><span></span><span></span></span>
      </div>
    `;
    this.messagesEl.appendChild(indicator);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
  }

  clearChat() {
    this._conversationsByTab.set(this._conversationKey(), []);
    this.setReceipt('');
    this.messagesEl.innerHTML = '';
    this._attachmentsSnapshot = null;
    this._clearAttachmentQueue();
    void this._persistAssistantHistoryNow();
    this._showGreeting();
  }

  // ── Connector Context Injection ─────────────────────────────────────────
  // Detects which connected services are relevant to the user's query,
  // queries them, and returns a formatted system context block.

  /**
   * When two Google accounts are connected, route connector Gmail queries by email substring in the user text.
   */
  _pickGmailConnectorServiceId(text, oauthSt) {
    const hasPrimary = !!(oauthSt && oauthSt.google && oauthSt.google.email);
    const hasSec = !!(oauthSt && oauthSt.google_2 && oauthSt.google_2.email);
    if (!hasSec) return 'gmail';
    if (!hasPrimary) return 'gmail_2';
    const low = text.toLowerCase();
    const tryMatch = (email, svc) => {
      if (!email) return null;
      const e = email.toLowerCase();
      if (e.length >= 3 && low.includes(e)) return svc;
      const local = e.split('@')[0] || '';
      if (local.length >= 2 && low.includes(local)) return svc;
      return null;
    };
    return (
      tryMatch(oauthSt.google_2.email, 'gmail_2') ||
      tryMatch(oauthSt.google.email, 'gmail') ||
      'gmail'
    );
  }

  /**
   * Which Gmail connector id(s) to prefetch: both when two accounts exist and the text
   * does not clearly name one mailbox; otherwise one side.
   */
  _gmailConnectorPrefetchServices(text, oauthSt, has) {
    const pri = has('gmail');
    const sec = has('gmail_2');
    if (!pri && !sec) return [];
    if (!sec) return ['gmail'];
    if (!pri) return ['gmail_2'];
    const low = (text || '').toLowerCase();
    const hit = (email) => {
      const e = (email || '').toLowerCase();
      if (!e) return false;
      if (low.includes(e)) return true;
      const loc = e.split('@')[0] || '';
      return loc.length >= 2 && low.includes(loc);
    };
    const g1 = oauthSt.google?.email || '';
    const g2 = oauthSt.google_2?.email || '';
    const h1 = hit(g1);
    const h2 = hit(g2);
    if (h2 && !h1) return ['gmail_2'];
    if (h1 && !h2) return ['gmail'];
    if (h1 && h2) return [this._pickGmailConnectorServiceId(text, oauthSt)];
    return ['gmail', 'gmail_2'];
  }

  async _buildConnectorContext(text, opts = {}) {
    const webMode = opts.webMode || 'auto';
    const mailMode = opts.mailMode || 'auto';
    try {
      let oauthSt = {};
      try {
        oauthSt = (await window.navio.oauthStatus()) || {};
      } catch {
        oauthSt = {};
      }

      const oauthGoogle = navioOAuthSlotActive(oauthSt.google);
      const oauthGoogle2 = navioOAuthSlotActive(oauthSt.google_2);
      const oauthMicrosoft = navioOAuthSlotActive(oauthSt.microsoft);

      const connected = ConnectorsManager.getConnectedIntegrations();
      const connectedIdSet = new Set(connected.map((c) => c.id));

      const has = (id) => {
        if (connectedIdSet.has(id)) return true;
        if (id === 'gmail' && oauthGoogle) return true;
        if (id === 'gmail_2' && oauthGoogle2) return true;
        if (id === 'gdrive' && oauthGoogle) return true;
        if (id === 'gcalendar' && oauthGoogle) return true;
        if (id === 'outlook' && oauthMicrosoft) return true;
        if (id === 'onedrive' && oauthMicrosoft) return true;
        return false;
      };

      if (!connected.length && !oauthGoogle && !oauthGoogle2 && !oauthMicrosoft) {
        return null;
      }

      // Fresh refs per user turn so subject enrichment only matches this query's messages.
      this._emailRefs.clear();
      this._pendingConnectorCitations = null;

      const results = [];

      // Helper: extract a clean search term from the user query
      const clean = (pattern) => text.replace(pattern, '').replace(/\b(my|the|search|find|in|from|about|show|list|all|open|get|what|are|is|any)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

      // ── Perplexity (real-time web search) ──────────────────────────────
      if (webMode !== 'never' && has('perplexity')) {
        const webSearchIntentAuto =
          /\b(search|look up|find out|latest|news|current|today|recent|on the web|from the web|web results|online|lookup|cite|verify|fact\s*check|browse\s+online|perplexity)\b/i.test(text) ||
          /\bwhat\s+(is|are|was|were)\s+the\s+(latest|news|weather|price|stock|rate|situation|meaning|definition)\b/i.test(text);
        const webSearchIntent =
          webMode === 'always' || (webMode === 'auto' && webSearchIntentAuto);
        if (webSearchIntent) {
          try {
            const res = await ConnectorsManager.queryConnector('perplexity', text);
            if (res?.answer) {
              if (Array.isArray(res.citations) && res.citations.length) {
                this._pendingConnectorCitations = res.citations.slice(0, 12);
              }
              results.push(
                `[Perplexity Web Search]\n${res.answer.slice(0, 1400)}${res.citations?.length ? `\n\nWeb sources: ${res.citations.slice(0, 4).join(', ')}` : ''}`
              );
            }
          } catch (_) {}
        }
      }

      // ── Gmail ──────────────────────────────────────────────────────────
      let gmailIntent = navioMailContextActiveForTurn(text, () => this._currentHistory());
      if (mailMode === 'never') gmailIntent = false;
      // "Mail: always" used to prefetch on every message — that matched non-mail questions. Intent must still be mail-like.
      const gmailApiConnected = has('gmail') || has('gmail_2');
      if (gmailApiConnected && gmailIntent && oauthGoogle && oauthGoogle2 && oauthSt?.google?.email && oauthSt?.google_2?.email) {
        results.push(
          `[Two Gmail API accounts: **${oauthSt.google.email}** (primary) and **${oauthSt.google_2.email}** (secondary). ` +
            `When the user's wording does not name one address, this prefetch includes **both** inboxes below. Agent tools use **google_account** primary|secondary.]`
        );
      }
      if (gmailApiConnected && gmailIntent) {
        const prefetchSvcs = this._gmailConnectorPrefetchServices(text, oauthSt, has);
        const wantsUnread = /\bunread\b/i.test(text);
        const wantsUnreplied =
          /\b(unreplied|unanswered|didn.?t\s*(respond|reply)|not\s*(respond|replied|reply)|no\s*response|pending\s*(reply|response)|haven.?t\s*(respond|replied|reply)|need\s*to\s*(respond|reply)|need\s+a\s*reply|needs?\s+replies?|that\s+need(s)?\s+(a\s+)?reply|still\s+.*\b(reply|respond)|awaiting\s+(a\s+)?response|waiting\s+for\s+(a\s+)?reply|follow.?up)\b/i.test(
            text
          );
        const wantsDraftReplies =
          /\b(draft|drafts)\b/i.test(text) &&
          /\b(reply|replies|respond)\b/i.test(text) &&
          /\b(email|gmail|mail|inbox|message|notification)\b/i.test(text);
        const wantsSent = /\b(sent|outbox|i\s*sent|my\s*sent)\b/i.test(text);
        const wantsAllInbox =
          /\b(all|every|everything|entire|full|whole)\s+(of\s+)?(my\s+)?(inbox|e-?mails?|mail|messages?)\b/i.test(text) ||
          /\b(my\s+)?(inbox|mail)\b.*\b(all|everything|full)\b/i.test(text);

        const _gmailFragmentOk = (s) => {
          if (!s || s.length < 2 || s.length > 72) return false;
          if (/[.!?(){}"'`[\]]/.test(s)) return false;
          const tokens = s.trim().split(/\s+/).filter(Boolean);
          if (tokens.length > 5) return false;
          if (/^(from|to|subject|label|in|is|category|newer_than|older_than|has|filename|after|before):/i.test(s.trim())) return true;
          if (tokens.length <= 3) return true;
          return /^[\w@+./-]+(\s+[\w@+./-]+){0,4}$/i.test(s);
        };

        // Date range detection
        let dateFilter = '';
        const weekMatch = text.match(/(\d+)\s*weeks?\b/i) || text.match(/past\s*(\d+)\s*weeks?\b/i);
        const dayMatch = text.match(/(\d+)\s*days?\b/i) || text.match(/past\s*(\d+)\s*days?\b/i);
        const monthMatch = text.match(/(\d+)\s*months?\b/i) || text.match(/past\s*(\d+)\s*months?\b/i);
        if (weekMatch) {
          dateFilter = `newer_than:${parseInt(weekMatch[1]) * 7}d`;
        } else if (dayMatch) {
          dateFilter = `newer_than:${parseInt(dayMatch[1])}d`;
        } else if (monthMatch) {
          dateFilter = `newer_than:${parseInt(monthMatch[1]) * 30}d`;
        } else if (/\b(past\s*(1|one|a)\s*week|this\s*week|last\s*week)\b/i.test(text)) {
          dateFilter = 'newer_than:7d';
        } else if (/\b(past\s*(2|two)\s*weeks?|couple\s*weeks?)\b/i.test(text)) {
          dateFilter = 'newer_than:14d';
        } else if (/\b(recent|lately|recently)\b/i.test(text)) {
          dateFilter = 'newer_than:14d';
        }
        // Sensible default window so vague "how's my inbox" doesn't scan years of mail.
        if (!dateFilter && !wantsSent) {
          dateFilter = 'newer_than:14d';
        }

        const rawQ = clean(/\b(email|gmail|mail|inbox|message|sent|unread|thread|respond|replied|reply|unreplied|unanswered|pending|follow.?up|recent|check|week|weeks|day|days|month|months|past|last|the|how|many|did|i|get|that|didn.?t|haven.?t|not|to|in|my|a|1|2|3)\b/gi);
        const safeExtra = _gmailFragmentOk(rawQ) ? rawQ : '';

        let gmailQuery;
        let fetchCount = 25;

        if (wantsUnreplied) {
          gmailQuery = `in:inbox -from:me ${dateFilter} ${safeExtra}`.replace(/\s+/g, ' ').trim();
          fetchCount = 50;
        } else if (wantsDraftReplies && !/\bunread\b/i.test(text)) {
          // Reply triage without an explicit "unread" ask — incoming threads you didn't start.
          gmailQuery = `in:inbox -from:me ${dateFilter} ${safeExtra}`.replace(/\s+/g, ' ').trim();
          fetchCount = 50;
        } else if (wantsSent) {
          gmailQuery = `in:sent ${dateFilter} ${safeExtra}`.replace(/\s+/g, ' ').trim();
        } else if (wantsAllInbox) {
          gmailQuery = `in:inbox ${dateFilter} ${safeExtra}`.replace(/\s+/g, ' ').trim();
          fetchCount = 40;
        } else if (wantsUnread || (wantsDraftReplies && /\bunread\b/i.test(text))) {
          gmailQuery = `in:inbox is:unread ${dateFilter} ${safeExtra}`.replace(/\s+/g, ' ').trim();
          fetchCount = wantsDraftReplies ? 50 : 25;
        } else if (safeExtra.length > 2) {
          gmailQuery = `in:inbox is:unread ${dateFilter} ${safeExtra}`.replace(/\s+/g, ' ').trim();
        } else {
          // Default: what people mean by "check my mail" — unread in inbox, recent window.
          gmailQuery = `in:inbox is:unread ${dateFilter}`.replace(/\s+/g, ' ').trim();
        }

        const dualPrefetch = prefetchSvcs.length > 1;
        const emailPriPrefetch = oauthSt.google?.email;
        const emailSecPrefetch = oauthSt.google_2?.email;
        for (const activeGmailSvc of prefetchSvcs) {
          if (!has(activeGmailSvc)) continue;
          const gmailLabel = activeGmailSvc === 'gmail_2' ? 'Gmail (2nd account)' : 'Gmail';
          try {
            const res = await ConnectorsManager.queryConnector(activeGmailSvc, gmailQuery, {
              maxResults: fetchCount,
              pages: fetchCount > 25 ? 2 : 1
            });
            if (res?.error) {
              results.push(`[${gmailLabel} connector error: ${res.error}]`);
            } else if (res?.results?.length) {
              const gSlot = activeGmailSvc === 'gmail_2' ? 1 : 0;
              const authEmailPrefetch = gSlot === 1 ? emailSecPrefetch : emailPriPrefetch;
              const lines = res.results.map((r, idx) => {
                const gmailUrl = r.id ? this._gmailWebInboxUrl(r.id, gSlot, authEmailPrefetch) : '';
                if (r.id) {
                  this._emailRefs.set(r.id, {
                    subject: r.subject || '(no subject)',
                    from: r.from || '',
                    snippet: r.snippet || '',
                    url: gmailUrl,
                    serviceId: activeGmailSvc,
                    gmailUSlot: gSlot,
                    authEmail: authEmailPrefetch || undefined
                  });
                }
                const snippet = r.snippet ? `\n  "${r.snippet.slice(0, 150)}"` : '';
                const dateStr = r.date ? ` · ${r.date}` : '';
                const num = `${idx + 1}.`;
                return gmailUrl
                  ? `${num} [${r.subject || '(no subject)'}](${gmailUrl}) — From: ${r.from || '?'}${dateStr}${snippet}`
                  : `${num} From: ${r.from || '?'} · Subject: ${r.subject || '(no subject)'}${dateStr}${snippet}`;
              }).join('\n');
              if (!dualPrefetch) {
                this._lastGmailPageToken = res.nextPageToken || null;
                this._lastGmailQuery = gmailQuery;
                this._lastGmailServiceId = activeGmailSvc;
              }
              const totalInfo = res.total > res.results.length
                ? ` (showing ${res.results.length} of ~${res.total} total)`
                : '';
              results.push(`[${gmailLabel} — ${res.results.length} result(s) for "${gmailQuery}"${totalInfo}]\n${lines}${res.nextPageToken ? '\n\n(More results available — user can ask to "load more" or "show more emails")' : ''}`);
            } else {
              results.push(`[${gmailLabel} — 0 results for "${gmailQuery}"]`);
            }
          } catch (_) {}
        }
        if (dualPrefetch) {
          this._lastGmailPageToken = null;
          this._lastGmailQuery = gmailQuery;
          this._lastGmailServiceId = 'gmail';
        }
      }

      // ── Gmail "load more" / continuation ────────────────────────────────
      const wantsMore = /\b(more|next|continue|load more|show more|rest of|remaining)\b/i.test(text)
        && /\b(email|mail|gmail|result|inbox)\b/i.test(text);
      const moreSvc = this._lastGmailServiceId || 'gmail';
      if (gmailApiConnected && has(moreSvc === 'gmail_2' ? 'gmail_2' : 'gmail') && wantsMore && this._lastGmailPageToken && !gmailIntent) {
        try {
          const res = await ConnectorsManager.queryConnector(moreSvc, this._lastGmailQuery, {
            maxResults: 25,
            pageToken: this._lastGmailPageToken,
            pages: 1
          });
          if (res?.results?.length) {
            const moreLabel = moreSvc === 'gmail_2' ? 'Gmail (2nd account)' : 'Gmail';
            const moreSlot = moreSvc === 'gmail_2' ? 1 : 0;
            const authEmailMore = moreSlot === 1 ? oauthSt.google_2?.email : oauthSt.google?.email;
            const lines = res.results.map((r, idx) => {
              const gmailUrl = r.id ? this._gmailWebInboxUrl(r.id, moreSlot, authEmailMore) : '';
              if (r.id) {
                this._emailRefs.set(r.id, {
                  subject: r.subject || '(no subject)',
                  from: r.from || '',
                  snippet: r.snippet || '',
                  url: gmailUrl,
                  serviceId: moreSvc,
                  gmailUSlot: moreSlot,
                  authEmail: authEmailMore || undefined
                });
              }
              const snippet = r.snippet ? `\n  "${r.snippet.slice(0, 150)}"` : '';
              const dateStr = r.date ? ` · ${r.date}` : '';
              return `${idx + 1}. [${r.subject || '(no subject)'}](${gmailUrl}) — From: ${r.from || '?'}${dateStr}${snippet}`;
            }).join('\n');
            this._lastGmailPageToken = res.nextPageToken || null;
            results.push(`[${moreLabel} — next ${res.results.length} result(s)]\n${lines}${res.nextPageToken ? '\n\n(Still more available)' : '\n\n(End of results)'}`);
          }
        } catch (_) {}
      }

      // ── Outlook ────────────────────────────────────────────────────────
      const outlookExplicit =
        /\boutlook|hotmail|live\.com|office\s*365|microsoft\s*365|exchange\b/i.test(text);
      const outlookMailIntent =
        has('outlook') &&
        (outlookExplicit || (!(has('gmail') || has('gmail_2')) && navioMailContextActiveForTurn(text, () => this._currentHistory())));
      if (outlookMailIntent) {
        const wantsUnreadOutlook = /\bunread\b/i.test(text);
        const rawOutlookQ = clean(/\b(outlook|email|mail|inbox|message)\b/gi);
        // Build Outlook search — default to unread inbox when no specific terms
        const outlookQuery = rawOutlookQ.length > 2 ? rawOutlookQ
          : wantsUnreadOutlook ? 'isRead:false' : 'isRead:false';
        try {
          const res = await ConnectorsManager.queryConnector('outlook', outlookQuery, { top: 10 });
          if (res?.error) {
            results.push(`[Outlook connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => {
              const unreadFlag = r.isRead === false ? ' [unread]' : '';
              return `- From: ${r.from || '?'} · Subject: ${r.subject || '(no subject)'}${unreadFlag}`;
            }).join('\n');
            results.push(`[Outlook — ${res.total} result(s)]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Google Drive ───────────────────────────────────────────────────
      const driveIntent =
        /\b(google\s*drive|gdrive|googledocs|google\s*docs|drive\.google\.com)\b/i.test(text) ||
        /\b(on|in)\s+my\s+drive\b/i.test(text) ||
        /\b(search|find|look\s+for|list|show)\b[\s\S]{0,120}\b(google\s*drive|drive|gdrive)\b/i.test(text) ||
        /\b(google\s*drive|drive|gdrive)\b[\s\S]{0,120}\b(search|find|look\s+for|list)\b/i.test(text) ||
        /\b(what|show|list|find|where)\b[\s\S]{0,48}\b(drive|docs|sheets|slides)\b/i.test(text) ||
        (/\b(sheets?|slides?|spreadsheet|presentation)\b/i.test(text) &&
          /\b(in|on|from)\s+(my\s+)?(google\s+)?drive\b/i.test(text));
      if (has('gdrive') && driveIntent) {
        const driveClean = (t) =>
          t
            .replace(
              /\b(google\s*drive|gdrive|googledocs|google\s*docs|drive|file|document|doc|sheet|spreadsheet|slide|folder|my\s+files|search|searches|find|look|for|in|from|the|a|an|on|my|can|you|please|could|would|something|anything|list|show|get|what|are|is|there|any|named|called)\b/gi,
              ' '
            )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        let q = driveClean(text);
        if (!q || q.length < 2) q = '__NAVIO_RECENT__';
        try {
          const res = await ConnectorsManager.queryConnector('gdrive', q, { pageSize: 15 });
          if (res?.error) {
            results.push(`[Google Drive connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const label = q === '__NAVIO_RECENT__' ? 'recent (last modified)' : q;
            const lines = res.results
              .map((r) => {
                const kind = r.type ? ` [${String(r.type).replace('application/vnd.google-apps.', '')}]` : '';
                return r.url ? `- [${r.name}](${r.url})${kind}` : `- ${r.name}${kind}`;
              })
              .join('\n');
            results.push(`[Google Drive — ${res.total} file(s) — ${label}]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Dropbox ────────────────────────────────────────────────────────
      const dropboxIntent =
        /\b(dropbox|dbx)\b/i.test(text) ||
        (/\b(file|document|folder)\b/i.test(text) && /\b(in|on|from)\s+dropbox\b/i.test(text));
      if (has('dropbox') && dropboxIntent && !has('gdrive')) {
        let q = clean(/\b(dropbox|dbx|file|document|folder)\b/gi);
        if (!q || q.length < 2) q = '*';
        try {
          const res = await ConnectorsManager.queryConnector('dropbox', q, { maxResults: 8 });
          if (res?.error) {
            results.push(`[Dropbox connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- ${r.name}${r.path ? ` (${r.path})` : ''}`).join('\n');
            results.push(`[Dropbox — ${res.total} file(s) — ${q === '*' ? 'broad search' : q}]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── OneDrive ───────────────────────────────────────────────────────
      const onedriveIntent =
        /\b(onedrive|o365|sharepoint|microsoft\s*drive)\b/i.test(text) ||
        (/\b(file|document|folder)\b/i.test(text) && /\b(in|on)\s+(onedrive|sharepoint)\b/i.test(text));
      if (has('onedrive') && onedriveIntent) {
        let q = clean(/\b(onedrive|file|document|folder|sharepoint|microsoft\s*drive)\b/gi);
        if (!q || q.length < 2) q = '*';
        try {
          const res = await ConnectorsManager.queryConnector('onedrive', q, { top: 8 });
          if (res?.error) {
            results.push(`[OneDrive connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- ${r.name}${r.type ? ` [${r.type}]` : ''}`).join('\n');
            results.push(`[OneDrive — ${res.total} file(s) — ${q === '*' ? 'broad search' : q}]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Slack ──────────────────────────────────────────────────────────
      const slackIntent =
        /\b(slack)\b/i.test(text) ||
        (/\b(channel|dm|direct\s*message|mention)\b/i.test(text) && /\b(on|in)\s+slack\b/i.test(text)) ||
        /\b(what|show|find|catch\s*up|miss)\b[\s\S]{0,40}\b(slack|channel)\b/i.test(text);
      if (has('slack') && slackIntent) {
        let q = clean(/\b(slack|channel|message|chat|dm|mention)\b/gi);
        if (!q || q.length < 2) q = '*';
        try {
          const res = await ConnectorsManager.queryConnector('slack', q, { count: 6 });
          if (res?.error) {
            results.push(`[Slack connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- #${r.channel || '?'} (${r.user || '?'}): "${r.text.slice(0, 120)}"`).join('\n');
            results.push(`[Slack — ${res.total} message(s) — ${q === '*' ? 'broad' : q}]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Google Calendar ────────────────────────────────────────────────
      const calendarIntent =
        /\b(calendar|meeting|event|schedule|appointment|agenda|busy|free|booked)\b/i.test(text) ||
        (/\b(today|tomorrow|this\s*week|next\s*week|upcoming)\b/i.test(text) &&
          /\b(when|what|am\s+i|do\s+i\s+have|anything)\b/i.test(text));
      if (has('gcalendar') && calendarIntent) {
        const q = clean(/\b(calendar|meeting|event|schedule|appointment|agenda)\b/gi) || 'events';
        try {
          const res = await ConnectorsManager.queryConnector('gcalendar', q);
          if (res?.error) {
            results.push(`[Google Calendar connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- ${r.title} — ${r.start ? new Date(r.start).toLocaleString() : '?'}${r.location ? ` @ ${r.location}` : ''}`).join('\n');
            results.push(`[Google Calendar — ${res.total} upcoming event(s)]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Notion ─────────────────────────────────────────────────────────
      const notionIntent =
        /\b(notion)\b/i.test(text) ||
        (/\b(note|page|wiki|workspace)\b/i.test(text) && /\b(in|on)\s+notion\b/i.test(text)) ||
        /\b(what|show|find|list)\b[\s\S]{0,40}\b(notion|my\s+notes)\b/i.test(text);
      if (has('notion') && notionIntent) {
        let q = clean(/\b(notion|note|page|wiki|knowledge|workspace)\b/gi);
        if (!q || q.length < 2) q = '';
        try {
          const res = await ConnectorsManager.queryConnector('notion', q, { pageSize: 6 });
          if (res?.error) {
            results.push(`[Notion connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- ${r.title}${r.type ? ` (${r.type})` : ''}`).join('\n');
            results.push(`[Notion — ${res.total} result(s)${q ? ` for "${q}"` : ' (recent)'}]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── GitHub ─────────────────────────────────────────────────────────
      const githubIntent =
        /\b(github|gh)\b/i.test(text) ||
        /\b(issue|issues|pull\s*request|repo|repository)\b/i.test(text) ||
        (/\b(bug|triage)\b/i.test(text) && /\b(on|in)\s+github\b/i.test(text));
      if (has('github') && githubIntent) {
        let q = clean(/\b(github|gh|issue|issues|pull request|repo|repository|pr\b)\b/gi);
        if (!q || q.length < 2) q = 'is:open';
        try {
          const res = await ConnectorsManager.queryConnector('github', q, { type: 'issues', perPage: 6 });
          if (res?.error) {
            results.push(`[GitHub connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- [#${r.number || '?'}] ${r.title} (${r.state || 'unknown'})${r.repo ? ` in ${r.repo}` : ''}`).join('\n');
            results.push(`[GitHub — ${res.total} result(s) for "${q}"]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Linear ─────────────────────────────────────────────────────────
      const linearIntent =
        /\b(linear)\b/i.test(text) ||
        (/\b(ticket|sprint|backlog)\b/i.test(text) && /\b(in|on)\s+linear\b/i.test(text)) ||
        /\b(what|show)\b[\s\S]{0,32}\b(issues?|tasks?|linear)\b/i.test(text);
      if (has('linear') && linearIntent) {
        let q = clean(/\b(linear|ticket|task|sprint|backlog|milestone)\b/gi);
        if (!q || q.length < 2) q = 'assignee:me';
        try {
          const res = await ConnectorsManager.queryConnector('linear', q);
          if (res?.error) {
            results.push(`[Linear connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r) => `- ${r.title} [${r.state || 'unknown'}]${r.team ? ` · ${r.team}` : ''}`).join('\n');
            results.push(`[Linear — ${res.total} result(s) for "${q}"]\n${lines}`);
          }
        } catch (_) {}
      }

      if (results.length === 0) return null;
      return `[Connected integrations returned the following context. Cite the source in your answer (e.g. "According to Gmail…", "In Google Drive…")]\n\n${results.join('\n\n')}`;
    } catch (e) {
      return null;
    }
  }

  // ── Task Chains (Agentic Workflows) ──────────────────────────────────────
  // Allows user to define a multi-step task plan that gets executed step-by-step
  // with approval gates between each step.

  startTaskChain(steps) {
    if (!steps || steps.length === 0) return;
    this._taskChain = {
      steps: steps.map((s, i) => ({ id: i, label: s, status: 'pending' })),
      currentStep: 0
    };
    this._renderTaskChainUI();
    this._runNextTaskStep();
  }

  _renderTaskChainUI() {
    const chain = this._taskChain;
    if (!chain) return;

    // Remove existing chain UI
    document.getElementById('navio-task-chain')?.remove();

    const el = document.createElement('div');
    el.id = 'navio-task-chain';
    el.className = 'task-chain';
    el.innerHTML = `
      <div class="tc-header">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        Task Chain
        <button class="tc-cancel" id="tc-cancel-btn" title="Cancel chain">✕</button>
      </div>
      <div class="tc-steps" id="tc-steps-list">
        ${chain.steps.map(s => `
          <div class="tc-step tc-step-${s.status}" id="tc-step-${s.id}">
            <div class="tc-step-icon">${s.status === 'done' ? '✓' : s.status === 'running' ? '⟳' : s.status === 'error' ? '✕' : String(s.id + 1)}</div>
            <div class="tc-step-label">${this._escHtml(s.label)}</div>
          </div>`).join('')}
      </div>
    `;
    document.getElementById('assistant-panel')?.appendChild(el);
    document.getElementById('tc-cancel-btn')?.addEventListener('click', () => this._cancelTaskChain());
  }

  async _runNextTaskStep() {
    const chain = this._taskChain;
    if (!chain) return;
    const step = chain.steps[chain.currentStep];
    if (!step) { this._finishTaskChain(); return; }

    // Mark as running
    step.status = 'running';
    this._updateTaskStepUI(step);

    // Show approval gate message
    const approvalId = `tc-approve-${step.id}`;
    this.addMessage('assistant',
      `**Task ${step.id + 1}/${chain.steps.length}:** ${step.label}\n\n` +
      `[[TASK_APPROVE:${approvalId}]]`
    );
  }

  approveTaskStep(approvalId) {
    const chain = this._taskChain;
    if (!chain) return;
    const step = chain.steps[chain.currentStep];
    if (!step) return;

    // Execute the step via AI
    this.inputEl.value = step.label;
    this.sendMessage().then(() => {
      step.status = 'done';
      this._updateTaskStepUI(step);
      chain.currentStep++;
      if (chain.currentStep < chain.steps.length) {
        setTimeout(() => this._runNextTaskStep(), 500);
      } else {
        this._finishTaskChain();
      }
    }).catch(() => {
      step.status = 'error';
      this._updateTaskStepUI(step);
    });
  }

  skipTaskStep() {
    const chain = this._taskChain;
    if (!chain) return;
    const step = chain.steps[chain.currentStep];
    if (step) { step.status = 'skipped'; this._updateTaskStepUI(step); }
    chain.currentStep++;
    if (chain.currentStep < chain.steps.length) this._runNextTaskStep();
    else this._finishTaskChain();
  }

  _finishTaskChain() {
    this.addMessage('assistant', '**Task chain complete!** All steps have been executed.');
    this._taskChain = null;
    setTimeout(() => document.getElementById('navio-task-chain')?.remove(), 3000);
  }

  _cancelTaskChain() {
    this._taskChain = null;
    document.getElementById('navio-task-chain')?.remove();
    this.addMessage('assistant', 'Task chain cancelled.');
  }

  _updateTaskStepUI(step) {
    const el = document.getElementById(`tc-step-${step.id}`);
    if (!el) return;
    el.className = `tc-step tc-step-${step.status}`;
    const icon = el.querySelector('.tc-step-icon');
    if (icon) icon.textContent = step.status === 'done' ? '✓' : step.status === 'running' ? '⟳' : step.status === 'error' ? '✕' : step.status === 'skipped' ? '–' : String(step.id + 1);
  }

  _escHtml(t) {
    return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

const AssistantManager = new AssistantManagerClass();

/** DevTools / emergency: `__navioToggleAssistant()` if the toolbar shortcut fails. */
if (typeof window !== 'undefined') {
  window.__navioToggleAssistant = () => {
    navioAssistantDebug('__navioToggleAssistant() invoked (from DevTools/console)');
    AssistantManager.toggle();
  };
}
