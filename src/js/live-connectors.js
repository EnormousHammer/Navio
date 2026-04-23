/**
 * Navio Browser — Live Connectors
 *
 * Real-time service monitoring with AI-powered reply drafting.
 * Continuously studies the user's writing style and can draft
 * replies for Gmail, Outlook, Slack, Discord, Teams, GitHub,
 * Google Calendar, and Notion — all without any OAuth setup.
 *
 * How it works (no OAuth needed):
 *  1. Keep a service tab open — Navio polls it on an interval.
 *  2. Gmail/Outlook/Slack title shows "(N)" when there are unread messages.
 *     When N increases, we surface an in-app notification.
 *  3. "Draft Reply" → AI reads the page context, combines it with
 *     learned style examples, and generates a reply in your voice.
 *  4. Review, edit, then "Send to Gmail" injects it into the compose field.
 *  5. "Learn this style" saves the edited draft as a style example.
 *     Over time the AI matches your exact tone and format.
 */

class LiveConnectorManagerClass {
  constructor() {
    this._agents = {};
    this._data = { liveConfig: {}, styleMemory: {} };
    this._notifId = 0;
    this._ready = false;

    // ── Service definitions ──────────────────────────────────────────────
    this.LIVE_CAPABLE = {
      gmail: {
        name: 'Gmail',
        pollMs: 30000,
        gradient: 'linear-gradient(135deg, #ea4335, #fbbc04)',
        icon: 'M',
        urlFragment: 'mail.google.com',
        titleUnreadRegex: /\((\d+)\)/,
        supportsDrafting: true,
        description: 'Monitor for new emails, learn your reply style, and draft AI-powered replies automatically.'
      },
      outlook: {
        name: 'Outlook',
        pollMs: 30000,
        gradient: 'linear-gradient(135deg, #0078d4, #00bcf2)',
        icon: 'O',
        urlFragment: 'outlook.live.com',
        titleUnreadRegex: /\((\d+)\)/,
        supportsDrafting: true,
        description: 'Monitor Outlook for new emails and get AI-drafted replies in your style.'
      },
      slack: {
        name: 'Slack',
        pollMs: 20000,
        gradient: 'linear-gradient(135deg, #4a154b, #e01e5a)',
        icon: 'S',
        urlFragment: 'app.slack.com',
        titleUnreadRegex: /^\((\d+)\)/,
        supportsDrafting: true,
        description: 'Surface unread Slack mentions and draft context-aware responses.'
      },
      discord: {
        name: 'Discord',
        pollMs: 20000,
        gradient: 'linear-gradient(135deg, #5865f2, #8b95f2)',
        icon: 'Ds',
        urlFragment: 'discord.com',
        titleUnreadRegex: /^\((\d+)\)/,
        supportsDrafting: true,
        description: 'Track unread Discord mentions and draft replies in your voice.'
      },
      teams: {
        name: 'Microsoft Teams',
        pollMs: 20000,
        gradient: 'linear-gradient(135deg, #6264a7, #8b8cc7)',
        icon: 'T',
        urlFragment: 'teams.microsoft.com',
        titleUnreadRegex: /\((\d+)\)/,
        supportsDrafting: true,
        description: 'Monitor Teams for messages and draft professional replies.'
      },
      github: {
        name: 'GitHub',
        pollMs: 60000,
        gradient: 'linear-gradient(135deg, #333, #555)',
        icon: 'GH',
        urlFragment: 'github.com',
        titleUnreadRegex: null,
        supportsDrafting: false,
        description: 'Monitor GitHub notifications for PRs, reviews, and issues.'
      },
      'google-calendar': {
        name: 'Google Calendar',
        pollMs: 120000,
        gradient: 'linear-gradient(135deg, #4285f4, #7baaf7)',
        icon: 'GC',
        urlFragment: 'calendar.google.com',
        titleUnreadRegex: null,
        supportsDrafting: false,
        description: 'Get proactive summaries of upcoming meetings and calendar events.'
      },
      notion: {
        name: 'Notion',
        pollMs: 120000,
        gradient: 'linear-gradient(135deg, #333, #555)',
        icon: 'N',
        urlFragment: 'notion.so',
        titleUnreadRegex: null,
        supportsDrafting: false,
        description: 'Monitor Notion for workspace activity and get AI writing suggestions.'
      }
    };

    this._ensureDOM();
    this._load();
  }

  // ── Init ────────────────────────────────────────────────────────────────

  async _load() {
    try {
      const result = await window.navio.liveConnectorData({ op: 'get' });
      if (result && result.data) {
        this._data = {
          liveConfig: result.data.liveConfig || {},
          styleMemory: result.data.styleMemory || {}
        };
      }
    } catch (e) {
      console.warn('[LiveConnectors] Load failed:', e.message);
    }
    this._ready = true;
    for (const [id, cfg] of Object.entries(this._data.liveConfig)) {
      if (cfg.enabled) this._startAgent(id);
    }
  }

