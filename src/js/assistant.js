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

    this.systemPrompt = `You are Navio, an intelligent AI assistant built into the Navio Browser. You help users browse the web efficiently, understand content, and automate tasks.

CAPABILITIES:
- You receive policy-scoped page context when enabled (see user settings and per-chat scope).
- You help users understand complex content, summarize pages, extract data.
- You can control the active browser tab on behalf of the user.

BROWSER CONTROL:
Embed action tokens in your response. Each becomes a card the user approves, or auto-runs in takeover mode.

Token format (use DOUBLE SQUARE BRACKETS — never angle brackets):
- Navigate:  [[ACTION:navigate:https://example.com]]
- Click:     [[ACTION:click:text=Search]]           ← PREFERRED — finds by visible text
             [[ACTION:click:aria=Submit]]            ← or by aria-label
             [[ACTION:click:#id]]                    ← CSS only as last resort
- Type:      [[ACTION:type:text=Search box:query]]  ← selector:value format
             [[ACTION:type:aria=Search:query text]]
- Scroll:    [[ACTION:scroll:down]]  /  [[ACTION:scroll:up]]
- History:   [[ACTION:goBack:]]  /  [[ACTION:goForward:]]

SMART NAVIGATION — always prefer a direct URL over UI interaction:
- YouTube search:   [[ACTION:navigate:https://www.youtube.com/results?search_query=funny+cats]]
- Google search:    [[ACTION:navigate:https://www.google.com/search?q=your+query]]
- Reddit search:    [[ACTION:navigate:https://www.reddit.com/search/?q=query]]
- Wikipedia:        [[ACTION:navigate:https://en.wikipedia.org/wiki/Topic_Name]]
→ One navigate to the results URL = always more reliable than navigate + type + click.

CRITICAL RULES:
1. Prefer direct URL navigation whenever possible — skip UI search interactions.
2. For click/type, use text= or aria= — CSS selectors break on redesigns.
3. When a [Page elements] snapshot is provided, use EXACT label text from it.
4. Emit ALL steps in ONE response. Never pause mid-task.
5. Keep descriptions concise — one sentence before each token.

FORMATTING:
- Use proper markdown for all responses — this renders beautifully in the UI.
- **Bold** for emphasis, *italic* for secondary info
- # Heading for major sections, ## for sub-sections
- \`inline code\` for technical terms, URLs, selectors
- \`\`\`language blocks for multi-line code
- > blockquote for tips, notes, or quotes
- Bullet lists (- item) and numbered lists (1. item)
- --- for horizontal dividers between sections
- Keep responses focused, scannable, and visually structured
- NEVER show raw action tokens as text — they must be embedded, not described

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
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
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

    const unChunk = window.navio.onAiStreamChunk((chunk) => {
      buffer += chunk;
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
      this._clearStreamListeners();
      if (buffer) {
        // Final render: parse action tokens and wire confirm buttons
        if (streamingMsg) {
          const contentEl = streamingMsg.querySelector('.message-content');
          if (contentEl) {
            contentEl.innerHTML = this.formatMessage(buffer, true);
            this._wireActions(contentEl);
          }
        }
        this.conversationHistory.push({ role: 'user', content: userHistory }, { role: 'assistant', content: buffer });
        this._trimHistory();
        await window.navio.contextGraph({
          op: 'addTurn',
          role: 'assistant',
          summary: buffer.slice(0, 200),
          tabId: TabManager.getActiveTab()?.id,
          url: TabManager.getActiveTab()?.url || ''
        });
      }
    });

    const unErr = window.navio.onAiStreamError(async (msg) => {
      this._clearStreamListeners();
      this.removeTypingIndicator();
      if (!buffer) {
        const fallback = await window.navio.aiRequest({ messages });
        if (fallback.error) {
          this.addMessage('assistant', fallback.error || msg, 'error');
        } else {
          this.addMessage('assistant', fallback.content);
          this.conversationHistory.push(
            { role: 'user', content: userHistory },
            { role: 'assistant', content: fallback.content }
          );
          this._trimHistory();
        }
      } else {
        this.addMessage('assistant', `\n\n*(Stream ended: ${msg})*`);
      }
    });

    this._streamUnsubs.push(unChunk, unDone, unErr);

    const streamResult = await window.navio.aiRequestStream({ messages });
    if (streamResult && streamResult.ok === false && !buffer) {
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
      if (role === 'assistant') this._wireActions(contentEl);
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
      return `\x00ACTION_${idx}\x00`;
    };

    if (parseActions) {
      // [[ACTION:type:params]] — non-greedy, stops at first ]]
      processedText = processedText.replace(/\[\[ACTION:(\w+):([\s\S]*?)\]\]/g, extractToken);
      // Legacy <<ACTION:type:params>> — keep compatible
      processedText = processedText.replace(/<<ACTION:(\w+):([\s\S]*?)>>/g, extractToken);
    } else {
      processedText = processedText.replace(/\[\[ACTION:[\s\S]*?\]\]/g, '');
      processedText = processedText.replace(/<<ACTION:[\s\S]*?>>/g, '');
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

      actionCards.forEach(({ type, params }, idx) => {
        const icon = ACTION_ICONS[type] || ACTION_ICONS.navigate;
        const verb = VERBS[type] || type;
        const safeParams = params.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        // For navigate, show a human-readable URL label
        let paramDisplay = safeParams;
        if (type === 'navigate') {
          try {
            const u = new URL(params);
            paramDisplay = u.hostname + (u.pathname !== '/' ? u.pathname : '') + (u.search ? '…' : '');
            paramDisplay = paramDisplay.replace(/^www\./, '');
          } catch (_) {}
        }
        const card = `<div class="browser-action-card" data-action="${type}" data-params="${safeParams}">
          <span class="bac-icon">${icon}</span>
          <span class="bac-desc"><strong>${verb}</strong>${params ? `<span class="bac-param">${paramDisplay}</span>` : ''}</span>
          <div class="bac-btns">
            <button class="bac-run" type="button">Run</button>
            <button class="bac-skip" type="button">Skip</button>
          </div>
        </div>`;
        html = html.replace(`\x00ACTION_${idx}\x00`, card);
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

  _wireActions(contentEl) {
    const cards = Array.from(contentEl.querySelectorAll('.browser-action-card'));
    if (!cards.length) return;

    if (this._takeoverMode) {
      // Takeover already active — mark cards queued and execute immediately
      cards.forEach((card) => {
        const btns = card.querySelector('.bac-btns');
        if (btns) btns.innerHTML = '<span class="bac-status bac-pending">Queued…</span>';
      });
      this._executeTakeover(contentEl);
      return;
    }

    // Manual mode — individual Run / Skip buttons
    cards.forEach((card) => {
      const action = card.dataset.action;
      const params = card.dataset.params;
      card.querySelector('.bac-run')?.addEventListener('click', () => this._executeAction(action, params, card, false));
      card.querySelector('.bac-skip')?.addEventListener('click', () => {
        card.classList.add('bac-skipped');
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status">Skipped</span>';
      });
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
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-ok">Done ✓</span>';
        if (!fromTakeover) {
          const msgEl = card.closest('.message');
          const pending = msgEl
            ? msgEl.querySelectorAll('.browser-action-card:not(.bac-done):not(.bac-skipped):not(.bac-error)').length
            : 0;
          if (pending === 0) setTimeout(() => this._smartFollowUp(), 1800);
        }
      } catch (err) {
        card.classList.add('bac-error');
        card.querySelector('.bac-btns').innerHTML = `<span class="bac-status">${err.message || 'Navigation error'}</span>`;
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
        card.querySelector('.bac-btns').innerHTML = '<span class="bac-status bac-ok">Done ✓</span>';
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
        pageInfo = `Title: ${page.title}\nURL: ${page.url}\n\nPage content:\n${(page.text || '').slice(0, 3000)}`;
      }
    } catch { /* ignore */ }

    if (!pageInfo) {
      this._addContinuePill('Could not read page — tell me what to do next.');
      return;
    }

    this._addContinuePill('↻ Reading page…');

    // Append accessibility snapshot so AI uses real element labels, not guessed selectors
    const snapText = await this._getPageSnapshotText();
    const followUpText = `[Action completed. Current page state follows. Continue task if steps remain, or give a clean summary if done. Use [[ACTION:type:params]] format for any new actions.]\n\n${pageInfo}${snapText}`;
    await this.processMessage(followUpText, true, null);
    document.getElementById('navio-continue-pill')?.remove();

    // In takeover mode, auto-execute any new action cards in the latest response
    if (this._takeoverMode) {
      const lastMsg = this.messagesEl.querySelector('.message.assistant-message:last-of-type');
      const contentEl = lastMsg?.querySelector('.message-content');
      if (contentEl) {
        const newCards = contentEl.querySelectorAll('.browser-action-card:not(.bac-done):not(.bac-skipped):not(.bac-error)');
        if (newCards.length) await this._executeTakeover(contentEl);
      }
    }
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
}

const AssistantManager = new AssistantManagerClass();
