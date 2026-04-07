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

    this.systemPrompt = `You are Navio, an intelligent AI assistant built into the Navio Browser. You help users browse the web efficiently, understand content, and automate tasks.

CAPABILITIES:
- You receive policy-scoped page context when enabled (see user settings and per-chat scope).
- You help users understand complex content, summarize pages, extract data.
- You answer questions; when given page content, reference it specifically.

BROWSER ACTIONS:
- Risky actions (navigate, click, type in the page) require explicit user confirmation in the app — describe steps rather than assuming automation ran.
- To suggest navigation: "I'd suggest going to [URL]"

FORMATTING:
- Use markdown-like formatting: **bold**, *italic*, \`code\`
- Keep responses focused and actionable

PERSONALITY:
- Professional, friendly, concise`;

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
          this.conversationHistory.push(
            { role: 'user', content: userHistory },
            { role: 'assistant', content: result.content }
          );
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
      // Clean the raw error text of any markdown bold we added at call sites
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
      contentEl.innerHTML = this.formatMessage(content);
    }

    msgEl.appendChild(contentEl);
    this.messagesEl.appendChild(msgEl);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  formatMessage(text) {
    if (!text) return '';

    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/<p>\s*(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)\s*<\/p>/g, '$1');

    return html;
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