  async _save() {
    try {
      await window.navio.liveConnectorData({ op: 'set', data: this._data });
    } catch (e) {
      console.warn('[LiveConnectors] Save failed:', e.message);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  isLiveCapable(serviceId) { return !!this.LIVE_CAPABLE[serviceId]; }
  isEnabled(serviceId) { return !!(this._data.liveConfig[serviceId]?.enabled); }
  getMode(serviceId) { return this._data.liveConfig[serviceId]?.mode || 'suggest'; }
  getExamplesCount(serviceId) {
    return (this._data.styleMemory[serviceId]?.examples || []).length;
  }

  async toggleLive(serviceId) {
    if (!this.LIVE_CAPABLE[serviceId]) return;
    const current = this._data.liveConfig[serviceId] || {};
    const nowEnabled = !current.enabled;
    const def = this.LIVE_CAPABLE[serviceId];
    this._data.liveConfig[serviceId] = {
      ...current,
      enabled: nowEnabled,
      mode: current.mode || 'suggest',
      enabledAt: nowEnabled ? Date.now() : current.enabledAt
    };
    nowEnabled ? this._startAgent(serviceId) : this._stopAgent(serviceId);
    await this._save();
    this._notifyConnectorsManager(serviceId);
    this._showToast(
      nowEnabled
        ? `${def.name} Live Connector activated — monitoring started.`
        : `${def.name} live monitoring paused.`,
      nowEnabled ? 'success' : 'info'
    );
  }

  async setMode(serviceId, mode) {
    if (!this._data.liveConfig[serviceId]) return;
    this._data.liveConfig[serviceId].mode = mode;
    await this._save();
  }

  openSettings(serviceId) {
    document.getElementById('live-settings-modal').classList.add('active');
    this._renderSettingsModal(serviceId);
  }

  // ── Agent management ────────────────────────────────────────────────────

  _startAgent(serviceId) {
    if (this._agents[serviceId]) return;
    const def = this.LIVE_CAPABLE[serviceId];
    if (!def) return;
    const intervalId = setInterval(() => this._pollAgent(serviceId), def.pollMs);
    this._agents[serviceId] = { intervalId, lastUnreadCount: -1, lastTitle: '' };
    setTimeout(() => this._pollAgent(serviceId), 3000);
  }

  _stopAgent(serviceId) {
    const agent = this._agents[serviceId];
    if (!agent) return;
    clearInterval(agent.intervalId);
    delete this._agents[serviceId];
  }

  async _pollAgent(serviceId) {
    if (!this._agents[serviceId]) return;
    const agent = this._agents[serviceId];
    const def = this.LIVE_CAPABLE[serviceId];
    const tab = this._findServiceTab(serviceId);
    if (!tab) return;

    const title = tab.title || '';

    if (def.titleUnreadRegex) {
      const match = title.match(def.titleUnreadRegex);
      const count = match ? parseInt(match[1], 10) : 0;
      if (agent.lastUnreadCount >= 0 && count > agent.lastUnreadCount) {
        const newCount = count - agent.lastUnreadCount;
        await this._onNewActivity(serviceId, tab, newCount, count);
      }
      agent.lastUnreadCount = count;
      agent.lastTitle = title;
    } else {
      if (serviceId === 'google-calendar') await this._pollCalendar(tab, agent);
      if (serviceId === 'github') await this._pollGitHub(tab, agent);
      if (serviceId === 'notion') await this._pollNotion(tab, agent);
    }
  }

  _findServiceTab(serviceId) {
    if (typeof TabManager === 'undefined') return null;
    const fragment = this.LIVE_CAPABLE[serviceId]?.urlFragment;
    if (!fragment) return null;
    return TabManager.tabs.find(t => t.url && t.url.includes(fragment)) || null;
  }

  // ── Activity handlers ───────────────────────────────────────────────────

  async _onNewActivity(serviceId, tab, newCount, total) {
    const def = this.LIVE_CAPABLE[serviceId];
    const mode = this.getMode(serviceId);

    if (serviceId === 'gmail' || serviceId === 'outlook') {
      const emailInfo = await this._extractEmailInfo(tab, serviceId);
      this._showEmailNotification(serviceId, { def, newCount, total, tabId: tab.id, emailInfo, mode });
    } else {
      this._showMentionNotification(serviceId, { def, newCount, total, tabId: tab.id, mode });
    }
  }

  async _extractEmailInfo(tab, serviceId) {
    try {
      const wv = TabManager.tabs.find(t => t.id === tab.id)?.webview;
      if (!wv) return null;
      const page = await window.navio.extractPageContent(wv.getWebContentsId());
      if (!page || page.error) return null;
      return this._parseEmailFromPageText(page.text || '', serviceId);
    } catch {
      return null;
    }
  }

  _parseEmailFromPageText(text, serviceId) {
    if (!text) return null;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let sender = '', subject = '', preview = '';

    if (serviceId === 'gmail') {
      for (let i = 0; i < Math.min(lines.length, 60); i++) {
        const line = lines[i];
        if (!sender && line.match(/^[A-Z][a-z]+ [A-Z][a-z]+$|^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)) {
          sender = line;
          if (lines[i + 1] && lines[i + 1].length < 120) subject = lines[i + 1];
          if (lines[i + 2] && lines[i + 2].length < 200) preview = lines[i + 2];
          break;
        }
      }
    }
    return sender || subject ? { sender, subject, preview } : null;
  }

  async _pollCalendar(tab, agent) {
    const now = Date.now();
    if (now - (agent.lastCalendarPoll || 0) < 14 * 60000) return;
    agent.lastCalendarPoll = now;
    try {
      const wv = TabManager.tabs.find(t => t.id === tab.id)?.webview;
      if (!wv) return;
      const page = await window.navio.extractPageContent(wv.getWebContentsId());
      if (!page || page.error) return;
      if (/today|in \d+ min/i.test(page.text || '')) {
        this._showToast('📅 Google Calendar: you may have upcoming events today.', 'info');
      }
    } catch {}
  }

  async _pollGitHub(tab, agent) {
    const now = Date.now();
    if (now - (agent.lastGhPoll || 0) < 59 * 60000) return;
    agent.lastGhPoll = now;
    try {
      const wv = TabManager.tabs.find(t => t.id === tab.id)?.webview;
      if (!wv) return;
      const page = await window.navio.extractPageContent(wv.getWebContentsId());
      if (!page || page.error) return;
      const notifMatch = (page.text || '').match(/(\d+) unread notification/i);
      if (notifMatch) {
        const def = this.LIVE_CAPABLE.github;
        this._showMentionNotification('github', {
          def, newCount: parseInt(notifMatch[1], 10), total: parseInt(notifMatch[1], 10),
          tabId: tab.id, mode: this.getMode('github')
        });
      }
    } catch {}
  }

  async _pollNotion(tab, agent) {
    const now = Date.now();
    if (now - (agent.lastNotionPoll || 0) < 119 * 60000) return;
    agent.lastNotionPoll = now;
  }

  // ── Notifications ───────────────────────────────────────────────────────

  _showEmailNotification(serviceId, { def, newCount, total, tabId, emailInfo, mode }) {
    const id = ++this._notifId;
    const sender = emailInfo?.sender || '';
    const subject = emailInfo?.subject || `${newCount} new email${newCount > 1 ? 's' : ''}`;
    const preview = emailInfo?.preview || '';
    const canDraft = def.supportsDrafting && mode !== 'monitor';

    const html = `
      <div class="live-notification" id="live-notif-${id}">
        <div class="live-notif-header">
          <div class="live-notif-svc-icon" style="background:${def.gradient}">${def.icon}</div>
          <div class="live-notif-meta">
            <div class="live-notif-svc">${this._esc(def.name)}</div>
            <div class="live-notif-badge-count">${newCount} new${total > 1 ? ` · ${total} total` : ''}</div>
          </div>
          <button class="live-notif-x" data-id="${id}">×</button>
        </div>
        ${sender ? `<div class="live-notif-from">${this._esc(sender)}</div>` : ''}
        <div class="live-notif-subject">${this._esc(subject)}</div>
        ${preview ? `<div class="live-notif-preview">${this._esc(preview.slice(0, 90))}…</div>` : ''}
        <div class="live-notif-actions">
          <button class="live-notif-btn live-notif-btn-open" data-tid="${tabId}">Open</button>
          ${canDraft ? `<button class="live-notif-btn live-notif-btn-draft" data-tid="${tabId}" data-svc="${serviceId}" data-id="${id}">✦ Draft Reply</button>` : ''}
          ${canDraft ? `<button class="live-notif-btn live-notif-btn-batch" data-tid="${tabId}" data-svc="${serviceId}" data-id="${id}">✦ Draft All</button>` : ''}
        </div>
        <div class="live-notif-progress"></div>
      </div>`;

    this._mountNotif(id, html, mode === 'auto-draft' ? 60000 : 18000, (el) => {
      el.querySelector('.live-notif-btn-open')?.addEventListener('click', () => {
        this._focusTab(tabId); this._dismiss(id);
      });
      el.querySelector('.live-notif-btn-draft')?.addEventListener('click', async () => {
        this._dismiss(id);
        await this._triggerDraft(serviceId, tabId, emailInfo);
      });
      el.querySelector('.live-notif-btn-batch')?.addEventListener('click', async () => {
        this._dismiss(id);
        await this._startBatchDraft(serviceId, tabId);
      });
    });
  }

  _showMentionNotification(serviceId, { def, newCount, total, tabId, mode }) {
    const id = ++this._notifId;
    const html = `
      <div class="live-notification" id="live-notif-${id}">
        <div class="live-notif-header">
          <div class="live-notif-svc-icon" style="background:${def.gradient}">${def.icon}</div>
          <div class="live-notif-meta">
            <div class="live-notif-svc">${this._esc(def.name)}</div>
            <div class="live-notif-badge-count">${newCount} unread mention${newCount > 1 ? 's' : ''}</div>
          </div>
          <button class="live-notif-x" data-id="${id}">×</button>
        </div>
        <div class="live-notif-actions">
          <button class="live-notif-btn live-notif-btn-open" data-tid="${tabId}">Jump to ${this._esc(def.name)}</button>
        </div>
        <div class="live-notif-progress"></div>
      </div>`;

    this._mountNotif(id, html, 15000, (el) => {
      el.querySelector('.live-notif-btn-open')?.addEventListener('click', () => {
        this._focusTab(tabId); this._dismiss(id);
      });
    });
  }

  _showToast(message, type = 'info') {
    const id = ++this._notifId;
    const icon = { success: '✓', info: 'ℹ', error: '✗', warning: '⚠' }[type] || '•';
    const html = `
      <div class="live-notification live-toast live-toast-${type}" id="live-notif-${id}">
        <span class="live-toast-icon">${icon}</span>
        <span class="live-toast-msg">${this._esc(message)}</span>
        <button class="live-notif-x" data-id="${id}">×</button>
      </div>`;
    this._mountNotif(id, html, 4000);
  }

  _mountNotif(id, html, autoMs, bindFn) {
    const stack = document.getElementById('live-notif-stack');
    if (!stack) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = html.trim();
    const el = tmp.firstChild;
    stack.prepend(el);

    const timer = setTimeout(() => this._dismiss(id), autoMs);
    el.querySelector(`.live-notif-x[data-id="${id}"]`)?.addEventListener('click', () => {
      clearTimeout(timer); this._dismiss(id);
    });

    const bar = el.querySelector('.live-notif-progress');
    if (bar) {
      bar.style.transition = `width ${autoMs}ms linear`;
      bar.style.width = '100%';
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = '0%'; }));
    }

