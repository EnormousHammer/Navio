/**
 * Navio Browser - Settings Manager
 */

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

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
      launchIntro: document.getElementById('setting-launch-intro'),
      downloadAskWhere: document.getElementById('setting-download-ask-where'),
      downloadRevealInFolder: document.getElementById('setting-download-reveal'),
      defaultZoom: document.getElementById('setting-default-zoom'),
      aiPageContext: document.getElementById('setting-ai-page-context'),
      provider: document.getElementById('setting-provider'),
      providerHint: document.getElementById('setting-provider-hint'),
      apiKey: document.getElementById('setting-api-key'),
      model: document.getElementById('setting-model'),
      modelSelectRow: document.getElementById('model-select-row'),
      modelCustom: document.getElementById('setting-model-custom'),
      modelCustomRow: document.getElementById('model-custom-row'),
      aiPlannerModel: document.getElementById('setting-ai-planner-model'),
      endpoint: document.getElementById('setting-endpoint'),
      endpointRow: document.getElementById('custom-endpoint-row'),
      searchEngine: document.getElementById('setting-search-engine'),
      homepage: document.getElementById('setting-homepage'),
      assistantWidth: document.getElementById('setting-assistant-width'),
      assistantWidthValue: document.getElementById('setting-assistant-width-value'),
      tabLayout: document.getElementById('setting-tab-layout'),
      bookmarkBar: document.getElementById('setting-bookmark-bar'),
      memorySearchInput: document.getElementById('memory-search-input'),
      extLoadUnpacked: document.getElementById('btn-ext-load-unpacked'),
      extensionsListSettings: document.getElementById('extensions-list-settings'),
      syncExport: document.getElementById('btn-sync-export'),
      syncImport: document.getElementById('btn-sync-import'),
      syncPassphrase: document.getElementById('sync-passphrase'),
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
      aiAutoScreenshot: document.getElementById('setting-ai-auto-screenshot'),
      aiAgentStepMode: document.getElementById('setting-ai-agent-step-mode'),
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
      adStrictPopup: document.getElementById('setting-ad-strict-popup'),
      adBlockStats: document.getElementById('ad-block-stats-hint'),
      memoryList: document.getElementById('memory-list'),
      memoryAddInput: document.getElementById('memory-add-input'),
      memoryAddBtn: document.getElementById('memory-add-btn'),
      memoryClearBtn: document.getElementById('memory-clear-btn'),
      memoryRetention: document.getElementById('setting-memory-retention'),
      aiProfileGrid: document.getElementById('ai-profile-grid'),
      extCrxId: document.getElementById('ext-crx-id'),
      extInstallCrx: document.getElementById('btn-ext-install-crx'),
      profilesListSettings: document.getElementById('profiles-list-settings'),
      profileNewId: document.getElementById('profile-new-id'),
      profileCreateBtn: document.getElementById('btn-profile-create')
    };

    this.panelIds = ['general', 'ai', 'appearance', 'browser', 'privacy', 'integrations', 'passwords', 'about'];

    this.bindEvents();
    this.loadConfig().catch(() => { /* pre-warm failure is non-critical; open() will retry */ });
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
      const defaults = { openai: 'gpt-5.4', anthropic: 'claude-opus-4-5', google: 'gemini-2.0-flash', custom: '__custom__' };
      this.elements.model.value = defaults[provider] || 'gpt-5.4';
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
      btn.addEventListener('click', () => {
        this.showPanel(btn.dataset.panel);
        if (btn.dataset.panel === 'passwords') this._renderPasswordList();
      });
    });

    // Password manager — export
    document.getElementById('btn-pwd-export')?.addEventListener('click', async () => {
      try {
        const r = await window.navio.passwordsExportCsv();
        if (!r.ok) { alert('Export failed: ' + r.error); return; }
        const blob = new Blob([r.csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'navio-passwords.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { alert('Export failed: ' + e.message); }
    });

    // Password manager — import
    const importFile = document.getElementById('pwd-import-file');
    document.getElementById('btn-pwd-import')?.addEventListener('click', () => importFile?.click());
    importFile?.addEventListener('change', async () => {
      const file = importFile.files[0];
      if (!file) return;
      const status = document.getElementById('pwd-import-status');
      if (status) status.textContent = 'Importing…';
      try {
        const text = await file.text();
        const r = await window.navio.passwordsImportCsv(text);
        if (status) status.textContent = r.ok ? `Imported ${r.imported} credential(s).` : ('Failed: ' + r.error);
        if (r.ok) this._renderPasswordList();
      } catch (e) {
        if (status) status.textContent = 'Import failed: ' + e.message;
      }
      importFile.value = '';
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

  async _renderPasswordList() {
    const container = document.getElementById('pwd-list');
    if (!container) return;
    try {
      const r = await window.navio.passwordsList();
      if (!r.ok || !r.entries.length) {
        container.innerHTML = '<p class="pwd-list-empty">No saved passwords yet.</p>';
        return;
      }
      container.innerHTML = r.entries.map((e) => {
        const site = e.origin.replace(/^https?:\/\//, '');
        const date = e.created ? new Date(e.created).toLocaleDateString() : '';
        return `<div class="pwd-entry" data-origin="${_escAttr(e.origin)}" data-user="${_escAttr(e.username)}">
          <div class="pwd-entry-info">
            <span class="pwd-entry-site">${_esc(site)}</span>
            <span class="pwd-entry-user">${_esc(e.username)}</span>
            ${date ? `<span class="pwd-entry-date">${_esc(date)}</span>` : ''}
          </div>
          <button class="pwd-entry-delete" title="Remove" data-origin="${_escAttr(e.origin)}" data-user="${_escAttr(e.username)}">×</button>
        </div>`;
      }).join('');
      container.querySelectorAll('.pwd-entry-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const origin = btn.dataset.origin;
          const username = btn.dataset.user;
          await window.navio.passwordsDelete(origin, username);
          this._renderPasswordList();
        });
      });
    } catch (e) {
      container.innerHTML = `<p class="pwd-list-empty">Could not load passwords: ${e.message}</p>`;
    }
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

    if (this.elements.downloadAskWhere) {
      this.elements.downloadAskWhere.checked = this.config.downloadAskWhere === true;
    }
    if (this.elements.downloadRevealInFolder) {
      this.elements.downloadRevealInFolder.checked = this.config.downloadRevealInFolder === true;
    }

    const scope = this.config.aiDataScope || (this.config.aiIncludePageContext === false ? 'none' : 'excerpt');
    this.elements.aiPageContext.checked = scope !== 'none';
    if (this.elements.aiDataScope) {
      this.elements.aiDataScope.value = ['none', 'selection', 'excerpt', 'full'].includes(scope) ? scope : 'excerpt';
    }
    if (this.elements.aiKillSwitch) this.elements.aiKillSwitch.checked = !!this.config.aiKillSwitch;
    if (this.elements.aiRedact) this.elements.aiRedact.checked = this.config.aiRedactPII !== false;
    if (this.elements.aiStream) this.elements.aiStream.checked = this.config.aiStreamResponses !== false;
    if (this.elements.aiAutoExecute) this.elements.aiAutoExecute.checked = !!this.config.aiAutoExecute;
    if (this.elements.aiAutoScreenshot) {
      this.elements.aiAutoScreenshot.checked = !!this.config.aiAutoScreenshotAfterNavigate;
    }
    if (this.elements.aiAgentStepMode) {
      this.elements.aiAgentStepMode.checked = !!this.config.aiAgentStepMode;
    }
    if (this.elements.aiProactivity) {
      this.elements.aiProactivity.value = this.config.aiProactivity || 'off';
    }
    if (this.elements.mcpEnabled) this.elements.mcpEnabled.checked = !!this.config.mcpEnabled;
    if (this.elements.syncEnabled) this.elements.syncEnabled.checked = !!this.config.syncEnabled;
    if (this.elements.extensionsAI) this.elements.extensionsAI.checked = !!this.config.extensionsAllowAI;
    if (this.elements.formAutofill) this.elements.formAutofill.checked = this.config.formAutofillAssist !== false;
    if (this.elements.adBlock) this.elements.adBlock.checked = this.config.adBlockEnabled !== false;
    if (this.elements.adStrictPopup) {
      this.elements.adStrictPopup.checked = this.config.adStrictPopupBlock !== false;
      this.elements.adStrictPopup.disabled = !!(this.elements.adBlock && !this.elements.adBlock.checked);
    }

    this.elements.provider.value = this.config.aiProvider || 'openai';
    try {
      const k = await window.navio.getApiKeyForSettings();
      this.elements.apiKey.value = k || '';
    } catch {
      this.elements.apiKey.value = '';
    }
    // Known-fake legacy model names from old defaults — silently upgrade
    const LEGACY_FAKE = new Set(['claude-opus-4.6', 'gemini-3.1-pro']);
    const LEGACY_OPENAI_GPT4 = new Set(['gpt-4o', 'gpt-4o-mini']);
    let savedModel = this.config.aiModel || 'gpt-5.4';
    if (LEGACY_FAKE.has(savedModel)) savedModel = 'gpt-5.4';
    if (LEGACY_OPENAI_GPT4.has(savedModel)) savedModel = 'gpt-5.4';

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
    if (this.elements.aiPlannerModel) {
      let planner = this.config.aiPlannerModel || 'gpt-5.4-mini';
      if (LEGACY_OPENAI_GPT4.has(planner)) planner = 'gpt-5.4-mini';
      this.elements.aiPlannerModel.value = planner;
    }
    this.elements.searchEngine.value = this.config.searchEngine || 'https://www.google.com/search?q=';
    this.elements.homepage.value = this.config.homepage || 'https://www.google.com';

    const aw = Number(this.config.assistantWidth);
    const width = Number.isFinite(aw) ? Math.min(560, Math.max(300, aw)) : 420;
    this.elements.assistantWidth.value = String(width);
    this.syncAssistantWidthLabel();

    if (this.elements.tabLayout) {
      this.elements.tabLayout.value = this.config.tabLayout === 'vertical' ? 'vertical' : 'horizontal';
    }
    if (this.elements.bookmarkBar) {
      this.elements.bookmarkBar.checked = this.config.showBookmarkBar !== false;
    }
    if (this.elements.memoryRetention) {
      const d = String(Number(this.config.memoryRetentionDays) || 0);
      const allowed = ['0', '7', '30', '90', '365'];
      this.elements.memoryRetention.value = allowed.includes(d) ? d : '0';
    }

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
    this._refreshSyncSection().catch(() => {});
  }

  async _refreshSyncSection() {
    const disp = document.getElementById('sync-folder-path-display');
    const stEl = document.getElementById('sync-passphrase-status');
    if (disp) {
      disp.textContent = this.config.syncFolderPath
        ? this.config.syncFolderPath
        : '— choose a folder, then Save settings —';
    }
    if (stEl && window.navio.syncGetStatus) {
      try {
        const st = await window.navio.syncGetStatus();
        stEl.textContent = st.hasPassphrase
          ? 'Passphrase is stored on this device. Enter a new one under Profile backup only to replace it.'
          : 'Set a passphrase under Profile backup (min. 4 characters), then Save, before sync can run.';
      } catch {
        stEl.textContent = '';
      }
    }
  }

  _bindCloudSyncControls() {
    const btn = document.getElementById('btn-sync-pick-folder');
    if (btn && !btn._navioBound) {
      btn._navioBound = true;
      btn.addEventListener('click', async () => {
        try {
          const r = await window.navio.syncPickFolder();
          if (r && r.ok && r.path) {
            this.config.syncFolderPath = r.path;
            const disp = document.getElementById('sync-folder-path-display');
            if (disp) disp.textContent = r.path;
          }
        } catch (_) {}
      });
    }
    const runBtn = document.getElementById('btn-sync-run-now');
    if (runBtn && !runBtn._navioBound) {
      runBtn._navioBound = true;
      runBtn.addEventListener('click', async () => {
        try {
          await window.navio.syncRunNow();
          alert('Sync finished.');
        } catch (e) {
          alert(e.message || 'Sync failed');
        }
      });
    }
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
    const defaults = { openai: 'gpt-5.4', anthropic: 'claude-opus-4-5', google: 'gemini-2.0-flash', custom: '__custom__' };
    const currentOption = modelSelect.options[modelSelect.selectedIndex];
    const currentGroupProvider = currentOption?.closest('optgroup')?.getAttribute('data-provider');

    if (!currentGroupProvider || (currentGroupProvider !== provider && provider !== 'custom')) {
      const def = defaults[provider] || 'gpt-5.4';
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
    this._bindMemorySearchFilter();
    this._bindExtensionsSettings();
    this._bindProfilesSettings();
    this._bindSyncButtons();
    this._bindCloudSyncControls();
    this._refreshExtensionsList();
    this._refreshProfilesList();

    // Live ad-blocker toggle (takes effect immediately without Save)
    if (this.elements.adBlock && !this.elements.adBlock._navioAdBlockBound) {
      this.elements.adBlock._navioAdBlockBound = true;
      this.elements.adBlock.addEventListener('change', async () => {
        const enabled = this.elements.adBlock.checked;
        await window.navio.setAdBlocker(enabled);
        if (this.elements.adStrictPopup) {
          this.elements.adStrictPopup.disabled = !enabled;
        }
        this._refreshAdBlockStats();
      });
    }
  }

  async _refreshAdBlockStats() {
    if (!this.elements.adBlockStats) return;
    try {
      const s = await window.navio.getAdBlockStats();
      const status = s.enabled ? 'ON' : 'OFF';
      const pops = typeof s.popupsBlocked === 'number' ? s.popupsBlocked : 0;
      this.elements.adBlockStats.textContent =
        `Status: ${status} · ${s.blocked.toLocaleString()} requests blocked · ${pops.toLocaleString()} ad pop-ups blocked · ${s.domains} domains in blocklist`;
    } catch {
      this.elements.adBlockStats.textContent =
        'Blocks requests and ad pop-up windows from known ad networks, tracking pixels, and data brokers.';
    }
  }

  // ── Browser Memory ──────────────────────────────────────────────────────
  _bindMemorySearchFilter() {
    const inp = this.elements.memorySearchInput;
    if (!inp || inp._bound) return;
    inp._bound = true;
    inp.addEventListener('input', () => this._loadMemoryList());
  }

  async _refreshExtensionsList() {
    const wrap = this.elements.extensionsListSettings;
    if (!wrap || !window.navio.extensionsList) return;
    try {
      const r = await window.navio.extensionsList();
      const loaded = r.loaded || [];
      const persisted = r.persisted || [];
      const enabledById = Object.fromEntries(persisted.map((e) => [e.id, e.enabled !== false]));
      const rows = loaded.map((x) => {
        const on = enabledById[x.id] !== false;
        return `<div class="ext-row ext-row-rich" data-id="${_escAttr(x.id)}">
          <span class="ext-row-title">${_esc(x.name || x.id)}</span>
          <span class="ext-row-actions">
            <label class="ext-toggle"><input type="checkbox" class="ext-enabled" data-id="${_escAttr(x.id)}" ${on ? 'checked' : ''}/> On</label>
            <button type="button" class="btn btn-secondary ext-popup" data-id="${_escAttr(x.id)}">Popup</button>
            <button type="button" class="btn btn-secondary ext-options" data-id="${_escAttr(x.id)}">Options</button>
            <button type="button" class="btn btn-secondary ext-remove" data-id="${_escAttr(x.id)}">Remove</button>
          </span>
        </div>`;
      });
      wrap.innerHTML = rows.length ? rows.join('') : '<p class="settings-inline-hint">No extensions loaded this session.</p>';
      wrap.querySelectorAll('.ext-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await window.navio.extensionsRemove(btn.dataset.id);
          this._refreshExtensionsList();
          if (typeof window.refreshNavioExtensionToolbar === 'function') window.refreshNavioExtensionToolbar();
        });
      });
      wrap.querySelectorAll('.ext-enabled').forEach((cb) => {
        cb.addEventListener('change', async () => {
          await window.navio.extensionsSetEnabled(cb.dataset.id, cb.checked);
          this._refreshExtensionsList();
          if (typeof window.refreshNavioExtensionToolbar === 'function') window.refreshNavioExtensionToolbar();
        });
      });
      wrap.querySelectorAll('.ext-popup').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const res = await window.navio.extensionsOpenPopup(btn.dataset.id);
          if (res && !res.ok && res.error) alert(res.error);
        });
      });
      wrap.querySelectorAll('.ext-options').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const res = await window.navio.extensionsOpenOptions(btn.dataset.id);
          if (res && !res.ok && res.error) alert(res.error);
        });
      });
    } catch {
      wrap.innerHTML = '<p class="settings-inline-hint">Could not list extensions.</p>';
    }
  }

  async _refreshProfilesList() {
    const wrap = this.elements.profilesListSettings;
    if (!wrap || !window.navio.profilesList) return;
    try {
      const r = await window.navio.profilesList();
      const rows = (r.profiles || []).map((p) => {
        const active = p.active ? ' <em>(active)</em>' : '';
        return `<div class="ext-row ext-row-rich"><span>${_esc(p.name || p.id)}${active}</span>
          <button type="button" class="btn btn-secondary profile-switch" data-id="${_escAttr(p.id)}">Switch to…</button></div>`;
      });
      wrap.innerHTML = rows.length ? rows.join('') : '<p class="settings-inline-hint">No profiles.</p>';
      wrap.querySelectorAll('.profile-switch').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Navio will restart to switch profiles. Continue?')) return;
          const res = await window.navio.profilesSetActive(btn.dataset.id);
          if (res && !res.ok && res.error) alert(res.error);
        });
      });
    } catch {
      wrap.innerHTML = '<p class="settings-inline-hint">Could not load profiles.</p>';
    }
  }

  _bindExtensionsSettings() {
    const btn = this.elements.extLoadUnpacked;
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', async () => {
        const r = await window.navio.extensionsLoadUnpacked();
        if (r && r.ok) {
          this._refreshExtensionsList();
          if (typeof window.refreshNavioExtensionToolbar === 'function') window.refreshNavioExtensionToolbar();
          alert('Extension loaded: ' + (r.extension && r.extension.name));
        } else if (r && !r.cancelled) {
          alert(r.error || 'Failed to load extension');
        }
      });
    }
    const ins = this.elements.extInstallCrx;
    if (ins && !ins._bound) {
      ins._bound = true;
      ins.addEventListener('click', async () => {
        const id = (this.elements.extCrxId && this.elements.extCrxId.value.trim()) || '';
        if (!id) {
          alert('Paste the 32-character extension id from the Chrome Web Store URL.');
          return;
        }
        const r = await window.navio.extensionsInstallCrxId(id);
        if (r && r.ok) {
          this._refreshExtensionsList();
          if (typeof window.refreshNavioExtensionToolbar === 'function') window.refreshNavioExtensionToolbar();
          alert('Installed: ' + (r.extension && r.extension.name));
        } else {
          alert((r && r.error) || 'Install failed');
        }
      });
    }
  }

  _bindProfilesSettings() {
    const b = this.elements.profileCreateBtn;
    if (!b || b._bound) return;
    b._bound = true;
    b.addEventListener('click', async () => {
      const id = (this.elements.profileNewId && this.elements.profileNewId.value.trim()) || '';
      if (!id) return;
      const r = await window.navio.profilesCreate(id);
      if (r && r.ok) {
        this.elements.profileNewId.value = '';
        alert('Profile folder created. Use “Switch to…” to open it (restarts Navio).');
        this._refreshProfilesList();
      } else {
        alert((r && r.error) || 'Could not create profile');
      }
    });
  }

  _bindSyncButtons() {
    const ex = this.elements.syncExport;
    const im = this.elements.syncImport;
    const pass = this.elements.syncPassphrase;
    if (ex && !ex._bound) {
      ex._bound = true;
      ex.addEventListener('click', async () => {
        const p = pass && pass.value.length >= 4 ? pass.value : '';
        const r = await window.navio.syncExportProfile({ passphrase: p || undefined });
        if (r && r.ok) alert('Exported to ' + r.path);
        else if (r && !r.cancelled) alert(r.error || 'Export failed');
      });
    }
    if (im && !im._bound) {
      im._bound = true;
      im.addEventListener('click', async () => {
        const p = pass && pass.value.length >= 4 ? pass.value : '';
        const r = await window.navio.syncImportProfile({ passphrase: p || undefined });
        if (r && r.ok) alert(r.message || 'Imported');
        else if (r && !r.cancelled) alert(r.error || 'Import failed');
      });
    }
  }

  async _loadMemoryList() {
    const el = this.elements.memoryList;
    if (!el) return;
    try {
      const q = this.elements.memorySearchInput && this.elements.memorySearchInput.value.trim();
      const mem = q && window.navio.memorySearch ? await window.navio.memorySearch(q) : await window.navio.memoryGet();
      const facts = mem.facts || [];
      if (facts.length === 0) {
        el.innerHTML = '<p class="settings-inline-hint" style="margin:8px 0">No memories saved yet. Navio will learn from your conversations.</p>';
      } else {
        el.innerHTML = facts.map(f => `
          <div class="memory-item" data-id="${f.id}">
            <span class="memory-item-text">${this._esc(f.content)}</span>
            ${f.sourceUrl ? `<div class="memory-item-src"><a href="#" data-url="${_escAttr(f.sourceUrl)}">${this._esc(f.sourceUrl)}</a></div>` : ''}
            <span class="memory-item-type ${f.type === 'auto' ? 'auto' : 'manual'}">${f.type === 'auto' ? 'AI' : 'You'}</span>
            <button class="memory-item-del" data-id="${f.id}" title="Delete">✕</button>
          </div>`).join('');
        el.querySelectorAll('.memory-item-src a').forEach((a) => {
          a.addEventListener('click', (e) => {
            e.preventDefault();
            const u = a.getAttribute('data-url');
            if (u && typeof TabManager !== 'undefined') TabManager.createTab(u);
          });
        });
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
      const cfgKey    = p.configKey;
      const secretKey = p.secretKey || null;
      const currentId  = this.config[cfgKey] || '';
      const currentSec = secretKey ? (this.config[secretKey] || '') : '';
      const secretField = secretKey ? `
          <input
            type="password"
            class="oauth-client-secret-input"
            data-key="${secretKey}"
            placeholder="${p.name} Client Secret"
            value="${currentSec}"
            spellcheck="false"
            autocomplete="off"
          >` : '';
      html += `
        <div class="oauth-provider-row" id="oauth-row-${p.id}">
          <div class="oauth-provider-label">
            <strong>${p.name}</strong>
            <span class="oauth-provider-services">${p.serviceIds.join(', ')}</span>
          </div>
          <div class="oauth-provider-input-row">
            <div class="oauth-credentials-fields">
              <input
                type="text"
                class="oauth-client-id-input"
                data-key="${cfgKey}"
                placeholder="${p.name} Client ID"
                value="${currentId}"
                spellcheck="false"
                autocomplete="off"
              >${secretField}
            </div>
            <button class="oauth-client-id-save-btn" data-key="${cfgKey}" data-secret-key="${secretKey || ''}" data-provider="${p.id}">Save</button>
          </div>
          <div class="oauth-account-status" id="oauth-status-${p.id}">
            <!-- populated by renderOAuthAccountStatus -->
          </div>
          <div class="oauth-provider-hint">
            <a class="oauth-console-link" href="${p.consoleUrl}" target="_blank" data-href="${p.consoleUrl}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Get ${p.name} Client ID &amp; Secret
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
        const key       = btn.dataset.key;
        const secretKey = btn.dataset.secretKey || '';
        const provider  = btn.dataset.provider;
        const input     = container.querySelector(`input[data-key="${key}"]`);
        const secretInput = secretKey ? container.querySelector(`input[data-key="${secretKey}"]`) : null;
        const val       = (input?.value || '').trim();
        const secretVal = secretInput ? (secretInput.value || '').trim() : '';
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        try {
          const savePayload = { [key]: val };
          if (secretKey) savePayload[secretKey] = secretVal;
          await window.navio.saveConfig(savePayload);
          this.config[key] = val;
          if (secretKey) this.config[secretKey] = secretVal;

          // Only open sign-in if both Client ID and Client Secret (if required) are present
          const readyToSignIn = val && (!secretKey || secretVal);
          if (readyToSignIn) {
            // Client ID (+ Secret) saved — immediately open the OAuth sign-in popup.
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

    // Render connected account status + Disconnect button for each provider
    await this._refreshOAuthAccountStatuses(providers);
  }

  async _refreshOAuthAccountStatuses(providers) {
    let tokens = {};
    try { tokens = await window.navio.oauthGetConnectedAccounts(); } catch { return; }

    for (const p of providers) {
      this._renderOAuthProviderStatus(p, tokens[p.id]);
    }
  }

  _renderOAuthProviderStatus(p, account) {
    const statusEl = document.getElementById(`oauth-status-${p.id}`);
    if (!statusEl) return;

    if (account && account.email) {
      // ── Connected state ──────────────────────────────────────────────────
      statusEl.innerHTML = `
        <div class="oauth-connected-row">
          <span class="oauth-connected-indicator">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            Connected as <strong>${account.email}</strong>
          </span>
          <button class="oauth-disconnect-btn" data-provider="${p.id}">Disconnect</button>
        </div>`;

      statusEl.querySelector('.oauth-disconnect-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Disconnecting…';
        try {
          await window.navio.oauthDisconnect(p.id);
          this._renderOAuthProviderStatus(p, null); // switch to disconnected state
        } catch {
          btn.disabled = false;
          btn.textContent = 'Disconnect';
        }
      });

    } else {
      // ── Disconnected state — show Connect button if a Client ID is saved ──
      const container = document.getElementById('oauth-client-id-fields');
      const clientIdInput = container?.querySelector(`input[data-key="${p.configKey}"]`);
      const hasClientId = !!(clientIdInput?.value?.trim() || this.config[p.configKey]);

      if (hasClientId) {
        statusEl.innerHTML = `
          <div class="oauth-disconnected-row">
            <span class="oauth-disconnected-note">Not connected</span>
            <button class="oauth-connect-now-btn" data-provider="${p.id}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Connect
            </button>
          </div>`;

        statusEl.querySelector('.oauth-connect-now-btn').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Connecting…';
          try {
            const result = await window.navio.oauthConnect(p.id);
            if (result?.ok) {
              this._renderOAuthProviderStatus(p, { email: result.email || result.name || 'account' });
            } else {
              btn.disabled = false;
              btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connect`;
              const errEl = document.createElement('div');
              errEl.className = 'oauth-signin-error';
              errEl.style.cssText = 'color:var(--text-danger,#f87171);font-size:12px;margin-top:4px;';
              errEl.textContent = result?.error || 'Sign-in failed — check your Client ID and try again.';
              statusEl.appendChild(errEl);
              setTimeout(() => errEl.remove(), 5000);
            }
          } catch (err) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Connect`;
          }
        });
      } else {
        statusEl.innerHTML = '';
      }
    }
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
    const syncPhraseInput = this.elements.syncPassphrase ? this.elements.syncPassphrase.value.trim() : '';
    if (this.elements.syncEnabled && this.elements.syncEnabled.checked) {
      const folder = String(this.config.syncFolderPath || '').trim();
      let st = { hasPassphrase: false };
      try {
        if (window.navio.syncGetStatus) st = await window.navio.syncGetStatus();
      } catch (_) {}
      if (!folder) {
        alert('Choose a sync folder under Integrations → Sync.');
        return;
      }
      if (!st.hasPassphrase && syncPhraseInput.length < 4) {
        alert('Folder sync needs a passphrase. Enter one under Profile backup (min. 4 characters), then Save.');
        return;
      }
      if (syncPhraseInput.length > 0 && syncPhraseInput.length < 4) {
        alert('Passphrase must be at least 4 characters.');
        return;
      }
    }

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
      showLaunchIntro: !!(this.elements.launchIntro && this.elements.launchIntro.checked),
      downloadAskWhere: !!(this.elements.downloadAskWhere && this.elements.downloadAskWhere.checked),
      downloadRevealInFolder: !!(this.elements.downloadRevealInFolder && this.elements.downloadRevealInFolder.checked),
      defaultZoom,
      aiIncludePageContext: aiDataScope !== 'none',
      aiDataScope,
      mcpServers: Array.isArray(this.config.mcpServers) ? this.config.mcpServers : [],
      aiKillSwitch: !!(this.elements.aiKillSwitch && this.elements.aiKillSwitch.checked),
      aiRedactPII: !!(this.elements.aiRedact && this.elements.aiRedact.checked),
      aiStreamResponses: !!(this.elements.aiStream && this.elements.aiStream.checked),
      aiAutoExecute: !!(this.elements.aiAutoExecute && this.elements.aiAutoExecute.checked),
      aiAutoScreenshotAfterNavigate: !!(this.elements.aiAutoScreenshot && this.elements.aiAutoScreenshot.checked),
      aiAgentStepMode: !!(this.elements.aiAgentStepMode && this.elements.aiAgentStepMode.checked),
      aiProactivity: this.elements.aiProactivity ? this.elements.aiProactivity.value : 'off',
      mcpEnabled: !!(this.elements.mcpEnabled && this.elements.mcpEnabled.checked),
      syncEnabled: !!(this.elements.syncEnabled && this.elements.syncEnabled.checked),
      extensionsAllowAI: !!(this.elements.extensionsAI && this.elements.extensionsAI.checked),
      formAutofillAssist: !!(this.elements.formAutofill && this.elements.formAutofill.checked),
      adBlockEnabled: !!(this.elements.adBlock && this.elements.adBlock.checked),
      adStrictPopupBlock: !!(this.elements.adStrictPopup && this.elements.adStrictPopup.checked),
      aiProvider: this.elements.provider.value,
      apiKey: this.elements.apiKey.value.trim(),
      aiModel: this.elements.model.value === '__custom__'
        ? (this.elements.modelCustom.value.trim() || 'gpt-5.4')
        : this.elements.model.value,
      aiPlannerModel: this.elements.aiPlannerModel
        ? (this.elements.aiPlannerModel.value.trim() || 'gpt-5.4-mini')
        : (this.config.aiPlannerModel || 'gpt-5.4-mini'),
      customEndpoint: this.elements.endpoint.value.trim(),
      searchEngine: this.elements.searchEngine.value,
      homepage: this.elements.homepage.value.trim() || 'https://www.google.com',
      theme: this.selectedTheme || 'dark',
      assistantWidth,
      tabLayout: this.elements.tabLayout ? this.elements.tabLayout.value : 'horizontal',
      showBookmarkBar: !!(this.elements.bookmarkBar && this.elements.bookmarkBar.checked),
      memoryRetentionDays: this.elements.memoryRetention
        ? parseInt(this.elements.memoryRetention.value, 10) || 0
        : 0,
      syncFolderPath: String(this.config.syncFolderPath || '').trim()
    };

    await window.navio.saveConfig(newConfig);

    if (syncPhraseInput.length >= 4 && window.navio.syncSavePassphrase) {
      const pr = await window.navio.syncSavePassphrase({ passphrase: syncPhraseInput });
      if (!pr || !pr.ok) {
        alert((pr && pr.error) || 'Could not save sync passphrase');
      }
    }
    if (this.elements.syncPassphrase) this.elements.syncPassphrase.value = '';

    this.config = { ...(await window.navio.getConfig()) };

    if (newConfig.syncEnabled && window.navio.syncRunNow) {
      try {
        await window.navio.syncRunNow();
      } catch (_) {}
    }

    this._refreshSyncSection().catch(() => {});

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
