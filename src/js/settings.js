/**
 * Navio Browser - Settings Manager
 */

const PROVIDER_KEY_LINKS = {
  openai: { label: 'Get an OpenAI API key', href: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Get an Anthropic API key', href: 'https://console.anthropic.com/settings/keys' },
  google: { label: 'Get a Google AI Studio key', href: 'https://aistudio.google.com/apikey' },
  custom: null
};

class SettingsManagerClass {
  constructor() {
    this.modal = document.getElementById('settings-modal');
    this.config = {};
    this._openedConfig = null;

    this.elements = {
      startupMode: document.getElementById('setting-startup-mode'),
      defaultZoom: document.getElementById('setting-default-zoom'),
      aiPageContext: document.getElementById('setting-ai-page-context'),
      provider: document.getElementById('setting-provider'),
      providerHint: document.getElementById('setting-provider-hint'),
      apiKey: document.getElementById('setting-api-key'),
      model: document.getElementById('setting-model'),
      modelSelectRow: document.getElementById('model-select-row'),
      modelCustom: document.getElementById('setting-model-custom'),
      modelCustomRow: document.getElementById('model-custom-row'),
      endpoint: document.getElementById('setting-endpoint'),
      endpointRow: document.getElementById('custom-endpoint-row'),
      searchEngine: document.getElementById('setting-search-engine'),
      homepage: document.getElementById('setting-homepage'),
      assistantWidth: document.getElementById('setting-assistant-width'),
      assistantWidthValue: document.getElementById('setting-assistant-width-value'),
      toggleKey: document.getElementById('btn-toggle-key'),
      themeOptions: document.getElementById('theme-options'),
      nav: document.getElementById('settings-nav'),
      clearApiKey: document.getElementById('btn-clear-api-key'),
      clearSiteData: document.getElementById('btn-clear-site-data'),
      clearSiteDataStatus: document.getElementById('clear-site-data-status'),
      aiKillSwitch: document.getElementById('setting-ai-kill-switch'),
      aiDataScope: document.getElementById('setting-ai-data-scope'),
      aiRedact: document.getElementById('setting-ai-redact'),
      aiStream: document.getElementById('setting-ai-stream'),
      aiAutoExecute: document.getElementById('setting-ai-auto-execute'),
      aiProactivity: document.getElementById('setting-ai-proactivity'),
      mcpEnabled: document.getElementById('setting-mcp-enabled'),
      mcpToolsHint: document.getElementById('setting-mcp-tools-hint'),
      syncEnabled: document.getElementById('setting-sync-enabled'),
      extensionsAI: document.getElementById('setting-extensions-ai'),
      formAutofill: document.getElementById('setting-form-autofill'),
      memoryInfo: document.getElementById('setting-memory-info'),
      exportLedger: document.getElementById('btn-export-ledger'),
      ledgerStatus: document.getElementById('ledger-export-status'),
      importScan: document.getElementById('btn-settings-import-scan'),
      importScanStatus: document.getElementById('settings-import-scan-status'),
      adBlock: document.getElementById('setting-ad-block'),
      adBlockStats: document.getElementById('ad-block-stats-hint'),
      memoryList: document.getElementById('memory-list'),
      memoryAddInput: document.getElementById('memory-add-input'),
      memoryAddBtn: document.getElementById('memory-add-btn'),
      memoryClearBtn: document.getElementById('memory-clear-btn'),
      aiProfileGrid: document.getElementById('ai-profile-grid')
    };

    this.panelIds = ['general', 'ai', 'appearance', 'browser', 'privacy', 'integrations', 'about'];

    this.bindEvents();
    this.loadConfig();
  }

  bindEvents() {
    document.getElementById('btn-settings').addEventListener('click', () => this.open());
    document.getElementById('btn-close-settings').addEventListener('click', () => this.close(true));
    document.getElementById('btn-cancel-settings').addEventListener('click', () => this.close(true));
    document.getElementById('btn-save-settings').addEventListener('click', () => this.save());

    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close(true);
    });

    this.elements.provider.addEventListener('change', () => {
      this.elements.endpointRow.style.display =
        this.elements.provider.value === 'custom' ? 'block' : 'none';
      this.updateModelOptions();
      this.updateProviderHint();
    });

    this.elements.model.addEventListener('change', () => {
      this._syncModelCustomUI();
    });

    document.getElementById('btn-model-back-presets')?.addEventListener('click', () => {
      const provider = this.elements.provider.value;
      const defaults = { openai: 'gpt-4o', anthropic: 'claude-opus-4-5', google: 'gemini-2.0-flash', custom: '__custom__' };
      this.elements.model.value = defaults[provider] || 'gpt-4o';
      this._syncModelCustomUI();
    });

    this.elements.toggleKey.addEventListener('click', () => {
      const input = this.elements.apiKey;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    this.elements.themeOptions.querySelectorAll('.theme-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.elements.themeOptions.querySelectorAll('.theme-option').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedTheme = btn.dataset.theme;
        if (typeof App !== 'undefined') {
          App.applyTheme(this.selectedTheme);
        }
      });
    });

    this.elements.assistantWidth.addEventListener('input', () => {
      this.syncAssistantWidthLabel();
    });

    this.elements.clearApiKey.addEventListener('click', () => {
      this.elements.apiKey.value = '';
      this.showPanel('ai');
      const aiBtn = this.elements.nav.querySelector('[data-panel="ai"]');
      if (aiBtn) aiBtn.focus();
    });

    this.elements.clearSiteData.addEventListener('click', async () => {
      const status = this.elements.clearSiteDataStatus;
      status.textContent = 'Clearing…';
      try {
        const r = await window.navio.clearBrowsingData();
        status.textContent = r.ok ? 'Browsing data cleared.' : (r.error || 'Could not clear data.');
      } catch (err) {
        status.textContent = err.message || 'Could not clear data.';
      }
    });

    this.elements.importScan?.addEventListener('click', async () => {
      const st = this.elements.importScanStatus;
      if (st) st.textContent = 'Scanning…';
      try {
        const browsers = await window.navio.detectBrowsers();
        if (!browsers.length) {
          if (st) st.textContent = 'No supported browser bookmark files found.';
          return;
        }
        const lines = browsers.map((b) => `${b.name}: ${b.bookmarkCount} bookmarks`).join('\n');
        if (st) st.textContent = `Found:\n${lines}\nUse onboarding import or add bookmarks manually.`;
      } catch (e) {
        if (st) st.textContent = e.message || 'Scan failed.';
      }
    });

    this.elements.exportLedger?.addEventListener('click', async () => {
      const st = this.elements.ledgerStatus;
      if (st) st.textContent = '';
      try {
        const text = await window.navio.ledgerExport();
        if (!text) {
          if (st) st.textContent = 'Ledger empty or unavailable.';
          return;
        }
        await navigator.clipboard.writeText(text);
        if (st) st.textContent = 'Ledger copied to clipboard.';
      } catch (e) {
        if (st) st.textContent = e.message || 'Export failed.';
      }
    });

    this.elements.nav.querySelectorAll('.settings-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => this.showPanel(btn.dataset.panel));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.classList.contains('visible')) {
        this.close(true);
      }
    });
  }

  showPanel(panelId) {
    if (!this.panelIds.includes(panelId)) return;

    this.elements.nav.querySelectorAll('.settings-nav-item').forEach((btn) => {
      const on = btn.dataset.panel === panelId;
      btn.classList.toggle('active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    this.panelIds.forEach((id) => {
      const el = document.getElementById(`settings-panel-${id}`);
      if (el) el.classList.toggle('active', id === panelId);
    });
  }

  _syncModelCustomUI() {
    const isCustom = this.elements.model.value === '__custom__';
    this.elements.modelSelectRow.style.display = isCustom ? 'none' : '';
    this.elements.modelCustomRow.style.display = isCustom ? '' : 'none';
    if (isCustom) setTimeout(() => this.elements.modelCustom.focus(), 50);
  }

  updateProviderHint() {
    const el = this.elements.providerHint;
    const prov = this.elements.provider.value;
    const link = PROVIDER_KEY_LINKS[prov];
    if (!link) {
      el.innerHTML =
        'Use an OpenAI-compatible <code>chat/completions</code> URL. Keys are stored with OS encryption when available.';
      return;
    }
    el.innerHTML = `<a href="#" data-external-href="${link.href}">${link.label}</a> — opens in a new tab.`;
    const a = el.querySelector('a');
    if (a) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const url = a.getAttribute('data-external-href');
        if (typeof TabManager !== 'undefined' && url) {
          TabManager.createTab(url);
        }
      });
    }
  }

  syncAssistantWidthLabel() {
    const v = this.elements.assistantWidth.value;
    this.elements.assistantWidthValue.textContent = `${v}px`;
    this.elements.assistantWidth.setAttribute('aria-valuetext', `${v} pixels wide`);
  }

  async loadConfig() {
    this.config = await window.navio.getConfig();
    this.populateFields();
  }

  async populateFields() {
    this.elements.startupMode.value =
      this.config.startupMode === 'homepage' ? 'homepage' : 'new-tab';

    const z = this.config.defaultZoom;
    const zVal = typeof z === 'number' ? String(z) : String(parseFloat(z) || 1);
    const allowed = ['0.75', '0.9', '1', '1.1', '1.25'];
    this.elements.defaultZoom.value = allowed.includes(zVal) ? zVal : '1';

    const scope = this.config.aiDataScope || (this.config.aiIncludePageContext === false ? 'none' : 'excerpt');
    this.elements.aiPageContext.checked = scope !== 'none';
    if (this.elements.aiDataScope) {
      this.elements.aiDataScope.value = ['none', 'selection', 'excerpt', 'full'].includes(scope) ? scope : 'excerpt';
    }
    if (this.elements.aiKillSwitch) this.elements.aiKillSwitch.checked = !!this.config.aiKillSwitch;
    if (this.elements.aiRedact) this.elements.aiRedact.checked = this.config.aiRedactPII !== false;
    if (this.elements.aiStream) this.elements.aiStream.checked = this.config.aiStreamResponses !== false;
    if (this.elements.aiAutoExecute) this.elements.aiAutoExecute.checked = !!this.config.aiAutoExecute;
    if (this.elements.aiProactivity) {
      this.elements.aiProactivity.value = this.config.aiProactivity || 'off';
    }
    if (this.elements.mcpEnabled) this.elements.mcpEnabled.checked = !!this.config.mcpEnabled;
    if (this.elements.syncEnabled) this.elements.syncEnabled.checked = !!this.config.syncEnabled;
    if (this.elements.extensionsAI) this.elements.extensionsAI.checked = !!this.config.extensionsAllowAI;
    if (this.elements.formAutofill) this.elements.formAutofill.checked = this.config.formAutofillAssist !== false;
    if (this.elements.adBlock) this.elements.adBlock.checked = this.config.adBlockEnabled !== false;

    this.elements.provider.value = this.config.aiProvider || 'openai';
    try {
      const k = await window.navio.getApiKeyForSettings();
      this.elements.apiKey.value = k || '';
    } catch {
      this.elements.apiKey.value = '';
    }
    // Known-fake legacy model names from old defaults — silently upgrade
    const LEGACY_FAKE = new Set(['claude-opus-4.6', 'gemini-3.1-pro']);
    let savedModel = this.config.aiModel || 'gpt-4o';
    if (LEGACY_FAKE.has(savedModel)) savedModel = 'gpt-4o';

    const modelOpts = Array.from(this.elements.model.options).map(o => o.value).filter(v => v !== '__custom__');
    if (modelOpts.includes(savedModel)) {
      this.elements.model.value = savedModel;
      this.elements.modelSelectRow.style.display = '';
      this.elements.modelCustomRow.style.display = 'none';
    } else {
      this.elements.model.value = '__custom__';
      this.elements.modelCustom.value = savedModel;
      this.elements.modelSelectRow.style.display = 'none';
      this.elements.modelCustomRow.style.display = '';
    }
    this.elements.endpoint.value = this.config.customEndpoint || '';
    this.elements.searchEngine.value = this.config.searchEngine || 'https://www.google.com/search?q=';
    this.elements.homepage.value = this.config.homepage || 'https://www.google.com';

    const aw = Number(this.config.assistantWidth);
    const width = Number.isFinite(aw) ? Math.min(560, Math.max(300, aw)) : 420;
    this.elements.assistantWidth.value = String(width);
    this.syncAssistantWidthLabel();

    this.elements.endpointRow.style.display =
      this.config.aiProvider === 'custom' ? 'block' : 'none';

    this.selectedTheme = this.config.theme || 'dark';
    this.elements.themeOptions.querySelectorAll('.theme-option').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === this.selectedTheme);
    });

    this.updateModelOptions();
    this.updateProviderHint();
    this.refreshMcpHint();
    this.refreshMemoryInfo();
  }

  async refreshMemoryInfo() {
    const el = this.elements.memoryInfo;
    if (!el) return;
    try {
      const m = await window.navio.getMemoryInfo();
      if (!m) {
        el.textContent = '';
        return;
      }
      const mb = (n) => (n / (1024 * 1024)).toFixed(1);
      el.textContent = `Process memory (approx.): RSS ${mb(m.rss)} MB · Heap used ${mb(m.heapUsed)} MB`;
    } catch {
      el.textContent = '';
    }
  }

  async refreshMcpHint() {
    const el = this.elements.mcpToolsHint;
    if (!el) return;
    try {
      const r = await window.navio.mcpConfig({ op: 'list-tools-stub' });
      const n = (r.tools || []).length;
      el.textContent = n ? `Stub tools visible: ${n}` : 'Enable MCP to list stub tools.';
    } catch {
      el.textContent = '';
    }
  }

  updateModelOptions() {
    const provider = this.elements.provider.value;
    const modelSelect = this.elements.model;

    // Show only the optgroup for the active provider
    modelSelect.querySelectorAll('optgroup').forEach((grp) => {
      const grpProvider = grp.getAttribute('data-provider');
      grp.style.display = (grpProvider === provider || provider === 'custom') ? '' : 'none';
    });

    // If current selection belongs to a now-hidden optgroup, reset to provider default
    const defaults = { openai: 'gpt-4o', anthropic: 'claude-opus-4-5', google: 'gemini-2.0-flash', custom: '__custom__' };
    const currentOption = modelSelect.options[modelSelect.selectedIndex];
    const currentGroupProvider = currentOption?.closest('optgroup')?.getAttribute('data-provider');

    if (!currentGroupProvider || (currentGroupProvider !== provider && provider !== 'custom')) {
      const def = defaults[provider] || 'gpt-4o';
      const match = Array.from(modelSelect.options).find(
        o => o.value === def && o.closest('optgroup')?.getAttribute('data-provider') === provider
      );
      if (match) modelSelect.value = def;
    }

    this._syncModelCustomUI();
  }

  async open() {
    await this.loadConfig();
    this._openedConfig = JSON.parse(JSON.stringify(this.config));
    if (this.elements.clearSiteDataStatus) this.elements.clearSiteDataStatus.textContent = '';
    if (this.elements.ledgerStatus) this.elements.ledgerStatus.textContent = '';
    this.showPanel('general');
    this.modal.classList.add('visible');
    this._renderOAuthClientIdFields();
    this._refreshAdBlockStats();
    this._loadMemoryList();
    this._bindProfileGrid();

    // Live ad-blocker toggle (takes effect immediately without Save)
    if (this.elements.adBlock && !this.elements.adBlock._navioAdBlockBound) {
      this.elements.adBlock._navioAdBlockBound = true;
      this.elements.adBlock.addEventListener('change', async () => {
        const enabled = this.elements.adBlock.checked;
        await window.navio.setAdBlocker(enabled);
        this._refreshAdBlockStats();
      });
    }
  }

  async _refreshAdBlockStats() {
    if (!this.elements.adBlockStats) return;
    try {
      const s = await window.navio.getAdBlockStats();
      const status = s.enabled ? 'ON' : 'OFF';
      this.elements.adBlockStats.textContent =
        `Status: ${status} · ${s.blocked.toLocaleString()} requests blocked this session · ${s.domains} domains in blocklist`;
    } catch {
      this.elements.adBlockStats.textContent = 'Blocks requests from known ad networks, tracking pixels, and data brokers.';
    }
  }

  // ── Browser Memory ──────────────────────────────────────────────────────
  async _loadMemoryList() {
    const el = this.elements.memoryList;
    if (!el) return;
    try {
      const mem = await window.navio.memoryGet();
      const facts = mem.facts || [];
      if (facts.length === 0) {
        el.innerHTML = '<p class="settings-inline-hint" style="margin:8px 0">No memories saved yet. Navio will learn from your conversations.</p>';
      } else {
        el.innerHTML = facts.map(f => `
          <div class="memory-item" data-id="${f.id}">
            <span class="memory-item-text">${this._esc(f.content)}</span>
            <span class="memory-item-type ${f.type === 'auto' ? 'auto' : 'manual'}">${f.type === 'auto' ? 'AI' : 'You'}</span>
            <button class="memory-item-del" data-id="${f.id}" title="Delete">✕</button>
          </div>`).join('');
        el.querySelectorAll('.memory-item-del').forEach(btn => {
          btn.addEventListener('click', async () => {
            await window.navio.memoryDelete(btn.dataset.id);
            this._loadMemoryList();
          });
        });
      }
    } catch { el.innerHTML = '<p class="settings-inline-hint">Could not load memories.</p>'; }

    // Bind add button (once)
    if (this.elements.memoryAddBtn && !this.elements.memoryAddBtn._bound) {
      this.elements.memoryAddBtn._bound = true;
      this.elements.memoryAddBtn.addEventListener('click', async () => {
        const val = this.elements.memoryAddInput?.value.trim();
        if (!val) return;
        await window.navio.memoryAdd(val);
        this.elements.memoryAddInput.value = '';
        this._loadMemoryList();
      });
      this.elements.memoryAddInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.elements.memoryAddBtn.click();
      });
    }
    if (this.elements.memoryClearBtn && !this.elements.memoryClearBtn._bound) {
      this.elements.memoryClearBtn._bound = true;
      this.elements.memoryClearBtn.addEventListener('click', async () => {
        if (!confirm('Clear all browser memories? This cannot be undone.')) return;
        await window.navio.memoryClear();
        this._loadMemoryList();
      });
    }
  }

  _esc(t) {
    return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── AI Profile ─────────────────────────────────────────────────────────
  _bindProfileGrid() {
    const grid = this.elements.aiProfileGrid;
    if (!grid || grid._bound) return;
    grid._bound = true;
    const current = this.config.aiProfile || 'default';
    grid.querySelectorAll('.ai-profile-btn').forEach(btn => {
      if (btn.dataset.profile === current) btn.classList.add('active');
      btn.addEventListener('click', async () => {
        grid.querySelectorAll('.ai-profile-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const profile = btn.dataset.profile;
        await window.navio.saveConfig({ aiProfile: profile });
        this.config.aiProfile = profile;
        // Update the navbar profile pill
        const icons = { default: '✦', developer: '⌨', researcher: '🔬', creator: '✏' };
        const pill = document.getElementById('profile-pill-icon');
        if (pill) pill.textContent = icons[profile] || '✦';
        const pillBtn = document.getElementById('btn-profile-pill');
        if (pillBtn) pillBtn.title = `AI Profile: ${btn.querySelector('.ai-profile-name')?.textContent} — click to change`;
      });
    });
  }

  async _renderOAuthClientIdFields() {
    const container = document.getElementById('oauth-client-id-fields');
    if (!container) return;
    container.innerHTML = '<div class="oauth-setup-loading">Loading…</div>';

    let providers = [];
    try {
      providers = await window.navio.oauthProvidersConfig();
    } catch {
      container.innerHTML = '<p class="settings-inline-hint" style="color:var(--text-danger)">Could not load OAuth provider config.</p>';
      return;
    }

    let html = '';
    for (const p of providers) {
      const cfgKey = p.configKey;
      const currentVal = this.config[cfgKey] || '';
      html += `
        <div class="oauth-provider-row" id="oauth-row-${p.id}">
          <div class="oauth-provider-label">
            <strong>${p.name}</strong>
            <span class="oauth-provider-services">${p.serviceIds.join(', ')}</span>
          </div>
          <div class="oauth-provider-input-row">
            <input
              type="text"
              class="oauth-client-id-input"
              data-key="${cfgKey}"
              placeholder="${p.name} Client ID"
              value="${currentVal}"
              spellcheck="false"
              autocomplete="off"
            >
            <button class="oauth-client-id-save-btn" data-key="${cfgKey}" data-provider="${p.id}">Save</button>
          </div>
          <div class="oauth-provider-hint">
            <a class="oauth-console-link" href="${p.consoleUrl}" target="_blank" data-href="${p.consoleUrl}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Get ${p.name} Client ID
            </a>
            <span class="oauth-console-hint">${p.consoleHint}</span>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;

    // Bind save buttons
    container.querySelectorAll('.oauth-client-id-save-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key      = btn.dataset.key;
        const provider = btn.dataset.provider;
        const input    = container.querySelector(`input[data-key="${key}"]`);
        const val      = (input?.value || '').trim();
        btn.disabled   = true;
        btn.textContent = 'Saving…';
        try {
          await window.navio.saveConfig({ [key]: val });
          this.config[key] = val;

          if (val) {
            // Client ID saved — immediately open the OAuth sign-in popup so the
            // user doesn't have to find the "Sign in" button in the Connectors Hub.
            btn.textContent = 'Signing in…';
            const result = await window.navio.oauthConnect(provider);
            if (result && result.error) {
              btn.textContent = '⚠ Sign-in failed';
              // Show the error inline under the input
              let errEl = btn.closest('.oauth-provider-row').querySelector('.oauth-signin-error');
              if (!errEl) {
                errEl = document.createElement('div');
                errEl.className = 'oauth-signin-error';
                errEl.style.cssText = 'color:var(--text-danger,#f87171);font-size:12px;margin-top:4px;';
                btn.closest('.oauth-provider-input-row').after(errEl);
              }
              errEl.textContent = result.error;
              setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 3000);
            } else if (result && result.ok) {
              btn.textContent = `✓ Connected as ${result.email || result.name || 'account'}`;
              const row = btn.closest('.oauth-provider-row');
              // Remove any previous error
              row.querySelector('.oauth-signin-error')?.remove();
              setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 4000);
            } else {
              btn.textContent = '✓ Saved';
              setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
            }
          } else {
            // Client ID cleared — just confirm save
            btn.textContent = '✓ Saved';
            setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
          }
        } catch {
          btn.textContent = 'Error';
          setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 2000);
        }
      });
    });

    // Open dev console links in Navio browser
    container.querySelectorAll('.oauth-console-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const href = a.dataset.href;
        if (href && typeof TabManager !== 'undefined') TabManager.createTab(href);
      });
    });
  }

  close(discardChanges) {
    if (discardChanges && this._openedConfig) {
      this.config = JSON.parse(JSON.stringify(this._openedConfig));
      this.populateFields();
      if (typeof App !== 'undefined') {
        App.applyTheme(this.config.theme || 'dark');
        App.applyLayoutFromConfig(this.config);
      }
      if (typeof TabManager !== 'undefined') {
        TabManager.applyZoomFromConfig();
      }
    }
    this._openedConfig = null;
    this.modal.classList.remove('visible');
    this.elements.apiKey.type = 'password';
  }

  async save() {
    const aw = parseInt(this.elements.assistantWidth.value, 10);
    const assistantWidth = Number.isFinite(aw) ? Math.min(560, Math.max(300, aw)) : 420;

    const zoomParsed = parseFloat(this.elements.defaultZoom.value);
    const defaultZoom = Number.isFinite(zoomParsed) ? zoomParsed : 1;

    let aiDataScope = this.elements.aiDataScope ? this.elements.aiDataScope.value : (this.config.aiDataScope || 'excerpt');
    if (!this.elements.aiPageContext.checked) aiDataScope = 'none';
    else if (aiDataScope === 'none') aiDataScope = 'excerpt';

    const newConfig = {
      ...this.config,
      startupMode: this.elements.startupMode.value === 'homepage' ? 'homepage' : 'new-tab',
      defaultZoom,
      aiIncludePageContext: aiDataScope !== 'none',
      aiDataScope,
      mcpServers: Array.isArray(this.config.mcpServers) ? this.config.mcpServers : [],
      aiKillSwitch: !!(this.elements.aiKillSwitch && this.elements.aiKillSwitch.checked),
      aiRedactPII: !!(this.elements.aiRedact && this.elements.aiRedact.checked),
      aiStreamResponses: !!(this.elements.aiStream && this.elements.aiStream.checked),
      aiAutoExecute: !!(this.elements.aiAutoExecute && this.elements.aiAutoExecute.checked),
      aiProactivity: this.elements.aiProactivity ? this.elements.aiProactivity.value : 'off',
      mcpEnabled: !!(this.elements.mcpEnabled && this.elements.mcpEnabled.checked),
      syncEnabled: !!(this.elements.syncEnabled && this.elements.syncEnabled.checked),
      extensionsAllowAI: !!(this.elements.extensionsAI && this.elements.extensionsAI.checked),
      formAutofillAssist: !!(this.elements.formAutofill && this.elements.formAutofill.checked),
      adBlockEnabled: !!(this.elements.adBlock && this.elements.adBlock.checked),
      aiProvider: this.elements.provider.value,
      apiKey: this.elements.apiKey.value.trim(),
      aiModel: this.elements.model.value === '__custom__'
        ? (this.elements.modelCustom.value.trim() || 'gpt-4o')
        : this.elements.model.value,
      customEndpoint: this.elements.endpoint.value.trim(),
      searchEngine: this.elements.searchEngine.value,
      homepage: this.elements.homepage.value.trim() || 'https://www.google.com',
      theme: this.selectedTheme || 'dark',
      assistantWidth
    };

    await window.navio.saveConfig(newConfig);

    this.config = { ...(await window.navio.getConfig()) };

    if (typeof App !== 'undefined') {
      App.config = this.config;
      App.applyTheme(newConfig.theme);
      App.applyLayoutFromConfig(newConfig);
    }

    if (typeof TabManager !== 'undefined') {
      TabManager.applyZoomFromConfig();
    }

    if (typeof AssistantManager !== 'undefined') {
      AssistantManager.syncScopeFromConfig();
    }

    this.close(false);
  }
}

const SettingsManager = new SettingsManagerClass();
