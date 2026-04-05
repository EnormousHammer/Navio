/**
 * Navio Browser - AI Assistant
 * Chat interface, page analysis, browser automation, and AI API integration
 */

class AssistantManagerClass {
  constructor() {
    this.panel = document.getElementById('assistant-panel');
    this.messagesEl = document.getElementById('assistant-messages');
    this.inputEl = document.getElementById('assistant-input');
    this.isOpen = false;
    this.isProcessing = false;
    this.conversationHistory = [];

    this.systemPrompt = `You are Navio, an intelligent AI assistant built into the Navio Browser. You help users browse the web efficiently, understand content, and automate tasks.

CAPABILITIES:
- You can read and analyze the current web page content when provided
- You can help users understand complex content, summarize pages, extract data
- You can answer questions about anything
- You provide clear, concise, and helpful responses
- When given page content, reference specific information from it

BROWSER ACTIONS (when you need the user to navigate):
- To suggest navigation, say: "I'd suggest going to [URL]"
- To suggest a search, say: "Try searching for [query]"
- For page interaction guidance, describe what elements to click or interact with

FORMATTING:
- Use markdown-like formatting: **bold**, *italic*, \`code\`
- Use bullet points for lists
- Keep responses focused and actionable
- Break long responses into clear sections

PERSONALITY:
- Professional but friendly
- Proactive in offering help
- Concise - don't over-explain unless asked
- Acknowledge when you don't know something`;

    this.bindEvents();
  }

  bindEvents() {
    // Toggle buttons
    document.getElementById('btn-toggle-assistant').addEventListener('click', () => this.toggle());
    document.getElementById('btn-close-assistant').addEventListener('click', () => this.close());
    document.getElementById('btn-clear-chat').addEventListener('click', () => this.clearChat());

    // Send message
    document.getElementById('btn-send-message').addEventListener('click', () => this.sendMessage());

    // Input handling
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });

    // Quick actions
    document.querySelectorAll('.quick-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        this.handleQuickAction(action);
      });
    });
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.panel.classList.add('open');
    setTimeout(() => this.inputEl.focus(), 300);
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

    await this.processMessage(text);
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
    await this.processMessage(prompt, true);
  }

  async processMessage(text, isQuickAction = false) {
    const config = await window.navio.getConfig();

    if (!config.apiKey) {
      this.addMessage('assistant', 'Please set your API key in **Settings** first. Click the ⚙️ Settings button in the sidebar.');
      return;
    }

    this.isProcessing = true;
    this.showTypingIndicator();

    // Build messages array for the AI
    const messages = [{ role: 'system', content: this.systemPrompt }];

    // Add page context if available and not already in the quick action prompt
    if (!isQuickAction) {
      const pageContent = await TabManager.getActivePageContent();
      if (pageContent && !pageContent.error && pageContent.url) {
        const contextMsg = `[Current page context]\nTitle: ${pageContent.title}\nURL: ${pageContent.url}\nDescription: ${pageContent.description || 'N/A'}\n\nPage headings: ${pageContent.headings?.map(h => `${h.level}: ${h.text}`).join(', ') || 'None'}\n\nPage content (first 6000 chars):\n${pageContent.text?.substring(0, 6000) || 'Unable to extract'}`;
        messages.push({ role: 'system', content: contextMsg });
      }
    }

    // Add conversation history (last 20 messages for context window)
    const recentHistory = this.conversationHistory.slice(-20);
    messages.push(...recentHistory);

    // Add current message
    messages.push({ role: 'user', content: text });

    try {
      const result = await window.navio.aiRequest({
        provider: config.aiProvider,
        apiKey: config.apiKey,
        model: config.aiModel,
        messages,
        endpoint: config.customEndpoint || undefined
      });

      this.removeTypingIndicator();

      if (result.error) {
        this.addMessage('assistant', `**Error:** ${result.error}\n\nPlease check your API key and settings.`);
      } else {
        this.addMessage('assistant', result.content);

        // Update conversation history
        this.conversationHistory.push(
          { role: 'user', content: text },
          { role: 'assistant', content: result.content }
        );

        // Trim history if too long
        if (this.conversationHistory.length > 40) {
          this.conversationHistory = this.conversationHistory.slice(-30);
        }
      }
    } catch (err) {
      this.removeTypingIndicator();
      this.addMessage('assistant', `**Connection error:** ${err.message}\n\nPlease check your internet connection and try again.`);
    }

    this.isProcessing = false;
  }

  addMessage(role, content) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}-message`;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.innerHTML = this.formatMessage(content);

    msgEl.appendChild(contentEl);
    this.messagesEl.appendChild(msgEl);

    // Scroll to bottom
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  formatMessage(text) {
    if (!text) return '';

    let html = text
      // Escape HTML
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Bullet lists
    html = html.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs
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
    this.messagesEl.innerHTML = `
      <div class="message assistant-message">
        <div class="message-content">
          <p>Chat cleared. How can I help you?</p>
        </div>
      </div>
    `;
  }
}

const AssistantManager = new AssistantManagerClass();
