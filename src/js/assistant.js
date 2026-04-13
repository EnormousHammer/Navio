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
  const mailThing =
    /\b(gmail|google\s*mail|inbox|mailbox|e-?mails?|unread|notification)\b/i.test(s) ||
    /\bmy\s+(e-?mails?|mail|inbox|messages?)\b/i.test(s) ||
    /\b(messages?|mail)\s+from\b/i.test(s);
  const mailPlusCasual =
    /\b(e-?mails?|\bmail\b)\b/i.test(s) &&
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

const NAVIO_ASSISTANT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const NAVIO_ASSISTANT_PDF_MAX_BYTES = 12 * 1024 * 1024;
const NAVIO_ASSISTANT_TEXT_MAX_CHARS = 180000;
const NAVIO_ASSISTANT_MAX_ATTACHMENTS = 8;

function navioIsTextLikeFile(file) {
  const n = (file.name || '').toLowerCase();
  if (file.type && file.type.startsWith('text/')) return true;
  return /\.(txt|md|json|csv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|c|h|cpp|hpp|py|java|kt|rs|go|yaml|yml|toml|ini|log|sh|bat|ps1|env|svg|sql|vue|svelte)$/i.test(
    n
  );
}

function navioIsImageFile(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(file.name || '');
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
    this.isProcessing = false;
    this.conversationHistory = [];
    this._streamUnsubs = [];
    this._autoFollowCount = 0;
    this._emailRefs = new Map();
    /** @type {Map<string, string>} messageId → plain body (Gmail API) */
    this._emailBodyCache = new Map();
    this._lastGmailPageToken = null;
    this._lastGmailQuery = '';
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

    // Minimal placeholder — the authoritative prompt is loaded from
    // navio-system-prompt.txt (or -legacy.txt) and injected by
    // injectSystemPrompt() in main.js before every API call.
    this.systemPrompt = 'You are Navio, an intelligent AI browser assistant.';

    this.bindEvents();
  }

  bindEvents() {
    document.getElementById('btn-toggle-assistant').addEventListener('click', () => this.toggle());
    document.getElementById('btn-close-assistant').addEventListener('click', () => this.close());
    document.getElementById('btn-clear-chat').addEventListener('click', () => this.clearChat());
    document.getElementById('btn-send-message').addEventListener('click', () => this.sendMessage());

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.inputEl.addEventListener('input', () => {
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

  async _processAttachmentFile(file, entry) {
    try {
      if (navioIsImageFile(file)) {
        if (file.size > NAVIO_ASSISTANT_IMAGE_MAX_BYTES) {
          throw new Error('Image too large (max 8 MB).');
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('Could not read image.'));
          r.readAsDataURL(file);
        });
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
      } else {
        entry.status = 'ready';
        entry.kind = 'binary';
        entry.text = '';
        entry.thumb = '';
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

  _buildAttachmentPayloadForApi(baseText) {
    const imageParts = [];
    const pdfParts = [];
    let textExtra = '';
    const ready = (this._attachmentsSnapshot || this._attachmentQueue).filter((a) => a.status === 'ready');
    for (const e of ready) {
      if (e.kind === 'image' && e.dataUrl) {
        imageParts.push({ type: 'image_url', image_url: { url: e.dataUrl, detail: 'high' } });
      } else if (e.kind === 'pdf' && e.base64) {
        pdfParts.push({ type: 'navio_pdf', filename: e.name, base64: e.base64 });
      } else if (e.kind === 'text' && e.text) {
        textExtra += `\n\n--- attached: ${e.name} ---\n\`\`\`\n${e.text}\n\`\`\`\n`;
      } else if (e.kind === 'binary') {
        textExtra += `\n\n[Attached file the app could not open as text: **${e.name}** — describe what you need or convert to PDF/image if the model should read it.]`;
      }
    }
    const fullText = (baseText || '') + textExtra;
    const hasShot = !!this._pendingScreenshotDataUrl;
    if (!imageParts.length && !pdfParts.length && !hasShot) {
      return fullText;
    }
    const parts = [];
    let head = fullText;
    if (hasShot) {
      head +=
        '\n\n[Attached: screenshot of the active tab after the last action. Use it to choose precise click:xy= coordinates or verify UI state.]';
    }
    parts.push({ type: 'text', text: head || '(see attachments)' });
    for (const p of pdfParts) parts.push(p);
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
    const cfg = await window.navio.getConfig();
    if (this.scopeSelect) {
      const v = cfg.aiDataScope || (cfg.aiIncludePageContext === false ? 'none' : 'excerpt');
      this.scopeSelect.value = ['none', 'selection', 'excerpt', 'full'].includes(v) ? v : 'excerpt';
    }
    const stepToggle = document.getElementById('assistant-step-mode-toggle');
    if (stepToggle) stepToggle.checked = !!cfg.aiAgentStepMode;
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

  // Resolve @[Tab Title] references → fetch page content for each → build system messages
  async _resolveAtMentions(text) {
    const matches = [...text.matchAll(/@\[([^\]]+)\]/g)];
    if (!matches.length) return [];
    const tabs = typeof TabManager !== 'undefined' ? TabManager.tabs : [];
    const contextMessages = [];
    for (const m of matches) {
      const title = m[1];
      const tab = tabs.find((t) => {
        const d = TabManager.getTabDisplayTitle(t);
        return d === title || d.toLowerCase() === title.toLowerCase() || t.title === title || (t.title || '').toLowerCase() === title.toLowerCase();
      });
      if (!tab || !tab.webview) continue;
      try {
        const wc = tab.webview.getWebContentsId();
        const content = await window.navio.extractPageContent(wc);
        if (content && !content.error) {
          const body = (content.text || '').slice(0, 15000);
          contextMessages.push({
            role: 'system',
            content: `[Referenced tab: "${title}"]\nURL: ${content.url}\nTitle: ${content.title}\n\n${body}`
          });
        }
      } catch {}
    }
    return contextMessages;
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  async open() {
    this.isOpen = true;
    this.panel.classList.add('open');
    await this.syncScopeFromConfig();
    if (this.messagesEl && this.messagesEl.children.length === 0) {
      await this._showGreeting();
    }
    setTimeout(() => this.inputEl.focus(), 300);
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
    this.isOpen = false;
    this.panel.classList.remove('open');
  }

  async sendMessage() {
    const text = this.inputEl.value.trim();
    const hasReadyAttachments = this._attachmentQueue.some((a) => a.status === 'ready');
    if (this._attachmentsStillLoading()) {
      this.addMessage('assistant', 'Wait until attachments finish loading.', 'error');
      return;
    }
    if ((!text && !hasReadyAttachments) || this.isProcessing) return;

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
    if (this.isProcessing) return;
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

  async buildPageContextSystemMessage(config, isQuickAction) {
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

    if (scope === 'selection') {
      const wv = TabManager.getActiveWebview();
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

  _clearStreamListeners() {
    this._streamUnsubs.forEach((u) => {
      try {
        u();
      } catch {
        /* ignore */
      }
    });
    this._streamUnsubs = [];
  }

  async processMessage(text, isQuickAction = false, historyUserLabel = null) {
    const config = await window.navio.getConfig();

    if (config.aiKillSwitch) {
      this.addMessage('assistant', 'AI is turned off (kill switch). Enable it in **Settings → AI → Policy**.');
      return;
    }

    if (!config.hasApiKey) {
      this.addMessage('assistant', 'Please set your API key in **Settings** first.');
      return;
    }

    this.isProcessing = true;
    if (!isQuickAction) this._actionFormatRetries = 0;
    this.showTypingIndicator();

    // ── Tool-calling mode (new agentic path) ────────────────────────────────
    if (config.aiUseToolCalling && !isQuickAction) {
      try {
        await this._processWithTools(text, config, historyUserLabel || this._historyLabelForAttachments(text));
      } catch (err) {
        this.removeTypingIndicator();
        this.addMessage('assistant', err.message || 'Tool-calling error', 'error');
      }
      this.isProcessing = false;
      return;
    }
    // ── Legacy <navio-actions> path ──────────────────────────────────────────

    const messages = [{ role: 'system', content: this.systemPrompt }];

    // ── Always inject active tab so the AI knows what page the user is on ──
    if (!isQuickAction && typeof TabManager !== 'undefined') {
      const activeTab = TabManager.getActiveTab();
      if (activeTab && activeTab.url && !activeTab.url.startsWith('about:')) {
        messages.push({
          role: 'system',
          content: `[Active tab]\nTitle: ${TabManager.getTabDisplayTitle(activeTab) || '(untitled)'}${activeTab.customTitle ? ` (page: ${activeTab.title || '—'})` : ''}\nURL: ${activeTab.url}`
        });
      }
    }

    const ctxMsg = await this.buildPageContextSystemMessage(config, isQuickAction);
    if (ctxMsg) messages.push(ctxMsg);

    const activeUrl = TabManager.getActiveTab()?.url || '';
    if (typeof EmailAssistant !== 'undefined' && EmailAssistant.isMailUrl(activeUrl)) {
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
      if (allTabs.length > 1) {
        const tabList = allTabs.map((t, i) => `${i + 1}. ${TabManager.getTabDisplayTitle(t) || t.url} — ${t.url}`).join('\n');
        messages.push({ role: 'system', content: `[Open tabs (${allTabs.length})]\n${tabList}` });
      }
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

    // Resolve @[Tab Title] mentions — inject referenced tabs' content
    const mentionMsgs = await this._resolveAtMentions(text);
    if (mentionMsgs.length) {
      messages.push({ role: 'system', content: `[Multi-tab context — ${mentionMsgs.length} tab(s) referenced by the user]` });
      messages.push(...mentionMsgs);
    }

    // Inject connected service context when the query seems to target them
    if (!isQuickAction && typeof ConnectorsManager !== 'undefined') {
      const connectorCtx = await this._buildConnectorContext(text);
      if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
    }

    // Inject accessibility snapshot for browser control / "what's on this page".
    // Skip for pure mail-triage asks (API Gmail is better than clicking the mail UI) — BUT if the user
    // also asks about the visible page (navioDetectPageFocusIntent), always include the snapshot so
    // mixed questions are not confusing.
    const isMailTriageQuery =
      /\b(email|gmail|mail|inbox|draft|reply|unread|thread|message|mailbox|notification)\b/i.test(text) &&
      /\b(check|show|list|read|summarize|search|draft|reply|unread|any|find|what|whats|what's|how|connected|got|gotten|missed|look|see|view|peek|triage|new|latest|arrived|anything|something|important|came\s+in|waiting)\b/i.test(
        text
      ) &&
      !/\b(click|navigate|fill|type\s+in|press\s+|scroll\s+to|open\s+http|open\s+www)/i.test(text);
    const pageFocusAsk = navioDetectPageFocusIntent(text);
    const actionVerbBrowse =
      /\b(click|go to|open|navigate|visit|search|type|fill|scroll|find|press|submit|play|watch|buy|book|login|sign)\b/i.test(text);
    const wantsPageSnapshot = pageFocusAsk || (!isMailTriageQuery && actionVerbBrowse);
    if (wantsPageSnapshot && !isQuickAction) {
      const snapText = await this._getPageSnapshotText();
      if (snapText) messages.push({ role: 'system', content: snapText });
    }

    const recentHistory = this.conversationHistory.slice(-40);
    messages.push(...recentHistory);
    const userContent = this._buildAttachmentPayloadForApi(text);
    messages.push({ role: 'user', content: userContent });
    const userHistory = historyUserLabel || this._historyLabelForAttachments(text);

    const useStream = config.aiStreamResponses !== false && (config.aiProvider === 'openai' || config.aiProvider === 'custom');

    try {
      if (useStream) {
        await this._processStream(messages, userHistory);
      } else {
        const result = await window.navio.aiRequest({ messages });
        this.removeTypingIndicator();
        if (result.error) {
          this.addMessage('assistant', result.error, 'error');
        } else {
          this.addMessage('assistant', result.content);
          this._checkAndShowActionFormatWarning(result.content, this.messagesEl.querySelector('.assistant-message:last-of-type'));
          if (userHistory) {
            this.conversationHistory.push(
              { role: 'user', content: userHistory },
              { role: 'assistant', content: result.content }
            );
          } else {
            // Auto-follow-up: only store the AI turn so context is preserved
            this.conversationHistory.push({ role: 'assistant', content: result.content });
          }
          this._trimHistory();
          await window.navio.contextGraph({
            op: 'addTurn',
            role: 'assistant',
            summary: result.content.slice(0, 200),
            tabId: TabManager.getActiveTab()?.id,
            url: TabManager.getActiveTab()?.url || ''
          });
        }
      }
    } catch (err) {
      this.removeTypingIndicator();
      this.addMessage('assistant', err.message, 'error');
    }

    this.isProcessing = false;
  }

  /**
   * Tool-calling path: builds context messages, sets up navigate/progress
   * listeners, calls the main-process agentic loop, and displays results.
   */
  async _processWithTools(text, config, historyUserLabel) {
    // Build context messages (same as legacy path but without page snapshot —
    // the model will call read_page itself via tools)
    const messages = [{ role: 'system', content: this.systemPrompt }];

    if (typeof TabManager !== 'undefined') {
      const activeTab = TabManager.getActiveTab();
      if (activeTab && activeTab.url && !activeTab.url.startsWith('about:')) {
        messages.push({
          role: 'system',
          content: `[Active tab]\nTitle: ${TabManager.getTabDisplayTitle(activeTab) || '(untitled)'}${activeTab.customTitle ? ` (page: ${activeTab.title || '—'})` : ''}\nURL: ${activeTab.url}`
        });
      }
    }

    // Page context scope (selection/excerpt/full) — still useful for non-browsing queries
    const ctxMsg = await this.buildPageContextSystemMessage(config, false);
    if (ctxMsg) messages.push(ctxMsg);

    // Email hint
    const activeUrl = TabManager.getActiveTab()?.url || '';
    if (typeof EmailAssistant !== 'undefined' && EmailAssistant.isMailUrl(activeUrl)) {
      const hint = EmailAssistant.contextHint(activeUrl);
      if (hint) messages.push({ role: 'system', content: hint });
    }

    // Open tabs awareness
    if (typeof TabManager !== 'undefined') {
      const allTabs = TabManager.tabs.filter(t => t.url && !t.url.startsWith('about:')).slice(0, 20);
      if (allTabs.length > 1) {
        const tabList = allTabs.map((t, i) => `${i + 1}. ${TabManager.getTabDisplayTitle(t) || t.url} — ${t.url}`).join('\n');
        messages.push({ role: 'system', content: `[Open tabs (${allTabs.length})]\n${tabList}` });
      }
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

    // @mentions
    const mentionMsgs = await this._resolveAtMentions(text);
    if (mentionMsgs.length) {
      messages.push({ role: 'system', content: `[Multi-tab context — ${mentionMsgs.length} tab(s) referenced by the user]` });
      messages.push(...mentionMsgs);
    }

    // Connector context
    if (typeof ConnectorsManager !== 'undefined') {
      const connectorCtx = await this._buildConnectorContext(text);
      if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
    }

    // Conversation history (skip stale page snapshots)
    const recentHistory = this.conversationHistory
      .slice(-40)
      .filter(m => {
        if (m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[Page elements')) return false;
        return true;
      });
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: this._buildAttachmentPayloadForApi(text) });

    // Create the agent activity feed element
    const activityEl = document.createElement('div');
    activityEl.className = 'navio-agent-activity';
    activityEl.innerHTML = '<div class="naa-header"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> Navio is working...</div><div class="naa-steps"></div>';
    this.messagesEl.appendChild(activityEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    this._currentActivityEl = activityEl;

    // Set up navigate handler
    const unNav = window.navio.onToolNavigate(async ({ url }) => {
      this._appendActivityStep('navigate', `Navigating to ${new URL(url).hostname}...`);
      try {
        const loadResult = await TabManager.navigateActiveAndWaitForLoad(url);
        if (!loadResult.ok) {
          window.navio.toolNavigateAck({
            success: false,
            error: loadResult.error || 'load failed',
            url: TabManager.getActiveTab()?.url || url
          });
          return;
        }
        window.navio.toolNavigateAck({
          success: true,
          url: TabManager.getActiveTab()?.url || url,
          timedOut: !!loadResult.timedOut
        });
      } catch (e) {
        window.navio.toolNavigateAck({ error: e.message });
      }
    });

    // Set up tab management handlers
    const unOpenTab = window.navio.onToolOpenTab(async ({ url }) => {
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
          window.navio.toolOpenTabAck({ success: false, error: loadResult.error || 'load failed' });
          return;
        }
        const tab = loadResult.tab || TabManager.getActiveTab();
        const wv = tab?.webview;
        window.navio.toolOpenTabAck({
          success: true,
          tab_id: tab?.id || '',
          webContentsId: wv?.getWebContentsId?.() || null,
          url: tab?.url || '',
          title: tab ? TabManager.getTabDisplayTitle(tab) : '',
          timedOut: !!loadResult.timedOut
        });
      } catch (e) {
        window.navio.toolOpenTabAck({ error: e.message });
      }
    });

    const unCloseTab = window.navio.onToolCloseTab(async ({ tab_id }) => {
      this._appendActivityStep('close_tab', `Closing tab ${tab_id}`);
      try {
        TabManager.closeTab(tab_id);
        await new Promise(r => setTimeout(r, 300));
        const active = TabManager.getActiveTab();
        window.navio.toolCloseTabAck({
          success: true,
          active_tab_id: active?.id || '',
          webContentsId: active?.webview?.getWebContentsId?.() || null
        });
      } catch (e) {
        window.navio.toolCloseTabAck({ error: e.message });
      }
    });

    const unSwitchTab = window.navio.onToolSwitchTab(async ({ tab_id }) => {
      this._appendActivityStep('switch_tab', `Switching to tab ${tab_id}`);
      try {
        TabManager.switchToTab(tab_id);
        await new Promise(r => setTimeout(r, 500));
        const tab = TabManager.getActiveTab();
        const wv = tab?.webview;
        window.navio.toolSwitchTabAck({
          success: true,
          tab_id: tab?.id || '',
          webContentsId: wv?.getWebContentsId?.() || null,
          url: tab?.url || '',
          title: tab ? TabManager.getTabDisplayTitle(tab) : ''
        });
      } catch (e) {
        window.navio.toolSwitchTabAck({ error: e.message });
      }
    });

    const unListTabs = window.navio.onToolListTabs(async () => {
      this._appendActivityStep('list_tabs', 'Listing open tabs...');
      try {
        const tabs = TabManager.tabs
          .filter(t => t.url || t.id)
          .map(t => ({
            tab_id: t.id,
            title: TabManager.getTabDisplayTitle(t) || '(untitled)',
            url: t.url || '',
            active: t.id === TabManager.activeTabId,
            webContentsId: t.webview?.getWebContentsId?.() || null
          }));
        window.navio.toolListTabsAck({ success: true, tabs });
      } catch (e) {
        window.navio.toolListTabsAck({ error: e.message });
      }
    });

    // Set up reasoning handler (intermediate AI thinking during tool loop)
    const unReasoning = window.navio.onToolReasoning?.(({ step, text }) => {
      this._appendActivityStep('thinking', text.slice(0, 200) + (text.length > 200 ? '...' : ''));
    });

    // Set up plan approval handler
    const unProposePlan = window.navio.onToolProposePlan?.(({ title, steps, estimated_time, risks }) => {
      this._appendActivityStep('propose_plan', `Plan: ${title}`);
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
        window.navio.toolProposePlanAck({ approved: true, title });
      });
      planEl.querySelector('.npc-cancel')?.addEventListener('click', () => {
        planEl.querySelector('.npc-actions').innerHTML = '<span class="npc-cancelled">Cancelled</span>';
        window.navio.toolProposePlanAck({ cancelled: true, title });
      });
    });

    // Set up progress handler
    const unProgress = window.navio.onToolProgress(({ step, tool, result }) => {
      if (tool === 'navigate') return; // already shown
      if (tool === 'gmail_search' && result && !result.error) {
        this._ingestGmailSearchToolResults(result);
      }
      const label = this._toolProgressLabel(tool, result);
      this._appendActivityStep(tool, label);
    });

    // Set up abort
    let aborted = false;
    const stopBtn = document.createElement('button');
    stopBtn.className = 'navio-agent-stop-btn';
    stopBtn.type = 'button';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => { aborted = true; });
    activityEl.querySelector('.naa-header').appendChild(stopBtn);

    // Call the tool-calling IPC
    const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    const response = await window.navio.aiRequestWithTools({
      messages,
      webContentsId: wv?.getWebContentsId()
    });

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

    // Update activity feed to done state
    const header = activityEl.querySelector('.naa-header');
    if (header) {
      stopBtn.remove();
      const stepsCount = (response.toolLog || []).length;
      header.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Done${stepsCount ? ` (${stepsCount} steps)` : ''}`;
    }

    // Offer to save as workflow if the tool loop had multiple steps
    if (response.toolLog && response.toolLog.length >= 2 && !response.error) {
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
      this.addMessage('assistant', response.error, 'error');
    } else if (response.content) {
      this.addMessage('assistant', response.content);
      const userHistory = historyUserLabel || this._historyLabelForAttachments(text);
      this.conversationHistory.push(
        { role: 'user', content: userHistory },
        { role: 'assistant', content: response.content }
      );
      this._trimHistory();
      await window.navio.contextGraph({
        op: 'addTurn',
        role: 'assistant',
        summary: response.content.slice(0, 200),
        tabId: TabManager.getActiveTab()?.id,
        url: TabManager.getActiveTab()?.url || ''
      });
    }
  }

  _appendActivityStep(tool, label) {
    if (!this._currentActivityEl) return;
    const stepsEl = this._currentActivityEl.querySelector('.naa-steps');
    if (!stepsEl) return;
    const step = document.createElement('div');
    step.className = 'naa-step';
    step.innerHTML = `<span class="naa-tool">${tool}</span> <span class="naa-label">${label}</span>`;
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
      case 'run_workflow': return `Running workflow: ${result?.workflow_name || ''}`;
      case 'gmail_search': return `Gmail: ${result?.results?.length ?? 0} message(s)`;
      case 'gmail_get_message': return `Gmail: opened message`;
      default: return tool;
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  async _processStream(messages, userHistory) {
    this._clearStreamListeners();
    let buffer = '';
    let streamingMsg = null;
    let finalized = false;
    let stallTimer = null;

    // Shared finalize: renders buffer with action cards, saves history.
    // Safe to call from done event, stall timeout, or error handler.
    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(stallTimer);
      this._clearStreamListeners();
      this.removeTypingIndicator();

      if (!buffer) {
        this.addMessage('assistant', 'No response received. Please try again.', 'error');
        return;
      }

      if (streamingMsg) {
        const contentEl = streamingMsg.querySelector('.message-content');
        if (contentEl) {
          contentEl.innerHTML = this.formatMessage(buffer, true);
          await this._wireActions(contentEl);
          this._checkAndShowActionFormatWarning(buffer, streamingMsg);
        }
      }
      this.conversationHistory.push(
        { role: 'user', content: userHistory },
        { role: 'assistant', content: buffer }
      );
      this._trimHistory();
      await window.navio.contextGraph({
        op: 'addTurn',
        role: 'assistant',
        summary: buffer.slice(0, 200),
        tabId: TabManager.getActiveTab()?.id,
        url: TabManager.getActiveTab()?.url || ''
      });
    };

    // Stall detector: if no new chunk arrives within 25 s, force-finalize.
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { finalize(); }, 25000);
    };

    const unChunk = window.navio.onAiStreamChunk((chunk) => {
      buffer += chunk;
      resetStallTimer();
      if (!streamingMsg) {
        this.removeTypingIndicator();
        streamingMsg = document.createElement('div');
        streamingMsg.className = 'message assistant-message';
        const contentEl = document.createElement('div');
        contentEl.className = 'message-content streaming-content';
        streamingMsg.appendChild(contentEl);
        this.messagesEl.appendChild(streamingMsg);
      }
      const contentEl = streamingMsg.querySelector('.message-content');
      contentEl.innerHTML = this.formatMessage(buffer);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });

    const unDone = window.navio.onAiStreamDone(async () => {
      await finalize();
    });

    const unErr = window.navio.onAiStreamError(async (msg) => {
      clearTimeout(stallTimer);
      this._clearStreamListeners();
      if (finalized) return;
      if (!buffer) {
        // Nothing received — try a non-streaming fallback
        this.removeTypingIndicator();
        const fallback = await window.navio.aiRequest({ messages });
        if (fallback.error) {
          this.addMessage('assistant', fallback.error || msg, 'error');
        } else {
          this.addMessage('assistant', fallback.content);
          this._checkAndShowActionFormatWarning(
            fallback.content,
            this.messagesEl.querySelector('.assistant-message:last-of-type')
          );
          this.conversationHistory.push(
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

    this._streamUnsubs.push(unChunk, unDone, unErr);

    const streamResult = await window.navio.aiRequestStream({ messages });
    if (streamResult && streamResult.ok === false && !buffer) {
      clearTimeout(stallTimer);
      this.removeTypingIndicator();
    }
  }

  _trimHistory() {
    if (this.conversationHistory.length > 80) {
      this.conversationHistory = this.conversationHistory.slice(-60);
    }
    // Strip stale page snapshot context from older system messages
    const len = this.conversationHistory.length;
    for (let i = 0; i < len - 4; i++) {
      const m = this.conversationHistory[i];
      if (m.role === 'system' && typeof m.content === 'string') {
        if (m.content.startsWith('[Page elements') || m.content.startsWith('[Page text')) {
          this.conversationHistory[i] = { role: 'system', content: '[page context removed — stale]' };
        }
      }
    }
  }

  addMessage(role, content, type = '') {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}-message${type ? ' message-' + type : ''}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    if (role === 'user' && content && typeof content === 'object' && !Array.isArray(content) && content.files) {
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
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /**
   * Extract Gmail message id from a mail.google.com href (fragment may be inbox/id, search/…, etc.).
   */
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

  _buildEmailRefChipHtml(url, msgId, subjectLabel) {
    const ref = (msgId && this._emailRefs?.get(msgId)) || {};
    const safeUrl = (url || '').replace(/"/g, '&quot;');
    const display = (subjectLabel || ref.subject || '(no subject)').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeFrom = (ref.from || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeSnippet = (ref.snippet || '').replace(/"/g, '&quot;').slice(0, 500);
    const midAttr = msgId ? ` data-msg-id="${String(msgId).replace(/"/g, '&quot;')}"` : '';
    return (
      `<span class="email-ref-chip" data-url="${safeUrl}"${midAttr} data-from="${safeFrom}" data-snippet="${safeSnippet}" role="button" tabindex="0" title="Open in Gmail · hover for body">`
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
          const chipUrl = ref.url || `https://mail.google.com/mail/u/0/#inbox/${frag.id}`;
          const wrap = document.createElement('div');
          wrap.innerHTML = this._buildEmailRefChipHtml(chipUrl, frag.id, ref.subject || frag.subject);
          const chip = wrap.firstElementChild;
          if (chip) parent.insertBefore(chip, refNode);
        }
      }
      parent.removeChild(refNode);
    }

    return tpl.innerHTML;
  }

  /** Register Gmail rows from agent gmail_search tool results (same shape as connector). */
  _ingestGmailSearchToolResults(result) {
    const rows = result?.results;
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r?.id) continue;
      const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${r.id}`;
      this._emailRefs.set(r.id, {
        subject: r.subject || '(no subject)',
        from: r.from || '',
        snippet: r.snippet || '',
        url: gmailUrl
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
      /<a\s+href="(https:\/\/mail\.google\.com\/mail\/u\/\d+\/[^"]*#([^"]+))"[^>]*>([^<]*)<\/a>/gi,
      (_, url, _frag, subject) => {
        const msgId = this._resolveGmailMessageIdFromMailUrl(url);
        return this._buildEmailRefChipHtml(url, msgId, subject);
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
    const prevBusy = this.isProcessing;
    this.isProcessing = true;
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
      this.isProcessing = prevBusy;
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
      chip.addEventListener('click', () => {
        const url = chip.dataset.url;
        if (!url) return;
        if (typeof TabManager !== 'undefined' && typeof TabManager.createTab === 'function') {
          TabManager.createTab(url);
        } else {
          window.open(url, '_blank');
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
          if (cached) {
            bodySlot.innerHTML = `<div class="ect-body">${_ectEsc(cached.slice(0, 12000))}</div>`;
          } else {
            bodySlot.innerHTML = '<div class="ect-body-loading">Loading full message…</div>';
            const gen = Date.now();
            chip._emailTipGen = gen;
            window.navio.gmailGetMessageBody(mid).then((res) => {
              if (chip._emailTipGen !== gen || !document.body.contains(tip)) return;
              if (res?.error) {
                bodySlot.innerHTML = `<div class="ect-snippet ect-muted">${_ectEsc(res.error)}</div>`;
              } else {
                const body = (res?.body || '').trim();
                if (body) this._emailBodyCache.set(mid, body);
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
        if (!TabManager || typeof TabManager.navigateActiveAndWaitForLoad !== 'function') {
          throw new Error('TabManager unavailable');
        }
        const loadResult = await TabManager.navigateActiveAndWaitForLoad(url, {
          timeoutMs: 12000,
          settleMs: 600
        });
        if (!loadResult.ok) throw new Error(loadResult.error || 'Navigation failed');

        const wvAfter = TabManager.getActiveWebview();

        let finalUrl = '';
        try {
          const pg = await TabManager.getActivePageContent();
          finalUrl = pg?.url || '';
        } catch {
          /* ignore */
        }
        if (!finalUrl) {
          const tab = TabManager.getActiveTab();
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
    if (this.isProcessing || this._autoFollowCount >= MAX_AUTO_STEPS) {
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
    const emailConversation = this.conversationHistory.some(m =>
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
      const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
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
    const indicator = document.createElement('div');
    indicator.className = 'message assistant-message';
    indicator.id = 'typing-indicator';
    indicator.innerHTML = `
      <div class="message-content typing-indicator">
        <span></span><span></span><span></span>
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
    this.conversationHistory = [];
    this.setReceipt('');
    this.messagesEl.innerHTML = '';
    this._attachmentsSnapshot = null;
    this._clearAttachmentQueue();
    this._showGreeting();
  }

  // ── Connector Context Injection ─────────────────────────────────────────
  // Detects which connected services are relevant to the user's query,
  // queries them, and returns a formatted system context block.

  async _buildConnectorContext(text) {
    try {
      const connected = ConnectorsManager.getConnectedIntegrations();
      if (connected.length === 0) return null;

      // Fresh refs per user turn so subject enrichment only matches this query's messages.
      this._emailRefs.clear();

      const results = [];
      const has = (id) => connected.some((c) => c.id === id);

      // Helper: extract a clean search term from the user query
      const clean = (pattern) => text.replace(pattern, '').replace(/\b(my|the|search|find|in|from|about|show|list|all|open|get|what|are|is|any)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

      // ── Perplexity (real-time web search) ──────────────────────────────
      const webSearchIntent = /\b(search|look up|find out|what is|who is|latest|news|current|today|recent|web)\b/i.test(text);
      if (has('perplexity') && webSearchIntent) {
        try {
          const res = await ConnectorsManager.queryConnector('perplexity', text);
          if (res?.answer) {
            results.push(`[Perplexity Web Search]\n${res.answer.slice(0, 1400)}${res.citations?.length ? `\n\nSources: ${res.citations.slice(0, 4).join(', ')}` : ''}`);
          }
        } catch (_) {}
      }

      // ── Gmail ──────────────────────────────────────────────────────────
      const gmailIntent = navioDetectMailboxIntent(text);
      if (has('gmail') && gmailIntent) {
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

        try {
          const res = await ConnectorsManager.queryConnector('gmail', gmailQuery, {
            maxResults: fetchCount,
            pages: fetchCount > 25 ? 2 : 1
          });
          if (res?.error) {
            results.push(`[Gmail connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const lines = res.results.map((r, idx) => {
              const gmailUrl = r.id ? `https://mail.google.com/mail/u/0/#inbox/${r.id}` : '';
              if (r.id) {
                this._emailRefs.set(r.id, {
                  subject: r.subject || '(no subject)',
                  from: r.from || '',
                  snippet: r.snippet || '',
                  url: gmailUrl
                });
              }
              const snippet = r.snippet ? `\n  "${r.snippet.slice(0, 150)}"` : '';
              const dateStr = r.date ? ` · ${r.date}` : '';
              const num = `${idx + 1}.`;
              return gmailUrl
                ? `${num} [${r.subject || '(no subject)'}](${gmailUrl}) — From: ${r.from || '?'}${dateStr}${snippet}`
                : `${num} From: ${r.from || '?'} · Subject: ${r.subject || '(no subject)'}${dateStr}${snippet}`;
            }).join('\n');
            this._lastGmailPageToken = res.nextPageToken || null;
            this._lastGmailQuery = gmailQuery;
            const totalInfo = res.total > res.results.length
              ? ` (showing ${res.results.length} of ~${res.total} total)`
              : '';
            results.push(`[Gmail — ${res.results.length} result(s) for "${gmailQuery}"${totalInfo}]\n${lines}${res.nextPageToken ? '\n\n(More results available — user can ask to "load more" or "show more emails")' : ''}`);
          } else {
            results.push(`[Gmail — 0 results for "${gmailQuery}"]`);
          }
        } catch (_) {}
      }

      // ── Gmail "load more" / continuation ────────────────────────────────
      const wantsMore = /\b(more|next|continue|load more|show more|rest of|remaining)\b/i.test(text)
        && /\b(email|mail|gmail|result|inbox)\b/i.test(text);
      if (has('gmail') && wantsMore && this._lastGmailPageToken && !gmailIntent) {
        try {
          const res = await ConnectorsManager.queryConnector('gmail', this._lastGmailQuery, {
            maxResults: 25,
            pageToken: this._lastGmailPageToken,
            pages: 1
          });
          if (res?.results?.length) {
            const lines = res.results.map((r, idx) => {
              const gmailUrl = r.id ? `https://mail.google.com/mail/u/0/#inbox/${r.id}` : '';
              if (r.id) {
                this._emailRefs.set(r.id, {
                  subject: r.subject || '(no subject)',
                  from: r.from || '',
                  snippet: r.snippet || '',
                  url: gmailUrl
                });
              }
              const snippet = r.snippet ? `\n  "${r.snippet.slice(0, 150)}"` : '';
              const dateStr = r.date ? ` · ${r.date}` : '';
              return `${idx + 1}. [${r.subject || '(no subject)'}](${gmailUrl}) — From: ${r.from || '?'}${dateStr}${snippet}`;
            }).join('\n');
            this._lastGmailPageToken = res.nextPageToken || null;
            results.push(`[Gmail — next ${res.results.length} result(s)]\n${lines}${res.nextPageToken ? '\n\n(Still more available)' : '\n\n(End of results)'}`);
          }
        } catch (_) {}
      }

      // ── Outlook ────────────────────────────────────────────────────────
      const outlookExplicit =
        /\boutlook|hotmail|live\.com|office\s*365|microsoft\s*365|exchange\b/i.test(text);
      const outlookMailIntent =
        has('outlook') &&
        (outlookExplicit || (!has('gmail') && navioDetectMailboxIntent(text)));
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
        /\b(drive|google\s*drive|gdrive|googledocs|google\s*docs|sheets?|slides?|file|document|doc|spreadsheet|presentation|folder|my\s+files)\b/i.test(
          text
        ) ||
        /\b(what|show|list|find|where|anything)\b[\s\S]{0,48}\b(drive|docs|sheets|slides|files?)\b/i.test(text) ||
        /\b(on|in)\s+my\s+drive\b/i.test(text);
      if (has('gdrive') && driveIntent) {
        let q = clean(/\b(drive|gdrive|file|document|doc|sheet|spreadsheet|slide|folder|googledocs|google\s*docs)\b/gi);
        if (!q || q.length < 2) q = '__NAVIO_RECENT__';
        try {
          const res = await ConnectorsManager.queryConnector('gdrive', q, { pageSize: 8 });
          if (res?.error) {
            results.push(`[Google Drive connector error: ${res.error}]`);
          } else if (res?.results?.length) {
            const label = q === '__NAVIO_RECENT__' ? 'recent (last modified)' : q;
            const lines = res.results.map((r) => `- ${r.name}${r.type ? ` [${r.type.replace('application/vnd.google-apps.', '')}]` : ''}`).join('\n');
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
