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
      importScanStatus: document.getElementById('settings-import-scan-status')
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
    if (this.elements.aiProactivity) {
      this.elements.aiProactivity.value = this.config.aiProactivity || 'off';
    }
    if (this.elements.mcpEnabled) this.elements.mcpEnabled.checked = !!this.config.mcpEnabled;
    if (this.elements.syncEnabled) this.elements.syncEnabled.checked = !!this.config.syncEnabled;
    if (this.elements.extensionsAI) this.elements.extensionsAI.checked = !!this.config.extensionsAllowAI;
    if (this.elements.formAutofill) this.elements.formAutofill.checked = this.config.formAutofillAssist !== false;

    this.elements.provider.value = this.config.aiProvider || 'openai';
    try {
      const k = await window.navio.getApiKeyForSettings();
      this.elements.apiKey.value = k || '';
    } catch {
      this.elements.apiKey.value = '';
    }
    this.elements.model.value = this.config.aiModel || 'gpt-5.4';
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
    const currentValue = modelSelect.value;

    const optgroups = modelSelect.querySelectorAll('optgroup');
    optgroups.forEach((group) => {
      const label = group.label.toLowerCase();
      if (provider === 'custom') {
        group.style.display = '';
      } else if (provider === 'openai' && label.includes('openai')) {
        group.style.display = '';
      } else if (provider === 'anthropic' && label.includes('anthropic')) {
        group.style.display = '';
      } else if (provider === 'google' && label.includes('google')) {
        group.style.display = '';
      } else {
        group.style.display = 'none';
      }
    });

    const visibleOptions = Array.from(modelSelect.querySelectorAll('optgroup:not([style*="none"]) option'));
    if (visibleOptions.length > 0 && !visibleOptions.find((o) => o.value === currentValue)) {
      modelSelect.value = visibleOptions[0].value;
    }
  }

  async open() {
    await this.loadConfig();
    this._openedConfig = JSON.parse(JSON.stringify(this.config));
    if (this.elements.clearSiteDataStatus) this.elements.clearSiteDataStatus.textContent = '';
    if (this.elements.ledgerStatus) this.elements.ledgerStatus.textContent = '';
    this.showPanel('general');
    this.modal.classList.add('visible');
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
      aiProactivity: this.elements.aiProactivity ? this.elements.aiProactivity.value : 'off',
      mcpEnabled: !!(this.elements.mcpEnabled && this.elements.mcpEnabled.checked),
      syncEnabled: !!(this.elements.syncEnabled && this.elements.syncEnabled.checked),
      extensionsAllowAI: !!(this.elements.extensionsAI && this.elements.extensionsAI.checked),
      formAutofillAssist: !!(this.elements.formAutofill && this.elements.formAutofill.checked),
      aiProvider: this.elements.provider.value,
      apiKey: this.elements.apiKey.value.trim(),
      aiModel: this.elements.model.value,
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
