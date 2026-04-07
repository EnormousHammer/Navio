/**
 * Navio Browser — New Tab Page controller
 *
 * Populates the dashboard new tab page with:
 *  • Greeting + live clock + weather (Open-Meteo, no API key)
 *  • Connected services status bar (IMAP email counts, etc.)
 *  • Top news feed (HackerNews API, no API key)
 *  • Inbox widget — unread emails from connected Gmail/Outlook via IMAP
 *  • "Draft All" button — triggers Live Connector batch draft flow
 */

const NTP = (() => {
  let _mode = 'search'; // 'search' | 'ai' | 'task'
  let _ntpVisible = false;

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    _startClock();
    _bindModeTabs();
    _bindSearchInput();
    _bindShortcuts();

    // Only run heavy tasks when new tab page is visible
    const observer = new MutationObserver(() => {
      const isActive = document.getElementById('new-tab-page')?.classList.contains('active');
      if (isActive && !_ntpVisible) {
        _ntpVisible = true;
        _onShow();
      } else if (!isActive) {
        _ntpVisible = false;
      }
    });
    const ntp = document.getElementById('new-tab-page');
    if (ntp) observer.observe(ntp, { attributes: true, attributeFilter: ['class'] });

    // If already visible on load
    if (ntp?.classList.contains('active')) { _ntpVisible = true; _onShow(); }
  }

  function _onShow() {
    _updateGreeting();
    _loadWeather();
    _loadNews();
    _loadServicesBar();
    _loadInbox();
  }

  // ── Clock + Greeting ──────────────────────────────────────────────────────

  function _startClock() {
    const tick = () => {
      const now = new Date();
      const dateEl = document.getElementById('ntp-date');
      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString(undefined, {
          weekday: 'short', month: 'short', day: 'numeric'
        });
      }
    };
    tick();
    setInterval(tick, 60000);
  }

  function _updateGreeting() {
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const el = document.getElementById('ntp-greeting');
    if (el) el.textContent = greet;
  }

  // ── Weather (Open-Meteo — free, no API key) ───────────────────────────────

  async function _loadWeather() {
    const block = document.getElementById('ntp-weather-block');
    if (!block) return;
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 6000 })
      );
      const { latitude, longitude } = pos.coords;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&temperature_unit=celsius`;
      const data = await fetch(url).then(r => r.json());
      const cw = data.current_weather;
      if (!cw) return;

      const wmoDesc = (code) => {
        if (code === 0) return '☀ Clear';
        if (code <= 3) return '⛅ Partly cloudy';
        if (code <= 48) return '🌫 Foggy';
        if (code <= 67) return '🌧 Rain';
        if (code <= 77) return '❄ Snow';
        if (code <= 99) return '⛈ Thunderstorm';
        return '🌤';
      };

      document.getElementById('ntp-weather-temp').textContent = `${Math.round(cw.temperature)}°C`;
      document.getElementById('ntp-weather-desc').textContent = wmoDesc(cw.weathercode);
      block.style.display = 'flex';
    } catch { /* geolocation denied or offline — just hide */ }
  }

  // ── Mode tabs (Search / Ask AI / Task) ───────────────────────────────────

  function _bindModeTabs() {
    document.querySelectorAll('.ntp-mode-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _mode = btn.dataset.mode;
        document.querySelectorAll('.ntp-mode-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const input = document.getElementById('ntp-search-input');
        if (input) {
          const placeholders = {
            search: 'Search the web…',
            ai: 'Ask Navio AI anything…',
            task: 'Give Navio a task…'
          };
          input.placeholder = placeholders[_mode] || 'Search…';
          input.focus();
        }
      });
    });
  }

  // ── Search input ──────────────────────────────────────────────────────────

  function _bindSearchInput() {
    const input = document.getElementById('ntp-search-input');
    const sendBtn = document.getElementById('ntp-search-send');
    if (!input) return;

    const submit = () => {
      const val = input.value.trim();
      if (!val) return;
      if (_mode === 'ai' || _mode === 'task') {
        // Open AI assistant with the query
        const assistantBtn = document.getElementById('btn-assistant') || document.getElementById('toggle-assistant');
        if (assistantBtn) assistantBtn.click();
        setTimeout(() => {
          const aiInput = document.getElementById('assistant-input') || document.querySelector('.assistant-input textarea');
          if (aiInput) {
            aiInput.value = val;
            aiInput.dispatchEvent(new Event('input', { bubbles: true }));
            aiInput.focus();
          }
        }, 150);
      } else {
        // Web search
        if (typeof App !== 'undefined') App.handleSearch(val);
      }
      input.value = '';
    };

    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    sendBtn?.addEventListener('click', submit);
  }

  // ── Quick links shortcuts ─────────────────────────────────────────────────

  function _bindShortcuts() {
    document.querySelectorAll('#ntp-shortcuts .ntp-shortcut').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        if (url && typeof TabManager !== 'undefined') {
          const activeTab = TabManager.getActiveTab();
          if (activeTab && !activeTab.url) {
            // Navigate in current tab (it's a blank new tab)
            if (typeof App !== 'undefined') App.handleSearch(url);
          } else {
            TabManager.createTab(url);
          }
        }
      });
    });
  }

  // ── Connected Services Status Bar ─────────────────────────────────────────

  async function _loadServicesBar() {
    const bar = document.getElementById('ntp-services-bar');
    if (!bar) return;
    bar.innerHTML = '';

    try {
      const imapSt = await window.navio.imapStatus();
      const pills = [];

      // IMAP email pills
      for (const [svcId, info] of Object.entries(imapSt || {})) {
        if (!info.connected) continue;
        const label = svcId === 'gmail' ? 'Gmail' : 'Outlook';
        const grad = svcId === 'gmail'
          ? 'linear-gradient(135deg,#ea4335,#fbbc04)'
          : 'linear-gradient(135deg,#0078d4,#00bcf2)';
        pills.push({ id: svcId, label, email: info.email, gradient: grad, count: null });
      }

      if (pills.length === 0) {
        bar.style.display = 'none';
        return;
      }

      bar.style.display = 'flex';
      for (const pill of pills) {
        const el = document.createElement('div');
        el.className = 'ntp-service-pill';
        el.dataset.id = pill.id;
        el.innerHTML = `
          <span class="ntp-svc-dot" style="background:${pill.gradient}"></span>
          <span class="ntp-svc-label">${pill.label}</span>
          <span class="ntp-svc-email">${pill.email}</span>
          <span class="ntp-svc-count" id="ntp-svc-count-${pill.id}" style="display:none"></span>
        `;
        bar.appendChild(el);
      }

      // Load unread counts in background
      for (const svcId of Object.keys(imapSt || {})) {
        window.navio.imapGetUnread(svcId, 1).then(r => {
          const countEl = document.getElementById(`ntp-svc-count-${svcId}`);
          if (countEl && r?.unreadCount > 0) {
            countEl.textContent = r.unreadCount;
            countEl.style.display = 'inline-flex';
          }
        }).catch(() => {});
      }
    } catch {}
  }

  // ── News feed (HackerNews — free, no API key) ────────────────────────────

  async function _loadNews() {
    const list = document.getElementById('ntp-news-list');
    if (!list) return;

    try {
      const ids = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')
        .then(r => r.json());
      const top = ids.slice(0, 8);
      const stories = await Promise.all(
        top.map(id =>
          fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
            .then(r => r.json())
            .catch(() => null)
        )
      );

      const valid = stories.filter(s => s && s.title);
      if (valid.length === 0) {
        list.innerHTML = '<p class="ntp-widget-empty">Could not load news. Check your connection.</p>';
        return;
      }

      list.innerHTML = valid.map(s => `
        <div class="ntp-news-item" data-url="${s.url || `https://news.ycombinator.com/item?id=${s.id}`}">
          <div class="ntp-news-title">${_esc(s.title)}</div>
          <div class="ntp-news-meta">
            <span>${s.score || 0} pts</span>
            <span>${s.descendants || 0} comments</span>
            <span>${_domain(s.url)}</span>
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.ntp-news-item').forEach(item => {
        item.addEventListener('click', () => {
          const url = item.dataset.url;
          if (url && typeof TabManager !== 'undefined') TabManager.createTab(url);
        });
      });
    } catch {
      list.innerHTML = '<p class="ntp-widget-empty">Could not load news.</p>';
    }
  }

  // ── Inbox widget ──────────────────────────────────────────────────────────

  async function _loadInbox() {
    const emailList = document.getElementById('ntp-email-list');
    const unreadBadge = document.getElementById('ntp-unread-badge');
    const draftAllBtn = document.getElementById('ntp-draft-all-btn');
    if (!emailList) return;

    try {
      const imapSt = await window.navio.imapStatus();
      const connectedServices = Object.keys(imapSt || {});

      if (connectedServices.length === 0) {
        // Show connect button
        emailList.innerHTML = `
          <div class="ntp-email-empty">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            <p>Connect Gmail or Outlook in the Connectors Hub to see your inbox here.</p>
            <button class="ntp-connect-email-btn" id="ntp-connect-email">Connect email</button>
          </div>`;
        document.getElementById('ntp-connect-email')?.addEventListener('click', () => {
          document.getElementById('btn-connectors')?.click();
        });
        return;
      }

      emailList.innerHTML = '<div class="ntp-widget-loading"><span></span><span></span><span></span></div>';

      const svcId = connectedServices[0]; // use first connected service
      const result = await window.navio.imapGetUnread(svcId, 10);

      if (result?.error) {
        emailList.innerHTML = `<p class="ntp-widget-empty">Could not load inbox: ${_esc(result.error)}</p>`;
        return;
      }

      const messages = result?.messages || [];
      const unreadCount = result?.unreadCount || 0;

      // Update badge
      if (unreadBadge && unreadCount > 0) {
        unreadBadge.textContent = unreadCount;
        unreadBadge.style.display = 'inline-flex';
      }

      // Show "Draft All" button
      if (draftAllBtn && messages.length > 0) {
        draftAllBtn.style.display = 'inline-flex';
        draftAllBtn.addEventListener('click', () => {
          // Trigger Live Connector batch draft
          if (typeof LiveConnectorManager !== 'undefined') {
            const tab = TabManager?.tabs?.find(t => {
              const url = t.webview?.src || t.url || '';
              return url.includes(svcId === 'gmail' ? 'mail.google.com' : 'outlook.live.com');
            });
            if (tab) {
              LiveConnectorManager._startBatchDraft(svcId, tab.id);
            } else {
              // No open email tab — use IMAP-based batch draft
              _imapBatchDraft(svcId, messages);
            }
          }
        });
      }

      if (messages.length === 0) {
        emailList.innerHTML = '<p class="ntp-widget-empty">All caught up — no unread emails.</p>';
        return;
      }

      emailList.innerHTML = messages.map(m => `
        <div class="ntp-email-item" data-uid="${m.uid}" data-svc="${svcId}">
          <div class="ntp-email-from">${_esc(m.fromName || m.from)}</div>
          <div class="ntp-email-subject">${_esc(m.subject)}</div>
          <div class="ntp-email-meta">${_timeAgo(m.date)}</div>
          <button class="ntp-email-draft-btn" data-uid="${m.uid}" data-svc="${svcId}" title="Draft a reply">
            ✦ Draft reply
          </button>
        </div>
      `).join('');

      // "Draft reply" per email
      emailList.querySelectorAll('.ntp-email-draft-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const { uid, svc } = btn.dataset;
          const emailItem = btn.closest('.ntp-email-item');
          const subject = emailItem.querySelector('.ntp-email-subject')?.textContent || '';
          const from = emailItem.querySelector('.ntp-email-from')?.textContent || '';
          await _draftSingleEmail(svc, parseInt(uid), from, subject, btn);
        });
      });

    } catch (e) {
      emailList.innerHTML = `<p class="ntp-widget-empty">Error: ${_esc(e.message)}</p>`;
    }
  }

  // ── AI draft for a single email (via IMAP, no tab needed) ────────────────

  async function _draftSingleEmail(svcId, uid, fromName, subject, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const config = await window.navio.getConfig();
      if (!config.hasApiKey) {
        alert('No AI API key configured. Open Settings → AI to add one.');
        return;
      }

      // Fetch email body via IMAP
      const bodyResult = await window.navio.imapGetEmailBody(svcId, uid);
      const body = bodyResult?.body || '';

      const messages = [
        { role: 'system', content: `You are drafting an email reply on behalf of the user. Write ONLY the reply text — no preamble, no "Here is a draft" prefix. Be professional and concise.` },
        { role: 'user', content: `Draft a reply to this email:\n\nFrom: ${fromName}\nSubject: ${subject}\n\nBody:\n${body.slice(0, 3000)}` }
      ];

      const result = await window.navio.aiRequest({ messages });
      if (result.error) throw new Error(result.error);

      // Show draft in Live Connector modal style
      if (typeof LiveConnectorManager !== 'undefined') {
        LiveConnectorManager._showDraftModal({
          draft: result.content,
          context: { subject, sender: fromName },
          serviceId: svcId,
          tabId: null,
          providerLabel: config.aiModel || config.aiProvider || 'AI'
        });
      }

      // Override the "Send to Gmail" button to use IMAP create-draft instead
      setTimeout(() => {
        const injectBtn = document.getElementById('lm-inject');
        if (injectBtn) {
          injectBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
            Save as Draft
          `;
          injectBtn.replaceWith(injectBtn.cloneNode(true)); // remove old handler
          document.getElementById('lm-inject')?.addEventListener('click', async () => {
            const draftText = document.getElementById('lm-draft-text')?.value || '';
            const draft = await window.navio.imapCreateDraft(svcId, {
              to: fromName,
              subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
              body: draftText
            });
            if (draft?.ok) {
              document.getElementById('live-draft-modal')?.classList.remove('active');
              if (typeof LiveConnectorManager !== 'undefined') {
                LiveConnectorManager._showToast('Draft saved to your Drafts folder.', 'success');
              }
            } else {
              alert(`Could not save draft: ${draft?.error}`);
            }
          });
        }
      }, 100);

    } catch (e) {
      alert(`Could not generate draft: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✦ Draft reply'; }
    }
  }

  // ── IMAP-based batch draft (when no email tab is open) ───────────────────

  async function _imapBatchDraft(svcId, messages) {
    if (typeof LiveConnectorManager === 'undefined') return;
    const def = LiveConnectorManager.LIVE_CAPABLE?.[svcId] || { name: svcId, gradient: '#333', icon: '✉' };

    LiveConnectorManager._showBatchDraftModal({
      phase: 'draft',
      serviceId: svcId,
      def,
      email: messages[0],
      idx: 0,
      total: messages.length,
      draft: '',
      emails: messages,
      tabId: null
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _esc(t) {
    return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _domain(url) {
    if (!url) return 'HN';
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function _timeAgo(iso) {
    if (!iso) return '';
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
    return `${Math.round(d / 86400000)}d ago`;
  }

  return { init };
})();

// Boot after DOM is ready and other managers are initialized
document.addEventListener('DOMContentLoaded', () => {
  // Small delay so TabManager and other globals are initialized first
  setTimeout(() => NTP.init(), 500);
});