    if (bindFn) bindFn(el);
    requestAnimationFrame(() => el.classList.add('live-notif-in'));
  }

  _dismiss(id) {
    const el = document.getElementById(`live-notif-${id}`);
    if (!el) return;
    el.classList.remove('live-notif-in');
    el.classList.add('live-notif-out');
    setTimeout(() => el.remove(), 300);
  }

  // ── Batch Draft — scan inbox and draft all emails one by one ────────────

  /**
   * Entry point. Reads the email list from the open tab (no tokens needed),
   * then opens the batch draft modal that lets the user approve/skip each one.
   */
  async _startBatchDraft(serviceId, tabId) {
    const def = this.LIVE_CAPABLE[serviceId] || {};
    const wv = TabManager.tabs.find(t => t.id === tabId)?.webview;
    if (!wv) {
      this._showToast(`Open a ${def.name || 'email'} tab first.`, 'error');
      return;
    }

    this._showBatchDraftModal({ phase: 'scanning', serviceId, def });

    let emails = [];
    try {
      const wcId = wv.getWebContentsId();
      const result = await window.navio.scanEmailInbox(wcId);
      if (result?.error) {
        this._showBatchDraftModal({ phase: 'error', serviceId, def, error: result.error });
        return;
      }
      emails = (result?.emails || []).filter(e => e.subject);
    } catch (e) {
      this._showBatchDraftModal({ phase: 'error', serviceId, def, error: e.message });
      return;
    }

    if (emails.length === 0) {
      this._showBatchDraftModal({ phase: 'empty', serviceId, def });
      return;
    }

    // Start drafting from the first email
    await this._draftEmailAtIndex(serviceId, tabId, def, emails, 0);
  }

  async _draftEmailAtIndex(serviceId, tabId, def, emails, idx) {
    if (idx >= emails.length) {
      this._showBatchDraftModal({ phase: 'done', serviceId, def, total: emails.length });
      return;
    }

    const email = emails[idx];
    this._showBatchDraftModal({ phase: 'generating', serviceId, def, email, idx, total: emails.length });

    let draft = '';
    try {
      const config = await window.navio.getConfig();
      if (config.aiKillSwitch) throw new Error('AI kill switch is on. Disable it in Settings → AI.');
      if (!config.hasApiKey) throw new Error('No AI API key configured. Add one in Settings → AI.');

      const messages = [
        { role: 'system', content: this._buildStylePrompt(serviceId) },
        { role: 'user', content: this._buildEmailPrompt(email) }
      ];
      const result = await window.navio.aiRequest({ messages });
      if (result.error) throw new Error(result.error);
      draft = result.content || '';
    } catch (e) {
      this._showBatchDraftModal({
        phase: 'draft', serviceId, def, email, idx, total: emails.length,
        draft: '', error: e.message, emails, tabId
      });
      return;
    }

    this._showBatchDraftModal({
      phase: 'draft', serviceId, def, email, idx, total: emails.length,
      draft, emails, tabId
    });
  }

  _showBatchDraftModal({ phase, serviceId, def, email, idx, total, draft, error, emails, tabId }) {
    const modal = document.getElementById('live-draft-modal');
    if (!modal) return;

    const close = () => modal.classList.remove('active');
    const progress = (total && total > 0)
      ? `<div class="lbdm-progress">
           ${Array.from({ length: total }, (_, i) =>
             `<span class="lbdm-dot ${i < idx ? 'done' : i === idx ? 'active' : ''}"></span>`
           ).join('')}
         </div>`
      : '';

    if (phase === 'scanning') {
      modal.innerHTML = `
        <div class="live-modal-panel lbdm-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title"><strong>Scanning inbox…</strong></div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          <div class="live-modal-loading">
            <div class="live-dots"><span></span><span></span><span></span></div>
            <p>Reading your ${def.name || 'email'} inbox — no login required.</p>
          </div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', close);
      return;
    }

    if (phase === 'generating') {
      modal.innerHTML = `
        <div class="live-modal-panel lbdm-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title">
              <strong>Drafting replies</strong>
              <span>${idx + 1} of ${total}</span>
            </div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          ${progress}
          <div class="lbdm-email-context">
            ${email.sender ? `<div class="lbdm-from"><span>From</span>${this._esc(email.senderName || email.sender)}</div>` : ''}
            <div class="lbdm-subject">${this._esc(email.subject || '(no subject)')}</div>
            ${email.snippet ? `<div class="lbdm-snippet">${this._esc(email.snippet.slice(0, 120))}…</div>` : ''}
          </div>
          <div class="live-modal-loading">
            <div class="live-dots"><span></span><span></span><span></span></div>
            <p>Writing your reply…</p>
          </div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', close);
      return;
    }

    if (phase === 'empty') {
      modal.innerHTML = `
        <div class="live-modal-panel lbdm-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title"><strong>No emails found</strong></div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          <div class="lbdm-empty">
            <p>No emails could be read from the open ${def.name || 'email'} tab.<br>Make sure the inbox is visible and try again.</p>
          </div>
          <div class="live-modal-footer"><button class="live-modal-btn-secondary" id="lm-close2">Close</button></div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', close);
      modal.querySelector('#lm-close2')?.addEventListener('click', close);
      return;
    }

    if (phase === 'error') {
      modal.innerHTML = `
        <div class="live-modal-panel lbdm-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title"><strong>Could not read inbox</strong></div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          <div class="live-modal-error">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <p>${this._esc(error || 'Unknown error')}</p>
          </div>
          <div class="live-modal-footer"><button class="live-modal-btn-secondary" id="lm-close2">Close</button></div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', close);
      modal.querySelector('#lm-close2')?.addEventListener('click', close);
      return;
    }

    if (phase === 'done') {
      modal.innerHTML = `
        <div class="live-modal-panel lbdm-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title"><strong>All done!</strong></div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          <div class="lbdm-done">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            <p>${total} draft${total !== 1 ? 's' : ''} saved.<br>Go to your ${def.name || 'email'} Drafts folder to review and send.</p>
          </div>
          <div class="live-modal-footer"><button class="live-modal-btn-primary" id="lm-close2">Done</button></div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', close);
      modal.querySelector('#lm-close2')?.addEventListener('click', close);
      return;
    }

    // phase === 'draft' — show the email + editable draft + action buttons
    const exCount = this.getExamplesCount(serviceId);
    const styleBadge = exCount > 0
      ? `<span class="live-style-pill">✦ ${exCount} example${exCount !== 1 ? 's' : ''}</span>`
      : `<span class="live-style-pill live-style-pill-new">✦ No style examples yet</span>`;

    modal.innerHTML = `
      <div class="live-modal-panel lbdm-panel">
        <div class="live-modal-header">
          <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
          <div class="live-modal-title">
            <strong>Draft ${idx + 1} of ${total}</strong>
            <div class="live-modal-pills">${styleBadge}</div>
          </div>
          <button class="live-modal-close-btn" id="lm-close">×</button>
        </div>

        ${progress}

        <div class="lbdm-email-context">
          ${email.sender ? `<div class="lbdm-from"><span>From</span>${this._esc(email.senderName || email.sender)}</div>` : ''}
          <div class="lbdm-subject">${this._esc(email.subject || '(no subject)')}</div>
          ${email.snippet ? `<div class="lbdm-snippet">${this._esc(email.snippet.slice(0, 140))}</div>` : ''}
        </div>

        ${error ? `<div class="live-modal-error" style="margin:8px 0 0;padding:8px 12px;font-size:12px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>${this._esc(error)}</span>
        </div>` : ''}

        <div class="live-modal-body-wrap">
          <textarea class="live-modal-textarea lbdm-textarea" id="lm-draft-text" spellcheck="true"
            placeholder="Edit the AI draft here before saving…">${this._esc(draft || '')}</textarea>
        </div>

        <div class="live-modal-footer lbdm-footer">
          <button class="live-modal-btn-primary lbdm-save-btn" id="lm-save-draft" ${!draft ? 'disabled' : ''}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save as Draft
          </button>
          <button class="live-modal-btn-secondary" id="lm-regen">↺ Regenerate</button>
          <button class="live-modal-btn-learn" id="lm-learn">✦ Learn style</button>
          <button class="live-modal-btn-discard" id="lm-skip">${idx + 1 < total ? 'Skip →' : 'Skip'}</button>
        </div>
      </div>`;

    modal.classList.add('active');
    modal.querySelector('#lm-close')?.addEventListener('click', close);

    modal.querySelector('#lm-skip')?.addEventListener('click', () => {
      this._draftEmailAtIndex(serviceId, tabId, def, emails, idx + 1);
    });

    modal.querySelector('#lm-regen')?.addEventListener('click', () => {
      this._draftEmailAtIndex(serviceId, tabId, def, emails, idx);
    });

    modal.querySelector('#lm-learn')?.addEventListener('click', async () => {
      const txt = modal.querySelector('#lm-draft-text')?.value || '';
      await this.captureExample(serviceId, email, txt);
      const n = this.getExamplesCount(serviceId);
      this._showToast(`Style example saved (${n} total).`, 'success');
    });

    modal.querySelector('#lm-save-draft')?.addEventListener('click', async () => {
      const txt = modal.querySelector('#lm-draft-text')?.value || '';
      const btn = modal.querySelector('#lm-save-draft');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

      const ok = await this._saveDraftToService(serviceId, tabId, email, txt);
      if (ok) {
        // Advance to next email automatically
        await this._draftEmailAtIndex(serviceId, tabId, def, emails, idx + 1);
      } else {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/></svg> Save as Draft'; }
      }
    });
  }

  /**
   * Injects a reply draft into Gmail/Outlook using the browser session.
   * Opens Compose → fills To / Subject / Body → minimizes (saves as draft).
   * Returns true on success.
   */
  async _saveDraftToService(serviceId, tabId, email, draftText) {
    const wv = TabManager.tabs.find(t => t.id === tabId)?.webview;
    if (!wv) { this._showToast('Service tab not found.', 'error'); return false; }

    const def = this.LIVE_CAPABLE[serviceId] || {};
    const wcId = wv.getWebContentsId();
    this._focusTab(tabId);

    try {
      if (serviceId === 'gmail') {
        // Click Compose button
        await window.navio.browserAction({
          webContentsId: wcId,
          action: 'click',
          params: { selector: 'div[gh="cm"], .T-I.T-I-KE, [aria-label*="Compose"]' },
          userConfirmed: true
        });
        await this._wait(1000);

        // Fill To field
        if (email.sender) {
          await window.navio.browserAction({
            webContentsId: wcId,
            action: 'type',
            params: { selector: 'input[aria-label="To"], textarea[name="to"], [name="to"]', text: email.sender },
            userConfirmed: true
          });
          await this._wait(400);
          // Press Tab to confirm recipient
          await window.navio.browserAction({ webContentsId: wcId, action: 'pressKey', params: { key: 'Tab', code: 'Tab' }, userConfirmed: true });
          await this._wait(300);
        }

        // Fill Subject field
        const subject = email.subject ? `Re: ${email.subject}` : '';
        if (subject) {
          await window.navio.browserAction({
            webContentsId: wcId,
            action: 'type',
            params: { selector: 'input[aria-label="Subject"], input[name="subjectbox"]', text: subject },
            userConfirmed: true
          });
          await this._wait(300);
        }

        // Fill Body
        await window.navio.browserAction({
          webContentsId: wcId,
          action: 'type',
          params: {
            selector: 'div[aria-label="Message Body"], div[g_editable="true"], div[contenteditable="true"][aria-label*="Message Body"]',
            text: draftText
          },
          userConfirmed: true
        });
        await this._wait(500);

        // Minimize compose window → Gmail auto-saves as draft
        await window.navio.browserAction({
          webContentsId: wcId,
          action: 'click',
          params: { selector: '[aria-label*="Minimize"], button[aria-label*="minimise"], .Hm' },
          userConfirmed: true
        });

        this._showToast(`Draft saved in Gmail — check your Drafts folder.`, 'success');
        return true;

      } else if (serviceId === 'outlook') {
        // Click New Mail / Compose in Outlook
        await window.navio.browserAction({
          webContentsId: wcId,
          action: 'click',
          params: { selector: 'button[aria-label*="New mail"], button[aria-label*="New email"], [data-testid="compose-button"]' },
          userConfirmed: true
        });
        await this._wait(1200);

        if (email.sender) {
          await window.navio.browserAction({
            webContentsId: wcId,
            action: 'type',
            params: { selector: 'input[aria-label="To"], [aria-label="To"]', text: email.sender },
            userConfirmed: true
          });
          await this._wait(400);
          await window.navio.browserAction({ webContentsId: wcId, action: 'pressKey', params: { key: 'Tab', code: 'Tab' }, userConfirmed: true });
          await this._wait(300);
        }

        const subject = email.subject ? `Re: ${email.subject}` : '';
        if (subject) {
          await window.navio.browserAction({
            webContentsId: wcId,
            action: 'type',
            params: { selector: 'input[aria-label="Add a subject"]', text: subject },
            userConfirmed: true
          });
          await this._wait(300);
        }

        await window.navio.browserAction({
          webContentsId: wcId,
          action: 'type',
          params: { selector: 'div[contenteditable="true"][aria-label*="Message body"]', text: draftText },
          userConfirmed: true
        });
        await this._wait(500);

        // Save draft via keyboard shortcut (Escape in Outlook or close button)
        await window.navio.browserAction({
          webContentsId: wcId,
          action: 'click',
          params: { selector: 'button[aria-label*="Discard"], button[title*="Discard"], [aria-label*="Save draft"]' },
          userConfirmed: true
        });

        this._showToast('Draft saved in Outlook — check your Drafts folder.', 'success');
        return true;
      } else {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(draftText).catch(() => {});
        this._showToast('Draft copied to clipboard — paste it as a reply.', 'info');
        return true;
      }
    } catch (e) {
      this._showToast(`Could not save draft: ${e.message}`, 'error');
      return false;
    }
  }

  _wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── AI Draft Reply ──────────────────────────────────────────────────────

  async _triggerDraft(serviceId, tabId, emailInfo) {
    this._showDraftModal({ loading: true, serviceId });

    let context = { ...(emailInfo || {}) };
    try {
      const wv = TabManager.tabs.find(t => t.id === tabId)?.webview;
      if (wv) {
        const page = await window.navio.extractPageContent(wv.getWebContentsId());
        if (page && !page.error) {
          context.pageText = (page.text || '').slice(0, 4000);
          context.pageTitle = page.title || '';
          if (!context.subject && page.title) context.subject = page.title;
        }
      }
    } catch {}

    try {
      const config = await window.navio.getConfig();

      if (config.aiKillSwitch) {
        this._showDraftModal({ error: 'AI is disabled (kill switch is on). Go to Settings → AI → Policy to re-enable it.', serviceId });
        return;
      }
      if (!config.hasApiKey) {
        this._showDraftModal({ error: 'No API key configured. Open Settings → AI and add your key to use AI drafting.', serviceId, noKey: true });
        return;
      }

      const providerLabel = this._providerLabel(config.aiProvider, config.aiModel);
      const messages = [
        { role: 'system', content: this._buildStylePrompt(serviceId) },
        { role: 'user', content: this._buildEmailPrompt(context) }
      ];

      const result = await window.navio.aiRequest({ messages });
      if (result.error) {
        this._showDraftModal({ error: `${providerLabel} returned an error: ${result.error}`, serviceId });
        return;
      }

      this._showDraftModal({ draft: result.content, context, serviceId, tabId, providerLabel });
    } catch (e) {
      this._showDraftModal({ error: e.message, serviceId });
    }
  }

  _providerLabel(provider, model) {
    const providerNames = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', custom: 'Custom' };
    const name = providerNames[provider] || provider || 'AI';
    return model ? `${name} / ${model}` : name;
  }

  _buildStylePrompt(serviceId) {
    const def = this.LIVE_CAPABLE[serviceId] || {};
    const examples = this._data.styleMemory[serviceId]?.examples || [];
    let p = `You are drafting a ${def.name || 'message'} reply on behalf of the user. Output ONLY the reply text — no explanation, no preamble, no "Here's a draft:" prefix. Use plain sentences and line breaks only — no Markdown (no **bold**, bullets with *, or \`code\`) and no HTML; the text may be pasted into an email client.`;

    if (examples.length > 0) {
      p += `\n\nThe user's writing style — study these examples carefully and match their exact tone, length, greeting, and sign-off:\n`;
      examples.slice(-6).forEach((ex, i) => {
        p += `\n[Example ${i + 1}]${ex.subject ? ` (re: ${ex.subject})` : ''}\n${ex.reply}\n`;
      });
      p += `\nMatch this style precisely.`;
    } else {
      p += `\nWrite naturally, professionally, and concisely. Be human, not robotic.`;
    }
    return p;
  }

  _buildEmailPrompt(context) {
    let p = 'Draft a reply to this email:\n\n';
    if (context.sender) p += `From: ${context.sender}\n`;
    if (context.subject) p += `Subject: ${context.subject}\n`;
    if (context.preview) p += `\nEmail preview:\n${context.preview}\n`;
    if (context.pageText) p += `\nFull email context (for reference):\n${context.pageText.slice(0, 3000)}\n`;
    return p;
  }

  // ── Draft Modal ─────────────────────────────────────────────────────────

  _showDraftModal({ loading, draft, error, context, serviceId, tabId, providerLabel, noKey }) {
    const modal = document.getElementById('live-draft-modal');
    if (!modal) return;
    const def = this.LIVE_CAPABLE[serviceId] || {};

    if (loading) {
      modal.innerHTML = `
        <div class="live-modal-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title"><strong>AI Draft Reply</strong><span>Analysing your style…</span></div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          <div class="live-modal-loading">
            <div class="live-dots"><span></span><span></span><span></span></div>
            <p>Studying your reply examples and drafting…</p>
          </div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', () => modal.classList.remove('active'));
      return;
    }

    if (error) {
      const isNoKey = !!noKey;
      modal.innerHTML = `
        <div class="live-modal-panel">
          <div class="live-modal-header">
            <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
            <div class="live-modal-title"><strong>AI Draft Reply</strong></div>
            <button class="live-modal-close-btn" id="lm-close">×</button>
          </div>
          <div class="live-modal-error">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <p>${this._esc(error)}</p>
            ${isNoKey ? `<p class="live-modal-error-hint">Open <strong>Settings → AI</strong> and add your OpenAI, Anthropic, or Google API key. Live Connectors will use whichever provider you configure there.</p>` : ''}
          </div>
          <div class="live-modal-footer">
            ${isNoKey ? `<button class="live-modal-btn-primary" id="lm-open-settings">Open AI Settings</button>` : ''}
            <button class="live-modal-btn-secondary" id="lm-close2">Close</button>
          </div>
        </div>`;
      modal.classList.add('active');
      modal.querySelector('#lm-close')?.addEventListener('click', () => modal.classList.remove('active'));
      modal.querySelector('#lm-close2')?.addEventListener('click', () => modal.classList.remove('active'));
      modal.querySelector('#lm-open-settings')?.addEventListener('click', () => {
        modal.classList.remove('active');
        // Open Navio settings panel if available
        document.getElementById('btn-settings')?.click() || document.getElementById('settings-overlay')?.classList.add('active');
      });
      return;
    }

    const exCount = this.getExamplesCount(serviceId);
    const styleBadge = exCount > 0
      ? `<span class="live-style-pill">✦ ${exCount} style example${exCount !== 1 ? 's' : ''} used</span>`
      : `<span class="live-style-pill live-style-pill-new">✦ No examples yet — reply will be generic</span>`;
    const modelBadge = providerLabel
      ? `<span class="live-model-pill" title="AI provider used for this draft">${this._esc(providerLabel)}</span>`
      : '';

    modal.innerHTML = `
      <div class="live-modal-panel">
        <div class="live-modal-header">
          <div class="live-modal-svc-icon" style="background:${def.gradient || '#333'}">${def.icon || '?'}</div>
          <div class="live-modal-title">
            <strong>AI Draft Reply</strong>
            <div class="live-modal-pills">${styleBadge}${modelBadge}</div>
          </div>
          <button class="live-modal-close-btn" id="lm-close">×</button>
        </div>
        ${context?.subject ? `
          <div class="live-modal-context">
            <span class="live-modal-re">RE: ${this._esc(context.subject)}</span>
            ${context.sender ? `<span class="live-modal-from">from ${this._esc(context.sender)}</span>` : ''}
          </div>` : ''}
        <div class="live-modal-body-wrap">
          <textarea class="live-modal-textarea" id="lm-draft-text" spellcheck="true">${this._esc(draft || '')}</textarea>
        </div>
        <div class="live-modal-footer">
          <button class="live-modal-btn-primary" id="lm-inject">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send to ${this._esc(def.name || 'service')}
          </button>
          <button class="live-modal-btn-secondary" id="lm-copy">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
          <button class="live-modal-btn-learn" id="lm-learn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Learn this style
          </button>
          <button class="live-modal-btn-discard" id="lm-discard">Discard</button>
        </div>
      </div>`;

    modal.classList.add('active');

    const close = () => modal.classList.remove('active');
    modal.querySelector('#lm-close')?.addEventListener('click', close);
    modal.querySelector('#lm-discard')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    modal.querySelector('#lm-copy')?.addEventListener('click', () => {
      const txt = modal.querySelector('#lm-draft-text')?.value || '';
      navigator.clipboard.writeText(txt).catch(() => {});
      this._showToast('Draft copied to clipboard.', 'success');
    });

    modal.querySelector('#lm-learn')?.addEventListener('click', async () => {
      const txt = modal.querySelector('#lm-draft-text')?.value || '';
      await this.captureExample(serviceId, context || {}, txt);
      const n = this.getExamplesCount(serviceId);
      this._showToast(`Style example saved! Navio now has ${n} example${n !== 1 ? 's' : ''}.`, 'success');
      const pill = modal.querySelector('.live-style-pill');
      if (pill) {
        pill.textContent = `✦ ${n} example${n !== 1 ? 's' : ''} used`;
        pill.classList.remove('live-style-pill-new');
      }
    });

    modal.querySelector('#lm-inject')?.addEventListener('click', async () => {
      const txt = modal.querySelector('#lm-draft-text')?.value || '';
      if (!tabId) { this._showToast('Tab not found. Open the service first.', 'error'); return; }
      await this._injectDraft(serviceId, tabId, txt);
    });
  }

  async _injectDraft(serviceId, tabId, draftText) {
    const wv = TabManager.tabs.find(t => t.id === tabId)?.webview;
    if (!wv) { this._showToast('Service tab not found.', 'error'); return; }

    const def = this.LIVE_CAPABLE[serviceId] || {};
    const wcId = wv.getWebContentsId();
    this._focusTab(tabId);

    const ok = window.confirm(
      `Navio will click "Reply" and fill in the compose field in ${def.name}.\n\nYou can still review before sending. Continue?`
    );
    if (!ok) return;

    if (serviceId === 'gmail') {
      await window.navio.browserAction({
        webContentsId: wcId,
        action: 'click',
        params: { selector: '[data-tooltip="Reply"], button[aria-label*="Reply"], .ams[data-tooltip="Reply"]' },
        userConfirmed: true
      });
      await new Promise(r => setTimeout(r, 1200));
      await window.navio.browserAction({
        webContentsId: wcId,
        action: 'type',
        params: {
          selector: 'div[g_editable="true"], div[contenteditable="true"][aria-label*="Message Body"], div[aria-label*="Message Body"]',
          text: draftText
        },
        userConfirmed: true
      });
      this._showToast('Draft injected into Gmail — review and send when ready.', 'success');
    } else if (serviceId === 'outlook') {
      await window.navio.browserAction({
        webContentsId: wcId,
        action: 'click',
        params: { selector: 'button[aria-label*="Reply"], [data-icon-name="Reply"]' },
        userConfirmed: true
      });
      await new Promise(r => setTimeout(r, 1200));
      await window.navio.browserAction({
        webContentsId: wcId,
        action: 'type',
        params: { selector: 'div[contenteditable="true"][aria-label*="Message body"]', text: draftText },
        userConfirmed: true
      });
      this._showToast('Draft injected into Outlook — review and send when ready.', 'success');
    } else {
      await navigator.clipboard.writeText(draftText).catch(() => {});
      this._showToast('Draft copied to clipboard — paste it in the reply field.', 'info');
    }

    document.getElementById('live-draft-modal')?.classList.remove('active');
  }

  // ── Style Learning ──────────────────────────────────────────────────────

  async captureExample(serviceId, context, reply) {
    if (!reply || reply.trim().length < 10) return;
    if (!this._data.styleMemory[serviceId]) this._data.styleMemory[serviceId] = { examples: [] };
    this._data.styleMemory[serviceId].examples.push({
      subject: context.subject || '',
      sender: context.sender || '',
      reply: reply.trim(),
      capturedAt: Date.now()
    });
    if (this._data.styleMemory[serviceId].examples.length > 20) {
      this._data.styleMemory[serviceId].examples = this._data.styleMemory[serviceId].examples.slice(-20);
    }
    await this._save();
  }

  // ── Settings Modal ──────────────────────────────────────────────────────

  async _renderSettingsModal(serviceId) {
    const modal = document.getElementById('live-settings-modal');
    if (!modal) return;
    const def = this.LIVE_CAPABLE[serviceId];
    if (!def) return;

    const cfg = this._data.liveConfig[serviceId] || {};
    const examples = this._data.styleMemory[serviceId]?.examples || [];
    const isEnabled = !!cfg.enabled;
    const currentMode = cfg.mode || 'suggest';

    // Fetch live AI configuration status
    let aiConfig = null;
    try { aiConfig = await window.navio.getConfig(); } catch {}

    const hasKey = !!aiConfig?.hasApiKey;
    const killSwitch = !!aiConfig?.aiKillSwitch;
    const providerNames = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', custom: 'Custom endpoint' };
    const providerName = providerNames[aiConfig?.aiProvider] || aiConfig?.aiProvider || 'AI';
    const modelName = aiConfig?.aiModel || '';
    const providerLabel = modelName ? `${providerName} · ${modelName}` : providerName;

    // Build AI status banner
    let aiStatusHtml = '';
    if (def.supportsDrafting) {
      if (killSwitch) {
        aiStatusHtml = `
          <div class="live-ai-status live-ai-status--warn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span>AI kill switch is <strong>on</strong> — drafting is disabled. Turn it off in <strong>Settings → AI → Policy</strong>.</span>
          </div>`;
      } else if (!hasKey) {
        aiStatusHtml = `
          <div class="live-ai-status live-ai-status--error">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div>
              <span>No API key configured — AI drafting won't work.</span>
              <button class="live-ai-status-link" id="ls-open-ai-settings">Open AI Settings →</button>
            </div>
          </div>`;
      } else {
        aiStatusHtml = `
          <div class="live-ai-status live-ai-status--ok">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Drafting via <strong>${this._esc(providerLabel)}</strong> — configured in Settings → AI.</span>
          </div>`;
      }
    }

    const modes = [
      { id: 'monitor', label: 'Monitor only', desc: 'Notifications for new activity — no AI drafting' },
      { id: 'suggest', label: 'Suggest', desc: 'Offer to draft a reply when new messages arrive' },
      { id: 'auto-draft', label: 'Auto-draft', desc: 'Automatically draft replies silently in the background' }
    ];

    modal.innerHTML = `
      <div class="live-settings-panel">
        <div class="live-settings-header">
          <div class="live-settings-svc-icon" style="background:${def.gradient}">${def.icon}</div>
          <div class="live-settings-title-block">
            <strong>${this._esc(def.name)} Live Connector</strong>
            <span>${this._esc(def.description)}</span>
          </div>
          <button class="live-modal-close-btn" id="ls-close">×</button>
        </div>

        <div class="live-settings-body">
          <div class="live-settings-section">
            <div class="live-settings-row">
              <div>
                <div class="live-settings-label">Enable live monitoring</div>
                <div class="live-settings-hint">Poll ${this._esc(def.name)} every ${Math.round(def.pollMs / 1000)}s for new activity</div>
              </div>
              <label class="live-toggle-wrap">
                <input type="checkbox" id="ls-toggle" ${isEnabled ? 'checked' : ''}>
                <span class="live-toggle-track"><span class="live-toggle-thumb"></span></span>
              </label>
            </div>
          </div>

          ${def.supportsDrafting && aiStatusHtml ? `
            <div class="live-settings-section live-settings-section--compact">
              ${aiStatusHtml}
            </div>
          ` : ''}

          ${def.supportsDrafting ? `
            <div class="live-settings-section">
              <div class="live-settings-section-title">Response mode</div>
              ${modes.map(m => `
                <label class="live-mode-option ${currentMode === m.id ? 'live-mode-active' : ''}">
                  <input type="radio" name="ls-mode" value="${m.id}" ${currentMode === m.id ? 'checked' : ''}>
                  <div class="live-mode-body">
                    <span class="live-mode-label">${this._esc(m.label)}</span>
                    <span class="live-mode-desc">${this._esc(m.desc)}</span>
                  </div>
                </label>
              `).join('')}
            </div>

            <div class="live-settings-section">
              <div class="live-settings-section-title">
                Style memory
                <span class="live-example-count">${examples.length} example${examples.length !== 1 ? 's' : ''}</span>
              </div>
              <p class="live-settings-hint">Navio studies these to match your writing style when drafting replies. The more examples, the better the match.</p>
              ${examples.length > 0 ? `
                <div class="live-examples-list">
                  ${examples.slice(-4).reverse().map(ex => `
                    <div class="live-example-item">
                      <div class="live-example-meta">${ex.subject ? `RE: ${this._esc(ex.subject.slice(0, 50))}` : 'General reply'} · ${this._timeAgo(ex.capturedAt)}</div>
                      <div class="live-example-preview">${this._esc(ex.reply.slice(0, 110))}${ex.reply.length > 110 ? '…' : ''}</div>
                    </div>
                  `).join('')}
                  ${examples.length > 4 ? `<div class="live-example-more-info">+${examples.length - 4} more examples stored</div>` : ''}
                </div>
                <button class="live-danger-sm" id="ls-clear-examples">Clear all style examples</button>
              ` : `
                <div class="live-examples-empty">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                  <p>No examples yet. Use <strong>"Learn this style"</strong> on a draft to teach Navio how you write.</p>
                </div>
              `}
            </div>
          ` : ''}

          ${def.supportsDrafting ? `
            <div class="live-settings-section live-settings-section--action">
              <div class="live-settings-section-title">Quick actions</div>
              <p class="live-settings-hint">Have ${this._esc(def.name)} open in a tab? Navio reads your inbox from the page directly — no login or tokens required.</p>
              <button class="live-batch-draft-trigger" id="ls-batch-draft">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                Draft Today's Emails
              </button>
            </div>
          ` : ''}

          <div class="live-settings-section">
            <div class="live-settings-section-title">How it works</div>
            <ul class="live-howto-list">
              <li>Keep a ${this._esc(def.name)} tab open — Navio polls it every ${Math.round(def.pollMs / 1000)}s</li>
              ${def.supportsDrafting ? `
                <li>When new emails arrive, a notification appears with <strong>Draft Reply</strong> and <strong>Draft All</strong> buttons</li>
                <li>Click <strong>Draft All</strong> to review AI-written replies for each email one by one</li>
                <li><strong>Save as Draft</strong> opens Compose, fills in the reply, and saves it to your Drafts folder</li>
                <li>Use <strong>Learn style</strong> to improve future drafts over time</li>
              ` : `
                <li>When new activity is detected, an in-app notification appears</li>
                <li>Click to jump to the correct tab instantly</li>
              `}
            </ul>
          </div>
        </div>

        <div class="live-settings-footer">
          <button class="live-modal-btn-secondary" id="ls-cancel">Cancel</button>
          <button class="live-modal-btn-primary" id="ls-save">Save settings</button>
        </div>
      </div>`;

    modal.classList.add('active');

    const close = () => modal.classList.remove('active');
    modal.querySelector('#ls-close')?.addEventListener('click', close);
    modal.querySelector('#ls-cancel')?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    modal.querySelector('#ls-open-ai-settings')?.addEventListener('click', () => {
      close();
      // Try to open Settings panel — works with the existing Navio settings overlay
      const settingsBtn = document.getElementById('btn-settings') || document.querySelector('[data-action="settings"]');
      if (settingsBtn) settingsBtn.click();
    });

    modal.querySelector('#ls-clear-examples')?.addEventListener('click', async () => {
      if (!confirm(`Delete all ${examples.length} style examples for ${def.name}?`)) return;
      if (this._data.styleMemory[serviceId]) this._data.styleMemory[serviceId].examples = [];
      await this._save();
      this._renderSettingsModal(serviceId);
    });

    modal.querySelector('#ls-batch-draft')?.addEventListener('click', async () => {
      // Find an open tab for this service
      const agent = this._agents[serviceId];
      const tab = agent?.tabId
        ? TabManager.tabs.find(t => t.id === agent.tabId)
        : TabManager.tabs.find(t => {
            const url = t.webview?.src || t.url || '';
            return url.includes(def.urlFragment || '');
          });

      if (!tab) {
        this._showToast(`Open a ${def.name} tab first, then try again.`, 'error');
        return;
      }

      close();
      await this._startBatchDraft(serviceId, tab.id);
    });

    modal.querySelector('#ls-save')?.addEventListener('click', async () => {
      const nowEnabled = modal.querySelector('#ls-toggle')?.checked || false;
      const modeEl = modal.querySelector('input[name="ls-mode"]:checked');
      const nowMode = modeEl?.value || 'suggest';
      const wasEnabled = this.isEnabled(serviceId);
      this._data.liveConfig[serviceId] = {
        ...this._data.liveConfig[serviceId],
        enabled: nowEnabled,
        mode: nowMode,
        enabledAt: nowEnabled && !wasEnabled ? Date.now() : (this._data.liveConfig[serviceId]?.enabledAt || null)
      };
      if (nowEnabled && !wasEnabled) { this._startAgent(serviceId); this._showToast(`${def.name} Live Connector activated!`, 'success'); }
      else if (!nowEnabled && wasEnabled) { this._stopAgent(serviceId); this._showToast(`${def.name} live monitoring paused.`, 'info'); }
      await this._save();
      this._notifyConnectorsManager(serviceId);
      close();
    });
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────

  _ensureDOM() {
    if (!document.getElementById('live-notif-stack')) {
      const el = document.createElement('div');
      el.id = 'live-notif-stack';
      el.className = 'live-notif-stack';
      document.body.appendChild(el);
    }
    if (!document.getElementById('live-draft-modal')) {
      const el = document.createElement('div');
      el.id = 'live-draft-modal';
      el.className = 'live-draft-modal';
      document.body.appendChild(el);
    }
    if (!document.getElementById('live-settings-modal')) {
      const el = document.createElement('div');
      el.id = 'live-settings-modal';
      el.className = 'live-settings-modal';
      document.body.appendChild(el);
    }
  }

  _focusTab(tabId) {
    if (typeof TabManager !== 'undefined') TabManager.switchToTab(tabId);
  }

  _notifyConnectorsManager(serviceId) {
    if (typeof ConnectorsManager !== 'undefined' && typeof ConnectorsManager.refreshLiveBadge === 'function') {
      ConnectorsManager.refreshLiveBadge(serviceId);
    }
  }

  _esc(t) {
    return String(t || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _timeAgo(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
    return `${Math.round(d / 86400000)}d ago`;
  }
}

const LiveConnectorManager = new LiveConnectorManagerClass();
