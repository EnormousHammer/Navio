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
  // "Send / write / draft email to Musa" (no @) — must run Gmail search + disambiguate, not guess one address.
  const mCompose = s.match(/\b(send|write|compose|draft)\s+(an?\s+)?(e-?)?mail\s+to\s+(\S+)/i);
  if (mCompose) {
    const tok = (mCompose[4] || '').trim();
    if (tok && !tok.includes('@')) return true;
  }
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
  // Use intent router when available (richer patterns)
  if (typeof NavioIntentRouter !== 'undefined') {
    const r = NavioIntentRouter.classifyIntent(text);
    if (r.activeIntents.includes('drive') || r.activeIntents.includes('calendar') ||
        r.activeIntents.includes('gmail_thread') || r.activeIntents.includes('gmail_attach')) {
      return true;
    }
  }
  return (
    /\b(gdrive|google drive|google calendar|google doc|google sheet|google slides|google meet|gcal)\b/.test(s) ||
    /drive\.google\.|docs\.google\.|sheets\.google|slides\.google|calendar\.google/.test(s) ||
    /\b(my\s+calendar|calendar\s+event|meeting\s+invite|drive\s+folder|file\s+in\s+drive|spreadsheet\s+in\s+drive)\b/.test(s) ||
    /\b(pickup\s+schedule|schedule\s+(a\s+)?pickup|book\s+(a\s+)?pickup)\b/i.test(s) ||
    /\b(full\s+thread|full\s+email\s+chain|read\s+(the\s+)?attachment|email\s+attachment)\b/i.test(s)
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

/** First token after "… mail to " when user names a person without an email address (for tighter prompts). */
function navioMailComposeRecipientToken(text) {
  const s = (text || '').trim();
  const m = s.match(/\b(send|write|compose|draft)\s+(an?\s+)?(e-?)?mail\s+to\s+(\S+)/i);
  if (!m) return null;
  const tok = (m[4] || '').trim();
  if (!tok || tok.includes('@')) return null;
  return tok;
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
/** Silence after speech before we treat the utterance as finished (Whisper VAD + Web Speech debounce). ~2.8s allows natural mid-sentence pauses. */
const NAVIO_VOICE_END_SILENCE_MS = 2800;
/** After OpenAI TTS (or speech) ends in voice conversation, reopen the mic after this delay. */
const NAVIO_VOICE_CONV_AFTER_TTS_MS = 200;
/** Voice-conversation TTS: first chunk target size (chars) — smaller first request = faster time-to-first-audio. */
const NAVIO_VOICE_TTS_FIRST_CHUNK = 320;
/** Voice-conversation TTS: max chars per subsequent chunk (pipelined while previous plays). */
const NAVIO_VOICE_TTS_CHUNK_MAX = 520;

/**
 * Split assistant speech into chunks at natural breaks for low-latency TTS playback.
 * @param {string} text
 * @param {number} maxChunk
 * @returns {string[]}
 */
function navioSplitTtsChunks(text, maxChunk) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length <= maxChunk) return [t];
  const chunks = [];
  let rest = t;
  while (rest.length) {
    if (rest.length <= maxChunk) {
      chunks.push(rest);
      break;
    }
    const slice = rest.slice(0, maxChunk);
    let breakEnd = -1;
    const tryDelim = (d) => {
      const idx = slice.lastIndexOf(d);
      if (idx > breakEnd) breakEnd = idx + d.length;
    };
    tryDelim('. ');
    tryDelim('? ');
    tryDelim('! ');
    if (breakEnd < maxChunk * 0.22) tryDelim('; ');
    if (breakEnd < maxChunk * 0.18) {
      const nl = slice.lastIndexOf('\n');
      if (nl >= maxChunk * 0.2) breakEnd = nl + 1;
    }
    if (breakEnd < maxChunk * 0.12) {
      const sp = slice.lastIndexOf(' ');
      if (sp > 48) breakEnd = sp + 1;
    }
    if (breakEnd < 32) breakEnd = maxChunk;
    const piece = rest.slice(0, breakEnd).trim();
    if (!piece) {
      chunks.push(rest.slice(0, maxChunk).trim());
      rest = rest.slice(maxChunk).trim();
      continue;
    }
    chunks.push(piece);
    rest = rest.slice(breakEnd).trim();
  }
  return chunks.filter(Boolean);
}

/**
 * Build a TTS chunk list for voice conversation: aggressive first chunk, larger follow-ups.
 * @param {string} text
 * @returns {string[]}
 */
function navioVoiceConvTtsChunkPlan(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const rough = navioSplitTtsChunks(t, NAVIO_VOICE_TTS_CHUNK_MAX);
  const firstSeg = rough[0] || t;
  if (firstSeg.length <= NAVIO_VOICE_TTS_FIRST_CHUNK) return rough;
  const sub = navioSplitTtsChunks(firstSeg, NAVIO_VOICE_TTS_FIRST_CHUNK);
  return sub.length ? [...sub, ...rough.slice(1)] : rough;
}

