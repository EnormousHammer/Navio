/**
 * Navio Browser - AI Assistant
 * Policy-scoped context, streaming (OpenAI), context receipt, pin tab / graph.
 */

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

    this.systemPrompt = `You are Navio, an intelligent AI assistant built into the Navio Browser. You help users browse the web, understand content, and automate tasks.

BROWSER CONTROL:
When the user asks you to do something in the browser, write your explanation first, then end your response with a <navio-actions> block listing every step.

Action block format — ONE action per line:
<navio-actions>
navigate:https://full-url-here
click:text=Visible button label
type:text=Field label:text to type
scroll:down
goBack:
goForward:
</navio-actions>

SMART NAVIGATION — always use a direct URL, never navigate + search:
- YouTube search → navigate:https://www.youtube.com/results?search_query=your+query
- Google search  → navigate:https://www.google.com/search?q=your+query
- Reddit search  → navigate:https://www.reddit.com/search/?q=query
- Wikipedia      → navigate:https://en.wikipedia.org/wiki/Topic

RULES:
1. Always prefer navigate with a full URL over click-to-search.
2. For click/type use text= (visible label) or aria= (aria-label) — never CSS selectors.
3. Put ALL steps in ONE <navio-actions> block at the end. Never split across messages.
4. Never ask "shall I proceed?" — just do it.
5. If a [Page elements] snapshot is provided, use the EXACT label text shown.

EXAMPLE — for "go to youtube and play world news":
I'll navigate straight to the YouTube search results for world news and click the first video.
<navio-actions>
navigate:https://www.youtube.com/results?search_query=world+news
click:text=Watch now
</navio-actions>

FORMATTING:
- Use markdown: **bold**, *italic*, # headings, bullet lists, \`code\`, > blockquotes.
- Keep responses concise and scannable.
- Do NOT output action tokens like [[ACTION:...]] — use the <navio-actions> block only.

STRICT EMAIL RULE — NEVER BREAK THIS:
You are NOT allowed to click the Send button on any email service under ANY circumstances.
- You MAY click "Compose", "Reply", "Reply All" and type draft text into compose fields — this saves drafts for user review.
- You MUST NEVER click "Send" or any button that dispatches an email.
- If the user asks you to "send" an email, explain you can only save drafts — then offer to draft it instead.

CONNECTED INTEGRATIONS:
When [Connected integrations returned...] context appears in the system messages, use it to answer questions. Always cite which service the information came from (e.g. "According to Gmail…", "In Google Drive…", "Perplexity search found…"). If the context is relevant, prioritize it over general knowledge.

PERSONALITY:
- Intelligent, modern, concise. Think Perplexity meets a skilled browser agent.
- Lead with the answer, then context. No filler phrases.`;

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

    const pinBtn = document.getElementById('btn-pin-tab');
    if (pinBtn) {
      pinBtn.addEventListener('click', () => this.pinActiveTab());
    }

    this._bindVoiceMode();
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
          setTimeout(() => { if (hint) hint.textContent = 'Enter to send \u00b7 Shift+Enter for new line'; }, 2500);
        }
      };

      recognition.onend = () => stopListening();
      recognition.start();
    };

    const stopListening = () => {
      listening = false;
      btn.classList.remove('listening');
      if (hint) hint.textContent = 'Enter to send \u00b7 Shift+Enter for new line';
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
      const pageHint = tab && tab.title && tab.url && !tab.url.startsWith('about:')
        ? `<p style="font-size:12px;color:var(--text-tertiary);margin-top:6px">On: <span style="color:var(--text-accent)">${tab.title}</span></p>`
        : '';
      this.addMessage('assistant', `Hey${name}! I'm Navio — your AI co-pilot.\n\nI can **summarize**, **explain**, **extract data**, or answer any question about the page you're on. Try a quick action below or just ask me anything.${pageHint}`);
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
    if (!text || this.isProcessing) return;

    // Task chain intake mode
    if (this._awaitingTaskChain) {
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

    this.addMessage('user', text);
    await this.processMessage(text, false);
  }

  async handleQuickAction(action) {
    if (this.isProcessing) return;
    if (!this.isOpen) this.open();

    const pageContent = await TabManager.getActivePageContent();
    if (!pageContent || pageContent.error) {
      this.addMessage('user', `[${action}]`);
      this.addMessage('assistant', 'No page content available. Navigate to a web page first, then try again.');
      return;
    }

    let prompt;
    switch (action) {
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
      const body = (page.text || '').slice(0, 6000);
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
      this.addMessage('assistant', `Pinned **${tab.title || 'tab'}** to the context graph for this profile.`);
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

    const messages = [{ role: 'system', content: this.systemPrompt }];

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

    const graphNote = await window.navio.contextGraph({ op: 'get' });
    const pinned = graphNote.graph?.pinnedTabIds || [];
    if (pinned.length && typeof TabManager !== 'undefined') {
      const titles = TabManager.tabs
        .filter((t) => pinned.includes(t.id))
        .map((t) => `- ${t.title} (${t.url || 'no url'})`)
        .join('\n');
      if (titles) {
        messages.push({ role: 'system', content: `[Pinned tabs in workspace]\n${titles}` });
      }
    }

    // Inject connected service context when the query seems to target them
    if (!isQuickAction && typeof ConnectorsManager !== 'undefined') {
      const connectorCtx = await this._buildConnectorContext(text);
      if (connectorCtx) messages.push({ role: 'system', content: connectorCtx });
    }

    // Inject accessibility snapshot when user is likely requesting browser control
    const browserIntent = /\b(click|go to|open|navigate|visit|search|type|fill|scroll|find|press|submit|play|watch|buy|book|login|sign)\b/i.test(text);
    if (browserIntent && !isQuickAction) {
      const snapText = await this._getPageSnapshotText();
      if (snapText) messages.push({ role: 'system', content: snapText });
    }

    const recentHistory = this.conversationHistory.slice(-20);
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: text });
    const userHistory = historyUserLabel || text;

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

      if (!buffer) return;

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
    if (this.conversationHistory.length > 40) {
      this.conversationHistory = this.conversationHistory.slice(-30);
    }
  }

  addMessage(role, content, type = '') {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}-message${type ? ' message-' + type : ''}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

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

    msgEl.appendChild(contentEl);
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
      processedText = processedText.replace(/\[\[ACTION:[\s\S]*?\]\]/g, '');
      processedText = processedText.replace(/<<ACTION:[\s\S]*?>>/g, '');
      processedText = processedText.replace(/\[\[TASK_APPROVE:[\s\S]*?\]\]/g, '');
    }

    // ── 2. HTML-escape raw text ───────────────────────────────────────────────
    let html = processedText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // ── 3. Fenced code blocks ─────────────────────────────────────────────────
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const langAttr = lang ? ` class="lang-${lang}"` : '';
      return `<pre${langAttr}><code>${code.trim()}</code></pre>`;
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
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

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
        goForward:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`
      };
      const VERBS = {
        navigate: 'Navigate to', click: 'Click', type: 'Type into',
        scroll: 'Scroll', goBack: 'Go back', goForward: 'Go forward'
      };

      const EDIT_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

      actionCards.forEach(({ type, params }, idx) => {
        let card;
        if (type === 'PLAN') {
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

    return html;
  }

  // ── Takeover mode ────────────────────────────────────────────────────────
  enableTakeover() {
    this._takeoverMode = true;
    // Banner above the input area
    if (!document.getElementById('navio-takeover-banner')) {
      const banner = document.createElement('div');
      banner.id = 'navio-takeover-banner';
      banner.className = 'navio-takeover-banner';
      banner.innerHTML = `
        <span class="ntb-dot"></span>
        <span class="ntb-label">Navio is in control</span>
        <button class="ntb-stop" type="button">Stop</button>`;
      banner.querySelector('.ntb-stop').addEventListener('click', () => this.disableTakeover());
      const inputArea = this.panel.querySelector('.assistant-input-area');
      if (inputArea) this.panel.insertBefore(banner, inputArea);
    }
  }

  disableTakeover() {
    this._takeoverMode = false;
    this._autoFollowCount = 0;
    document.getElementById('navio-takeover-banner')?.remove();
    this._addContinuePill('Navio stopped. You\'re back in control.');
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
      const finish = (keep) => {
        step.classList.remove('navio-plan-editing');
        const span = document.createElement('span');
        span.className = 'navio-plan-text';
        span.textContent = keep ? (ta.value.trim() || original) : original;
        ta.replaceWith(span);
        this._wirePlanStep(step);
      };
      ta.addEventListener('blur', () => finish(true));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); ta.removeEventListener('blur', () => finish(true)); finish(false); }
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
  }

  async _wireActions(contentEl) {
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
    for (const card of cards) {
      if (!this._takeoverMode) break;
      await this._executeAction(card.dataset.action, card.dataset.params, card, true);
      // Stop the chain if an action genuinely failed (element not found, etc.)
      if (card.classList.contains('bac-error')) break;
      // Navigate already waits for page load internally; still give a short gap for paint
      const gap = card.dataset.action === 'navigate' ? 400 : 600;
      if (this._takeoverMode) await new Promise((r) => setTimeout(r, gap));
    }
    // After all cards in this message are done, trigger the agent loop
    if (this._takeoverMode) {
      setTimeout(() => this._smartFollowUp(), 1000);
    }
  }

  async _executeAction(action, paramsStr, card, fromTakeover = false) {
    const wv = typeof TabManager !== 'undefined' ? TabManager.getActiveWebview() : null;
    if (!wv) {
      card.classList.add('bac-error');
      card.querySelector('.bac-btns').innerHTML = '<span class="bac-status">No active tab</span>';
      return;
    }
    card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-running">Running…</span>';

    // ── Navigate: use TabManager.navigateActive() in the renderer ─────────────
    // This correctly hides the Navio new-tab overlay and updates all tab state.
    // Going through the main-process IPC only calls wc.loadURL() which bypasses
    // the overlay-hide logic, leaving the NTP visible on top of the loaded page.
    if (action === 'navigate') {
      try {
        const url = paramsStr;
        if (!TabManager || typeof TabManager.navigateActive !== 'function') throw new Error('TabManager unavailable');
        const ok = TabManager.navigateActive(url);
        if (!ok) throw new Error('Navigation failed to start');

        // Wait for the webview to finish loading (up to 12 s)
        await new Promise((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            wv.removeEventListener('did-finish-load', onLoad);
            wv.removeEventListener('did-fail-load', onFail);
            resolve();
          };
          // Extra paint time after finish-load
          const onLoad = () => setTimeout(settle, 600);
          // ERR_ABORTED (-3) is a normal redirect — treat as success
          const onFail = (e) => {
            if (e && e.errorCode === -3) setTimeout(settle, 600);
            else settle();
          };
          const timer = setTimeout(settle, 12000);
          wv.addEventListener('did-finish-load', onLoad);
          wv.addEventListener('did-fail-load', onFail);
        });

        card.classList.add('bac-done');
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-ok"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>Done</span>';
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
      } else if (action === 'scroll') {
        params = { direction: paramsStr || 'down' };
      }
      const result = await window.navio.browserAction({ webContentsId, action, params, userConfirmed: true });
      if (result && result.success) {
        card.classList.add('bac-done');
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-ok"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>Done</span>';
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
      }
    } catch (err) {
      card.classList.add('bac-error');
      card.querySelector('.bac-btns').innerHTML = `<span class="bac-status">${err.message || 'Error'}</span>`;
    }
  }

  async _smartFollowUp() {
    const MAX_AUTO_STEPS = 10;
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
        pageInfo = `Title: ${page.title}\nURL: ${page.url}\n\nPage content:\n${(page.text || '').slice(0, 10000)}`;
      }
    } catch { /* ignore */ }

    if (!pageInfo) {
      this._addContinuePill('Could not read page — tell me what to do next.');
      return;
    }

    this._addContinuePill('↻ Reading page…');

    // Append accessibility snapshot so AI uses real element labels, not guessed selectors
    const snapText = await this._getPageSnapshotText();
    const followUpText = `[Action completed. Current page state follows.

IMPORTANT AGENT RULES:
- If this is a price/deal/flight/hotel/product research page: EXTRACT all visible prices, options, and dates from the page text above. List them clearly. Do NOT just say "I found results" — show the actual data.
- If multiple options are visible, rank them by price and identify the cheapest with a clear callout.
- If the data looks incomplete or the page didn't fully load, navigate to the same URL again or try an alternate source.
- If steps remain in the plan, continue executing them. If all steps are done, give a final summary with the best option found and why.
- Use [[ACTION:type:params]] format for any new browser actions.
- NEVER make up prices or results — only report what is actually in the page text above.

${pageInfo}${snapText}`;
    await this.processMessage(followUpText, true, null);
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
    this._showGreeting();
  }

  // ── Connector Context Injection ─────────────────────────────────────────
  // Detects which connected services are relevant to the user's query,
  // queries them, and returns a formatted system context block.

  async _buildConnectorContext(text) {
    try {
      const connected = ConnectorsManager.getConnectedIntegrations();
      if (connected.length === 0) return null;

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
      const gmailIntent = /\b(email|gmail|mail|inbox|message|sent|unread|thread|attachment)\b/i.test(text);
      if (has('gmail') && gmailIntent) {
        const q = clean(/\b(email|gmail|mail|inbox|message|sent|unread|thread)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('gmail', q, { maxResults: 4 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- From: ${r.from || '?'} · Subject: ${r.subject}${r.snippet ? `\n  "${r.snippet.slice(0, 100)}"` : ''}`).join('\n');
              results.push(`[Gmail — ${res.total} result(s) for "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── Outlook ────────────────────────────────────────────────────────
      const outlookIntent = /\b(outlook|email|mail|inbox|message|exchange)\b/i.test(text);
      if (has('outlook') && outlookIntent && !has('gmail')) {
        const q = clean(/\b(outlook|email|mail|inbox|message)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('outlook', q, { top: 4 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- From: ${r.from || '?'} · Subject: ${r.subject}`).join('\n');
              results.push(`[Outlook — ${res.total} result(s) for "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── Google Drive ───────────────────────────────────────────────────
      const driveIntent = /\b(drive|file|document|doc|sheet|spreadsheet|slide|presentation|folder|gdrive)\b/i.test(text);
      if (has('gdrive') && driveIntent) {
        const q = clean(/\b(drive|gdrive|file|document|doc|sheet|spreadsheet|slide|folder)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('gdrive', q, { pageSize: 5 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- ${r.name}${r.type ? ` [${r.type.replace('application/vnd.google-apps.', '')}]` : ''}`).join('\n');
              results.push(`[Google Drive — ${res.total} file(s) matching "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── Dropbox ────────────────────────────────────────────────────────
      const dropboxIntent = /\b(dropbox|file|document|folder)\b/i.test(text);
      if (has('dropbox') && dropboxIntent && !has('gdrive')) {
        const q = clean(/\b(dropbox|file|document|folder)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('dropbox', q, { maxResults: 5 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- ${r.name}${r.path ? ` (${r.path})` : ''}`).join('\n');
              results.push(`[Dropbox — ${res.total} file(s) matching "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── OneDrive ───────────────────────────────────────────────────────
      const onedriveIntent = /\b(onedrive|file|document|folder|sharepoint)\b/i.test(text);
      if (has('onedrive') && onedriveIntent) {
        const q = clean(/\b(onedrive|file|document|folder)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('onedrive', q, { top: 5 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- ${r.name}${r.type ? ` [${r.type}]` : ''}`).join('\n');
              results.push(`[OneDrive — ${res.total} file(s) matching "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── Slack ──────────────────────────────────────────────────────────
      const slackIntent = /\b(slack|channel|message|chat|dm|mention|conversation)\b/i.test(text);
      if (has('slack') && slackIntent) {
        const q = clean(/\b(slack|channel|message|chat|dm|mention)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('slack', q, { count: 4 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- #${r.channel || '?'} (${r.user || '?'}): "${r.text.slice(0, 120)}"`).join('\n');
              results.push(`[Slack — ${res.total} message(s) for "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── Google Calendar ────────────────────────────────────────────────
      const calendarIntent = /\b(calendar|meeting|event|schedule|appointment|agenda|today|this week|upcoming)\b/i.test(text);
      if (has('gcalendar') && calendarIntent) {
        const q = clean(/\b(calendar|meeting|event|schedule|appointment|agenda)\b/gi) || 'events';
        try {
          const res = await ConnectorsManager.queryConnector('gcalendar', q);
          if (res?.results?.length) {
            const lines = res.results.map((r) => `- ${r.title} — ${r.start ? new Date(r.start).toLocaleString() : '?'}${r.location ? ` @ ${r.location}` : ''}`).join('\n');
            results.push(`[Google Calendar — ${res.total} upcoming event(s)]\n${lines}`);
          }
        } catch (_) {}
      }

      // ── Notion ─────────────────────────────────────────────────────────
      const notionIntent = /\b(notion|note|page|wiki|knowledge|workspace|doc|document|wrote|saved)\b/i.test(text);
      if (has('notion') && notionIntent) {
        const q = clean(/\b(notion|note|page|wiki|knowledge|workspace)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('notion', q, { pageSize: 4 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- ${r.title}${r.type ? ` (${r.type})` : ''}`).join('\n');
              results.push(`[Notion — ${res.total} result(s) for "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── GitHub ─────────────────────────────────────────────────────────
      const githubIntent = /\b(github|issue|pr|pull request|bug|fix|repo|repository|commit|branch|code)\b/i.test(text);
      if (has('github') && githubIntent) {
        const q = clean(/\b(github|issue|pr|pull request|repo|repository)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('github', q, { type: 'issues', perPage: 4 });
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- [#${r.number || '?'}] ${r.title} (${r.state || 'unknown'})${r.repo ? ` in ${r.repo}` : ''}`).join('\n');
              results.push(`[GitHub — ${res.total} result(s) for "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
      }

      // ── Linear ─────────────────────────────────────────────────────────
      const linearIntent = /\b(linear|ticket|task|sprint|backlog|milestone|assigned)\b/i.test(text);
      if (has('linear') && linearIntent) {
        const q = clean(/\b(linear|ticket|task|sprint|backlog|milestone)\b/gi);
        if (q.length > 2) {
          try {
            const res = await ConnectorsManager.queryConnector('linear', q);
            if (res?.results?.length) {
              const lines = res.results.map((r) => `- ${r.title} [${r.state || 'unknown'}]${r.team ? ` · ${r.team}` : ''}`).join('\n');
              results.push(`[Linear — ${res.total} result(s) for "${q}"]\n${lines}`);
            }
          } catch (_) {}
        }
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
