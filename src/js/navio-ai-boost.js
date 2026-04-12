/**
 * Navio AI Boost — Competitive feature upgrades
 * Proactive suggestions, omnibox AI preview, cross-tab intelligence,
 * in-line writing assist, agent step UI, NTP suggestions, orb state sync.
 */

(function NavioAIBoost() {
  'use strict';

  // ── AI Orb State Sync ─────────────────────────────────────────────────────
  const orb = document.getElementById('ai-orb');
  let orbThinking = false;

  function setOrbThinking(on) {
    if (!orb || orbThinking === on) return;
    orbThinking = on;
    orb.classList.toggle('thinking', on);
  }

  const _origShowTyping = typeof AssistantManager !== 'undefined' && AssistantManager.showTypingIndicator;
  const _origHideTyping = typeof AssistantManager !== 'undefined' && AssistantManager.hideTypingIndicator;

  if (typeof AssistantManager !== 'undefined') {
    const am = AssistantManager;
    const origShow = am.showTypingIndicator?.bind(am);
    const origHide = am.hideTypingIndicator?.bind(am);

    if (origShow) {
      am.showTypingIndicator = function () {
        setOrbThinking(true);
        return origShow();
      };
    }
    if (origHide) {
      am.hideTypingIndicator = function () {
        setOrbThinking(false);
        return origHide();
      };
    }
  }

  // ── Proactive Chips Container ─────────────────────────────────────────────
  const chipsContainer = document.getElementById('navio-proactive-chips');

  function showProactiveChips(suggestions) {
    if (!chipsContainer) return;
    chipsContainer.innerHTML = '';

    const panel = document.getElementById('assistant-panel');
    if (panel && panel.classList.contains('open')) {
      chipsContainer.classList.add('panel-open');
    } else {
      chipsContainer.classList.remove('panel-open');
    }

    suggestions.slice(0, 3).forEach((s) => {
      const chip = document.createElement('button');
      chip.className = 'proactive-chip';
      chip.innerHTML = `
        <span class="pc-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </span>
        <span class="pc-text">${s.label}</span>
        <button class="pc-dismiss" title="Dismiss">&times;</button>
      `;

      chip.addEventListener('click', (e) => {
        if (e.target.closest('.pc-dismiss')) {
          chip.remove();
          return;
        }
        chipsContainer.innerHTML = '';
        if (typeof AssistantManager !== 'undefined') {
          AssistantManager.open();
          AssistantManager.inputEl.value = s.prompt || s.label;
          AssistantManager.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          AssistantManager.inputEl.focus();
          if (s.autoSend) {
            setTimeout(() => AssistantManager.sendMessage(), 100);
          }
        }
      });

      chipsContainer.appendChild(chip);
    });

    setTimeout(() => { chipsContainer.innerHTML = ''; }, 15000);
  }

  function clearProactiveChips() {
    if (chipsContainer) chipsContainer.innerHTML = '';
  }

  // ── Page-Aware Proactive Suggestions ──────────────────────────────────────
  function detectPageSuggestions(url, title) {
    if (!url || url === 'about:blank') return [];
    const u = url.toLowerCase();
    const t = (title || '').toLowerCase();
    const suggestions = [];

    if (/amazon\.|ebay\.com|walmart\.com|shopify|\/product\//i.test(u)) {
      suggestions.push(
        { label: 'Compare prices', prompt: 'Find this product cheaper elsewhere and compare prices', autoSend: true },
        { label: 'Summarize reviews', prompt: 'Summarize the reviews for this product — pros, cons, and verdict', autoSend: true }
      );
    } else if (/github\.com.*\/(pull|issues|blob)\//i.test(u)) {
      suggestions.push(
        { label: 'Explain this code', prompt: 'Explain what this code does in simple terms', autoSend: true },
        { label: 'Find bugs', prompt: 'Review this code for potential bugs or issues', autoSend: true }
      );
    } else if (/stackoverflow\.com\/questions/i.test(u)) {
      suggestions.push(
        { label: 'Best answer?', prompt: 'What is the best answer to this Stack Overflow question and why?', autoSend: true }
      );
    } else if (/youtube\.com\/watch/i.test(u)) {
      suggestions.push(
        { label: 'Summarize video', prompt: 'Summarize this YouTube video — key points and takeaways', autoSend: true }
      );
    } else if (/wikipedia\.org\/wiki\//i.test(u)) {
      suggestions.push(
        { label: 'TL;DR', prompt: 'Give me a TL;DR of this Wikipedia article', autoSend: true },
        { label: 'Key facts', prompt: 'Extract the key facts from this Wikipedia article as bullet points', autoSend: true }
      );
    } else if (/docs\.google\.com|notion\.so|medium\.com/i.test(u)) {
      suggestions.push(
        { label: 'Summarize', prompt: 'Summarize this document concisely', autoSend: true }
      );
    } else if (/mail\.google\.com|outlook\.live\.com|outlook\.office/i.test(u)) {
      suggestions.push(
        { label: 'Draft reply', prompt: 'Help me draft a reply to this email', autoSend: false }
      );
    } else if (/linkedin\.com\/jobs|indeed\.com|glassdoor\.com/i.test(u)) {
      suggestions.push(
        { label: 'Job summary', prompt: 'Summarize this job listing — requirements, salary, and key qualifications', autoSend: true },
        { label: 'Cover letter', prompt: 'Help me write a cover letter for this position', autoSend: false }
      );
    } else if (/(bbc\.com|reuters\.com|nytimes\.com|cnn\.com|theguardian\.com|apnews\.com)/i.test(u)) {
      suggestions.push(
        { label: 'Key takeaways', prompt: 'What are the key takeaways from this article?', autoSend: true },
        { label: 'Related context', prompt: 'Give me background context on this news story', autoSend: true }
      );
    } else if (u.length > 60 && !/(google\.com\/search|bing\.com\/search)/i.test(u)) {
      suggestions.push(
        { label: 'Summarize page', prompt: 'Summarize this page briefly', autoSend: true }
      );
    }

    return suggestions;
  }

  let _lastProactiveUrl = '';
  let _proactiveTimeout = null;

  function onPageNavigated(url, title) {
    const key = (url || '').slice(0, 200);
    if (key === _lastProactiveUrl) return;
    _lastProactiveUrl = key;

    clearTimeout(_proactiveTimeout);
    _proactiveTimeout = setTimeout(() => {
      const suggestions = detectPageSuggestions(url, title);
      if (suggestions.length > 0) {
        showProactiveChips(suggestions);
      } else {
        clearProactiveChips();
      }
    }, 1500);
  }

  // Hook into webview navigation events
  if (typeof TabManager !== 'undefined') {
    const origSetActive = TabManager.setActiveTab?.bind(TabManager);
    if (origSetActive) {
      TabManager.setActiveTab = function (id) {
        const result = origSetActive(id);
        const tab = TabManager.getActiveTab();
        if (tab) {
          setTimeout(() => onPageNavigated(tab.url, TabManager.getTabDisplayTitle(tab)), 500);
        }
        return result;
      };
    }
  }

  // ── Omnibox AI Preview ────────────────────────────────────────────────────
  const urlInput = document.getElementById('url-input');
  const omniPreview = document.getElementById('omnibox-ai-preview');
  let omniDebounce = null;
  let omniAbort = null;

  function isQuestion(text) {
    const t = text.trim().toLowerCase();
    if (/^(what|how|why|when|where|who|which|can|is|are|do|does|should|would|could|will|tell me|explain)\b/.test(t)) return true;
    if (t.endsWith('?')) return true;
    if (t.startsWith('?')) return true;
    return false;
  }

  function showOmniPreview(query) {
    if (!omniPreview || !query) return;
    omniPreview.style.display = 'flex';
    omniPreview.innerHTML = `
      <div class="omni-ai-header">
        <div class="ai-orb" style="width:22px;height:22px">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </div>
        <span class="omni-ai-label">Navio AI</span>
      </div>
      <div class="omni-ai-body">
        <div class="omni-ai-typing"><span></span><span></span><span></span></div>
      </div>
      <div class="omni-ai-footer">
        <span style="font-size:10px;color:var(--text-tertiary)">Tab to expand in assistant</span>
        <button class="omni-ai-open-btn" id="omni-ai-expand">Open in panel</button>
      </div>
    `;

    document.getElementById('omni-ai-expand')?.addEventListener('click', () => {
      hideOmniPreview();
      if (typeof AssistantManager !== 'undefined') {
        AssistantManager.open();
        AssistantManager.inputEl.value = query;
        AssistantManager.sendMessage();
      }
    });

    fetchOmniAnswer(query);
  }

  async function fetchOmniAnswer(query) {
    if (omniAbort) omniAbort.abort();
    omniAbort = new AbortController();

    try {
      const cfg = await window.navio.getConfig();
      if (!cfg.hasApiKey) {
        const body = omniPreview?.querySelector('.omni-ai-body');
        if (body) body.innerHTML = '<p style="color:var(--text-tertiary);font-size:12px">Add an API key in Settings to enable AI answers.</p>';
        return;
      }

      const result = await window.navio.aiRequest({
        messages: [
          { role: 'system', content: 'You are a concise AI assistant. Answer in 2-3 sentences max. Be direct and helpful.' },
          { role: 'user', content: query }
        ],
        maxTokens: 150
      });

      const body = omniPreview?.querySelector('.omni-ai-body');
      if (body && result && !result.error) {
        const text = result.content || result.text || '';
        body.innerHTML = `<p>${text.replace(/\n/g, '<br>')}</p>`;
      } else if (body && result?.error) {
        body.innerHTML = `<p style="color:var(--text-tertiary);font-size:12px">${result.error}</p>`;
      }
    } catch {
      // Silently fail — preview is optional
    }
  }

  function hideOmniPreview() {
    if (omniPreview) {
      omniPreview.style.display = 'none';
      omniPreview.innerHTML = '';
    }
    if (omniAbort) { omniAbort.abort(); omniAbort = null; }
  }

  if (urlInput && omniPreview) {
    urlInput.addEventListener('input', () => {
      clearTimeout(omniDebounce);
      const val = urlInput.value.trim();
      if (val.length < 8 || !isQuestion(val)) {
        hideOmniPreview();
        return;
      }
      omniDebounce = setTimeout(() => showOmniPreview(val), 800);
    });

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideOmniPreview();
      if (e.key === 'Tab' && omniPreview.style.display !== 'none') {
        e.preventDefault();
        hideOmniPreview();
        if (typeof AssistantManager !== 'undefined') {
          AssistantManager.open();
          AssistantManager.inputEl.value = urlInput.value.trim();
          AssistantManager.sendMessage();
          urlInput.value = '';
        }
      }
    });

    urlInput.addEventListener('blur', () => {
      setTimeout(hideOmniPreview, 200);
    });
  }

  // ── NTP + Assistant starter prompt chips ─────────────────────────────────
  document.querySelectorAll('.ntp-ai-suggestion, .assistant-starter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      if (!prompt) return;
      if (typeof AssistantManager !== 'undefined') {
        AssistantManager.open();
        AssistantManager.inputEl.value = prompt;
        AssistantManager.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        AssistantManager.inputEl.focus();
      }
    });
  });

  // ── In-Line Writing Assist ────────────────────────────────────────────────
  let writeAssistEl = null;
  let writeAssistTarget = null;

  function createWriteAssist() {
    if (writeAssistEl) return writeAssistEl;
    writeAssistEl = document.createElement('div');
    writeAssistEl.className = 'navio-write-assist';
    writeAssistEl.style.display = 'none';
    writeAssistEl.innerHTML = `
      <button class="nwa-btn" data-action="improve" title="Improve writing">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Improve
      </button>
      <span class="nwa-sep"></span>
      <button class="nwa-btn" data-action="fix-grammar" title="Fix grammar">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        Fix grammar
      </button>
      <span class="nwa-sep"></span>
      <button class="nwa-btn" data-action="make-shorter" title="Make shorter">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12H3M21 6H3M15 18H3"/></svg>
        Shorter
      </button>
      <span class="nwa-sep"></span>
      <button class="nwa-btn" data-action="make-professional" title="Make professional">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
        Professional
      </button>
    `;
    document.body.appendChild(writeAssistEl);

    writeAssistEl.querySelectorAll('.nwa-btn').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = btn.dataset.action;
        applyWriteAssist(action);
      });
    });

    return writeAssistEl;
  }

  async function applyWriteAssist(action) {
    if (!writeAssistTarget) return;
    const text = writeAssistTarget.value || writeAssistTarget.innerText || '';
    if (!text.trim()) return;

    const prompts = {
      'improve': `Improve the following text. Make it clearer and more engaging. Return ONLY the improved text, nothing else:\n\n${text}`,
      'fix-grammar': `Fix grammar and spelling in the following text. Return ONLY the corrected text, nothing else:\n\n${text}`,
      'make-shorter': `Make the following text shorter and more concise. Return ONLY the shortened text, nothing else:\n\n${text}`,
      'make-professional': `Rewrite the following text in a professional tone. Return ONLY the rewritten text, nothing else:\n\n${text}`
    };

    const prompt = prompts[action];
    if (!prompt) return;

    hideWriteAssist();

    try {
      const result = await window.navio.aiRequest({
        messages: [
          { role: 'system', content: 'You are a writing assistant. Follow the instruction exactly. Return only the modified text.' },
          { role: 'user', content: prompt }
        ],
        maxTokens: 1000
      });

      if (result && !result.error) {
        const newText = (result.content || result.text || '').trim();
        if (newText && writeAssistTarget) {
          if ('value' in writeAssistTarget) {
            writeAssistTarget.value = newText;
            writeAssistTarget.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            writeAssistTarget.innerText = newText;
          }
        }
      }
    } catch {
      // Silently fail
    }
  }

  function showWriteAssist(target, rect) {
    const el = createWriteAssist();
    writeAssistTarget = target;
    el.style.display = 'flex';
    el.style.left = Math.max(4, rect.left) + 'px';
    el.style.top = (rect.bottom + 6) + 'px';
  }

  function hideWriteAssist() {
    if (writeAssistEl) {
      writeAssistEl.style.display = 'none';
    }
    writeAssistTarget = null;
  }

  // Listen for focus on text inputs in webviews via the main process IPC
  // For the assistant's own textarea, show it when there's selected text
  const assistantInput = document.getElementById('assistant-input');
  if (assistantInput) {
    assistantInput.addEventListener('select', () => {
      const sel = assistantInput.value.substring(
        assistantInput.selectionStart,
        assistantInput.selectionEnd
      );
      if (sel.length > 10) {
        const rect = assistantInput.getBoundingClientRect();
        showWriteAssist(assistantInput, rect);
      }
    });

    assistantInput.addEventListener('blur', () => {
      setTimeout(hideWriteAssist, 200);
    });
  }

  // ── Panel open/close → reposition proactive chips ─────────────────────────
  const observer = new MutationObserver(() => {
    const panel = document.getElementById('assistant-panel');
    if (chipsContainer) {
      chipsContainer.classList.toggle('panel-open', panel && panel.classList.contains('open'));
    }
  });

  const assistPanel = document.getElementById('assistant-panel');
  if (assistPanel) {
    observer.observe(assistPanel, { attributes: true, attributeFilter: ['class'] });
  }

  // ── Webview navigation listener for proactive chips ───────────────────────
  function hookWebviewNavigation() {
    const container = document.getElementById('browser-container');
    if (!container) return;

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.tagName === 'WEBVIEW') {
            node.addEventListener('did-navigate', (e) => {
              const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
              onPageNavigated(e.url || node.src, tab?.title || '');
            });
            node.addEventListener('page-title-updated', (e) => {
              onPageNavigated(node.src, e.title || '');
            });
          }
        }
      }
    });

    mo.observe(container, { childList: true, subtree: true });

    container.querySelectorAll('webview').forEach((wv) => {
      wv.addEventListener('did-navigate', (e) => {
        const tab = typeof TabManager !== 'undefined' ? TabManager.getActiveTab() : null;
        onPageNavigated(e.url || wv.src, tab?.title || '');
      });
    });
  }

  hookWebviewNavigation();

  // ── Agent Step Card Builder (utility for assistant.js) ────────────────────
  window.NavioAIBoost = {
    setOrbThinking,
    showProactiveChips,
    clearProactiveChips,
    onPageNavigated,

    buildAgentStepCard(stepNum, action, detail, status) {
      const card = document.createElement('div');
      card.className = 'agent-step-card';
      card.innerHTML = `
        <span class="asc-num">${stepNum}</span>
        <div class="asc-body">
          <div class="asc-action">${action}</div>
          <div class="asc-detail">${detail}</div>
        </div>
        <span class="asc-status ${status}">${status === 'done' ? 'Done' : status === 'running' ? 'Running...' : status === 'failed' ? 'Failed' : 'Pending'}</span>
      `;
      return card;
    },

    buildAgentTakeoverBar(label, stepInfo) {
      const existing = document.querySelector('.agent-takeover-bar');
      if (existing) existing.remove();

      const bar = document.createElement('div');
      bar.className = 'agent-takeover-bar';
      bar.id = 'agent-takeover-bar';
      bar.innerHTML = `
        <div class="atb-orb"></div>
        <div class="atb-label">${label || 'Agent is working...'} <span class="atb-step">${stepInfo || ''}</span></div>
        <button class="atb-stop" id="atb-stop-btn">Stop</button>
      `;

      bar.querySelector('#atb-stop-btn')?.addEventListener('click', () => {
        if (typeof AssistantManager !== 'undefined' && AssistantManager._takeoverAbort) {
          AssistantManager._takeoverAbort.abort();
        }
        bar.remove();
      });

      return bar;
    },

    buildCrossTabBadge(count) {
      const badge = document.createElement('span');
      badge.className = 'cross-tab-badge';
      badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> ${count} tabs`;
      return badge;
    }
  };

})();