/** Ellipses after ? / ! so TTS takes a short breath before the next clause (voice mode). */
function navioAddSpokenBreathingPauses(s) {
  const t = String(s || '').trim();
  if (!t) return t;
  return t.replace(/([!?])\s+(?=[A-Z0-9"'(\[])/g, '$1 … ');
}
/** Non-text files: send as base64 for models that accept inline bytes (Gemini, etc.). */
const NAVIO_ASSISTANT_INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** Unknown extensions: try UTF-8 decode when under this size (code, configs, odd MIME). */
const NAVIO_ASSISTANT_HEURISTIC_TEXT_MAX_BYTES = 768 * 1024;

/** Fallback storage key when no tab is active (edge cases only). Never written to disk as v2 byKey. */
const NAVIO_PROFILE_CHAT_KEY = '__profile__';
/** Saved sidebar threads (Comet-style); persisted under `byKey` with this prefix. */
const NAVIO_SIDEBAR_THREAD_PREFIX = 'sb:';

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
    /** When true the takeover loop waits at the next step boundary. */
    this._takeoverPaused = false;
    /** @type {(() => void) | null} Resolves when _resumeTakeover() is called. */
    this._takeoverPausedResolve = null;
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
    /**
     * The web-tab ID that the full-page chat was opened FROM (Comet-style anchoring).
     * While set, the guest chat uses this tab's conversation bucket instead of '__guest__',
     * so the sidebar and the full-page chat share the same history.
     */
    this._guestAnchoredTabId = null;
    /**
     * When set, sidebar transcript + API history use this storage key instead of the active tab
     * (or tab group). Browsing tools still use the focused tab via TabManager.
     */
    this._sidebarThreadKey = null;
    /** @type {Array<{ id: string, title: string, updatedAt: number }>} */
    this._sidebarSessionOrder = [];
    /** When true, `addMessage` always appends (rebuilding history from disk). */
    this._assistantHistoryDomReplay = false;
    /** Dedupe toggle when globalShortcut and guest webview forward both fire. */
    this._lastToggleAt = 0;

    // Minimal placeholder — the authoritative prompt is loaded from
    // navio-system-prompt.txt (or -legacy.txt) and injected by
    // injectSystemPrompt() in main.js before every API call.
    this.systemPrompt = 'You are Navio, an intelligent AI browser assistant.';
    /** Last known Settings → TTS voice; avoids awaiting IPC before every speak. */
    this._cachedTtsVoice = 'nova';

    this.bindEvents();
    this._assistantHistoryLoadPromise = this._loadPersistedChat();
    void this._refreshCachedTtsVoice();
  }

  /** Refresh `_cachedTtsVoice` from disk (fire-and-forget; called at init and after speaking). */
  async _refreshCachedTtsVoice() {
    try {
      const cfg = await window.navio.getConfig();
      if (cfg && cfg.ttsVoice) {
        this._cachedTtsVoice =
          typeof window.navioNormalizeTtsVoiceId === 'function'
            ? window.navioNormalizeTtsVoiceId(cfg.ttsVoice)
            : cfg.ttsVoice;
      }
    } catch {
      /* ignore */
    }
  }

  /** Re-resolve panel if DOM changed or constructor ran before the node existed. */
  _ensurePanel() {
    if (!this.panel) this.panel = document.getElementById('assistant-panel');
    return this.panel;
  }

  /** Autosize sidebar composer; keeps at least two lines when empty (see #assistant-input rows + min-height). */
  _fitAssistantInputHeight() {
    if (!this.inputEl) return;
    const maxPx = 160;
    const cs = getComputedStyle(this.inputEl);
    const fs = parseFloat(cs.fontSize) || 14;
    let linePx = parseFloat(cs.lineHeight);
    if (!Number.isFinite(linePx) || linePx <= 0 || cs.lineHeight === 'normal') linePx = fs * 1.5;
    const minPx = Math.ceil(linePx * 2);
    this.inputEl.style.height = 'auto';
    const sh = this.inputEl.scrollHeight;
    this.inputEl.style.height = Math.min(Math.max(sh, minPx), maxPx) + 'px';
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
    document.getElementById('assistant-session-new')?.addEventListener('click', () => void this._startNewSidebarSession());
    document.getElementById('assistant-session-history-list')?.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-session-delete]');
      const openBtn = e.target.closest('[data-session-open]');
      const tabBtn = e.target.closest('[data-session-this-tab]');
      const hist = document.getElementById('assistant-session-history');
      if (delBtn) {
        e.preventDefault();
        const sid = delBtn.getAttribute('data-session-delete');
        if (sid) void this._deleteSidebarSession(sid);
        return;
      }
      if (openBtn) {
        e.preventDefault();
        const sid = openBtn.getAttribute('data-session-open');
        if (sid) void this._openSidebarSession(sid);
        if (hist) hist.open = false;
        return;
      }
      if (tabBtn) {
        e.preventDefault();
        void this._selectThisTabThread();
        if (hist) hist.open = false;
        return;
      }
      const jumpTab = e.target.closest('[data-session-switch-tab]');
      if (jumpTab) {
        e.preventDefault();
        const tid = jumpTab.getAttribute('data-session-switch-tab');
        if (tid) void this._openTabThreadFromHistory(tid);
        if (hist) hist.open = false;
        return;
      }
    });
    document.getElementById('btn-send-message')?.addEventListener('click', () => this.sendMessage());
    document.getElementById('btn-assistant-stop')?.addEventListener('click', () => this.stopGeneration());
    document.getElementById('btn-tts-stop')?.addEventListener('click', () => this._stopTTSFromBar());
    this._voiceConvActive = false;
    this._voiceConvRec = null;
    /** Bumped on every voice-conversation end so delayed timers / STT callbacks cannot run after stop or across restart. */
    this._vcSid = 0;
    /** Cleared when voice conversation stops. */
    this._voiceConvFlashTimer = null;
    /** Throttle optional spoken tool-progress updates in voice conversation (ms since epoch). */
    this._voiceConvProgressTtsAt = 0;
    this._ttsSessionId = 0;
    this._bindVoiceConversation();

    // ── Macro record button ────────────────────────────────────────────────
    document.getElementById('btn-record-macro')?.addEventListener('click', () => this._toggleRecording());
    this._workflowRecording = false;
    this._recordedSteps = [];

    this.inputEl?.addEventListener('keydown', (e) => {
      // Skip IME composition (Enter confirms Japanese/Chinese input — do not submit early).
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        void this.sendMessage();
      }
    });

    this.inputEl?.addEventListener('input', () => {
      this._fitAssistantInputHeight();
      this._handleAtMention();
    });

    document.querySelectorAll('.quick-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        this.handleQuickAction(action);
      });
    });

    document.querySelectorAll('.assistant-smart-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const prompt = this._smartPromptFor(chip.dataset.smart);
        if (!prompt || !this.inputEl) return;
        this.inputEl.value = prompt;
        this.sendMessage();
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

    window.addEventListener('navio-tabs-changed', () => {
      try {
        this._renderSidebarSessionList();
      } catch {
        /* ignore */
      }
    });
    window.addEventListener('navio-config-saved', () => {
      void this._refreshCachedTtsVoice();
    });

    const pinBtn = document.getElementById('btn-pin-tab');
    if (pinBtn) {
      pinBtn.addEventListener('click', () => this.pinActiveTab());
    }

    document.getElementById('btn-assistant-open-ai-settings')?.addEventListener('click', () => {
      if (typeof SettingsManager !== 'undefined' && typeof SettingsManager.open === 'function') {
        void SettingsManager.open('ai');
      }
    });

    this._bindVoiceMode();
    this._bindAssistantAttachments();
    this._bindTTSDelegate();
    this._fitAssistantInputHeight();
    requestAnimationFrame(() => this._fitAssistantInputHeight());
  }

  /** Delegate TTS button clicks from any assistant bubble. */
  _bindTTSDelegate() {
    if (!this.messagesEl) return;
    this.messagesEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.assistant-tts-btn');
      if (!btn) return;
      const text = btn.dataset.tts || '';
      if (btn.classList.contains('tts-speaking') || btn.classList.contains('tts-loading')) {
        this._stopTTSFromBar();
        btn.classList.remove('tts-speaking', 'tts-loading');
      } else {
        // Stop any other in-progress TTS and clear their states
        this.messagesEl.querySelectorAll('.assistant-tts-btn.tts-speaking, .assistant-tts-btn.tts-loading')
          .forEach(b => b.classList.remove('tts-speaking', 'tts-loading'));
        // Immediate feedback — loading state before API call
        btn.classList.add('tts-loading');
        this._setTTSBarVisible(true, 'Preparing audio…');
        try {
          await this._speakText(text, btn);
        } catch {
          btn.classList.remove('tts-loading', 'tts-speaking');
          this._setTTSBarVisible(false);
        }
      }
    });
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

  _smartPromptFor(kind) {
    const baseContext = 'Use the page open in my active tab as context. Keep the answer concise and actionable.';
    switch (kind) {
      case 'summarize-page':
        return `${baseContext} Give a 3-bullet TL;DR and three concrete next actions I can take.`;
      case 'with-sources':
        return `${baseContext} Answer with citations. If the question needs web context, fetch it and cite sources clearly.`;
      case 'next-actions':
        return `${baseContext} List the top 5 next actions I should take, with short reasons and links if relevant.`;
      default:
        return '';
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

  /**
   * Conversation key for the full-page chat turn.
   * When anchored to a source tab (Comet-style), returns that tab's key so the
   * sidebar and the full-page chat share the same history bucket.
   * Falls back to '__guest__' when no anchor is set.
   */
  _guestConversationKey() {
    if (this._guestAnchoredTabId) {
      return this._storageKeyForTabId(this._guestAnchoredTabId);
    }
    return '__guest__';
  }

  _conversationKey() {
    if (this._sidebarThreadKey) return this._sidebarThreadKey;
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
    // Legacy: unanchored guest turn always shows
    if (turnKey === '__guest__') return true;
    if (this._sidebarThreadKey && String(this._sidebarThreadKey) === String(turnKey)) return true;
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
    this._conversationsByTab.set(k, []);
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
      this._conversationsByTab.delete(NAVIO_PROFILE_CHAT_KEY);
      this._sidebarSessionOrder = [];
      if (data && (data.version === 2 || data.version === 3) && data.byKey && typeof data.byKey === 'object') {
        for (const [k, raw] of Object.entries(data.byKey)) {
          if (!k || k === NAVIO_PROFILE_CHAT_KEY || k.startsWith('__')) continue;
          if (!Array.isArray(raw)) continue;
          const messages = [];
          for (const m of raw) {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
            if (typeof m.content !== 'string') continue;
            messages.push({ role: m.role, content: m.content });
          }
          if (messages.length || k.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX)) {
            this._conversationsByTab.set(k, messages);
          }
        }
        const order = Array.isArray(data.sidebarSessionOrder) ? data.sidebarSessionOrder : [];
        const cleaned = [];
        const seen = new Set();
        for (const row of order) {
          if (!row || typeof row !== 'object') continue;
          const id = typeof row.id === 'string' ? row.id.trim() : '';
          if (!id.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX) || seen.has(id)) continue;
          if (!this._conversationsByTab.has(id)) continue;
          seen.add(id);
          cleaned.push({
            id,
            title: typeof row.title === 'string' ? row.title.slice(0, 120) : 'Saved chat',
            updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
          });
        }
        for (const kid of this._conversationsByTab.keys()) {
          if (!kid.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX)) continue;
          if (cleaned.some((x) => x.id === kid)) continue;
          cleaned.push({ id: kid, title: 'Saved chat', updatedAt: Date.now() });
        }
        cleaned.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        this._sidebarSessionOrder = cleaned.slice(0, 80);
        return;
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
      const byKey = {};
      for (const [k, h] of this._conversationsByTab.entries()) {
        if (!k || k === NAVIO_PROFILE_CHAT_KEY || k.startsWith('__')) continue;
        const isSb = k.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX);
        if ((!h || !h.length) && !isSb) continue;
        const messages = (h || [])
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content }));
        if (messages.length || isSb) byKey[k] = messages;
      }
      const sidebarSessionOrder = (this._sidebarSessionOrder || [])
        .filter((row) => row && row.id && String(row.id).startsWith(NAVIO_SIDEBAR_THREAD_PREFIX) && byKey[row.id])
        .map((row) => ({
          id: row.id,
          title: String(row.title || 'Saved chat').slice(0, 120),
          updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now()
        }))
        .slice(0, 80);
      await window.navio.assistantChatSave({ version: 3, byKey, sidebarSessionOrder });
    } catch (e) {
      console.warn('[navio-assistant] persist chat failed', e);
    }
  }

  /** API message history (per ungrouped tab, or shared per tab group). Persisted under the same storage keys (disk v2). */
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
    if (this._sidebarThreadKey) {
      navioAssistantDebug('onActiveTabChanged: sidebar session — keep transcript', { prevTabId, nextTabId });
      return;
    }
    void this._syncPanelToTab(String(nextTabId));
    navioAssistantDebug('onActiveTabChanged', { prevTabId, nextTabId });
    try {
      this._renderSidebarSessionList();
    } catch {
      /* ignore */
    }
  }

  /**
   * When a tab (or the last tab in a group) goes away, keep a Comet-style copy in saved History (`sb:…`)
   * instead of discarding the transcript with the storage key.
   */
  _archiveThreadToSavedHistory(messages, titleHint) {
    if (!Array.isArray(messages) || !messages.length) return;
    const copy = [];
    for (const m of messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if (typeof m.content !== 'string') continue;
      copy.push({ role: m.role, content: m.content });
    }
    if (!copy.length) return;
    let id;
    try {
      id =
        NAVIO_SIDEBAR_THREAD_PREFIX +
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`);
    } catch {
      id = NAVIO_SIDEBAR_THREAD_PREFIX + `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
    this._conversationsByTab.set(id, copy);
    const firstUser = copy.find((m) => m && m.role === 'user' && String(m.content || '').trim());
    let title = firstUser
      ? String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 56)
      : '';
    const hint = String(titleHint || '').replace(/\s+/g, ' ').trim();
    if (!title && hint) title = hint.slice(0, 56);
    if (!title) title = 'Saved chat';
    this._sidebarSessionOrder = (this._sidebarSessionOrder || []).filter((x) => x.id !== id);
    this._sidebarSessionOrder.unshift({ id, title, updatedAt: Date.now() });
    if (this._sidebarSessionOrder.length > 80) this._sidebarSessionOrder.length = 80;
    try {
      this._renderSidebarSessionList();
    } catch {
      /* ignore */
    }
    this._schedulePersistAssistantHistory();
  }

  onTabClosed(tabId, meta = {}) {
    if (!tabId) return;
    const id = String(tabId);
    const gid = meta && meta.groupId != null && meta.groupId !== '' ? String(meta.groupId) : '';
    const skipArchive = !!(meta && meta.incognito);
    if (gid) {
      const gk = `g:${gid}`;
      const stillGrouped =
        typeof TabManager !== 'undefined' && TabManager.tabs.some((t) => t.groupId === gid);
      if (!stillGrouped) {
        if (!skipArchive) {
          const h = this._conversationsByTab.get(gk);
          if (h && h.length) this._archiveThreadToSavedHistory(h, meta.archiveTitle);
        }
        this._conversationsByTab.delete(gk);
      }
      this._busyTabs.delete(gk);
    } else {
      if (!skipArchive) {
        const h = this._conversationsByTab.get(id);
        if (h && h.length) this._archiveThreadToSavedHistory(h, meta.archiveTitle);
      }
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

    const stillGrouped =
      typeof TabManager !== 'undefined' && TabManager.tabs.some((t) => String(t.groupId || '') === String(groupId));
    if (!stillGrouped) {
      this._conversationsByTab.delete(gk);
      this._busyTabs.delete(gk);
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
    if (this._sidebarThreadKey) return;
    const k = String(tabId || '');
    if (!k) return;
    const storageKey = this._storageKeyForTabId(k);
    const turn = this._turnConversationKey;
    // Comet-style: an in-flight tool/stream run is tied to `turn` (the tab that started it).
    // Switching the *browser* to another tab must not wipe the sidebar or silence progress —
    // main-process tools still target the agent-controlled webview.
    if (turn && this._busyTabs.has(String(turn)) && storageKey !== String(turn)) {
      return;
    }

    const prevPanelId = this._panelDisplayTabId;
    const prevStorageKey = prevPanelId ? this._storageKeyForTabId(String(prevPanelId)) : '';

    this._panelDisplayTabId = k;
    this._ensureConversationEntry(storageKey);
    try {
      this._clearAttachmentQueue();
    } catch {
      /* ignore */
    }
    this.setReceipt('');
    document.getElementById('navio-continue-pill')?.remove();

    // Check if an AI stream is currently active for this tab before touching DOM
    const isStreamingTab = !!(turn && storageKey === turn);

    const h = this._conversationsByTab.get(storageKey) || [];
    // Replaying history destroys the live "Working" card and streaming bubble — skip while this tab's turn is active.
    if (h.length && !isStreamingTab) {
      this._renderDomFromHistoryKey(storageKey);
    } else if (this.messagesEl && !isStreamingTab) {
      // Never replace a visible in-progress thread with the welcome screen just because `h` is
      // momentarily empty (wrong storage key, race with persistence, or post-turn resync timing).
      if (!h.length) {
        const liveThread = this.messagesEl.querySelector(
          '.assistant-message, .user-message, .navio-agent-activity, .navio-plan-card, #typing-indicator, .message-content.streaming-content'
        );
        // Same conversation bucket as before: do not wipe live DOM on a transient empty `h`.
        if (liveThread && prevStorageKey === storageKey) {
          navioAssistantDebug('_syncPanelToTab: skip empty-history wipe — DOM still shows an active thread', {
            storageKey
          });
          return;
        }
      }
      this.messagesEl.innerHTML = '';
      await this._showGreeting();
    }

    // If the AI is mid-stream for this tab, immediately show the typing indicator so
    // the user sees activity rather than a blank gap before the next chunk re-creates
    // the streaming element (the chunk handler detects the detached element via isConnected).
    if (isStreamingTab) {
      this.showTypingIndicator();
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
    const nameTok = navioMailComposeRecipientToken(text);
    let extra = '';
    if (nameTok) {
      extra =
        `\n\n**Compose to a name (no @ address) — user said something like mail to "${nameTok}":** Your **first tool call** must be **gmail_search** with a query that surfaces threads involving that person (e.g. \`${nameTok}\` or \`from:${nameTok} OR to:${nameTok}\` when it is a single token). Use **max_results: 15** and **pages: 1** unless they asked for full history. **Do not** call gmail_create_draft until the user picks which thread/address they mean: show a **numbered list** (subject — counterparty — date — one-line snippet) and ask **which number** to use (or ask them to paste the exact email). If zero results, say so and ask for their address. Keep the first assistant turn short — search first, then list — no long preamble.`;
    }
    messages.push({
      role: 'system',
      content:
        '[Mail — API first, browser when needed]\nThe user’s message was detected as mail-related. Gmail is connected in Navio (Settings → Connectors and/or Google sign-in). Prefer **gmail_search**, **gmail_get_message**, **gmail_list_drafts**, and draft tools — they are fast and reliable. **Do not** open Gmail or use mail tools for questions that are not about email/inbox/messages/drafts. **If the API response does not contain what the task requires** (e.g. amounts or text inside an attachment, previews, or anything only visible in the Gmail UI), you MUST NOT stop with “I can’t” — use **navigate** or **open_tab** with **gmail_browser_takeover: true** to open the real Gmail tab, then **read_page**, **click** (open attachment / preview), **screenshot** as needed. Never click Send on email.\n\n**How to reply:** For “how many”, totals, or inbox summaries — **first line = the usable answer** (number or clear “need attachment/UI”); then a few tight bullets. Skip long “what’s evidenced vs inferred” unless they asked for that.' +
        extra
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

  /**
   * Merge speech into the composer like typed text: keeps existing draft and appends
   * a new paragraph so voice stacks with prefixes, @mentions, and pending attachments.
   * @param {string} transcript
   * @param {{ replace?: boolean }} opts - `replace: true` for barge-in (new command replaces all).
   */
  _applyVoiceTranscriptToInput(transcript, opts = {}) {
    const replace = !!opts.replace;
    const t = String(transcript || '').trim();
    if (!this.inputEl || !t) return;
    const cur = (this.inputEl.value || '').trim();
    if (replace || !cur) {
      this.inputEl.value = t;
    } else {
      this.inputEl.value = `${cur}\n${t}`;
    }
    this._fitAssistantInputHeight();
    this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── Voice Mode (Web Speech API) ──────────────────────────────────────────
  /**
   * Record microphone audio, detect end-of-speech via silence detection,
   * then transcribe via OpenAI gpt-4o-mini-transcribe (Whisper-class accuracy).
   *
   * @param {function} onTranscript  - Called with final transcript string (may be '')
   * @param {function} [onUpdate]    - Called with { state: 'recording'|'processing', level: number }
   * @returns {function}             - Call to abort / stop recording early
   */
  /**
   * Record mic audio and transcribe via Whisper (OpenAI STT).
   * @param {Function} onTranscript - called with final text when done
   * @param {Function} onUpdate - called with {state, level} during recording
   * @param {MediaStream|null} sharedStream - pre-opened mic stream to reuse (no getUserMedia, no track teardown).
   *   Pass this._vcPersistentStream in voice-conversation mode so barge-in has zero latency.
   */
  _whisperListen(onTranscript, onUpdate, sharedStream = null) {
    /** True only when the user cancels — NOT when VAD / max-duration ends the take. */
    let userAborted = false;
    let ownedStream = null;  // only set when WE opened the mic
    let mediaRecorder = null;
    let audioCtx = null;
    let rafId = null;
    const chunks = [];

    const cleanup = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      // Only stop tracks if we own the stream — never close a shared persistent stream
      if (ownedStream) { ownedStream.getTracks().forEach(t => t.stop()); ownedStream = null; }
      if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
    };

    /** End-of-utterance (silence VAD or cap) — must still run Whisper in `onstop`. */
    const endRecording = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch { /* ignore */ }
      } else {
        cleanup();
      }
    };

    /** Mic toolbar Stop / End — discard audio, do not transcribe. */
    const userStop = () => {
      userAborted = true;
      endRecording();
    };

    (async () => {
      try {
        let stream;
        if (sharedStream) {
          stream = sharedStream; // reuse — capture starts immediately, zero getUserMedia latency
        } else {
          stream = ownedStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }
        if (userAborted) { if (ownedStream) { ownedStream.getTracks().forEach(t => t.stop()); ownedStream = null; } return; }

        // ── Audio analysis for voice activity detection ──────────────────
        audioCtx = new AudioContext();
        try {
          if (audioCtx.state === 'suspended') await audioCtx.resume();
        } catch {
          /* ignore */
        }
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.2;
        source.connect(analyser);
        const pcmBuf = new Uint8Array(analyser.frequencyBinCount);

        // ── MediaRecorder — prefer opus/webm (best quality in Chromium) ──
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
          .find(t => MediaRecorder.isTypeSupported(t)) || '';
        mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        mediaRecorder.start(80); // 80 ms chunks

        // ── VAD — adaptive floor + "no loud frames for N ms" end detection ──
        // Fixed speech/silence RMS gates (e.g. >10 vs <6) fail on many Windows setups:
        // room noise sits between the two, so silence never accumulates and recording
        // never ends. Calibrate from the first ~400 ms, then end after NAVIO_VOICE_END_SILENCE_MS
        // with no frame above the speech threshold (same idea as Web Speech silence debounce).
        let hasSpoken = false;
        let lastLoudMs = 0;
        let vadCalibrated = false;
        let vadCalibratedAt = 0;
        const vadCalSamples = [];
        const VAD_CALIBRATE_MS = 400;
        const SILENCE_NEEDED_MS = NAVIO_VOICE_END_SILENCE_MS;
        /** If we never cross `speakGate` after calibration, stop anyway (quiet room / mic gain / hung analyser). */
        const NO_SPEECH_GIVEUP_MS = SILENCE_NEEDED_MS + 1200;
        const MAX_RECORD_MS = 90_000;   // 90 s safety cap
        const recordStart = Date.now();
        let speechThresh = 14;

        const vadLoop = () => {
          if (userAborted) return;
          if (audioCtx && audioCtx.state === 'suspended') {
            void audioCtx.resume().catch(() => {});
          }
          analyser.getByteTimeDomainData(pcmBuf);
          let sum = 0;
          for (let i = 0; i < pcmBuf.length; i++) {
            const v = (pcmBuf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / pcmBuf.length) * 100;
          onUpdate?.({ state: 'recording', level: rms });

          const now = Date.now();
          // Collect RMS only until calibrated (avoids unbounded growth + keeps stats stable).
          if (!vadCalibrated) {
            vadCalSamples.push(rms);
            if (now - recordStart >= VAD_CALIBRATE_MS) {
              vadCalSamples.sort((a, b) => a - b);
              const pick = (p) => {
                if (!vadCalSamples.length) return 7;
                const idx = Math.max(0, Math.min(vadCalSamples.length - 1, Math.floor(vadCalSamples.length * p)));
                return vadCalSamples[idx];
              };
              // Upper-mid percentile tracks steady fan/hum; threshold must stay above it so
              // "no loud frames for N ms" can elapse after the user stops talking.
              const qHi = pick(0.72);
              // Slightly gentler than qHi+6 so quiet laptops still register speech for end-of-utterance.
              speechThresh = Math.min(26, Math.max(10, qHi + 5));
              vadCalibrated = true;
              vadCalibratedAt = now;
            }
          } else {
            // Gate below `speechThresh` so soft voices still arm VAD; silence still uses clock after last loud frame.
            const speakGate = Math.max(7.5, speechThresh - 4.5);
            if (rms > speakGate) {
              hasSpoken = true;
              lastLoudMs = now;
            }
          }
          if (vadCalibrated && hasSpoken && lastLoudMs && now - lastLoudMs >= SILENCE_NEEDED_MS) {
            endRecording();
            return;
          }
          // Never crossed speakGate — do not spin forever; treat as empty utterance.
          if (vadCalibrated && vadCalibratedAt && !hasSpoken && now - vadCalibratedAt >= NO_SPEECH_GIVEUP_MS) {
            endRecording();
            return;
          }

          if (now - recordStart > MAX_RECORD_MS) { endRecording(); return; }
          rafId = requestAnimationFrame(vadLoop);
        };
        rafId = requestAnimationFrame(vadLoop);

        // ── On recording stop: encode + send to Whisper ──────────────────
        mediaRecorder.onstop = async () => {
          cleanup();
          if (userAborted) return;
          if (chunks.length === 0) {
            onTranscript('');
            return;
          }

          onUpdate?.({ state: 'processing', level: 0 });

          try {
            const blob = new Blob(chunks, { type: mime ? mime.split(';')[0] : 'audio/webm' });
            const arrayBuf = await blob.arrayBuffer();
            if (userAborted) return;

            // Chunked base64 encode — avoids stack overflow on large buffers
            const uint8 = new Uint8Array(arrayBuf);
            const CHUNK = 8192;
            let bin = '';
            for (let i = 0; i < uint8.length; i += CHUNK) {
              bin += String.fromCharCode(...uint8.subarray(i, Math.min(i + CHUNK, uint8.length)));
            }
            const b64 = btoa(bin);

            if (!window.navio?.navioSTT) {
              onTranscript('');
              return;
            }
            const result = await window.navio.navioSTT({
              audio: b64,
              mimeType: mime ? mime.split(';')[0] : 'audio/webm',
              language: 'en',
            });
            if (userAborted) return;
            onTranscript(result?.ok ? (result.text || '') : '');
          } catch {
            if (!userAborted) onTranscript('');
          }
        };
      } catch {
        // Mic access denied or device error
        cleanup();
        if (!userAborted) onTranscript('');
      }
    })();

    return userStop;
  }

  _bindVoiceMode() {
    const btn = document.getElementById('btn-voice-mode');
    const hint = document.getElementById('voice-hint');
    if (!btn) return;

    const HINT_DEFAULT = 'Shift+Enter for new line';
    let active = false;
    let stopFn = null;

    const resetUI = () => {
      active = false;
      stopFn = null;
      btn.classList.remove('listening');
      if (hint) hint.textContent = HINT_DEFAULT;
    };

    const onGotTranscript = (text, sttBaseline = '') => {
      resetUI();
      if (!text.trim()) return;
      const b = String(sttBaseline || '').trimEnd().trim();
      if (b && this.inputEl) {
        this.inputEl.value = `${b}\n${text.trim()}`;
        this._fitAssistantInputHeight();
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        this._applyVoiceTranscriptToInput(text, { replace: false });
      }
      this.sendMessage();
    };

    // ── Whisper path ──────────────────────────────────────────────────────
    const startWhisper = () => {
      active = true;
      btn.classList.add('listening');
      if (hint) hint.textContent = 'Listening… pause ~3s when done (merges with text in the box)';
      stopFn = this._whisperListen(onGotTranscript, ({ state }) => {
        if (state === 'processing' && hint) hint.textContent = 'Transcribing…';
      });
    };

    // ── Web Speech API fallback ──────────────────────────────────────────
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const startBrowserSTT = () => {
      if (!SpeechRecognition) return;
      active = true;
      const baseline = (this.inputEl?.value || '').trimEnd();
      const rec = new SpeechRecognition();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      stopFn = () => { try { rec.stop(); } catch { /* ignore */ } };

      // Silence detection: auto-submit after NAVIO_VOICE_END_SILENCE_MS of no new speech.
      // On Windows/Chromium, isFinal often never fires — this is the reliable path.
      let silenceTimer = null;
      let lastTranscript = '';
      const SILENCE_MS = NAVIO_VOICE_END_SILENCE_MS;
      const scheduleAutoSubmit = (t) => {
        clearTimeout(silenceTimer);
        lastTranscript = t;
        silenceTimer = setTimeout(() => {
          try { rec.stop(); } catch { /* ignore */ }
          if (lastTranscript.trim()) onGotTranscript(lastTranscript, baseline);
          else resetUI();
        }, SILENCE_MS);
      };

      rec.onstart = () => {
        btn.classList.add('listening');
        if (hint) hint.textContent = 'Listening… pause ~3s when done (merges with text in the box)';
      };
      rec.onresult = (e) => {
        const t = Array.from(e.results).map(r => r[0].transcript).join('');
        if (this.inputEl) {
          const display = baseline.trim() ? `${baseline.trim()}\n${t}` : t;
          this.inputEl.value = display;
          this._fitAssistantInputHeight();
        }
        if (e.results[e.results.length - 1].isFinal) {
          clearTimeout(silenceTimer);
          if (stopFn) try { rec.stop(); } catch { /* ignore */ }
          onGotTranscript(t, baseline);
        } else {
          // Interim result — reset the silence timer so we wait for the pause
          scheduleAutoSubmit(t);
        }
      };
      rec.onerror = (e) => {
        clearTimeout(silenceTimer);
        resetUI();
        if (e.error !== 'no-speech') {
          if (hint) hint.textContent = `Voice error: ${e.error}`;
          setTimeout(() => { if (hint) hint.textContent = HINT_DEFAULT; }, 2500);
        }
      };
      rec.onend = () => { clearTimeout(silenceTimer); if (active) resetUI(); };
      rec.start();
    };

    btn.addEventListener('click', () => {
      if (active) {
        if (stopFn) try { stopFn(); } catch { /* ignore */ }
        resetUI();
        return;
      }
      // Prefer Whisper; fall back to browser STT if unavailable
      if (window.navio?.navioSTT) startWhisper();
      else if (SpeechRecognition) startBrowserSTT();
    });
  }

  // ── Voice Conversation Mode ───────────────────────────────────────────────

  _bindVoiceConversation() {
    document.getElementById('btn-voice-conv')?.addEventListener('click', () => {
      if (this._voiceConvActive) this._stopVoiceConversation();
      else this._startVoiceConversation();
    });
    document.getElementById('btn-voice-conv-end')?.addEventListener('click', () => {
      this._stopVoiceConversation();
    });
  }

  _startVoiceConversation() {
    if (!navigator.mediaDevices?.getUserMedia) {
      if (typeof _showAppToast === 'function') {
        _showAppToast('Voice conversation requires microphone access.', 'warning');
      }
      return;
    }
    // Tear down any in-flight read-aloud **before** voice conv flips on — otherwise
    // `_setTTSBarVisible(false)` is suppressed while `_voiceConvActive` is true and the
    // TTS bar can stay interactive / misleading above the HUD.
    this._stopSpeaking();
    this._voiceConvActive = true;
    this._vcInterruptActive = false;
    document.getElementById('btn-voice-conv')?.classList.add('voice-conv-on');
    const hud = document.getElementById('voice-conv-hud');
    if (hud) {
      hud.hidden = false;
      requestAnimationFrame(() => hud.classList.add('vch-show'));
    }

    // Open ONE persistent mic stream for the entire conversation.
    // Shared by both the interrupt VAD analyser and Whisper recorder so barge-in
    // starts capturing at the exact moment the user's voice is detected — zero getUserMedia latency.
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        if (!this._voiceConvActive) { stream.getTracks().forEach(t => t.stop()); return; }
        this._vcPersistentStream = stream;
        this._voiceConvListen();
      })
      .catch(() => {
        if (typeof _showAppToast === 'function') {
          _showAppToast('Could not open microphone.', 'warning');
        }
        this._stopVoiceConversation();
      });
  }

  _stopVoiceConversation() {
    this._voiceConvActive = false;
    this._voiceConvProgressTtsAt = 0;
    this._vcSid++;
    if (this._voiceConvFlashTimer) {
      try { clearTimeout(this._voiceConvFlashTimer); } catch { /* ignore */ }
      this._voiceConvFlashTimer = null;
    }
    this._stopVoiceConvInterruptListener();
    if (this._voiceConvRec) {
      try { this._voiceConvRec.stop(); } catch { /* ignore */ }
      this._voiceConvRec = null;
    }
    this._stopSpeaking();
    // Close the persistent mic stream last (interrupt listener and recorder must stop first)
    if (this._vcPersistentStream) {
      this._vcPersistentStream.getTracks().forEach(t => t.stop());
      this._vcPersistentStream = null;
    }
    document.getElementById('btn-voice-conv')?.classList.remove('voice-conv-on');
    const transcriptEl = document.getElementById('vch-transcript');
    if (transcriptEl) transcriptEl.textContent = '';
    const hud = document.getElementById('voice-conv-hud');
    if (hud) {
      try { delete hud.dataset.vcState; } catch { /* ignore */ }
      hud.classList.remove('vch-show');
      setTimeout(() => { hud.hidden = true; }, 220);
    }
  }

  // ── Interrupt listener — stays active during thinking/speaking so the user can speak at any time ──

  /**
   * Opens a lightweight parallel mic stream that watches for sustained speech.
   * When detected during thinking/speaking states, immediately stops the AI and starts listening.
   * Called automatically by _voiceConvSetState when entering non-listening states.
   */
  _startVoiceConvInterruptListener() {
    if (this._vcInterruptActive || !this._voiceConvActive) return;

    // Use the persistent stream — no getUserMedia, no latency, no device conflicts
    const stream = this._vcPersistentStream;
    if (!stream) return;

    this._vcInterruptActive = true;

    const audioCtx = new AudioContext();
    this._vcInterruptAudioCtx = audioCtx;
    void audioCtx.resume().catch(() => {});
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.25;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    // Adaptive noise floor: sample ambient audio (including TTS bleed) for 350ms,
    // then set the trigger threshold above it. This handles rooms where speaker audio
    // leaks into the mic without causing false triggers or missing the user's voice.
    const INTERRUPT_CONFIRM_MS = 120; // ms of sustained speech above threshold → fire (was 260ms)
    let speechStart = null;
    let noiseSamples = [];
    let noiseFloor = 8;
    let noiseMeasured = false;
    const noiseMeasureStart = Date.now();
    const NOISE_MEASURE_MS = 350;

    const loop = () => {
      if (!this._vcInterruptActive || !this._voiceConvActive) {
        try { audioCtx.close(); } catch { /* ignore */ }
        return;
      }

      // Only watch during non-listening states — Whisper's own VAD handles listening
      const vcState = document.getElementById('voice-conv-hud')?.dataset.vcState;
      if (vcState === 'listening') {
        speechStart = null;
        this._vcInterruptRaf = requestAnimationFrame(loop);
        return;
      }

      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length) * 100;

      // Calibration phase — measure ambient noise / TTS bleed level
      if (!noiseMeasured) {
        if (Date.now() - noiseMeasureStart < NOISE_MEASURE_MS) {
          noiseSamples.push(rms);
        } else {
          // 90th-percentile of samples = noise ceiling; trigger must be clearly above it
          noiseSamples.sort((a, b) => a - b);
          noiseFloor = noiseSamples[Math.floor(noiseSamples.length * 0.9)] || 8;
          noiseMeasured = true;
        }
        this._vcInterruptRaf = requestAnimationFrame(loop);
        return;
      }

      // Dynamic threshold: must be meaningfully above measured noise floor
      const threshold = Math.max(noiseFloor * 1.9 + 5, 12);

      if (rms > threshold) {
        if (!speechStart) speechStart = Date.now();
        else if (Date.now() - speechStart >= INTERRUPT_CONFIRM_MS) {
          this._handleVoiceConvInterrupt();
          return; // loop stops; interrupt handler takes over
        }
      } else {
        speechStart = null;
      }
      this._vcInterruptRaf = requestAnimationFrame(loop);
    };
    this._vcInterruptRaf = requestAnimationFrame(loop);
  }

  _stopVoiceConvInterruptListener() {
    this._vcInterruptActive = false;
    if (this._vcInterruptRaf) { cancelAnimationFrame(this._vcInterruptRaf); this._vcInterruptRaf = null; }
    // Don't touch the persistent mic stream — managed by _startVoiceConversation/_stopVoiceConversation
    if (this._vcInterruptAudioCtx) {
      try { this._vcInterruptAudioCtx.close(); } catch { /* ignore */ }
      this._vcInterruptAudioCtx = null;
    }
  }

  /**
   * Fires when the user speaks during thinking/speaking states.
   * Kills current AI work + TTS immediately, then starts fresh listening.
   * The user is still speaking when this fires, so Whisper captures their full command.
   */
  _handleVoiceConvInterrupt() {
    if (!this._voiceConvActive) return;

    // Stop interrupt listener first (prevents re-triggering)
    this._stopVoiceConvInterruptListener();

    // Cancel any in-flight AI generation
    try { this.stopGeneration?.(); } catch { /* ignore */ }

    // Cancel any in-progress TTS
    this._stopSpeaking();

    // Cancel any active Whisper session (shouldn't be active, but be safe)
    if (this._voiceConvRec) {
      try { this._voiceConvRec.stop(); } catch { /* ignore */ }
      this._voiceConvRec = null;
    }

    // Visual feedback — brief "interrupted" flash before switching to listening
    const transcriptEl = document.getElementById('vch-transcript');
    if (transcriptEl) transcriptEl.textContent = '✋ Interrupted';
    this._voiceConvSetState('listening');

    // Clear the transcript flash after a moment and let Whisper replace it
    if (this._voiceConvFlashTimer) {
      try { clearTimeout(this._voiceConvFlashTimer); } catch { /* ignore */ }
    }
    const flashCap = this._vcSid;
    this._voiceConvFlashTimer = setTimeout(() => {
      this._voiceConvFlashTimer = null;
      if (flashCap !== this._vcSid || !this._voiceConvActive) return;
      if (transcriptEl && transcriptEl.textContent === '✋ Interrupted') {
        transcriptEl.textContent = '';
      }
    }, 600);

    if (window.navio?.navioSTT) {
      // Whisper path — pass the persistent stream so recording starts at the EXACT moment
      // the interrupt fired. No getUserMedia latency, no lost words at the start of the barge-in.
      const stopFn = this._whisperListen(
        (text) => {
          this._voiceConvRec = null;
          if (!this._voiceConvActive) return;
          if (transcriptEl) transcriptEl.textContent = '';
          if (text.trim()) {
            this._voiceConvSetState('thinking');
            this._applyVoiceTranscriptToInput(text, { replace: true });
            this.sendMessage();
          } else {
            this._scheduleVoiceConvListen(350);
          }
        },
        ({ state, level }) => {
          if (!this._voiceConvActive) return;
          if (state === 'recording' && transcriptEl) {
            const filled = Math.min(Math.round((level || 0) / 7), 8);
            transcriptEl.textContent = '▮'.repeat(filled) + '▯'.repeat(8 - filled);
          } else if (state === 'processing' && transcriptEl) {
            transcriptEl.textContent = 'Transcribing…';
          }
        },
        this._vcPersistentStream  // ← shared stream, zero latency
      );
      this._voiceConvRec = { stop: stopFn };
    } else {
      // Web Speech API fallback — no persistent stream support needed (browser manages its own mic)
      this._voiceConvListenWebSpeech();
    }
  }

  /**
   * System message for hands-free voice: same model capabilities as typed chat, but
   * answers must be spoken-friendly. Used by both legacy and tool-calling paths.
   * @returns {{ role: 'system', content: string } | null}
   */
  _voiceConversationModeSystemMessage() {
    if (!this._voiceConvActive) return null;
    return {
      role: 'system',
      content: `[VOICE CONVERSATION MODE — ACTIVE]
The user is talking to you hands-free. Your reply will be read aloud by text-to-speech. These rules override all other formatting rules:

CAPABILITY PARITY:
- You have the same tools, connectors, and browsing abilities as when the user types. Use them the same way; only how you word answers changes for speech.
- User text may come from speech-to-text — interpret unclear phrases charitably, as you would for a sloppy typed message.

RESPONSE STYLE:
- Write as if talking, not typing. Natural spoken sentences. No markdown — no asterisks, bullets, dashes, headers, or code fences. They will be spoken literally and sound wrong.
- Same idea when they are reading on screen in typed chat: sound human there too — just markdown is allowed in text mode.
- Contractions are good: "I'll", "I've", "I'm now", "let me", "here's what I found".
- Keep each spoken response to 2–4 sentences. Expand only if they asked for depth.
- Do NOT append the [FOLLOWUP] chips block — it is not useful in audio.

NARRATE YOUR WORK (this is the most important rule):
- Your reply is read aloud in real time: always include at least one short spoken sentence in your FIRST assistant message before tool calls (no empty content round). If you would otherwise jump straight to tools, say what you are doing first so the user never sits in long silence.
- Keep the user oriented while tools run, but never sound like a broken record: invent fresh wording every time. Do not reuse the same sentence, opener, or catchphrase twice in this conversation turn — and avoid leaning on the same stock fillers you used on the last turn when you can help it.
- Vary structure and tone across steps: mix factual pings, plain status, and brief asides — but write each line from scratch for this moment. Never start two consecutive updates with the same word or the same template (e.g. do not do "One sec…" then "One sec…" again, or two lines that both begin with "Okay").
- Anchor each line to what is literally happening (which mailbox, which site, which attachment, what you're opening next) so uniqueness comes naturally from the task, not from random fluff.
- After each meaningful tool result, say what you actually found using real titles — never vague "the first email" alone. Name the subject, sender, company, order, flight, or amount when the data gives you one.
- Between tool calls, one short new line is enough; make it different from the line before it in both words and rhythm.
- Before starting a distinct new phase of a task, tell the user what you're about to do and ask if they want you to continue — again, phrase it in your own words, not the same template every time.
- This is not permission-seeking between micro-steps — it's a natural pause at logical checkpoints (e.g. between login and checkout, between search and booking, between filling and submitting).

END WITH A SPOKEN SUMMARY:
- When a task completes, give a 2–3 sentence spoken summary of what was done.
  Example: "All done. I found four flights, the cheapest was Air Canada for 189 dollars on April 12th, and I've got that page open for you. Want me to check another route as well?"

DATES AND NUMBERS (spoken naturally — never read digits one by one):
- Dates: say "January fifteenth, twenty twenty-four" — never "2024-01-15" or "01/15/24".
- Years: say "twenty twenty-four", "nineteen ninety-nine" — never "two zero two four".
- Prices: always say the currency — "twelve hundred dollars", "eighty-five pounds fifty pence". Never say a bare number like "the price is 1200" without the currency.
- Times: say "three fifteen PM" or "quarter past three" — not "15:15".
- Percentages: say "fifteen percent" — not "15%".`
    };
  }

  /** Update the HUD ring + label to reflect current conversation state. */
  _voiceConvSetState(state) {
    const hud = document.getElementById('voice-conv-hud');
    const lbl = document.getElementById('vch-state-label');
    const icon = document.getElementById('vch-state-icon');
    if (!hud) return;
    hud.dataset.vcState = state;

    const labels = {
      listening:   'Listening…',
      thinking:    'Thinking… (speak to interrupt)',
      speaking:    'Speak anytime to interrupt',
      summarizing: 'Wrapping up… (speak to interrupt)',
    };
    if (lbl) lbl.textContent = labels[state] || state;

    // Swap icon per state
    const icons = {
      listening:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`,
      thinking:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
      speaking:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
      summarizing: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    };
    if (icon && icons[state]) icon.innerHTML = icons[state];

    // Start interrupt listener when AI is busy; stop it when we're listening (Whisper handles it)
    if (state === 'thinking' || state === 'speaking' || state === 'summarizing') {
      this._startVoiceConvInterruptListener();
    } else {
      this._stopVoiceConvInterruptListener();
    }
  }

  /**
   * Schedule returning to the mic after a delay. Safe across stop/restart: superseded
   * when `_vcSid` changes (voice conversation ended) or `_voiceConvActive` is false.
   */
  _scheduleVoiceConvListen(delayMs) {
    const cap = this._vcSid;
    setTimeout(() => {
      if (cap !== this._vcSid || !this._voiceConvActive) return;
      this._voiceConvListen();
    }, delayMs);
  }

  /** Start a single mic capture cycle in voice conversation mode using Whisper. */
  _voiceConvListen() {
    if (!this._voiceConvActive) return;
    this._voiceConvSetState('listening');
    const transcriptEl = document.getElementById('vch-transcript');
    if (transcriptEl) transcriptEl.textContent = '';

    // Use Whisper (gpt-4o-mini-transcribe) for near-perfect accuracy.
    // Falls back to Web Speech API if navioSTT is unavailable.
    if (window.navio?.navioSTT) {
      const stopFn = this._whisperListen(
        (text) => {
          this._voiceConvRec = null;
          if (!this._voiceConvActive) return;
          if (transcriptEl) transcriptEl.textContent = '';
          if (text.trim()) {
            this._voiceConvSetState('thinking');
            this._applyVoiceTranscriptToInput(text, { replace: false });
            this.sendMessage();
          } else {
            // Nothing heard — loop back to listening
            this._scheduleVoiceConvListen(350);
          }
        },
        ({ state, level }) => {
          if (!this._voiceConvActive) return;
          if (state === 'recording' && transcriptEl) {
            // Live audio level bars — 8 segments
            const filled = Math.min(Math.round((level || 0) / 7), 8);
            transcriptEl.textContent = '▮'.repeat(filled) + '▯'.repeat(8 - filled);
          } else if (state === 'processing' && transcriptEl) {
            transcriptEl.textContent = 'Transcribing…';
          }
        },
        this._vcPersistentStream  // ← reuse persistent stream, no getUserMedia per turn
      );
      this._voiceConvRec = { stop: stopFn };
    } else {
      // Fallback: Web Speech API
      this._voiceConvListenWebSpeech();
    }
  }

  /** Web Speech API listening cycle — used when Whisper (navioSTT) is unavailable. */
  _voiceConvListenWebSpeech() {
    if (!this._voiceConvActive) return;
    const transcriptEl = document.getElementById('vch-transcript');
    const vcBaseline = (this.inputEl?.value || '').trimEnd();
    {
      // Fallback: Web Speech API
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) { this._stopVoiceConversation(); return; }
      const rec = new SpeechRecognition();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      this._voiceConvRec = { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };

      // Silence detection: auto-submit after NAVIO_VOICE_END_SILENCE_MS of no new speech.
      // Prevents the mic staying open forever when isFinal never fires (common on Windows/Chromium).
      let vcSilenceTimer = null;
      let vcLastText = '';
      const VC_SILENCE_MS = NAVIO_VOICE_END_SILENCE_MS;
      const submitVoiceText = (text) => {
        clearTimeout(vcSilenceTimer);
        if (!this._voiceConvActive) return;
        this._voiceConvRec = null;
        if (transcriptEl) transcriptEl.textContent = '';
        if (text.trim()) {
          this._voiceConvSetState('thinking');
          const b = vcBaseline.trim();
          if (b && this.inputEl) {
            this.inputEl.value = `${b}\n${text.trim()}`;
            this._fitAssistantInputHeight();
            this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            this._applyVoiceTranscriptToInput(text, { replace: false });
          }
          this.sendMessage();
        } else {
          this._scheduleVoiceConvListen(350);
        }
      };

      rec.onresult = (e) => {
        const text = Array.from(e.results).map(r => r[0].transcript).join('');
        vcLastText = text;
        if (transcriptEl) transcriptEl.textContent = vcBaseline.trim() ? `${vcBaseline.trim()}\n${text}` : text;
        if (e.results[e.results.length - 1].isFinal) {
          submitVoiceText(text);
        } else {
          // Interim result — schedule auto-submit after silence pause
          clearTimeout(vcSilenceTimer);
          vcSilenceTimer = setTimeout(() => {
            try { rec.stop(); } catch { /* ignore */ }
            submitVoiceText(vcLastText);
          }, VC_SILENCE_MS);
        }
      };
      rec.onerror = (e) => {
        clearTimeout(vcSilenceTimer);
        this._voiceConvRec = null;
        if (e.error !== 'aborted') {
          this._scheduleVoiceConvListen(500);
        }
      };
      rec.onend = () => {
        clearTimeout(vcSilenceTimer);
        if (this._voiceConvActive && !this._voiceConvRec) {
          const s = document.getElementById('voice-conv-hud')?.dataset.vcState;
          if (s === 'listening') this._scheduleVoiceConvListen(300);
        }
      };
      try { rec.start(); } catch { this._voiceConvRec = null; }
    }
  }

  // ── Text-to-speech ───────────────────────────────────────────────────────

  /** Strip markdown to clean spoken text for TTS. */
  _stripMarkdown(text) {
    return String(text)
      // Remove fenced code blocks entirely (don't read code aloud)
      .replace(/```[\s\S]*?```/g, '')
      // Remove inline code ticks
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      // Remove bold/italic markers, keep content
      .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_{2}(.*?)_{2}/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      // Remove headings (keep text)
      .replace(/^#{1,6}\s+/gm, '')
      // Remove markdown links, keep label
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // Remove bare URLs (they sound terrible spoken)
      .replace(/https?:\/\/\S+/g, '')
      // Remove HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove FOLLOWUP chips
      .replace(/\[FOLLOWUP\][\s\S]*?\[\/FOLLOWUP\]/gi, '')
      // Convert bullet/numbered list markers to natural pauses
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      // Remove horizontal rules
      .replace(/^[-*_]{3,}\s*$/gm, '')
      // Collapse multiple blank lines
      .replace(/\n{3,}/g, '\n\n')
      // Clean up leading/trailing whitespace per line
      .split('\n').map(l => l.trim()).join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Preprocess stripped-markdown text for natural TTS delivery.
   * Converts ISO dates, standalone years, currency amounts, ordinals, and percentages
   * into forms that both OpenAI TTS and Web Speech API read naturally.
   */
  _prepareSpeechText(text) {
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const ONES   = ['','one','two','three','four','five','six','seven','eight','nine',
                    'ten','eleven','twelve','thirteen','fourteen','fifteen',
                    'sixteen','seventeen','eighteen','nineteen'];
    const TENS   = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

    const tensWords = (n) => {
      if (n < 20) return ONES[n] || String(n);
      return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
    };
    const yearWords = (y) => {
      if (y >= 2000 && y <= 2099) {
        const rem = y - 2000;
        if (rem === 0) return 'two thousand';
        if (rem < 10) return 'twenty oh ' + ONES[rem];
        return 'twenty ' + tensWords(rem);
      }
      if (y >= 1900 && y <= 1999) {
        const rem = y - 1900;
        if (rem === 0) return 'nineteen hundred';
        return 'nineteen ' + tensWords(rem);
      }
      return String(y);
    };
    const currencyWords = (numStr, symbol) => {
      const n = parseFloat(numStr.replace(/,/g, ''));
      if (isNaN(n)) return symbol + numStr;
      const dollars = Math.floor(n);
      const cents = Math.round((n - dollars) * 100);
      const name = symbol === '£' ? 'pound' : symbol === '€' ? 'euro' : symbol === '¥' ? 'yen' : 'dollar';
      const plural = (x) => x === 1 ? '' : 's';
      if (symbol === '¥') return `${dollars.toLocaleString()} yen`;
      if (cents > 0) return `${dollars.toLocaleString()} ${name}${plural(dollars)} and ${cents} cent${plural(cents)}`;
      return `${dollars.toLocaleString()} ${name}${plural(dollars)}`;
    };

    return text
      // ISO date YYYY-MM-DD → "January 15th, twenty twenty-four"
      .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => {
        const month = MONTHS[parseInt(m, 10) - 1] || m;
        const day = parseInt(d, 10);
        const suffix = [,'st','nd','rd'][day % 10] && day < 11 || day > 13 ? [,'st','nd','rd'][day % 10] || 'th' : 'th';
        return `${month} ${day}${suffix}, ${yearWords(parseInt(y, 10))}`;
      })
      // Standalone 4-digit years (1900-2099) not already part of a date
      .replace(/\b((?:19|20)\d{2})\b(?![-\/])/g, (_, y) => yearWords(parseInt(y, 10)))
      // Currency with symbol: $1,234.56 / £500 / €1,000
      .replace(/([$£€¥])(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g, (_, sym, num) => currencyWords(num, sym))
      // Bare currency range: "500 - 800 USD" / "USD 500"
      .replace(/\bUSD\s+(\d[\d,]*)/gi, (_, n) => currencyWords(n, '$'))
      .replace(/(\d[\d,]*)\s+USD\b/gi, (_, n) => currencyWords(n, '$'))
      .replace(/\bGBP\s+(\d[\d,]*)/gi, (_, n) => currencyWords(n, '£'))
      .replace(/(\d[\d,]*)\s+GBP\b/gi, (_, n) => currencyWords(n, '£'))
      .replace(/\bEUR\s+(\d[\d,]*)/gi, (_, n) => currencyWords(n, '€'))
      .replace(/(\d[\d,]*)\s+EUR\b/gi, (_, n) => currencyWords(n, '€'))
      // Percentages: 15% → "15 percent"
      .replace(/(\d+(?:\.\d+)?)%/g, '$1 percent')
      // Ordinals read naturally (1st, 2nd etc.) — Web Speech handles these; OpenAI does too
      .trim();
  }

  /**
   * Play one OpenAI TTS audio clip; resolves when playback finishes or errors.
   * @param {{ ok?: boolean, audio?: string, mimeType?: string }} result
   * @param {number} mySession
   * @param {HTMLElement|null} btn
   * @param {boolean} isLastChunk — only then reopen mic in voice conversation mode
   */
  async _playOpenAITtsClip(result, mySession, btn, isLastChunk) {
    if (mySession !== this._ttsSessionId) return;
    if (!result || !result.ok || !result.audio) return;
    if (btn) {
      btn.classList.remove('tts-loading');
      btn.classList.add('tts-speaking');
    }
    this._setTTSBarVisible(true, 'Reading aloud…');
    const dataUrl = `data:${result.mimeType || 'audio/mpeg'};base64,${result.audio}`;
    const audio = new Audio(dataUrl);
    audio.volume = 1.0;
    this._currentAudio = audio;
    await new Promise((resolve) => {
      let settled = false;
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const finish = () => {
        if (mySession !== this._ttsSessionId) {
          safeResolve();
          return;
        }
        this._currentAudio = null;
        if (btn && isLastChunk) btn.classList.remove('tts-speaking');
        if (isLastChunk) {
          this._setTTSBarVisible(false);
          this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
        }
        safeResolve();
      };
      audio.addEventListener('ended', finish, { once: true });
      audio.addEventListener(
        'error',
        () => {
          if (btn) btn.classList.remove('tts-speaking', 'tts-loading');
          if (isLastChunk) {
            this._setTTSBarVisible(false);
            this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
          }
          safeResolve();
        },
        { once: true }
      );
      // `pause()` from `_stopSpeaking()` does not emit `ended` — without this, the
      // await never completes and chunked / voice TTS pipelines can stall indefinitely.
      audio.addEventListener('pause', () => {
        if (settled) return;
        if (mySession !== this._ttsSessionId) {
          this._currentAudio = null;
          if (btn && isLastChunk) btn.classList.remove('tts-speaking');
          if (isLastChunk) this._setTTSBarVisible(false);
          safeResolve();
        }
      });
      audio.play().catch(() => {
        if (btn) btn.classList.remove('tts-speaking', 'tts-loading');
        if (isLastChunk) {
          this._setTTSBarVisible(false);
          this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
        }
        safeResolve();
      });
    });
  }

  /**
   * Chunked OpenAI TTS: small first request + prefetch next chunk while audio plays.
   * Used for voice conversation and for **manual Read aloud** so the user hears audio
   * quickly instead of waiting on one huge `/v1/audio/speech` response.
   * @returns {boolean} true if the full plan was handled here (success or aborted mid-flight)
   */
  async _speakVoiceConvChunkedPipeline(plain, voicePref, mySession, btn, ttsSpeed, speechOpts = {}) {
    if (!window.navio?.navioTTS) return false;
    const chunks = navioVoiceConvTtsChunkPlan(plain.slice(0, 4000));
    if (chunks.length <= 1) return false;

    void this._refreshCachedTtsVoice();
    const ttsPayload = (txt) => {
      const o = { text: txt.slice(0, 4000), voice: voicePref };
      if (ttsSpeed != null && Number.isFinite(Number(ttsSpeed))) o.speed = Number(ttsSpeed);
      return o;
    };
    let prefetched = window.navio.navioTTS(ttsPayload(chunks[0]));

    for (let i = 0; i < chunks.length; i++) {
      if (mySession !== this._ttsSessionId) return true;
      const result = await prefetched;
      if (mySession !== this._ttsSessionId) return true;
      if (i + 1 < chunks.length) {
        prefetched = window.navio.navioTTS(ttsPayload(chunks[i + 1]));
      }
      const isLast = i === chunks.length - 1;
      if (!result || !result.ok || !result.audio) {
        const tail = chunks.slice(i).join('').trim();
        if (tail) {
          await this._speakWebSpeechUtterance(tail, voicePref, mySession, btn, true, speechOpts || {});
        } else if (isLast) {
          this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
        }
        return true;
      }
      await this._playOpenAITtsClip(result, mySession, btn, isLast);
      if (this._voiceConvActive && !isLast) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return true;
  }

  /** Web Speech fallback / tail after chunked OpenAI partial failure. */
  async _speakWebSpeechUtterance(plain, voicePref, mySession, btn, isLastChunk = true, speechOpts = {}) {
    if (mySession !== this._ttsSessionId) return;
    if (!window.speechSynthesis) {
      if (btn) btn.classList.remove('tts-speaking');
      if (isLastChunk) {
        this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
      }
      return;
    }
    if (btn) {
      btn.classList.remove('tts-loading');
      btn.classList.add('tts-speaking');
    }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(plain);
    const voices = window.speechSynthesis.getVoices();
    const isFemalePref =
      typeof window.navioTtsVoiceFemalePreferred === 'function'
        ? window.navioTtsVoiceFemalePreferred(voicePref)
        : voicePref === 'nova' || voicePref === 'shimmer' || voicePref === 'alloy';
    const scoreVoice = (v) => {
      let score = 0;
      if (/en[-_]US/i.test(v.lang)) score += 10;
      else if (/en/i.test(v.lang)) score += 5;
      if (/online|neural|natural/i.test(v.name)) score += 8;
      if (/premium|enhanced/i.test(v.name)) score += 4;
      const isFemale = /ava|emma|aria|nova|shimmer|zira|samantha|victoria|karen|moira|siri|google uk english female|female/i.test(v.name);
      const isMale = /andrew|ryan|echo|onyx|guy|luca|daniel|rishi|aaron|male/i.test(v.name);
      if (isFemalePref && isFemale) score += 6;
      if (!isFemalePref && isMale) score += 6;
      return score;
    };
    if (voices.length > 0) {
      const sorted = voices.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a));
      const best = sorted[0];
      if (best) utt.voice = best;
    }
    const baseRate = this._voiceConvActive ? 0.84 : 0.92;
    utt.rate =
      typeof speechOpts.webSpeechRate === 'number' && Number.isFinite(speechOpts.webSpeechRate)
        ? speechOpts.webSpeechRate
        : baseRate;
    utt.pitch = isFemalePref ? 1.05 : 0.9;
    utt.volume = 1.0;
    this._setTTSBarVisible(true, 'Reading aloud…');
    await new Promise((resolve) => {
      utt.onend = () => {
        if (mySession !== this._ttsSessionId) {
          resolve();
          return;
        }
        if (btn) btn.classList.remove('tts-speaking');
        if (isLastChunk) this._setTTSBarVisible(false);
        if (isLastChunk) {
          this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
        }
        resolve();
      };
      utt.onerror = () => {
        if (mySession !== this._ttsSessionId) {
          resolve();
          return;
        }
        if (btn) btn.classList.remove('tts-speaking', 'tts-loading');
        if (isLastChunk) this._setTTSBarVisible(false);
        if (isLastChunk) {
          this._scheduleVoiceConvListen(NAVIO_VOICE_CONV_AFTER_TTS_MS);
        }
        resolve();
      };
      window.speechSynthesis.speak(utt);
    });
  }

  /**
   * Speak text using OpenAI TTS (nova = female, onyx = male) with Web Speech API as fallback.
   * Prefers the configured voice gender preference.
   * @param {string} text - Text to speak
   * @param {HTMLElement|null} btn - TTS button element for state management (loading → speaking → done)
   * @param {{ speed?: number, workNudge?: boolean, humanPace?: boolean, webSpeechRate?: number }} [opts]
   */
  async _speakText(text, btn = null, opts = {}) {
    if (!text) return;
    let plain = this._prepareSpeechText(this._stripMarkdown(text));
    if (!plain) return;
    if (this._voiceConvActive && opts.humanPace !== false) {
      plain = navioAddSpokenBreathingPauses(plain);
    }

    // Stop any current speech and claim this session — any prior in-flight _speakText
    // will see a mismatched session ID after its awaits and bail without playing.
    this._stopSpeaking();
    const mySession = ++this._ttsSessionId;

    void this._refreshCachedTtsVoice();
    const voicePref = this._cachedTtsVoice || 'nova';

    if (mySession !== this._ttsSessionId) return;

    const ttsSpeed =
      opts.speed != null && Number.isFinite(Number(opts.speed))
        ? Number(opts.speed)
        : this._voiceConvActive
          ? opts.workNudge
            ? 0.82
            : 0.9
          : undefined;
    const speechOpts = {};
    if (opts.webSpeechRate != null && Number.isFinite(Number(opts.webSpeechRate))) {
      speechOpts.webSpeechRate = Number(opts.webSpeechRate);
    } else if (this._voiceConvActive) {
      speechOpts.webSpeechRate = opts.workNudge ? 0.8 : 0.84;
    }

    const chunkPlan = navioVoiceConvTtsChunkPlan(plain.slice(0, 4000));
    const useChunkedOpenAi =
      window.navio?.navioTTS &&
      !opts.workNudge &&
      plain.length > NAVIO_VOICE_TTS_FIRST_CHUNK &&
      chunkPlan.length > 1;

    if (useChunkedOpenAi) {
      const handled = await this._speakVoiceConvChunkedPipeline(
        plain,
        voicePref,
        mySession,
        btn,
        ttsSpeed,
        speechOpts
      );
      if (handled) return;
    }

    // Try OpenAI TTS first (much more human-sounding)
    if (window.navio && window.navio.navioTTS) {
      try {
        const req = { text: plain.slice(0, 4000), voice: voicePref };
        if (ttsSpeed != null && Number.isFinite(ttsSpeed)) req.speed = ttsSpeed;
        const result = await window.navio.navioTTS(req);

        // Bail if superseded while waiting for TTS IPC
        if (mySession !== this._ttsSessionId) return;

        if (result && result.ok && result.audio) {
          await this._playOpenAITtsClip(result, mySession, btn, true);
          return;
        }
      } catch { /* fall through to Web Speech API */ }
    }

    // Bail again if superseded before reaching Web Speech fallback
    if (mySession !== this._ttsSessionId) return;

    await this._speakWebSpeechUtterance(plain, voicePref, mySession, btn, true, speechOpts);
  }

  /** Short spoken status while tools run (voice conversation); avoids long silent gaps. */
  async _speakVoiceConvWorkNudge(snippet) {
    const s = String(snippet || '').trim();
    if (!this._voiceConvActive || !s) return;
    if (s.length > 900) return;
    await this._speakText(s, null, { speed: 0.82, workNudge: true, humanPace: true });
  }

  /** Show / hide the persistent TTS active bar above the input area. */
  _setTTSBarVisible(visible, label = 'Reading aloud…') {
    // During voice conversation we hide the duplicate "reading" chrome on **show** only;
    // **hide** must always run so Stop / End can clear a stale bar left from prior read-aloud.
    if (visible && this._voiceConvActive) return;
    const bar = document.getElementById('tts-active-bar');
    if (!bar) return;
    const lbl = bar.querySelector('.tts-active-label');
    if (lbl) lbl.textContent = label;
    bar.hidden = !visible;
    if (visible) {
      // Trigger entrance animation
      requestAnimationFrame(() => bar.classList.add('tts-bar-show'));
    } else {
      bar.classList.remove('tts-bar-show');
    }
  }

  /** Called by the Stop button in the TTS active bar. */
  _stopTTSFromBar() {
    this._stopSpeaking({ resumeVoiceListen: !!this._voiceConvActive });
    // Clear any active button states in the messages list
    if (this.messagesEl) {
      this.messagesEl.querySelectorAll('.assistant-tts-btn.tts-speaking, .assistant-tts-btn.tts-loading')
        .forEach(b => b.classList.remove('tts-speaking', 'tts-loading'));
    }
  }

  /**
   * Stop any in-progress speech and cancel any pending _speakText IPC calls.
   * @param {{ resumeVoiceListen?: boolean }} [opts] - If true and voice conv is active, reopen the mic after a user Stop on read-aloud (OpenAI clips do not fire `ended` when paused).
   */
  _stopSpeaking(opts = {}) {
    const resumeMic = !!opts.resumeVoiceListen && this._voiceConvActive;
    // Increment session so any in-flight _speakText awaits abort themselves
    this._ttsSessionId = (this._ttsSessionId || 0) + 1;
    if (this._currentAudio) {
      try { this._currentAudio.pause(); this._currentAudio.currentTime = 0; } catch { /* ignore */ }
      this._currentAudio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    this._setTTSBarVisible(false);
    if (resumeMic) this._scheduleVoiceConvListen(0);
  }

  /**
   * Returns HTML for a speaker icon button to append after an AI reply bubble.
   * The button's click is delegated via the messages container.
   */
  _makeTTSButton(text) {
    const safe = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
    return `<button class="assistant-tts-btn msg-tts-btn" type="button" title="Read aloud" data-tts="${safe.slice(0, 4000)}">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
    </button>`;
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

    // Bucket tabs by group, preserving strip order
    const byGroup = new Map();
    const ungrouped = [];
    for (const t of allTabs) {
      const gid = t.groupId && TabManager.groups?.[t.groupId] ? t.groupId : null;
      if (gid) {
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(t);
      } else {
        ungrouped.push(t);
      }
    }

    const lines = [];

    // Groups first — each as a labeled block so the AI clearly sees them as units
    for (const [gid, tabs] of byGroup) {
      const name = TabManager.getTabGroupLabel?.(tabs[0]) || gid;
      lines.push(`[Tab group "${name}" · group_id=${gid} · ${tabs.length} tab${tabs.length !== 1 ? 's' : ''} — use switch_tab between any member]`);
      for (const t of tabs) {
        const title = TabManager.getTabDisplayTitle(t) || t.url;
        const act = t.id === activeId ? ' [active]' : '';
        lines.push(`  tab_id=${t.id}${act} — ${title} — ${t.url}`);
      }
    }

    // Ungrouped tabs
    if (ungrouped.length) {
      if (byGroup.size > 0) lines.push('[Ungrouped tabs]');
      for (const t of ungrouped) {
        const title = TabManager.getTabDisplayTitle(t) || t.url;
        const act = t.id === activeId ? ' [active]' : '';
        lines.push(`  tab_id=${t.id}${act} — ${title} — ${t.url}`);
      }
    }

    return lines.join('\n');
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
        this._fitAssistantInputHeight();
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
          const body = (content.text || '').slice(0, 30000);
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

  /**
   * When the browsing-context tab is in a group, fetch and return page content for every
   * OTHER member of that group. This means the AI always has full context for the whole
   * group without the user needing to @mention each tab individually.
   */
  async _fetchGroupSiblingContext() {
    if (typeof TabManager === 'undefined') return [];
    const ctxTab = typeof TabManager.getBrowserContextTab === 'function'
      ? (TabManager.getBrowserContextTab() || TabManager.getActiveTab())
      : TabManager.getActiveTab();
    if (!ctxTab?.groupId) return [];
    const siblings = TabManager.tabs.filter(t =>
      t.groupId === ctxTab.groupId &&
      t.id !== ctxTab.id &&
      t.webview &&
      t.url &&
      !t.url.startsWith('about:')
    );
    if (!siblings.length) return [];
    return this._fetchTabContextForTabs(siblings, 'Tab group member');
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

    // Relational intent: user is comparing or referencing info across tabs without naming them.
    // Auto-inject body of up to 3 other open real tabs so the model doesn't need to switch_tab.
    const relationalIntent =
      /\b(for the|from the|on the|using the|based on|vs\.?|versus|compare|compared to|cross.?ref|against|match(ing)?|related to|link(ed)? to|the (other|second|another) tab|both tabs?|all (open )?tabs?|the (po|so|order|invoice|quote|document|form|sheet|file|page) (in|on|from) the (other|other tab|tab))\b/i.test(text) ||
      /\bwhat (comments?|notes?|fields?|info|information|data|details?|values?|text)\s+(should|do|can|to)\s+(i\s+)?(put|add|write|enter|fill|use|type)\b/i.test(text);

    if (relationalIntent && typeof TabManager !== 'undefined') {
      const activeId = TabManager.getActiveTab?.()?.id;
      const browserCtxId = TabManager.getBrowserContextTab?.()?.id;
      const knownIds = new Set([...(ex || []), ...(toFetch.map((t) => t.id))]);
      if (activeId) knownIds.add(activeId);
      if (browserCtxId) knownIds.add(browserCtxId);
      const otherTabs = TabManager.tabs
        .filter((t) => t.webview && t.url && !t.url.startsWith('about:') && !knownIds.has(t.id))
        .slice(0, 3);
      if (otherTabs.length) {
        const otherCtx = await this._fetchTabContextForTabs(otherTabs, 'Related open tab');
        return [...(await this._fetchTabContextForTabs(toFetch, 'Matched tab from your message')), ...otherCtx];
      }
    }

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
      if (this._sidebarThreadKey) {
        const sk = this._sidebarThreadKey;
        const busy = this._busyTabs.has(sk);
        if (!busy) {
          const h = this._conversationsByTab.get(sk) || [];
          if (h.length) this._renderDomFromHistoryKey(sk);
          else {
            this.messagesEl.innerHTML = '';
            await this._showGreeting();
          }
        }
      } else if (aid) {
        await this._syncPanelToTab(aid);
      }
      this._renderSidebarSessionList();
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
    setTimeout(() => {
      this.inputEl?.focus();
      this._fitAssistantInputHeight();
    }, 300);
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
      // Render the greeting text first (no raw HTML in the string — formatMessage escapes it)
      this.addMessage('assistant', `Hey${name}! I'm Navio — your AI co-pilot.\n\nJust ask me anything — about the page you're on, the web, your emails, or any task you want automated.`);
      // Then inject the page-context hint as a real DOM node into the last message's content area
      if (tab && tab.url && !tab.url.startsWith('about:')) {
        const lastMsg = this.messagesEl?.lastElementChild;
        const contentEl = lastMsg?.querySelector('.message-content');
        if (contentEl) {
          const hint = document.createElement('p');
          hint.style.cssText = 'font-size:12px;color:var(--text-tertiary);margin-top:6px';
          hint.textContent = 'On: ';
          const span = document.createElement('span');
          span.style.color = 'var(--text-accent)';
          span.textContent = TabManager.getTabDisplayTitle(tab) || tab.url;
          hint.appendChild(span);
          contentEl.appendChild(hint);
        }
      }
      /* addMessage() sets scrollTop to bottom; for a short greeting we want the thread pinned to the top. */
      if (this.messagesEl) this.messagesEl.scrollTop = 0;
    } catch {
      this.addMessage('assistant', "Hey! I'm Navio — your AI co-pilot. How can I help?");
      if (this.messagesEl) this.messagesEl.scrollTop = 0;
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
    this.inputEl = document.getElementById('assistant-input') || this.inputEl;
    if (!this.inputEl) return;
    // `addMessage` is gated by `_panelShowsTurnDom()` vs `_panelDisplayTabId`. That id can go stale
    // (e.g. tab switch edge cases, "This tab" vs saved thread) so the composer clears but bubbles never render.
    if (!this._sidebarThreadKey) {
      if (typeof TabManager !== 'undefined' && TabManager.activeTabId) {
        this._panelDisplayTabId = String(TabManager.activeTabId);
      } else {
        this._panelDisplayTabId = null;
      }
    }
    const text = this.inputEl.value.trim();
    const hasReadyAttachments = this._attachmentQueue.some((a) => a.status === 'ready');
    if (this._attachmentsStillLoading()) {
      this.addMessage('assistant', 'Wait until attachments finish loading.', 'error');
      return;
    }
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if ((!text && !hasReadyAttachments) || this._threadBusyForSend() || (aid && this._tabIsBusy(aid))) return;

    if (text.startsWith('>>')) {
      if (hasReadyAttachments) {
        this.addMessage('assistant', 'Remove attachments before using **>>** research.', 'error');
        return;
      }
      const q = text.slice(2).trim();
      this.inputEl.value = '';
      this._fitAssistantInputHeight();
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
      this._fitAssistantInputHeight();
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
    if (this._voiceConvActive) this._voiceConvSetState('thinking');
    this.inputEl.value = '';
    this._fitAssistantInputHeight();

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
    if (this._threadBusyForSend() || (aid && this._tabIsBusy(aid))) return;
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
      const rawBody = page.text || '';
      const body = rawBody.slice(0, 40000);
      const truncated = rawBody.length > 40000;
      this.setReceipt(`Scope: excerpt — title + headings + ${body.length} chars of body${truncated ? ' (truncated)' : ''}.`);
      return {
        role: 'system',
        content: `[Current page context — excerpt]\nTitle: ${page.title}\nURL: ${page.url}\nDescription: ${page.description || 'N/A'}\nHeadings:\n${heads}\n\nBody${truncated ? ' (truncated — ask me to read a specific section for more)' : ''}:\n${body}`
      };
    }

    const rawBody = page.text || '';
    const body = rawBody.slice(0, 60000);
    const truncated = rawBody.length > 60000;
    this.setReceipt(`Scope: extended — large extract (${body.length} chars${truncated ? ', truncated' : ''}).`);
    return {
      role: 'system',
      content: `[Current page context — extended]\nTitle: ${page.title}\nURL: ${page.url}\n\n${body}${truncated ? '\n\n[Content truncated — ask me to read a specific section for more]' : ''}`
    };
  }

  setReceipt(text) {
    if (this.receiptEl) this.receiptEl.textContent = text || '';
  }

  /** Abort streaming or tool-loop for the active tab only (other tabs keep running). */
  stopGeneration() {
    try {
      if (window.navio && typeof window.navio.aiAbort === 'function') {
        let sk = this._turnConversationKey ? String(this._turnConversationKey) : '';
        if (!sk) {
          const t = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
          sk = t ? this._storageKeyForTab(t) : '';
        }
        void window.navio.aiAbort(sk ? { tabId: sk } : {});
      }
    } catch {
      /* ignore */
    }
  }

  _threadBusyForSend() {
    if (this._sidebarThreadKey && this._busyTabs.has(this._sidebarThreadKey)) return true;
    return false;
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
    this._syncTabStripBadge(k, busy);
  }

  /** Add or remove the pulsing AI-busy badge on the tab strip item(s) for the given storage key. */
  _syncTabStripBadge(storageKey, busy) {
    if (!storageKey || storageKey === '__profile__' || storageKey === '__guest__') return;
    try {
      if (storageKey.startsWith('g:')) {
        const groupId = storageKey.slice(2);
        if (typeof TabManager === 'undefined' || !TabManager.tabs) return;
        for (const tab of TabManager.tabs) {
          if (tab.groupId !== groupId) continue;
          const el = document.getElementById(`tabitem-${tab.id}`);
          el?.classList.toggle('tab-ai-busy', !!busy);
        }
      } else {
        const el = document.getElementById(`tabitem-${storageKey}`);
        el?.classList.toggle('tab-ai-busy', !!busy);
      }
    } catch (_) { /* non-critical */ }
  }

  _updateAssistantBusyChrome() {
    const active = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
    const sk = active ? this._storageKeyForTab(active) : '';
    const sbBusy = !!(this._sidebarThreadKey && this._busyTabs.has(this._sidebarThreadKey));
    const busy = sbBusy || !!(active && sk && this._busyTabs.has(sk));
    const stop = document.getElementById('btn-assistant-stop');
    const send = document.getElementById('btn-send-message');
    if (stop) {
      stop.hidden = !busy;
      stop.disabled = !busy;
    }
    if (send) send.hidden = !!busy;
  }

  /**
   * Show a toast notification when an AI turn completes on a background tab.
   * Clicking the toast switches to that tab so the user can read the response.
   */
  _showBackgroundCompletionToast(storageKey) {
    try {
      if (typeof TabManager === 'undefined') return;
      const activeTab = TabManager.getActiveTab();
      const activeStorageKey = activeTab ? this._storageKeyForTab(activeTab) : null;
      if (activeStorageKey === storageKey) return; // User is already on this tab

      // Resolve the tab to jump to
      let targetTabId = null;
      let tabTitle = 'another tab';
      if (storageKey && storageKey.startsWith('g:')) {
        const groupId = storageKey.slice(2);
        const groupTab = TabManager.tabs.find((t) => t.groupId === groupId);
        if (groupTab) { targetTabId = groupTab.id; tabTitle = groupTab.customTitle || groupTab.title || tabTitle; }
      } else if (storageKey && storageKey !== '__profile__' && storageKey !== '__guest__') {
        const tab = TabManager.tabs.find((t) => String(t.id) === storageKey);
        if (tab) { targetTabId = tab.id; tabTitle = tab.customTitle || tab.title || tabTitle; }
      }
      if (!targetTabId) return;

      const stack = document.getElementById('live-notif-stack');
      if (!stack) return;

      const el = document.createElement('div');
      el.className = 'live-notification live-toast live-toast-navio-ai';
      el.id = `navio-ai-toast-${Date.now()}`;
      const safeTitle = tabTitle.length > 32 ? tabTitle.slice(0, 30) + '\u2026' : tabTitle;
      el.innerHTML = `
        <span class="live-toast-icon navio-ai-toast-icon">&#x2728;</span>
        <span class="live-toast-msg">Navio finished on <strong>${safeTitle}</strong></span>
        <button type="button" class="live-toast-jump-btn">View</button>
        <button type="button" class="live-notif-x">\u00d7</button>`;

      const jumpBtn = el.querySelector('.live-toast-jump-btn');
      const closeBtn = el.querySelector('.live-notif-x');
      const _dismiss = () => el.remove();
      jumpBtn.addEventListener('click', () => {
        TabManager.switchToTab(targetTabId);
        _dismiss();
      });
      closeBtn.addEventListener('click', _dismiss);
      stack.prepend(el);
      setTimeout(_dismiss, 8000);
    } catch (_) { /* non-critical */ }
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

    // ── Tool-calling mode (single agentic path) ─────────────────────────────
    // All requests go through _processWithTools when tool calling is enabled.
    // The legacy XML action path is kept only as a fallback when explicitly disabled.
    if (config.aiUseToolCalling !== false) {
    try {
      await this._processWithTools(text, config, historyUserLabel || this._historyLabelForAttachments(text), null, { isQuickAction });
    } catch (err) {
      this.removeTypingIndicator();
      this._turnStartedAt = null;
      this.addMessage('assistant', err.message || 'Tool-calling error', 'error');
    }
      return;
    }
    // ── Legacy <navio-actions> path (only when aiUseToolCalling explicitly false) ──

    const messages = [{ role: 'system', content: this.systemPrompt }];

    // ── Voice conversation mode (same instructions as tool-calling path) ───
    const _voiceLegacy = this._voiceConversationModeSystemMessage();
    if (_voiceLegacy) messages.push(_voiceLegacy);

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

      // When the browsing-context tab is in a group, spell out the group explicitly
      const ctxTab = typeof TabManager.getBrowserContextTab === 'function'
        ? (TabManager.getBrowserContextTab() || TabManager.getActiveTab())
        : TabManager.getActiveTab();
      if (ctxTab?.groupId && TabManager.groups?.[ctxTab.groupId]) {
        const gid = ctxTab.groupId;
        const groupName = TabManager.getTabGroupLabel?.(ctxTab) || gid;
        const members = TabManager.tabs.filter(t => t.groupId === gid);
        const memberLines = members.map(t => {
          const title = TabManager.getTabDisplayTitle(t);
          const cur = t.id === ctxTab.id ? ' [current]' : '';
          return `  tab_id=${t.id}${cur} — ${title} — ${t.url}`;
        }).join('\n');
        messages.push({
          role: 'system',
          content:
            `[Active tab group: "${groupName}" · group_id=${gid} · ${members.length} tab${members.length !== 1 ? 's' : ''}]\n` +
            `All tabs in this group share conversation memory. Use switch_tab to move between them without losing context.\n` +
            memberLines
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

    // When the active tab is in a group, auto-inject the other group members' content
    const groupSiblingMsgs = await this._fetchGroupSiblingContext();

    const tabCtxN = mentionMsgs.length + implicitTabMsgs.length + groupSiblingMsgs.length;
    if (tabCtxN) {
      messages.push({
        role: 'system',
        content: `[Multi-tab context — ${tabCtxN} tab(s)${mentionMsgs.length ? ' (@mention and/or wording match)' : ''}${groupSiblingMsgs.length ? ` · ${groupSiblingMsgs.length} from your tab group` : ''}]`
      });
      messages.push(...mentionMsgs, ...implicitTabMsgs, ...groupSiblingMsgs);
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
    // Pre-work acknowledgment: for multi-step tool tasks, output one brief natural sentence before
    // the first tool call so the user knows you heard them. Text surfaces as a chat bubble.
    if (!isQuickAction) {
      messages.push({
        role: 'system',
        content:
          '[Pre-work acknowledgment]\n' +
          'When this task will require multiple tool calls (browsing, searching, filling forms, reading emails, etc.), ' +
          'output ONE brief natural sentence BEFORE your first tool call. For example: ' +
          '"On it \u2014 opening that now." or "Let me look that up." or "Got it, searching for that." ' +
          'This sentence is shown as a chat bubble so the user knows you are working and not silent. ' +
          'Do NOT start with filler: no "Sure!", "Certainly!", "Of course!", "Absolutely!". ' +
          'Skip entirely for: instant single-tool answers, pure question responses, or when asking the user a clarifying question.'
      });
    }
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
      // Do NOT call _syncPanelToTab here: it replays from `_conversationsByTab` and can wipe the live
      // transcript (empty key / wrong-tab timing / async ordering) back to the welcome screen mid-work.
      // Tab switches already call _syncPanelToTab from onActiveTabChanged; addMessage keeps DOM in sync.
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

    // ── Comet-style anchoring: tie this chat to a specific web tab ─────────
    if (payload.action === 'anchorTab') {
      this._guestAnchoredTabId = payload.tabId || null;
      return;
    }
    // Push the existing sidebar conversation for the anchored tab to the chat page
    if (payload.action === 'requestHistory') {
      void this._ensureAssistantHistoryLoaded().then(() => {
        const gkey = this._guestConversationKey();
        const history = this._conversationsByTab.get(gkey) || [];
        const msgs = history
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : ''
          }));
        this._guestDeliver(guestWv, { type: 'historyLoad', messages: msgs });
      });
      return;
    }

    if (payload.action === 'planAck') {
      try {
        if (payload.approved) window.navio.toolProposePlanAck({ approved: true, title: payload.title });
        else window.navio.toolProposePlanAck({ cancelled: true, title: payload.title });
      } catch {
        /* ignore */
      }
      return;
    }
    if (payload.action === 'gmailSendConfirmAck') {
      try {
        const oid = payload.operationId;
        if (payload.approved) window.navio.toolGmailSendConfirmAck({ approved: true, operationId: oid });
        else window.navio.toolGmailSendConfirmAck({ cancelled: true, operationId: oid });
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
    if (payload.action === 'pauseTakeover') {
      this._pauseTakeover();
      return;
    }
    if (payload.action === 'resumeTakeover') {
      this._resumeTakeover();
      return;
    }
    if (payload.action === 'stopTakeover') {
      this.disableTakeover();
      return;
    }
    if (payload.action === 'openUrl') {
      const url = String(payload.url || '').trim();
      if (url && /^https?:\/\//i.test(url) && typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
        try {
          TabManager.createTab(url);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (payload.action === 'send' && (payload.text || (Array.isArray(payload.files) && payload.files.length))) {
      const text = payload.text != null ? String(payload.text).trim() : '';
      const files = Array.isArray(payload.files) ? payload.files : null;
      void this.processGuestChatMessage(guestWv, text, files);
    }
  }

  /**
   * Build a ready `_attachmentsSnapshot` entry from a payload sent by the
   * full-page chat tab. The tab has already read the file client-side into
   * the same wire shape the sidebar uses (`kind` + `base64`/`dataUrl`/`text`),
   * so we just re-stamp it as "ready" and let the existing API-payload
   * builder (`_buildAttachmentPayloadForApi`) forward it to the model.
   */
  _normalizeGuestAttachment(f) {
    if (!f || typeof f !== 'object') return null;
    const kind = String(f.kind || '').toLowerCase();
    if (!['image', 'pdf', 'text', 'inline', 'binary'].includes(kind)) return null;
    const name = typeof f.name === 'string' && f.name.trim() ? f.name.trim() : 'file';
    const entry = {
      id: `att_guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      name,
      status: 'ready',
      kind,
      thumb: typeof f.thumb === 'string' ? f.thumb : ''
    };
    if (kind === 'image' && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:')) {
      entry.dataUrl = f.dataUrl;
      if (!entry.thumb) entry.thumb = f.dataUrl;
      return entry;
    }
    if (kind === 'pdf' && typeof f.base64 === 'string' && f.base64) {
      entry.base64 = f.base64;
      return entry;
    }
    if (kind === 'text' && typeof f.text === 'string') {
      entry.text =
        f.text.length > NAVIO_ASSISTANT_TEXT_MAX_CHARS
          ? `${f.text.slice(0, NAVIO_ASSISTANT_TEXT_MAX_CHARS)}\n\n… [truncated]`
          : f.text;
      return entry;
    }
    if (kind === 'inline' && typeof f.base64 === 'string' && f.base64) {
      entry.base64 = f.base64;
      entry.mimeType = typeof f.mimeType === 'string' && f.mimeType ? f.mimeType : 'application/octet-stream';
      if (!entry.thumb && entry.mimeType.startsWith('image/')) {
        entry.thumb = `data:${entry.mimeType};base64,${entry.base64}`;
      }
      return entry;
    }
    if (kind === 'binary') return entry;
    return null;
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

  async processGuestChatMessage(guestWv, text, files) {
    await this._ensureAssistantHistoryLoaded();
    if (!guestWv) return;
    const hasFiles = Array.isArray(files) && files.length > 0;
    if (!text && !hasFiles) return;
    const guestKey = this._guestConversationKey();
    if (this._tabIsBusy(guestKey)) {
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
    // Stage attachments for this turn so `_buildAttachmentPayloadForApi` / `_maybePushAttachmentSystemHint`
    // forward them to the model exactly like they do for the sidebar.
    let installedSnapshot = null;
    if (hasFiles) {
      const snapshot = files
        .map((f) => this._normalizeGuestAttachment(f))
        .filter(Boolean);
      if (snapshot.length) {
        installedSnapshot = snapshot;
        this._attachmentsSnapshot = snapshot;
      }
    }
    // Blank text + only attachments: mirror the sidebar's default prompt.
    const effectiveText = text || (installedSnapshot ? 'Please help with the attached file(s).' : '');
    const prevTurn = this._turnConversationKey;
    this._turnConversationKey = guestKey;
    this._setTabBusy(guestKey, true);
    this._updateAssistantBusyChrome();
    // Signals a full-page guest turn to TabManager.getBrowserContextTab() (tools + streaming).
    this._guestChatWebview = guestWv;
    try {
      if (config.aiUseToolCalling !== false) {
        await this._processWithTools(effectiveText, config, this._historyLabelForAttachments(effectiveText), guestWv);
      } else {
        await this._processGuestLegacyAi(guestWv, effectiveText, config);
      }
    } catch (err) {
      this._guestDeliver(guestWv, { type: 'assistant', error: true, content: err.message || String(err) });
    } finally {
      this._guestChatWebview = null;
      this._turnConversationKey = prevTurn;
      this._setTabBusy(guestKey, false);
      this._updateAssistantBusyChrome();
      if (installedSnapshot && this._attachmentsSnapshot === installedSnapshot) {
        this._attachmentsSnapshot = null;
      }
      // Sync the sidebar panel for the anchored tab so it reflects the new messages
      if (this._guestAnchoredTabId) {
        void this._syncPanelToTab(this._guestAnchoredTabId);
      }
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

    // Use the already-set _turnConversationKey so stream chunks are routed
    // to the same bucket as the conversation history (anchored tab or '__guest__').
    const gsk = String(this._turnConversationKey || '__guest__');
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
  async _processWithTools(text, config, historyUserLabel, guestWv = null, opts = {}) {
    const isQuickAction = !!(opts && opts.isQuickAction);
    this._guestChatWebview = guestWv || null;
    try {
    const tk = String(this._turnConversationKey || '__default__');
    if (this.inputEl && typeof this.inputEl.blur === 'function') this.inputEl.blur();

    // ── Agent Router — detect domain and add focused context ────────────────
    const agentDomain = this._detectAgentDomain(text, typeof TabManager !== 'undefined' ? TabManager.getActiveTab()?.url || '' : '');

    // Build context messages
    const messages = [{ role: 'system', content: this.systemPrompt }];
    // Inject domain-specific focus hint so the model behaves like a specialist
    if (agentDomain && agentDomain !== 'general') {
      messages.push({ role: 'system', content: this._agentDomainFocusHint(agentDomain) });
    }
    const _voiceTools = this._voiceConversationModeSystemMessage();
    if (_voiceTools) messages.push(_voiceTools);
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

    if (!isQuickAction) {
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

      // Connector context (Perplexity, Gmail, Drive, etc.)
      if (typeof ConnectorsManager !== 'undefined') {
        const connectorCtx = await this._buildConnectorContext(text, this._connectorOptsFromConfig(config));
        if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
      }
    }

    messages.push({
      role: 'system',
      content:
        '[Thread discipline]\nThe **latest user message** (see **What to do now** on it) is the only target. ' +
        'Do not do work they did not ask for. Do not switch to a new goal mid-turn. ' +
        'Earlier messages are context only; short replies mean “continue the same task,” not “start something new.”'
    });
    // Pre-work acknowledgment: output one brief sentence before first tool call so the user isn't silent.
    // This text is sent via tr() as bubble:true and surfaced as a chat message above the Working card.
    if (!isQuickAction) {
      messages.push({
        role: 'system',
        content:
          '[Pre-work acknowledgment]\n' +
          'When this task requires multiple tool calls (browsing, filling forms, searching, reading emails, etc.), ' +
          'output ONE brief natural sentence BEFORE your first tool call. Examples: ' +
          '"On it - opening that now." or "Let me look that up." or "Got it, searching for that." ' +
          'This sentence appears as a chat bubble immediately so the user sees you are working. ' +
          'Do NOT use filler openers: no "Sure!", "Certainly!", "Of course!", "Absolutely!". ' +
          'Skip for: instant single-tool answers, pure question responses, clarifying questions.'
      });
    }

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
        '<div class="naa-header"><span class="naa-header-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg></span><span class="naa-header-text"><span class="naa-title">On it</span><span class="naa-sub">Running steps in order</span></span></div><div class="naa-steps"></div>';
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

    // Set up reasoning handler (intermediate AI thinking during tool loop).
    // step-0 text (the model's initial acknowledgment before first tools) surfaces as a real chat bubble
    // inserted above the Working card so the user sees "On it — navigating to X now" instead of silence.
    const unReasoning = window.navio.onToolReasoning?.((payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { step, text, bubble } = payload || {};
      if (!text) return;
      const snippet = text.trim();
      if (bubble && snippet.length > 8) {
        if (this._currentActivityEl) {
          // Remove the typing indicator (it's been replaced by the activity card already, but clean up just in case)
          this.removeTypingIndicator();
          // Build a proper assistant message bubble and insert it BEFORE the Working card
          const msgEl = document.createElement('div');
          msgEl.className = 'message assistant-message naa-pre-work-bubble';
          msgEl.appendChild(this._messageRoleStrip('assistant', ''));
          const contentEl = document.createElement('div');
          contentEl.className = 'message-content';
          contentEl.innerHTML = this.formatMessage(text, true);
          msgEl.appendChild(contentEl);
          this._currentActivityEl.parentNode.insertBefore(msgEl, this._currentActivityEl);
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        } else if (guestWv) {
          this._guestDeliver(guestWv, { type: 'preWorkBubble', text: snippet });
        }
        if (this._voiceConvActive) {
          void this._speakVoiceConvWorkNudge(snippet);
        }
      } else {
        this._appendActivityStep('thinking', text.slice(0, 200) + (text.length > 200 ? '...' : ''));
      }
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

    const unGmailSendConfirm = window.navio.onToolGmailSendConfirm?.((payload) => {
      if (payload && payload.tabId != null && String(payload.tabId) !== tk) return;
      const { draftId, operationId } = payload || {};
      const did = String(draftId || '').trim() || '(unknown draft)';
      this._appendActivityStep('gmail_send_draft', 'Waiting for send confirmation…');
      if (guestWv) {
        this._guestDeliver(guestWv, {
          type: 'gmailSendConfirm',
          draftId: did,
          operationId
        });
        return;
      }
      const card = document.createElement('div');
      card.className = 'navio-plan-card navio-gmail-send-confirm';
      card.innerHTML =
        `<div class="npc-title">Send this email now?</div>` +
        `<div class="npc-meta">Draft ID: <code class="navio-send-draft-id">${this._escapeHtml(did)}</code></div>` +
        `<div class="npc-meta npc-risks">This uses Gmail’s API to dispatch the message from your account (not the browser Send button).</div>` +
        `<div class="npc-actions">` +
        `<button class="npc-btn npc-approve" type="button">Confirm send</button>` +
        `<button class="npc-btn npc-cancel" type="button">Cancel</button>` +
        `</div>`;
      this.messagesEl.appendChild(card);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

      card.querySelector('.npc-approve').addEventListener('click', () => {
        card.querySelector('.npc-actions').innerHTML = '<span class="npc-approved">Confirmed — sending…</span>';
        window.navio.toolGmailSendConfirmAck({ approved: true, operationId });
      });
      card.querySelector('.npc-cancel')?.addEventListener('click', () => {
        card.querySelector('.npc-actions').innerHTML = '<span class="npc-cancelled">Send cancelled</span>';
        window.navio.toolGmailSendConfirmAck({ cancelled: true, operationId });
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
      // Update the typing indicator label in real-time (Comet-style)
      this._updateTypingLabel(tool);
      const label = this._toolProgressLabel(tool, result);
      this._appendActivityStep(tool, label);
      if (
        this._voiceConvActive &&
        tool &&
        tool !== 'navigate' &&
        tool !== 'thinking' &&
        label &&
        String(label).length < 130
      ) {
        const now = Date.now();
        if (now - (this._voiceConvProgressTtsAt || 0) > 6200) {
          this._voiceConvProgressTtsAt = now;
          void this._speakVoiceConvWorkNudge(String(label));
        }
      }
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
    if (unGmailSendConfirm) unGmailSendConfirm();
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
        header.innerHTML = `<span class="naa-header-icon naa-header-icon--done"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span><span class="naa-header-text"><span class="naa-title">All set${stepsCount ? ` · ${stepsCount} step${stepsCount === 1 ? '' : 's'}` : ''}</span><span class="naa-sub">Answer below</span></span>`;
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
        // Collect citations from web_search tool calls in this run
        const toolSearchCitations = (response.toolLog || [])
          .filter((t) => t.tool === 'web_search' && Array.isArray(t.result?.citations) && t.result.citations.length)
          .flatMap((t) => t.result.citations)
          .filter((u) => typeof u === 'string' && u.startsWith('http'))
          .slice(0, 12);
        const connectorCites = (this._pendingConnectorCitations || []).filter((u) => typeof u === 'string');
        const allCitations = [...new Set([...toolSearchCitations, ...connectorCites])];
        const meta = {};
        if (allCitations.length) meta.citations = allCitations;
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
      // Guest turns: processGuestChatMessage owns _guestChatWebview lifecycle (Comet-style context).
      if (!guestWv) this._guestChatWebview = null;
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
    // Human-readable tool badges (Comet-style)
    const TOOL_BADGES = {
      thinking: 'Thinking…', navigate: 'Open', read_page: 'Look', get_page_text: 'Pull text',
      click: 'Tap', type_text: 'Fill', scroll: 'Scroll', screenshot: 'Snap',
      press_key: 'Key', insert_text: 'Paste', wait: 'Wait', go_back: 'Back', go_forward: 'Forward',
      open_tab: 'New tab', close_tab: 'Close tab', switch_tab: 'Switch tab', list_tabs: 'Tabs',
      read_console: 'Console', read_network: 'Network', propose_plan: 'Plan',
      list_workflows: 'Workflows', run_workflow: 'Run workflow',
      gmail_search: 'Gmail', gmail_get_message: 'Gmail', gmail_list_drafts: 'Drafts',
      gmail_create_draft: 'Draft', gmail_create_reply_draft: 'Reply draft',
      gmail_update_draft: 'Update draft', gmail_delete_draft: 'Delete draft',
      gmail_send_draft: 'Send', web_search: 'Web search'
    };
    const toolShown = TOOL_BADGES[tool] || this._escapeHtml(String(tool));
    const toolClass = tool === 'web_search' ? 'naa-tool naa-tool--search' : 'naa-tool';
    const n = stepsEl.children.length + 1;
    step.innerHTML = `<span class="naa-step-index" aria-hidden="true">${n}</span><span class="${toolClass}">${toolShown}</span><span class="naa-label">${this._escapeHtml(String(label))}</span>`;
    stepsEl.appendChild(step);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  _toolProgressLabel(tool, result) {
    if (result?.error) return `Error: ${result.error}`;
    switch (tool) {
      case 'read_page': return `Checked the page (${result?.title || 'untitled'})`;
      case 'get_page_text': return `Pulled about ${((result?.text || '').length / 1000).toFixed(1)}k of text`;
      case 'click': return `Clicked${result?.success ? '' : ' (no luck)'}`;
      case 'type_text': return `Filled a field`;
      case 'select_option': return `Chose an option`;
      case 'scroll': return `Scrolled the view`;
      case 'press_key': return `Sent a key`;
      case 'screenshot': return `Grabbed a screenshot`;
      case 'insert_text': return `Pasted into the field`;
      case 'wait': return `Paused briefly`;
      case 'go_back': return `Went back a page`;
      case 'go_forward': return `Went forward`;
      case 'open_tab': return `Opened a tab${result?.url ? ': ' + result.url : ''}`;
      case 'close_tab': return `Closed a tab`;
      case 'switch_tab': return `Jumped to${result?.title ? ' ' + result.title : ' another tab'}`;
      case 'list_tabs': return `Listed ${result?.tabs?.length || 0} open tabs`;
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
      case 'web_search': {
        if (result?.error) return `Search failed: ${result.error}`;
        const cites = Array.isArray(result?.citations) ? result.citations.length : 0;
        return `Web search${cites ? ` (${cites} sources)` : ''}`;
      }
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
        const { clean: cleanBuffer, chips: streamChips } = this._extractFollowUpChips(buffer);
        if (contentEl) {
          contentEl.classList.remove('streaming-content');
          contentEl.innerHTML = this.formatMessage(cleanBuffer, true);
          await this._wireActions(contentEl);
          this._checkAndShowActionFormatWarning(cleanBuffer, streamingMsg);
        }
        this._attachCopyButtonToMessage(streamingMsg, contentEl);
        this._attachReadAloudButtonToMessage(streamingMsg, contentEl);
        const autoSpeakPlain = (contentEl.innerText || contentEl.textContent || '').trim().slice(0, 4000);
        if (!streamCancelled && autoSpeakPlain) {
          this._maybeAutoSpeakAssistantReply(autoSpeakPlain);
        }
        if (elapsed != null) this._appendMessageDurationRow(streamingMsg, elapsed);
        if (this._pendingConnectorCitations && this._pendingConnectorCitations.length) {
          this._appendCitationChips(streamingMsg, this._pendingConnectorCitations);
        } else {
          const fromText = this._extractUrlsForCitationChipsFromAssistantText(cleanBuffer);
          if (fromText && fromText.length) this._appendCitationChips(streamingMsg, fromText);
        }
        this._pendingConnectorCitations = null;
        if (streamChips && streamChips.length) {
          this._appendFollowUpChips(streamingMsg, streamChips, (label) => {
            if (this.inputEl) {
              this.inputEl.value = label;
              this.inputEl.dispatchEvent(new Event('input'));
              this.sendMessage();
            }
          });
        }
      }
      this._currentHistory().push(
        { role: 'user', content: userHistory },
        { role: 'assistant', content: buffer }
      );
      this._trimHistory();
      // Notify user if they're on a different tab when this response finishes
      this._showBackgroundCompletionToast(sk);
      const graphTab = this._tabForTurnContext();
      await window.navio.contextGraph({
        op: 'addTurn',
        role: 'assistant',
        summary: buffer.slice(0, 200),
        tabId: graphTab?.id,
        url: graphTab?.url || ''
      });
      // Auto-speak (Settings → read aloud and/or voice conversation) runs from
      // _maybeAutoSpeakAssistantReply inside the streamingMsg block above.
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
      if (!this._panelShowsTurnDom()) {
        // User is viewing a different tab — null out the element reference so that
        // when they switch back (_syncPanelToTab will call showTypingIndicator),
        // the next chunk correctly re-creates the streaming element with the full buffer.
        streamingMsg = null;
        return;
      }
      if (!streamingMsg || !streamingMsg.isConnected) {
        // First chunk OR user returned to this tab (element was detached by _syncPanelToTab)
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
      // Strip [FOLLOWUP] block from live stream so it doesn't flash as raw text
      const { clean: liveClean } = this._extractFollowUpChips(buffer);
      contentEl.innerHTML = this.formatMessage(liveClean);
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
    this._maybeRefreshSidebarSessionMeta(k);
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

    // Shared singleton tooltip for all citation chips
    let tip = document.getElementById('navio-source-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'navio-source-tip';
      tip.className = 'navio-source-tip';
      document.body.appendChild(tip);
      tip.onmouseenter = () => clearTimeout(tip._hideTimer);
      tip.onmouseleave = () => {
        tip._hideTimer = setTimeout(() => tip.classList.remove('nst-visible'), 120);
      };
    }

    const _showSourceTip = (chip, raw, host) => {
      clearTimeout(tip._hideTimer);
      const displayUrl = raw.length > 72 ? raw.slice(0, 69) + '…' : raw;
      tip.innerHTML = `
        <div class="nst-header">
          <img class="nst-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32"
               onerror="this.style.display='none'" width="16" height="16" alt="" loading="lazy">
          <span class="nst-host">${this._escapeHtml(host)}</span>
        </div>
        <div class="nst-url">${this._escapeHtml(displayUrl)}</div>
        <div class="nst-cta">Open source <span>↗</span></div>
      `;
      // Position: attempt above first, flip below if not enough space
      tip.style.visibility = 'hidden';
      tip.style.left = '-9999px';
      tip.classList.add('nst-visible');
      requestAnimationFrame(() => {
        const r = chip.getBoundingClientRect();
        const tipW = tip.offsetWidth;
        const tipH = tip.offsetHeight;
        let top = r.top - tipH - 8;
        let left = r.left;
        if (top < 8) top = r.bottom + 8;
        if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
        if (left < 8) left = 8;
        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
        tip.style.visibility = '';
      });
    };

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
      let host = 'Source';
      try {
        host = new URL(raw).hostname.replace(/^www\./i, '');
      } catch {
        /* keep label */
      }
      a.innerHTML = `<span class="ncc-idx">${idx}</span><span class="ncc-host">${this._escapeHtml(host)}</span>`;
      a.addEventListener('mouseenter', () => _showSourceTip(a, raw, host));
      a.addEventListener('mouseleave', () => {
        tip._hideTimer = setTimeout(() => tip.classList.remove('nst-visible'), 150);
      });
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
    strip.className = 'msg-role-strip msg-role-strip--assistant msg-role-strip--sidecar';
    strip.innerHTML = '<span class="msg-role-label">Assistant</span>';
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

  /**
   * Robust clipboard write that works in Electron's BrowserWindow renderer.
   * navigator.clipboard.writeText requires focus and can silently fail when the
   * sidebar window doesn't have browser focus. Falls back to execCommand which
   * always works in Electron.
   */
  _writeClipboard(text) {
    const _execFallback = (t) => {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
      return ok ? Promise.resolve() : Promise.reject(new Error('execCommand failed'));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => _execFallback(text));
    }
    return _execFallback(text);
  }

  _attachCopyButtonToMessage(msgEl, contentEl) {
    if (!msgEl || !contentEl || msgEl.querySelector('.msg-copy-btn')) return;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-copy-btn';
    copyBtn.title = 'Copy message';
    copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    copyBtn.addEventListener('click', () => {
      const raw = contentEl.innerText || contentEl.textContent || '';
      this._writeClipboard(raw.trim()).then(() => {
        copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        copyBtn.classList.add('msg-copy-ok');
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
          copyBtn.classList.remove('msg-copy-ok');
        }, 1800);
      }).catch(() => {
        copyBtn.title = 'Copy failed — try selecting text manually';
        copyBtn.classList.add('msg-copy-err');
        setTimeout(() => { copyBtn.classList.remove('msg-copy-err'); copyBtn.title = 'Copy message'; }, 2000);
      });
    });
    msgEl.insertBefore(copyBtn, contentEl);
  }

  /**
   * Read-aloud control (separate from copy — never use `msg-copy-btn` here; those
   * share the same absolute corner and stacked on top of each other).
   */
  _attachReadAloudButtonToMessage(msgEl, contentEl) {
    if (!msgEl || !contentEl || msgEl.querySelector('.assistant-tts-btn')) return;
    const plainText = (contentEl.innerText || contentEl.textContent || '').slice(0, 4000);
    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'assistant-tts-btn msg-tts-btn';
    ttsBtn.type = 'button';
    ttsBtn.title = 'Read aloud';
    ttsBtn.setAttribute('aria-label', 'Read aloud');
    ttsBtn.dataset.tts = plainText;
    ttsBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
    msgEl.insertBefore(ttsBtn, contentEl);
  }

  /** Auto-play TTS when Settings → read aloud is on, or during voice conversation. */
  _maybeAutoSpeakAssistantReply(plainText) {
    const t = String(plainText || '').trim().slice(0, 4000);
    if (!t) return;
    if (this._voiceConvActive) {
      this._voiceConvSetState('speaking');
      void this._speakText(t);
      return;
    }
    void window.navio.getConfig().then((cfg) => {
      if (cfg && cfg.ttsEnabled) void this._speakText(t);
    }).catch(() => { /* ignore */ });
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

    let followUpChips = [];
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
      let renderContent = content;
      if (role === 'assistant' && typeof content === 'string') {
        const extracted = this._extractFollowUpChips(content);
        renderContent = extracted.clean;
        followUpChips = extracted.chips;
      }
      contentEl.innerHTML = this.formatMessage(renderContent, role === 'assistant');
      if (role === 'assistant') this._wireActions(contentEl); // async — fire-and-forget is fine here
    }

    msgEl.appendChild(contentEl);

    // ── Copy + read-aloud (content first so insertBefore(sidecar, contentEl) orders correctly) ──
    if (role === 'assistant' || type === 'error') {
      this._attachCopyButtonToMessage(msgEl, contentEl);
      if (role === 'assistant') {
        this._attachReadAloudButtonToMessage(msgEl, contentEl);
        const plainText = (contentEl.innerText || contentEl.textContent || content || '').slice(0, 4000);
        this._maybeAutoSpeakAssistantReply(plainText);
      }
    }
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
    if (role === 'assistant' && followUpChips && followUpChips.length) {
      this._appendFollowUpChips(msgEl, followUpChips, (label) => {
        if (this.inputEl) {
          this.inputEl.value = label;
          this.inputEl.dispatchEvent(new Event('input'));
          this.sendMessage();
        }
      });
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
    // Support any slot number (0, 1, 2, …) — not just binary primary/secondary.
    const slot = Math.max(0, parseInt(String(gmailUSlot ?? 0), 10) || 0);
    const email =
      typeof authEmail === 'string' && authEmail.includes('@') ? authEmail.trim() : '';
    if (email) {
      // `?authuser=email` is account-position-independent: Gmail's client-side JS
      // detects the mismatch with u/0 and redirects to the correct u/N slot while
      // preserving the #inbox/ID hash fragment. This works for any number of accounts.
      return `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(email)}#inbox/${id}`;
    }
    // Fallback: use the numeric slot directly (no hash encoding — Gmail uses raw hex IDs).
    return `https://mail.google.com/mail/u/${slot}/#inbox/${id}`;
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
    // Support any slot number (0, 1, 2, …)
    const slotN = Math.max(0, parseInt(String(slot ?? 0), 10) || 0);
    const authEmail = ref.authEmail;
    const safeUrl = (this._gmailWebInboxUrl(msgId, slotN, authEmail) || url || '').replace(/"/g, '&quot;');
    const display = (subjectLabel || ref.subject || '(no subject)').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeFrom = (ref.from || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeSnippet = (ref.snippet || '').replace(/"/g, '&quot;').slice(0, 500);
    const midAttr = msgId ? ` data-msg-id="${String(msgId).replace(/"/g, '&quot;')}"` : '';
    const uAttr = ` data-gmail-u="${slotN}"`;

    // Show a subtle account badge on chips from non-primary accounts.
    // Display the full email (or "Account 2" fallback) so the user knows which inbox will open.
    const accountBadgeEmail = slotN > 0 ? (authEmail || '') : '';
    const accountBadgeLabel = accountBadgeEmail || (slotN > 0 ? `Account ${slotN + 1}` : '');
    const accountBadge = accountBadgeLabel
      ? `<span class="erc-account-badge" title="From: ${accountBadgeEmail || `Gmail account ${slotN + 1}`}">${accountBadgeLabel.replace(/"/g, '&quot;').replace(/</g, '&lt;')}</span>`
      : '';

    return (
      `<span class="email-ref-chip" data-url="${safeUrl}"${midAttr}${uAttr} data-from="${safeFrom}" data-snippet="${safeSnippet}" role="button" tabindex="0" title="Open in Gmail · hover for body">`
      + `<svg class="erc-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`
      + `<span class="erc-subject">${display}</span>`
      + accountBadge
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

  /**
   * Detect the domain of the current request — used for agent routing.
   * Returns: 'mail' | 'research' | 'browser' | 'shipping' | 'docs' | 'general'
   */
  _detectAgentDomain(text, activeUrl) {
    const t = (text || '').toLowerCase();
    const url = (activeUrl || '').toLowerCase();

    // Mail domain
    if (
      /mail\.google\.com|outlook\.(com|office)|webmail/i.test(url) ||
      navioDetectMailboxIntent(text)
    ) return 'mail';

    // Shipping / freight domain
    if (
      /purolator\.com|fedex\.com|ups\.com|dhl\.com|tql\.com|freightquote|ltl|truckload|shipment|shipper/i.test(url) ||
      /\b(purolator|fedex|ups|dhl|ltl|ftl|freight|carrier|pallet|shipment|tracking\s+number|waybill)\b/i.test(t)
    ) return 'shipping';

    // Research / web search domain
    if (
      /\b(research|find|search|look\s+up|what\s+is|who\s+is|how\s+(to|do|does)|compare|price|cost|news|latest|review|best|top)\b/i.test(t) &&
      !/\b(click|navigate|fill|type|scroll|form|button)\b/i.test(t)
    ) return 'research';

    // Docs / productivity domain
    if (
      /docs\.google\.com|sheets\.google\.com|drive\.google\.com|notion\.so|confluence|document/i.test(url) ||
      /\b(google\s+doc|spreadsheet|presentation|notion|document|report)\b/i.test(t)
    ) return 'docs';

    // Browser automation domain
    if (
      /\b(click|navigate|go\s+to|open|fill|type|scroll|submit|press|buy|book|sign\s+in|log\s+in)\b/i.test(t)
    ) return 'browser';

    return 'general';
  }

  _agentDomainFocusHint(domain) {
    const hints = {
      mail: '[Agent: Mail] You are in Mail mode. Use gmail_search, gmail_get_message, gmail_create_reply_draft, gmail_create_draft as primary tools. Prefer the Gmail API over navigating to mail.google.com.',
      research: '[Agent: Research] You are in Research mode. Use web_search as your primary tool for facts, comparisons, news, and general knowledge. Synthesize answers with citations. Lead with the answer on line 1.',
      browser: '[Agent: Browser] You are in Browser mode. Use navigate, read_page, click, type_text, scroll, screenshot in sequence. Always read_page after every navigation or click.',
      shipping: '[Agent: Shipping] You are in Shipping mode — a shipping desk specialist. Use read_page with filter="all" first. Set mode (parcel vs LTL/FTL) before typing addresses. Never mix origin and destination.',
      docs: '[Agent: Docs] You are in Docs mode. Use get_page_text for reading, insert_text for writing into Google Docs/Sheets (canvas editors). Never use type_text in Google Docs.',
      general: ''
    };
    return hints[domain] || '';
  }

  /**
   * Normalize one FOLLOWUP chip entry: string (prompt) or { text|label|title, url } (optional new-tab URL).
   * @returns {{ label: string, url: string|null }|null}
   */
  _normalizeFollowUpChipEntry(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const t = c.trim();
      return t ? { label: t, url: null } : null;
    }
    if (typeof c === 'object') {
      const label = String(c.text || c.label || c.title || '').trim();
      let url = typeof c.url === 'string' ? c.url.trim() : typeof c.href === 'string' ? c.href.trim() : '';
      if (url && !/^https?:\/\//i.test(url)) url = '';
      try {
        if (url) url = new URL(url).href;
      } catch {
        url = '';
      }
      if (!label && !url) return null;
      return { label: label || 'Open link', url: url || null };
    }
    return null;
  }

  /** Open a follow-up chip URL in a new tab (http/https only). */
  _openFollowUpChipUrl(url) {
    const u = String(url || '').trim();
    if (!u || !/^https?:\/\//i.test(u)) return;
    try {
      if (typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
        TabManager.createTab(u);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Strip [FOLLOWUP]{...}[/FOLLOWUP] from content and return chips separately.
   * Returns { clean: string, chips: Array<{ label: string, url: string|null }> }.
   */
  _extractFollowUpChips(text) {
    if (!text || typeof text !== 'string') return { clean: text || '', chips: [] };
    const re = /\[FOLLOWUP\]\s*(\{[\s\S]*?\})\s*\[\/FOLLOWUP\]/g;
    const chips = [];
    const clean = text
      .replace(re, (_, json) => {
        try {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed.chips)) {
            parsed.chips.forEach((c) => {
              const norm = this._normalizeFollowUpChipEntry(c);
              if (norm) chips.push(norm);
            });
          }
        } catch {
          /* malformed JSON, ignore */
        }
        return '';
      })
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\[FOLLOWUP\][\s\S]*/gi, '')
      .trim();
    return { clean, chips: chips.slice(0, 4) };
  }

  _appendFollowUpChips(msgEl, chips, onChipClick) {
    if (!msgEl || !chips || !chips.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'navio-followup-chips';
    chips.forEach((raw) => {
      const chip = this._normalizeFollowUpChipEntry(raw);
      if (!chip) return;
      const btn = document.createElement('button');
      btn.className = 'navio-followup-chip';
      btn.type = 'button';
      btn.textContent = chip.label;
      if (chip.url) btn.title = chip.url;
      btn.addEventListener('click', () => {
        if (chip.url) {
          this._openFollowUpChipUrl(chip.url);
          return;
        }
        if (typeof onChipClick === 'function') onChipClick(chip.label);
      });
      wrap.appendChild(btn);
    });
    msgEl.appendChild(wrap);
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
      return `<div class="msg-code-header"><span class="msg-code-lang">${langLabel}</span><button class="msg-code-copy" data-code-id="${codeId}" onclick="(function(b){var c=document.getElementById('${codeId}');if(!c)return;var t=c.textContent;var ok=function(){b.textContent='Copied!';b.classList.add('copied');setTimeout(function(){b.textContent='Copy';b.classList.remove('copied')},1500)};var fail=function(){b.textContent='Failed';setTimeout(function(){b.textContent='Copy'},1500)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok).catch(function(){var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:-9999px;opacity:0';document.body.appendChild(ta);ta.focus();ta.select();var r=document.execCommand('copy');document.body.removeChild(ta);if(r)ok();else fail()});}else{var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:-9999px;opacity:0';document.body.appendChild(ta);ta.focus();ta.select();var r=document.execCommand('copy');document.body.removeChild(ta);if(r)ok();else fail();}})(this)">Copy</button></div><pre${langAttr}><code id="${codeId}">${code.trim()}</code></pre>`;
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
    html = this._rewriteGmailAnchorsToAuthUser(html);

    return html;
  }

  /**
   * Catch-net: if the model wrote a raw `<a href="https://mail.google.com/mail/u/N/#inbox/<id>">`
   * link, rewrite it so the href uses `?authuser=<connected-email>` — otherwise clicks open in
   * whatever Gmail account happens to be in the browser session's slot N (often the user's
   * personal mailbox, not the OAuth-connected one). This is a second line of defence; tool
   * results already carry a `web_url` the model is told to use verbatim.
   */
  _rewriteGmailAnchorsToAuthUser(html) {
    if (typeof html !== 'string' || !html || !/mail\.google\.com/i.test(html)) return html;
    const refs = this._emailRefs;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const anchors = tpl.content.querySelectorAll('a[href*="mail.google.com"]');
    if (!anchors.length) return html;
    let changed = false;
    anchors.forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href) return;
      let msgId = null;
      try {
        const u = new URL(href);
        if (!/^mail\.google\.com$/i.test(u.hostname)) return;
        // Don't re-rewrite a URL that already targets a specific account.
        if (u.searchParams.get('authuser')) return;
        const frag = (u.hash || '').replace(/^#/, '');
        const segs = frag.split('/').filter(Boolean);
        const last = (segs[segs.length - 1] || '').split('?')[0];
        if (last && (refs?.has?.(last) || /^[a-fA-F0-9]{10,}$/.test(last))) msgId = last;
      } catch {
        return;
      }
      if (!msgId) return;
      const ref = refs?.get?.(msgId);
      if (!ref || !ref.authEmail) return;
      const fixed = this._gmailWebInboxUrl(msgId, ref.gmailUSlot || 0, ref.authEmail);
      if (fixed && fixed !== href) {
        a.setAttribute('href', fixed);
        a.setAttribute('data-navio-authuser', '1');
        changed = true;
      }
    });
    return changed ? tpl.innerHTML : html;
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
    this._takeoverPaused = false;
    this._takeoverPausedResolve = null;
    this._takeoverAbort = new AbortController();
    this._agentLogEntries = [];
    this._takeoverStepNum = 0;
    this._renderAgentLog();
    if (window.NavioAIBoost) window.NavioAIBoost.setOrbThinking(true);
    // Sidebar banner (Pause + Undo + Stop)
    if (!document.getElementById('navio-takeover-banner')) {
      const banner = document.createElement('div');
      banner.id = 'navio-takeover-banner';
      banner.className = 'navio-takeover-banner';
      banner.innerHTML = `
        <span class="ntb-dot"></span>
        <span class="ntb-label">Navio is in control</span>
        <button class="ntb-undo" type="button">Undo</button>
        <button class="ntb-pause" type="button">Pause</button>
        <button class="ntb-stop" type="button">Stop</button>`;
      banner.querySelector('.ntb-stop').addEventListener('click', () => this.disableTakeover());
      banner.querySelector('.ntb-undo').addEventListener('click', () => this._undoLastNavigation());
      banner.querySelector('.ntb-pause').addEventListener('click', () => this._pauseTakeover());
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
    // Floating chrome pill — visible even when sidebar is closed
    if (!document.getElementById('navio-agent-chrome-pill')) {
      const pill = document.createElement('div');
      pill.id = 'navio-agent-chrome-pill';
      pill.className = 'navio-agent-chrome-pill';
      pill.innerHTML = `
        <span class="nacp-dot"></span>
        <span class="nacp-label">Navio is working</span>
        <button class="nacp-pause" type="button">Pause</button>
        <button class="nacp-stop" type="button">Stop</button>`;
      pill.querySelector('.nacp-pause').addEventListener('click', () => this._pauseTakeover());
      pill.querySelector('.nacp-stop').addEventListener('click', () => this.disableTakeover());
      const navbar = document.getElementById('navbar');
      if (navbar) navbar.appendChild(pill);
    }
    // Notify guest chat tab if agent triggered from there
    if (this._guestChatWebview) {
      void this._guestDeliver(this._guestChatWebview, { type: 'takeoverStart' });
    }
  }

  disableTakeover() {
    if (typeof TabManager !== 'undefined') TabManager.setAgentControlledTab?.(null);
    this._takeoverMode = false;
    this._autoFollowCount = 0;
    // Release any pending pause before aborting so the loop can exit cleanly
    this._takeoverPaused = false;
    if (this._takeoverPausedResolve) {
      this._takeoverPausedResolve();
      this._takeoverPausedResolve = null;
    }
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
    document.getElementById('navio-agent-chrome-pill')?.remove();
    const logPanel = document.getElementById('assistant-agent-log');
    if (logPanel) {
      logPanel.hidden = true;
      const body = logPanel.querySelector('.assistant-agent-log-body');
      if (body) body.innerHTML = '';
    }
    // Notify guest chat tab
    if (this._guestChatWebview) {
      void this._guestDeliver(this._guestChatWebview, { type: 'takeoverStop' });
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
        // Use the actual stored slot number — supports 0, 1, 2+ (not just binary).
        const uSlot = Math.max(0, parseInt(chip.dataset.gmailU || '0', 10) || 0);
        const isNonPrimary = uSlot >= 1;

        if (
          isNonPrimary &&
          typeof ConnectorsManager !== 'undefined' &&
          ConnectorsManager.connectedIds &&
          typeof ConnectorsManager.connectedIds.has === 'function' &&
          !ConnectorsManager.connectedIds.has('gmail_2')
        ) {
          if (typeof _showAppToast === 'function') {
            _showAppToast(
              'That message is from your second Gmail account. Connect **Gmail (2nd account)** in Settings → Connectors, then click again.',
              'warning'
            );
          }
          return;
        }

        // ── Resolve the best email auth so authuser= routes to the right inbox ──
        // Priority 1: email stored on the ref when the connector fetched the message
        let authEmail = (msgId && this._emailRefs?.get?.(msgId)?.authEmail) || '';
        // Priority 2: live OAuth status (in case the ref was built before OAuth loaded)
        if (!authEmail || !String(authEmail).includes('@')) {
          try {
            const oauthSt = (await window.navio.oauthStatus()) || {};
            // Map slot to the correct OAuth account (slot 0 → google, slot 1 → google_2, …)
            // Navio's OAuth keys: slot 0 → 'google', slot 1 → 'google_2'
            authEmail = uSlot === 0
              ? (oauthSt.google?.email || '')
              : (oauthSt.google_2?.email || '');
          } catch { /* ignore */ }
        }

        // ── Helper: navigate an already-loaded Gmail webview to a specific message ──
        // Works by setting the hash in-page — no server round-trip, no redirect.
        const _navGmailMsgInPage = (wv, mid) => {
          if (!wv || !mid) return;
          try {
            wv.executeJavaScript(
              `(function(){` +
              `var p=window.location.pathname;` +
              `window.location.replace(p+'#inbox/${mid}');` +
              `})()`
            ).catch(() => {});
          } catch { /* ignore */ }
        };

        // ── Helper: read the signed-in account email from a Gmail webview ──
        const _getGmailAccountEmail = async (wv) => {
          try {
            return await wv.executeJavaScript(
              `(function(){` +
              // Most Gmail versions expose the account email via data-email on the avatar
              `var e=document.querySelector('[data-email]');` +
              `if(e)return e.getAttribute('data-email');` +
              // Fallback: aria-label on the Google Account button (contains email in parens)
              `var a=document.querySelector('[aria-label*="Google Account"]');` +
              `if(a){var m=a.getAttribute('aria-label').match(/[\\w.+%-]+@[\\w.-]+\\.[a-z]{2,}/i);if(m)return m[0];}` +
              `return '';` +
              `})()`
            );
          } catch { return ''; }
        };

        if (typeof TabManager !== 'undefined') {
          // ── Step 1: scan ALL open Gmail tabs to find one already showing authEmail ──
          // This is more reliable than matching by slot number, which doesn't correlate
          // with the browser's Gmail session order.
          if (authEmail && msgId) {
            const gmailTabs = TabManager.tabs.filter(t =>
              t.webview && t.url && t.url.includes('mail.google.com/mail/u/')
            );
            for (const t of gmailTabs) {
              const tabEmail = await _getGmailAccountEmail(t.webview);
              if (tabEmail && tabEmail.toLowerCase() === authEmail.toLowerCase()) {
                // Found the right account's tab — switch and navigate in-page
                TabManager.switchToTab(t.id);
                _navGmailMsgInPage(t.webview, msgId);
                return;
              }
            }
          }

          // ── Step 2: open a new tab using Google AccountChooser ──
          // AccountChooser actively selects the right account even if it isn't the
          // default browser Gmail session — unlike ?authuser= which silently falls
          // back to the primary account when the target isn't signed in yet.
          let navUrl;
          if (authEmail) {
            // AccountChooser: if signed in → goes straight to Gmail; if not → prompts login
            const continueAfterAuth = encodeURIComponent('https://mail.google.com/mail/');
            navUrl = `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(authEmail)}&continue=${continueAfterAuth}`;
          } else {
            navUrl = `https://mail.google.com/mail/u/${uSlot}/`;
          }

          const newTab = TabManager.createTab(navUrl);
          if (!msgId || !newTab || !newTab.webview) return;

          // ── Step 3: wait until we land on mail.google.com/mail/u/N/ (not accounts.google.com) ──
          // did-stop-loading fires on EVERY redirect, so we must ignore the
          // intermediate accounts.google.com stops and only act once Gmail itself has loaded.
          let _msgNavDone = false;
          const _onStop = () => {
            if (_msgNavDone) return;
            const currentUrl = newTab.webview?.getURL?.() || '';
            if (!currentUrl.includes('mail.google.com/mail/u/')) return; // still redirecting
            _msgNavDone = true;
            newTab.webview.removeEventListener('did-stop-loading', _onStop);
            clearTimeout(_navTimeout);
            // Short settle delay: Gmail's SPA needs ~1 s to register the hash navigation
            setTimeout(() => _navGmailMsgInPage(newTab.webview, msgId), 1200);
          };
          newTab.webview.addEventListener('did-stop-loading', _onStop);
          // Safety: clean up listener after 45 s (in case of login flow or slow network)
          const _navTimeout = setTimeout(() => {
            newTab.webview?.removeEventListener('did-stop-loading', _onStop);
          }, 45000);
        } else {
          // Fallback for non-Electron environments
          const fallbackUrl = authEmail
            ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(authEmail)}#inbox/${msgId}`
            : `https://mail.google.com/mail/u/${uSlot}/#inbox/${msgId}`;
          window.open(fallbackUrl, '_blank');
        }
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.click(); }
      });

      // ── Shared tooltip hide logic with delay so mouse can move chip → tooltip ──
      const _hideTipSoon = (delay = 180) => {
        clearTimeout(chip._tooltipHideTimer);
        chip._tooltipHideTimer = setTimeout(() => {
          chip._emailTipGen = 0;
          chip._tooltip?.remove();
          delete chip._tooltip;
        }, delay);
      };
      const _cancelHide = () => clearTimeout(chip._tooltipHideTimer);

      chip.addEventListener('mouseenter', () => {
        _cancelHide();
        const mid = (chip.dataset.msgId || '').trim();
        const from = chip.dataset.from || '';
        const snippet = chip.dataset.snippet || '';
        const acctEmail = chip.dataset.url?.match(/authuser=([^&#]+)/)?.[1]
          ? decodeURIComponent(chip.dataset.url.match(/authuser=([^&#]+)/)[1])
          : '';

        document.getElementById('email-chip-tooltip')?.remove();

        const tip = document.createElement('div');
        tip.id = 'email-chip-tooltip';
        tip.className = 'email-chip-tooltip';

        // Header row: from + close button
        const header = document.createElement('div');
        header.className = 'ect-header';
        if (from) {
          header.innerHTML = `<div class="ect-from"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>${_ectEsc(from)}</span></div>`;
        }
        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ect-close';
        closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5"/></svg>';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); chip._emailTipGen = 0; tip.remove(); delete chip._tooltip; });
        header.appendChild(closeBtn);
        tip.appendChild(header);

        // Account indicator (only for non-primary accounts)
        if (acctEmail) {
          const acctRow = document.createElement('div');
          acctRow.className = 'ect-account';
          acctRow.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${_ectEsc(acctEmail)}`;
          tip.appendChild(acctRow);
        }

        if (snippet) {
          const snipEl = document.createElement('div');
          snipEl.className = 'ect-snippet';
          snipEl.textContent = snippet;
          tip.appendChild(snipEl);
        }

        const bodySlot = document.createElement('div');
        bodySlot.className = 'ect-body-slot';
        tip.appendChild(bodySlot);

        if (mid && typeof window.navio?.gmailGetMessageBody === 'function') {
          const uSlotVal = parseInt(chip.dataset.gmailU || '0', 10) || 0;
          const svcId = uSlotVal >= 1 ? 'gmail_2' : 'gmail';
          const cacheKey = svcId + ':' + mid;
          const useCache = this._emailBodyCache.get(cacheKey) || this._emailBodyCache.get(mid);
          if (useCache) {
            bodySlot.innerHTML = `<div class="ect-body">${_ectEsc(useCache.slice(0, 12000))}</div>`;
          } else {
            bodySlot.innerHTML = '<div class="ect-body-loading">Loading…</div>';
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
                  : '<div class="ect-snippet ect-muted">No plain-text body.</div>';
              }
              requestAnimationFrame(() => {
                if (document.body.contains(tip)) _ectPositionTip(tip, chip);
              });
            }).catch(() => {
              if (chip._emailTipGen !== gen || !document.body.contains(tip)) return;
              bodySlot.innerHTML = '<div class="ect-snippet ect-muted">Could not load message body.</div>';
            });
          }
        } else if (mid) {
          bodySlot.innerHTML = '<div class="ect-snippet ect-muted">Connect Gmail to load full body on hover.</div>';
        } else if (!from && !snippet) {
          bodySlot.innerHTML = '<div class="ect-snippet ect-muted">Click to open in Gmail.</div>';
        }

        document.body.appendChild(tip);
        chip._tooltip = tip;

        // Allow mouse to move into the tooltip without it disappearing
        tip.addEventListener('mouseenter', _cancelHide);
        tip.addEventListener('mouseleave', () => _hideTipSoon(120));

        requestAnimationFrame(() => {
          _ectPositionTip(tip, chip);
          tip.classList.add('ect-visible');
        });
      });

      chip.addEventListener('mouseleave', () => _hideTipSoon(180));
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
      // Pause gate — agent is suspended until _resumeTakeover() is called
      if (this._takeoverPaused) {
        await new Promise((resolve) => { this._takeoverPausedResolve = resolve; });
        this._takeoverPausedResolve = null;
      }
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

  /** Suspend the running takeover loop at the next step boundary. */
  _pauseTakeover() {
    if (!this._takeoverMode) return;
    this._takeoverPaused = true;
    // Update chrome pill button → Resume
    const pill = document.getElementById('navio-agent-chrome-pill');
    if (pill) {
      const pauseBtn = pill.querySelector('.nacp-pause');
      if (pauseBtn) {
        pauseBtn.textContent = 'Resume';
        pauseBtn.classList.add('nacp-paused');
        pauseBtn.onclick = () => this._resumeTakeover();
      }
      const label = pill.querySelector('.nacp-label');
      if (label) label.textContent = 'Navio paused';
    }
    // Update sidebar banner
    const banner = document.getElementById('navio-takeover-banner');
    if (banner) {
      const pauseBtn = banner.querySelector('.ntb-pause');
      if (pauseBtn) { pauseBtn.textContent = 'Resume'; pauseBtn.onclick = () => this._resumeTakeover(); }
      const labelEl = banner.querySelector('.ntb-label');
      if (labelEl) labelEl.textContent = 'Navio paused';
    }
    // Notify guest chat tab
    if (this._guestChatWebview) {
      void this._guestDeliver(this._guestChatWebview, { type: 'takeoverPaused' });
    }
  }

  /** Resume a paused takeover. */
  _resumeTakeover() {
    if (!this._takeoverMode) return;
    this._takeoverPaused = false;
    if (this._takeoverPausedResolve) {
      this._takeoverPausedResolve();
      this._takeoverPausedResolve = null;
    }
    // Restore chrome pill button → Pause
    const pill = document.getElementById('navio-agent-chrome-pill');
    if (pill) {
      const pauseBtn = pill.querySelector('.nacp-pause');
      if (pauseBtn) {
        pauseBtn.textContent = 'Pause';
        pauseBtn.classList.remove('nacp-paused');
        pauseBtn.onclick = () => this._pauseTakeover();
      }
      const label = pill.querySelector('.nacp-label');
      if (label) label.textContent = 'Navio is working';
    }
    // Restore sidebar banner
    const banner = document.getElementById('navio-takeover-banner');
    if (banner) {
      const pauseBtn = banner.querySelector('.ntb-pause');
      if (pauseBtn) { pauseBtn.textContent = 'Pause'; pauseBtn.onclick = () => this._pauseTakeover(); }
      const labelEl = banner.querySelector('.ntb-label');
      if (labelEl) labelEl.textContent = 'Navio is in control';
    }
    // Notify guest chat tab
    if (this._guestChatWebview) {
      void this._guestDeliver(this._guestChatWebview, { type: 'takeoverResumed' });
    }
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
    if (this._threadBusyForSend() || (aid && this._tabIsBusy(aid)) || this._autoFollowCount >= MAX_AUTO_STEPS) {
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
      <div class="msg-role-strip msg-role-strip--assistant msg-role-strip--sidecar msg-role-strip--typing">
        <span class="msg-role-label">Assistant</span>
      </div>
      <div class="message-content typing-indicator">
        <span class="typing-indicator-label" id="typing-indicator-label">One sec</span>
        <span class="typing-dots"><span></span><span></span><span></span></span>
      </div>
    `;
    this.messagesEl.appendChild(indicator);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    // Cycle through warm-up labels so the user knows something is happening during context-building.
    // Labels rotate every 3s while still on "Thinking" (tool updates override immediately via _updateTypingLabel).
    const warmupLabels = ['One sec', 'Pulling context', 'Almost there', 'One sec'];
    let warmupIdx = 0;
    const warmupTimer = setInterval(() => {
      const labelEl = document.getElementById('typing-indicator-label');
      if (!labelEl) { clearInterval(warmupTimer); return; }
      // Only cycle if the label is still on a warmup phase (not overridden by a tool-specific label)
      const curText = labelEl.textContent || '';
      if (warmupLabels.includes(curText) || curText === 'Thinking' || curText === 'One sec') {
        warmupIdx = (warmupIdx + 1) % warmupLabels.length;
        labelEl.textContent = warmupLabels[warmupIdx];
      } else {
        clearInterval(warmupTimer);
      }
    }, 3000);
    // Store timer ref so removeTypingIndicator can clean it up
    indicator.dataset.warmupTimer = warmupTimer;
  }

  /** Update the typing-indicator label with the current tool (short, human phrasing). */
  _updateTypingLabel(tool) {
    const labelEl = document.getElementById('typing-indicator-label');
    if (!labelEl) return;
    const labels = {
      navigate: 'Opening the page',
      read_page: 'Looking at the page',
      get_page_text: 'Pulling text',
      click: 'Using the page',
      type_text: 'Filling something in',
      scroll: 'Scrolling',
      screenshot: 'Taking a screenshot',
      open_tab: 'Opening a tab',
      switch_tab: 'Switching tabs',
      list_tabs: 'Listing your tabs',
      web_search: 'Searching the web',
      gmail_search: 'Digging through mail',
      gmail_get_message: 'Opening that email',
      gmail_list_drafts: 'Checking drafts',
      gmail_create_draft: 'Drafting mail',
      gmail_create_reply_draft: 'Drafting a reply',
      read_console: 'Peeking at the console',
      read_network: 'Watching network calls',
      propose_plan: 'Sketching a plan',
      wait: 'Holding on a moment'
    };
    labelEl.textContent = labels[tool] || 'On it';
  }

  removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
      if (indicator.dataset.warmupTimer) clearInterval(Number(indicator.dataset.warmupTimer));
      indicator.remove();
    }
  }

  _maybeRefreshSidebarSessionMeta(storageKey) {
    if (!storageKey || !String(storageKey).startsWith(NAVIO_SIDEBAR_THREAD_PREFIX)) return;
    const h = this._conversationsByTab.get(storageKey);
    if (!h || !h.length) return;
    const firstUser = h.find((m) => m && m.role === 'user' && String(m.content || '').trim());
    const title = firstUser
      ? String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 56) || 'Saved chat'
      : 'Saved chat';
    let meta = this._sidebarSessionOrder.find((x) => x.id === storageKey);
    if (!meta) {
      meta = { id: storageKey, title, updatedAt: Date.now() };
      this._sidebarSessionOrder.unshift(meta);
    } else {
      meta.title = title;
      meta.updatedAt = Date.now();
    }
    this._renderSidebarSessionList();
  }

  _thisTabThreadSubtitle() {
    try {
      if (typeof TabManager === 'undefined' || !TabManager.getActiveTab) return 'Per-tab thread';
      const t = TabManager.getActiveTab();
      if (!t) return 'Per-tab thread';
      return (TabManager.getTabDisplayTitle && TabManager.getTabDisplayTitle(t)) || t.title || 'Current tab';
    } catch {
      return 'Per-tab thread';
    }
  }

  _formatSessionTime(ts) {
    const t = typeof ts === 'number' && ts > 0 ? ts : Date.now();
    try {
      const d = new Date(t);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  /**
   * Other open tabs (or tab groups) that already have AI messages — listed under History from any tab.
   */
  _otherTabsWithChatHistory() {
    const out = [];
    if (typeof TabManager === 'undefined' || !TabManager.tabs || !TabManager.getActiveTab) return out;
    const active = TabManager.getActiveTab();
    const activeSk = active ? this._storageKeyForTab(active) : '';
    const seen = new Set();
    for (const t of TabManager.tabs) {
      if (!t || !t.id) continue;
      const sk = this._storageKeyForTab(t);
      if (!sk || sk === NAVIO_PROFILE_CHAT_KEY || sk.startsWith('__')) continue;
      if (sk.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX)) continue;
      if (seen.has(sk)) continue;
      if (sk === activeSk) continue;
      seen.add(sk);
      const h = this._conversationsByTab.get(sk) || [];
      if (!h.length) continue;
      const firstUser = h.find((m) => m && m.role === 'user' && String(m.content || '').trim());
      const tabLabel =
        (TabManager.getTabDisplayTitle && TabManager.getTabDisplayTitle(t)) || t.title || 'Tab';
      let title;
      if (firstUser) {
        title = String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 52);
        if (String(firstUser.content).replace(/\s+/g, ' ').trim().length > 52) title += '\u2026';
      } else {
        title = tabLabel.slice(0, 56);
      }
      const sub =
        sk.startsWith('g:') && TabManager.tabs.filter((x) => x && x.groupId === t.groupId).length > 1
          ? `${tabLabel} \u00b7 tab group`
          : tabLabel;
      out.push({ tabId: String(t.id), title, sub });
    }
    return out;
  }

  async _openTabThreadFromHistory(tabId) {
    await this._ensureAssistantHistoryLoaded();
    if (this._threadBusyForSend()) return;
    const tid = String(tabId || '').trim();
    if (!tid || typeof TabManager === 'undefined' || typeof TabManager.switchToTab !== 'function') return;
    if (this._tabIsBusy(tid)) return;
    this._sidebarThreadKey = null;
    TabManager.switchToTab(tid);
    await this._selectThisTabThread();
  }

  _renderSidebarSessionList() {
    const root = document.getElementById('assistant-session-history-list');
    if (!root) return;
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    const rows = [];
    rows.push(
      `<button type="button" class="assistant-session-this-tab${!this._sidebarThreadKey ? ' is-active' : ''}" data-session-this-tab="1">` +
        `<span class="assistant-session-row-title">This tab</span>` +
        `<span class="assistant-session-row-sub">${esc(this._thisTabThreadSubtitle())}</span></button>`
    );
    const otherTabs = this._otherTabsWithChatHistory();
    if (otherTabs.length) {
      rows.push('<div class="assistant-session-section-h" role="presentation">Other tabs</div>');
      for (const row of otherTabs) {
        const tid = esc(row.tabId);
        rows.push(
          `<div class="assistant-session-row assistant-session-row--jump-tab">` +
            `<button type="button" class="assistant-session-open assistant-session-open--full" data-session-switch-tab="${tid}" title="Switch to this tab and show its AI thread">` +
            `<span class="assistant-session-row-title">${esc(row.title)}</span>` +
            `<span class="assistant-session-row-sub">${esc(row.sub)}</span>` +
            `</button>` +
            `</div>`
        );
      }
    }
    const order = [...(this._sidebarSessionOrder || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (order.length) {
      rows.push('<div class="assistant-session-section-h" role="presentation">Saved chats</div>');
    }
    for (const meta of order) {
      const active = this._sidebarThreadKey === meta.id ? ' is-active' : '';
      const title = esc(meta.title || 'Saved chat');
      const idAttr = esc(meta.id);
      rows.push(
        `<div class="assistant-session-row${active}">` +
          `<button type="button" class="assistant-session-open" data-session-open="${idAttr}">` +
            `<span class="assistant-session-row-title">${title}</span>` +
            `<span class="assistant-session-row-sub">${esc(this._formatSessionTime(meta.updatedAt))}</span>` +
          `</button>` +
          `<button type="button" class="assistant-session-delete" data-session-delete="${idAttr}" title="Delete conversation" aria-label="Delete conversation">` +
            `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>` +
          `</button>` +
        `</div>`
      );
    }
    root.innerHTML = rows.join('');
  }

  async _startNewSidebarSession() {
    await this._ensureAssistantHistoryLoaded();
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if (this._threadBusyForSend() || (aid && this._tabIsBusy(aid))) return;
    let id;
    try {
      id =
        NAVIO_SIDEBAR_THREAD_PREFIX +
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`);
    } catch {
      id = NAVIO_SIDEBAR_THREAD_PREFIX + `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
    this._conversationsByTab.set(id, []);
    this._sidebarThreadKey = id;
    this._sidebarSessionOrder = this._sidebarSessionOrder.filter((x) => x.id !== id);
    this._sidebarSessionOrder.unshift({ id, title: 'New chat', updatedAt: Date.now() });
    if (aid) this._panelDisplayTabId = aid;
    this.messagesEl.innerHTML = '';
    this.setReceipt('');
    document.getElementById('navio-continue-pill')?.remove();
    try {
      this._clearAttachmentQueue();
    } catch {
      /* ignore */
    }
    await this._showGreeting();
    this._renderSidebarSessionList();
    void this._persistAssistantHistoryNow();
    if (!this.isOpen) void this.open();
    setTimeout(() => this.inputEl?.focus(), 200);
  }

  async _openSidebarSession(id) {
    await this._ensureAssistantHistoryLoaded();
    const sid = String(id || '').trim();
    if (!sid.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX)) return;
    if (this._threadBusyForSend()) return;
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if (aid && this._tabIsBusy(aid)) return;
    this._sidebarThreadKey = sid;
    this._ensureConversationEntry(sid);
    if (aid) this._panelDisplayTabId = aid;
    try {
      this._clearAttachmentQueue();
    } catch {
      /* ignore */
    }
    this.setReceipt('');
    document.getElementById('navio-continue-pill')?.remove();
    const h = this._conversationsByTab.get(sid) || [];
    this.messagesEl.innerHTML = '';
    if (h.length) this._renderDomFromHistoryKey(sid);
    else await this._showGreeting();
    this._renderSidebarSessionList();
    setTimeout(() => this.inputEl?.focus(), 150);
  }

  async _selectThisTabThread() {
    await this._ensureAssistantHistoryLoaded();
    if (this._threadBusyForSend()) return;
    this._sidebarThreadKey = null;
    const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
    if (aid) await this._syncPanelToTab(aid);
    else {
      this.messagesEl.innerHTML = '';
      await this._showGreeting();
    }
    this._renderSidebarSessionList();
    setTimeout(() => this.inputEl?.focus(), 150);
  }

  async _deleteSidebarSession(id) {
    await this._ensureAssistantHistoryLoaded();
    const sid = String(id || '').trim();
    if (!sid.startsWith(NAVIO_SIDEBAR_THREAD_PREFIX)) return;
    if (this._busyTabs.has(sid)) return;
    this._conversationsByTab.delete(sid);
    this._sidebarSessionOrder = this._sidebarSessionOrder.filter((x) => x.id !== sid);
    if (this._sidebarThreadKey === sid) {
      this._sidebarThreadKey = null;
      const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
      if (aid) await this._syncPanelToTab(aid);
      else {
        this.messagesEl.innerHTML = '';
        await this._showGreeting();
      }
    }
    void this._persistAssistantHistoryNow();
    this._renderSidebarSessionList();
  }

  clearChat() {
    const k = this._conversationKey();
    const wasSidebar = String(k).startsWith(NAVIO_SIDEBAR_THREAD_PREFIX);
    if (wasSidebar) {
      this._conversationsByTab.delete(k);
      this._sidebarSessionOrder = this._sidebarSessionOrder.filter((x) => x.id !== k);
      this._sidebarThreadKey = null;
    } else {
      this._conversationsByTab.set(k, []);
    }
    this.setReceipt('');
    this.messagesEl.innerHTML = '';
    this._attachmentsSnapshot = null;
    this._clearAttachmentQueue();
    void this._persistAssistantHistoryNow();
    this._showGreeting();
    if (wasSidebar) {
      const aid = typeof TabManager !== 'undefined' && TabManager.activeTabId ? String(TabManager.activeTabId) : '';
      if (aid) void this._syncPanelToTab(aid);
    }
    this._renderSidebarSessionList();
  }

  // ── Macro Recording ──────────────────────────────────────────────────────

  _toggleRecording() {
    const btn = document.getElementById('btn-record-macro');
    if (!this._workflowRecording) {
      // Start recording
      this._workflowRecording = true;
      this._recordedSteps = [];
      if (btn) {
        btn.classList.add('recording-active');
        btn.setAttribute('aria-pressed', 'true');
        btn.title = 'Recording… click to stop and save workflow';
      }
      this.addMessage('assistant', '🔴 **Recording started.** Perform your task — every agent step will be captured. Click the record button again when done to save it as a replayable workflow.', 'info');
    } else {
      // Stop recording
      this._workflowRecording = false;
      const steps = (this._recordedSteps || []).slice();
      this._recordedSteps = [];
      if (btn) {
        btn.classList.remove('recording-active');
        btn.setAttribute('aria-pressed', 'false');
        btn.title = 'Record: capture your next agent task as a replayable workflow';
      }
      if (!steps.length) {
        this.addMessage('assistant', 'Recording stopped — no agent steps were captured. Run a task while recording is active.', 'info');
        return;
      }
      const name = window.prompt(`Name this workflow (${steps.length} step${steps.length === 1 ? '' : 's'} recorded):`);
      if (!name?.trim()) {
        this.addMessage('assistant', `Recording discarded (${steps.length} step${steps.length === 1 ? '' : 's'}).`, 'info');
        return;
      }
      window.navio.workflowSave({ name: name.trim(), steps }).then((result) => {
        if (result?.ok) {
          this.addMessage('assistant', `✅ Workflow **"${name.trim()}"** saved with ${steps.length} step${steps.length === 1 ? '' : 's'}. You can replay it anytime by asking: *"Run the ${name.trim()} workflow"*.`, '');
        } else {
          this.addMessage('assistant', `Could not save workflow: ${result?.error || 'unknown error'}`, 'error');
        }
      }).catch((e) => this.addMessage('assistant', `Save failed: ${e.message}`, 'error'));
    }
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
          /\bwhat\s+(is|are|was|were)\s+the\s+(latest|news|weather|price|stock|rate|situation|meaning|definition)\b/i.test(text) ||
          // General knowledge questions not likely answered from the active page
          /^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|did|can|could|should|would)\b/i.test(text.trim()) ||
          /\b(how\s+(much|many|long|far|old|often)|what\s+does|who\s+is|where\s+is|what\s+year|what\s+time|what\s+are\s+the\s+(best|top|most))\b/i.test(text) ||
          /\b(price|cost|rate|stock|weather|definition|meaning|explain|difference\s+between|compare|vs\.?|versus|pros\s+and\s+cons|review|rating|recommend)\b/i.test(text) ||
          /\b(how\s+to|best\s+way\s+to|steps\s+to|guide\s+(to|for)|tutorial)\b/i.test(text);
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
      // Use intent router when available; fall back to legacy regex
      const _driveIntentRouter = typeof NavioIntentRouter !== 'undefined' ? NavioIntentRouter.hasDriveIntent(text) : false;
      const driveIntent =
        _driveIntentRouter ||
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
      const _calIntentRouter = typeof NavioIntentRouter !== 'undefined' ? NavioIntentRouter.hasCalendarIntent(text) : false;
      const calendarIntent =
        _calIntentRouter ||
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
