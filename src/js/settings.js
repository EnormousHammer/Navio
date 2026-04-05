/**
 * Navio Browser - Settings Manager
 * Category-based settings (major-browser style) + AI/privacy transparency
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
      clearSiteDataStatus: document.getElementById('clear-site-data-status')
    };

    this.panelIds = ['general', 'ai', 'appearance', 'browser', 'privacy', 'about'];

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
        'Use an OpenAI-compatible <code>chat/completions</code> URL. Keys are stored only on this device.';
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

  populateFields() {
    this.elements.startupMode.value =
      this.config.startupMode === 'homepage' ? 'homepage' : 'new-tab';

    const z = this.config.defaultZoom;
    const zVal = typeof z === 'number' ? String(z) : String(parseFloat(z) || 1);
    const allowed = ['0.75', '0.9', '1', '1.1', '1.25'];
    this.elements.defaultZoom.value = allowed.includes(zVal) ? zVal : '1';

    this.elements.aiPageContext.checked = this.config.aiIncludePageContext !== false;

    this.elements.provider.value = this.config.aiProvider || 'openai';
    this.elements.apiKey.value = this.config.apiKey || '';
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

    const newConfig = {
      ...this.config,
      startupMode: this.elements.startupMode.value === 'homepage' ? 'homepage' : 'new-tab',
      defaultZoom,
      aiIncludePageContext: this.elements.aiPageContext.checked,
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
    this.config = newConfig;

    if (typeof App !== 'undefined') {
      App.config = newConfig;
      App.applyTheme(newConfig.theme);
      App.applyLayoutFromConfig(newConfig);
    }

    if (typeof TabManager !== 'undefined') {
      TabManager.applyZoomFromConfig();
    }

    this.close(false);
  }
}

const SettingsManager = new SettingsManagerClass();
