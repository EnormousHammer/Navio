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
  ollama: null,
  custom: null
};

/** Short overview shown in the settings content rail (right column). */
const SETTINGS_PANEL_RAIL = {
  general: 'Startup, new tab, Home dashboard corners, display zoom, downloads, tab snooze, and translate defaults.',
  profiles: 'Create and switch profiles so work, personal, and test browsing stay in separate data folders.',
  ai: 'Provider, model, keys, streaming, safety, MCP tools, and how Navio pulls live web or mail context.',
  appearance: 'Theme, accent colorway, tab strip layout, bookmark bar, and how wide the AI assistant dock opens.',
  browser: 'Search engine, homepage, extensions, import, workflows, and troubleshooting helpers.',
  privacy: 'Ad blocking, pop-ups, trackers, cookies, saved AI memory, and clearing site data.',
  integrations: 'OAuth, Gmail sync, Perplexity, Brave Search, MCP servers, and connected services.',
  passwords: 'Saved logins for this profile: review, copy, or remove entries Navio can autofill.',
  about: 'Version, documentation links, update checks, and a compact list of keyboard shortcuts for the shell.'
};

const ABOUT_DOC_LINKS = [
  ['btn-about-doc-privacy', 'https://github.com/EnormousHammer/Navio/blob/main/docs/PRIVACY.md'],
  ['btn-about-doc-security', 'https://github.com/EnormousHammer/Navio/blob/main/docs/SECURITY_THREAT_MODEL.md'],
  ['btn-about-doc-third-party', 'https://github.com/EnormousHammer/Navio/blob/main/docs/THIRD_PARTY_NOTICES.md']
];

class SettingsManagerClass {
  constructor() {
    this.modal = document.getElementById('settings-modal');
    this.config = {};
    this._openedConfig = null;
    this.selectedColorway = 'aurora';

    this.elements = {
      startupMode: document.getElementById('setting-startup-mode'),
      newTabMode: document.getElementById('setting-new-tab-mode'),
      ntpWidgetTL: document.getElementById('setting-ntp-widget-tl'),
      ntpWidgetTR: document.getElementById('setting-ntp-widget-tr'),
      ntpWidgetBL: document.getElementById('setting-ntp-widget-bl'),
      ntpWidgetBR: document.getElementById('setting-ntp-widget-br'),
      ntpNewsSubreddit: document.getElementById('setting-ntp-news-subreddit'),
      downloadAskWhere: document.getElementById('setting-download-ask-where'),
      downloadRevealInFolder: document.getElementById('setting-download-reveal'),
      tabDiscardIdleMinutes: document.getElementById('setting-tab-discard'),
      translateTargetLang: document.getElementById('setting-translate-lang'),
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
      fullMigrationExport: document.getElementById('btn-full-migration-export'),
      fullMigrationExportStatus: document.getElementById('full-migration-export-status'),
      syncImport: document.getElementById('btn-sync-import'),
      syncPassphrase: document.getElementById('sync-passphrase'),
      toggleKey: document.getElementById('btn-toggle-key'),
      themeOptions: document.getElementById('theme-options'),
      accentColorwayOptions: document.getElementById('accent-colorway-options'),
      nav: document.getElementById('settings-nav'),
      clearApiKey: document.getElementById('btn-clear-api-key'),
      clearSiteData: document.getElementById('btn-clear-site-data'),
      clearSiteDataStatus: document.getElementById('clear-site-data-status'),
      aiKillSwitch: document.getElementById('setting-ai-kill-switch'),
      aiDataScope: document.getElementById('setting-ai-data-scope'),
      aiRedact: document.getElementById('setting-ai-redact'),
      aiStream: document.getElementById('setting-ai-stream'),
      aiReasoningEffort: document.getElementById('setting-ai-reasoning-effort'),
      aiAutoExecute: document.getElementById('setting-ai-auto-execute'),
      aiAutoScreenshot: document.getElementById('setting-ai-auto-screenshot'),
      aiAgentStepMode: document.getElementById('setting-ai-agent-step-mode'),
      ttsEnabled: document.getElementById('setting-tts-enabled'),
      ttsVoice: document.getElementById('setting-tts-voice'),
      sttModel: document.getElementById('setting-stt-model'),
      assistantConnectorWeb: document.getElementById('setting-assistant-connector-web'),
      assistantConnectorMail: document.getElementById('setting-assistant-connector-mail'),
      assistantTabDigest: document.getElementById('setting-assistant-tab-digest'),
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
      popupBlocker: document.getElementById('setting-popup-blocker'),
      adBlock: document.getElementById('setting-ad-block'),
      adStrictPopup: document.getElementById('setting-ad-strict-popup'),
      defaultBrowserHosts: document.getElementById('setting-default-browser-hosts'),
      adBlockStats: document.getElementById('ad-block-stats-hint'),
      memoryList: document.getElementById('memory-list'),
      memoryAddInput: document.getElementById('memory-add-input'),
      memoryAddBtn: document.getElementById('memory-add-btn'),
      memoryClearBtn: document.getElementById('memory-clear-btn'),
      memoryRetention: document.getElementById('setting-memory-retention'),
      aiProfileGrid: document.getElementById('ai-profile-grid'),
      extCrxId: document.getElementById('ext-crx-id'),
      extInstallCrx: document.getElementById('btn-ext-install-crx'),
      workflowsListSettings: document.getElementById('settings-workflows-list'),
      btnCheckUpdates: document.getElementById('btn-check-updates'),
      btnInstallUpdate: document.getElementById('btn-install-update'),
      updateStatus: document.getElementById('settings-update-status'),
      profilesListSettings: document.getElementById('profiles-list-settings'),
      profileNewId: document.getElementById('profile-new-id'),
      profileCreateBtn: document.getElementById('btn-profile-create'),
      crashReporting: document.getElementById('setting-crash-reporting'),
      crashReportingRow: document.getElementById('setting-crash-reporting-row'),
      crashReportingHint: document.getElementById('setting-crash-reporting-hint')
    };

    this.panelIds = ['general', 'profiles', 'ai', 'appearance', 'browser', 'privacy', 'integrations', 'passwords', 'about'];

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
      const prov = this.elements.provider.value;
      this.elements.endpointRow.style.display = prov === 'custom' ? 'block' : 'none';
      const ollamaRow = document.getElementById('ollama-detect-row');
      if (ollamaRow) ollamaRow.style.display = prov === 'ollama' ? 'flex' : 'none';
      // Ollama needs no API key
      const apiKeyRow = this.elements.apiKey?.closest('.setting-row');
      if (apiKeyRow) apiKeyRow.style.opacity = prov === 'ollama' ? '0.4' : '';
      if (prov === 'ollama') {
        this.elements.apiKey.placeholder = 'No API key required for Ollama';
      } else {
        this.elements.apiKey.placeholder = 'Enter your API key…';
      }
      this.updateModelOptions();
      this.updateProviderHint();
    });

    this.elements.model.addEventListener('change', () => {
      this._syncModelCustomUI();
    });

    document.getElementById('btn-model-back-presets')?.addEventListener('click', () => {
      const provider = this.elements.provider.value;
      const defaults = { openai: 'gpt-5.4', anthropic: 'claude-opus-4-5', google: 'gemini-2.0-flash', ollama: 'llama3.2', custom: '__custom__' };
      this.elements.model.value = defaults[provider] || 'gpt-5.4';
      this._syncModelCustomUI();
    });

    document.getElementById('btn-ollama-detect')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-ollama-detect');
      const hint = document.getElementById('ollama-detect-hint');
      if (btn) { btn.disabled = true; btn.textContent = 'Detecting…'; }
      if (hint) hint.textContent = '';
      try {
        const result = await window.navio.ollamaDetect();
        if (result && result.ok && result.models && result.models.length) {
          // Rebuild the Ollama optgroup with detected models
          const optgroup = this.elements.model.querySelector('optgroup[data-provider="ollama"]');
          if (optgroup) {
            optgroup.innerHTML = result.models
              .map(m => `<option value="${_escAttr(m)}">${_esc(m)}</option>`)
              .join('') + '<option value="__custom__">Enter model name…</option>';
          }
          if (this.elements.provider.value === 'ollama') {
            this.elements.model.value = result.models[0];
            this._syncModelCustomUI();
          }
          if (hint) hint.textContent = `Found ${result.models.length} model${result.models.length === 1 ? '' : 's'}: ${result.models.slice(0,3).join(', ')}${result.models.length > 3 ? '…' : ''}`;
        } else {
          if (hint) hint.textContent = result?.error || 'Ollama not found. Make sure it is running (ollama serve).';
        }
      } catch (e) {
        if (hint) hint.textContent = 'Error: ' + (e.message || String(e));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Detect Ollama models'; }
      }
    });

    this.elements.toggleKey.addEventListener('click', () => {
      const input = this.elements.apiKey;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    this._inferKeyDebounce = null;
    this.elements.apiKey.addEventListener('input', () => {
      if (this._inferKeyDebounce) clearTimeout(this._inferKeyDebounce);
      this._inferKeyDebounce = setTimeout(() => this._maybeInferProviderFromKeyField(), 400);
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

    if (this.elements.accentColorwayOptions) {
      const allowedCw = new Set(['aurora', 'ocean', 'ember', 'forest', 'magenta', 'slate']);
      this.elements.accentColorwayOptions.querySelectorAll('.colorway-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          const raw = (btn.dataset.colorway || 'aurora').trim().toLowerCase();
          const id = allowedCw.has(raw) ? raw : 'aurora';
          this.elements.accentColorwayOptions.querySelectorAll('.colorway-option').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          this.selectedColorway = id;
          if (typeof App !== 'undefined' && App.applyColorway) App.applyColorway(id);
        });
      });
    }

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

    const navSearch = document.getElementById('settings-nav-search');
    if (navSearch) {
      navSearch.addEventListener('input', () => this._filterSettingsNav());
      navSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const visible = [...this.elements.nav.querySelectorAll('.settings-nav-item')].filter(
            (el) => el.style.display !== 'none'
          );
          const first = visible[0];
          if (first && first.dataset.panel) {
            this.showPanel(first.dataset.panel);
            if (first.dataset.panel === 'passwords') this._renderPasswordList();
          }
        }
      });
    }

    // Password manager — export
    document.getElementById('btn-pwd-export')?.addEventListener('click', async () => {
      try {
        const r = await window.navio.passwordsExportCsv();
        if (!r.ok) {
          if (r.error === 'cancelled') return;
          alert('Export failed: ' + r.error);
          return;
        }
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

    for (const [btnId, href] of ABOUT_DOC_LINKS) {
      const docBtn = document.getElementById(btnId);
      if (docBtn && !docBtn._navioBound) {
        docBtn._navioBound = true;
        docBtn.addEventListener('click', () => {
          window.navio.openExternal(href).catch(() => {});
        });
      }
    }

    if (this.elements.btnCheckUpdates && !this.elements.btnCheckUpdates._navioBound) {
      this.elements.btnCheckUpdates._navioBound = true;
      this.elements.btnCheckUpdates.addEventListener('click', async () => {
        const st = this.elements.updateStatus;
        if (st) st.textContent = 'Checking…';
        try {
          const r = await window.navio.checkForUpdates();
          if (st) st.textContent = r && r.message ? r.message : '';
          if (r && r.ok === false && r.message) alert(r.message);
        } catch (e) {
          if (st) st.textContent = '';
          alert(e.message || String(e));
        }
      });
    }

    if (this.elements.btnInstallUpdate && !this.elements.btnInstallUpdate._navioBound) {
      this.elements.btnInstallUpdate._navioBound = true;
      this.elements.btnInstallUpdate.addEventListener('click', async () => {
        if (!confirm('Navio will restart to install the update. Continue?')) return;
        try {
          const r = await window.navio.installUpdate();
          if (r && r.ok === false && r.message) alert(r.message);
        } catch (e) {
          alert(e.message || String(e));
        }
      });
    }

    this._applyUpdateState = (state) => {
      const st = this.elements.updateStatus;
      const btn = this.elements.btnInstallUpdate;
      if (!state) return;
      if (st && state.message) st.textContent = state.message;
      if (btn) {
        const ready = state.status === 'ready';
        btn.style.display = ready ? '' : 'none';
        btn.disabled = !ready;
      }
    };

    if (typeof window.navio?.getUpdateStatus === 'function' && !this._navioUpdateInit) {
      this._navioUpdateInit = true;
      window.navio.getUpdateStatus().then((r) => {
        if (r && r.state) this._applyUpdateState(r.state);
      }).catch(() => { /* ignore */ });
      if (typeof window.navio.onUpdateStatusChanged === 'function') {
        window.navio.onUpdateStatusChanged((state) => this._applyUpdateState(state));
      }
    }
  }

  _filterSettingsNav() {
    const inp = document.getElementById('settings-nav-search');
    if (!inp || !this.elements.nav) return;
    const q = inp.value.trim().toLowerCase();
    const items = this.elements.nav.querySelectorAll('.settings-nav-item');
    let firstVisible = null;
    items.forEach((btn) => {
      const panel = btn.dataset.panel || '';
      const kw = (btn.dataset.search || '') + ' ' + panel + ' ' + (btn.querySelector('span')?.textContent || '');
      const match = !q || kw.toLowerCase().includes(q);
      btn.style.display = match ? '' : 'none';
      if (match && !firstVisible) firstVisible = btn;
    });
    if (q && !firstVisible) {
      items.forEach((btn) => { btn.style.display = ''; });
    }
    const active = this.elements.nav.querySelector('.settings-nav-item.active');
    if (active && active.style.display === 'none' && firstVisible) {
      this.showPanel(firstVisible.dataset.panel);
    }
  }

  showPanel(panelId) {
    if (!this.panelIds.includes(panelId)) return;

    const navBtn = this.elements.nav.querySelector(`.settings-nav-item[data-panel="${panelId}"]`);
    const pageTitle = document.getElementById('settings-page-title');
    const navLabel = navBtn
      ? (() => {
          const span = navBtn.querySelector('span');
          return span ? String(span.textContent).trim() : '';
        })()
      : '';
    if (pageTitle) pageTitle.textContent = navLabel || panelId;

    const railKicker = document.getElementById('settings-pane-rail-kicker');
    const railBody = document.getElementById('settings-pane-rail-body');
    if (railKicker) railKicker.textContent = navLabel || panelId;
    if (railBody) railBody.textContent = SETTINGS_PANEL_RAIL[panelId] || '';

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
      // Group rows by origin, ordered: visible entries first, then any hidden/managed ones.
      const entries = r.entries.slice().sort((a, b) => {
        const ho = Number(!!a.hidden) - Number(!!b.hidden);
        if (ho !== 0) return ho;
        return String(a.origin).localeCompare(String(b.origin));
      });
      const eyeOpenSvg  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      const eyeOffSvg   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.5 19.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.5 19.5 0 0 1-3.17 4.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      const copySvg     = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      const trashSvg    = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';

      container.innerHTML = entries.map((e) => {
        const site = e.origin.replace(/^https?:\/\//, '');
        const date = e.created ? new Date(e.created).toLocaleDateString() : '';
        const hiddenBadge = e.hidden
          ? '<span class="pwd-entry-badge" title="Managed by Navio (auto-fill only)">Managed</span>'
          : '';
        return `<div class="pwd-entry" data-origin="${_escAttr(e.origin)}" data-user="${_escAttr(e.username)}">
          <div class="pwd-entry-row">
            <div class="pwd-entry-info">
              <span class="pwd-entry-site">${_esc(site)}</span>
              <span class="pwd-entry-user">${_esc(e.username)}</span>
              ${hiddenBadge}
              ${date ? `<span class="pwd-entry-date">${_esc(date)}</span>` : ''}
            </div>
            <div class="pwd-entry-actions">
              <input class="pwd-entry-pwd" type="password" value="••••••••••" readonly tabindex="-1" aria-label="Password">
              <button class="pwd-entry-btn pwd-entry-toggle" title="Show password" aria-label="Show password" data-shown="0">${eyeOpenSvg}</button>
              <button class="pwd-entry-btn pwd-entry-copy"   title="Copy password" aria-label="Copy password">${copySvg}</button>
              <button class="pwd-entry-btn pwd-entry-delete" title="Remove" aria-label="Remove">${trashSvg}</button>
            </div>
          </div>
        </div>`;
      }).join('');

      /** @returns {Promise<string|null>} password, empty string on error, null if user cancelled reveal dialog */
      const _ensurePwd = async (row) => {
        if (row.dataset.pwdLoaded === '1') return row.dataset.pwd || '';
        const r2 = await window.navio.passwordsReveal(row.dataset.origin, row.dataset.user);
        if (!r2 || !r2.ok) {
          if (r2 && r2.error === 'cancelled') return null;
          row.dataset.pwdError = r2 && r2.error ? r2.error : 'unknown error';
          return '';
        }
        row.dataset.pwd = r2.password || '';
        row.dataset.pwdLoaded = '1';
        return row.dataset.pwd;
      };

      container.querySelectorAll('.pwd-entry').forEach((row) => {
        const input  = row.querySelector('.pwd-entry-pwd');
        const toggle = row.querySelector('.pwd-entry-toggle');
        const copy   = row.querySelector('.pwd-entry-copy');
        const del    = row.querySelector('.pwd-entry-delete');

        toggle.addEventListener('click', async () => {
          const shown = toggle.dataset.shown === '1';
          if (shown) {
            input.type = 'password';
            input.value = '••••••••••';
            toggle.dataset.shown = '0';
            toggle.title = 'Show password';
            toggle.setAttribute('aria-label', 'Show password');
            toggle.innerHTML = eyeOpenSvg;
          } else {
            const pwd = await _ensurePwd(row);
            if (pwd === null) return;
            if (!pwd) {
              input.type = 'text';
              input.value = `(unable to decrypt: ${row.dataset.pwdError || 'no key'})`;
            } else {
              input.type = 'text';
              input.value = pwd;
            }
            toggle.dataset.shown = '1';
            toggle.title = 'Hide password';
            toggle.setAttribute('aria-label', 'Hide password');
            toggle.innerHTML = eyeOffSvg;
          }
        });

        copy.addEventListener('click', async () => {
          const pwd = await _ensurePwd(row);
          if (pwd === null || !pwd) return;
          try {
            await navigator.clipboard.writeText(pwd);
            const orig = copy.title;
            copy.title = 'Copied!';
            copy.classList.add('pwd-entry-btn-ok');
            setTimeout(() => {
              copy.title = orig;
              copy.classList.remove('pwd-entry-btn-ok');
            }, 1100);
          } catch { /* clipboard blocked */ }
        });

        del.addEventListener('click', async () => {
          if (!confirm(`Remove saved password for ${row.dataset.user} on ${row.dataset.origin}?`)) return;
          await window.navio.passwordsDelete(row.dataset.origin, row.dataset.user);
          this._renderPasswordList();
        });
      });
    } catch (e) {
      while (container.firstChild) container.removeChild(container.firstChild);
      const p = document.createElement('p');
      p.className = 'pwd-list-empty';
      p.textContent = `Could not load passwords: ${e && e.message ? e.message : String(e)}`;
      container.appendChild(p);
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
    if (prov === 'ollama') {
      el.innerHTML = '🔒 <strong>100% local</strong> — no data leaves your device. Requires <a href="#" data-external-href="https://ollama.com">Ollama</a> running locally (<code>ollama serve</code>). Use the Detect button to populate installed models.';
      const a = el.querySelector('a');
      if (a) a.addEventListener('click', (e) => { e.preventDefault(); if (typeof TabManager !== 'undefined') TabManager.createTab('https://ollama.com'); });
      return;
    }
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

    if (this.elements.newTabMode) {
      const mode = String(this.config.newTabMode || 'home');
      this.elements.newTabMode.value = ['home', 'chat', 'blank'].includes(mode) ? mode : 'home';
    }
    const WOPTS = ['inbox', 'news', 'stocks', 'sports', 'none'];
    const _ntpSel = (el, cfgKey, fallback) => {
      if (!el) return;
      const v = String(this.config[cfgKey] || fallback).toLowerCase();
      el.value = WOPTS.includes(v) ? v : fallback;
    };
    _ntpSel(this.elements.ntpWidgetTL, 'ntpWidgetTL', 'inbox');
    _ntpSel(this.elements.ntpWidgetTR, 'ntpWidgetTR', 'news');
    _ntpSel(this.elements.ntpWidgetBL, 'ntpWidgetBL', 'stocks');
    _ntpSel(this.elements.ntpWidgetBR, 'ntpWidgetBR', 'sports');
    if (this.elements.ntpNewsSubreddit) {
      const sub = String(this.config.ntpNewsSubreddit || 'worldnews')
        .trim()
        .toLowerCase()
        .replace(/^r\//, '');
      const allowed = ['worldnews', 'news', 'technology', 'sports', 'business', 'science'];
      this.elements.ntpNewsSubreddit.value = allowed.includes(sub) ? sub : 'worldnews';
    }

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
    if (this.elements.tabDiscardIdleMinutes) {
      const m = Number(this.config.tabDiscardIdleMinutes) || 0;
      const allowed = ['0', '15', '30', '60', '120'];
      this.elements.tabDiscardIdleMinutes.value = allowed.includes(String(m)) ? String(m) : '0';
    }
    if (this.elements.translateTargetLang) {
      this.elements.translateTargetLang.value = String(this.config.translateTargetLang || '').trim();
    }

    const scope = this.config.aiDataScope || (this.config.aiIncludePageContext === false ? 'none' : 'excerpt');
    this.elements.aiPageContext.checked = scope !== 'none';
    if (this.elements.aiDataScope) {
      this.elements.aiDataScope.value = ['none', 'selection', 'excerpt', 'full'].includes(scope) ? scope : 'excerpt';
    }
    if (this.elements.aiKillSwitch) this.elements.aiKillSwitch.checked = !!this.config.aiKillSwitch;
    if (this.elements.aiRedact) this.elements.aiRedact.checked = this.config.aiRedactPII !== false;
    if (this.elements.aiStream) this.elements.aiStream.checked = this.config.aiStreamResponses !== false;
    if (this.elements.aiReasoningEffort) {
      const eff = String(this.config.aiReasoningEffort || 'auto').toLowerCase();
      this.elements.aiReasoningEffort.value = ['auto', 'off', 'low', 'medium', 'high'].includes(eff) ? eff : 'auto';
    }
    if (this.elements.aiAutoExecute) this.elements.aiAutoExecute.checked = !!this.config.aiAutoExecute;
    if (this.elements.aiAutoScreenshot) {
      this.elements.aiAutoScreenshot.checked = !!this.config.aiAutoScreenshotAfterNavigate;
    }
    if (this.elements.aiAgentStepMode) {
      this.elements.aiAgentStepMode.checked = !!this.config.aiAgentStepMode;
    }
    if (this.elements.ttsEnabled) {
      this.elements.ttsEnabled.checked = !!this.config.ttsEnabled;
    }
    if (this.elements.ttsVoice && typeof window.navioPopulateTtsVoiceSelect === 'function') {
      window.navioPopulateTtsVoiceSelect(this.elements.ttsVoice, this.config.ttsVoice);
    }
    if (this.elements.sttModel) {
      const allowed = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];
      const v = allowed.includes(this.config.sttModel) ? this.config.sttModel : 'whisper-1';
      this.elements.sttModel.value = v;
    }
    if (this.elements.assistantConnectorWeb) {
      const w = this.config.assistantConnectorWeb || 'auto';
      this.elements.assistantConnectorWeb.value = ['auto', 'always', 'never'].includes(w) ? w : 'auto';
    }
    if (this.elements.assistantConnectorMail) {
      const mail = this.config.assistantConnectorMail || 'auto';
      this.elements.assistantConnectorMail.value = ['auto', 'always', 'never'].includes(mail) ? mail : 'auto';
    }
    if (this.elements.assistantTabDigest) {
      this.elements.assistantTabDigest.checked = !!this.config.assistantTabDigest;
    }
    if (this.elements.aiProactivity) {
      this.elements.aiProactivity.value = this.config.aiProactivity || 'off';
    }
    if (this.elements.mcpEnabled) this.elements.mcpEnabled.checked = !!this.config.mcpEnabled;
    if (this.elements.syncEnabled) this.elements.syncEnabled.checked = !!this.config.syncEnabled;
    if (this.elements.extensionsAI) this.elements.extensionsAI.checked = !!this.config.extensionsAllowAI;
    if (this.elements.formAutofill) this.elements.formAutofill.checked = this.config.formAutofillAssist !== false;
    if (this.elements.popupBlocker) this.elements.popupBlocker.checked = this.config.popupBlockerEnabled !== false;
    if (this.elements.adBlock) this.elements.adBlock.checked = this.config.adBlockEnabled !== false;
    if (this.elements.adStrictPopup) {
      this.elements.adStrictPopup.checked = this.config.adStrictPopupBlock !== false;
      this.elements.adStrictPopup.disabled = !!(this.elements.popupBlocker && !this.elements.popupBlocker.checked);
    }
    if (this.elements.defaultBrowserHosts) {
      const lines = Array.isArray(this.config.defaultBrowserHostLines) ? this.config.defaultBrowserHostLines : [];
      this.elements.defaultBrowserHosts.value = lines.join('\n');
    }

    if (this.elements.crashReporting) {
      const avail = this.config.crashReportingAvailable === true;
      this.elements.crashReporting.disabled = !avail;
      this.elements.crashReporting.checked = avail && !!this.config.crashReportingEnabled;
      if (this.elements.crashReportingHint) {
        this.elements.crashReportingHint.textContent = avail
          ? 'When enabled, uncaught errors may be sent to our diagnostics service (Sentry). No API keys or page content are included by default.'
          : 'Not available in this build. Set environment variable NAVIO_SENTRY_DSN before starting Navio to enable this option.';
      }
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
    // Show/hide Ollama detect row based on current provider
    const ollamaRow = document.getElementById('ollama-detect-row');
    if (ollamaRow) ollamaRow.style.display = (this.config.aiProvider === 'ollama') ? 'flex' : 'none';
    if (this.config.aiProvider === 'ollama') {
      this.elements.apiKey.placeholder = 'No API key required for Ollama';
      const apiKeyRow = this.elements.apiKey?.closest('.setting-row');
      if (apiKeyRow) apiKeyRow.style.opacity = '0.4';
    }
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

    const allowedCw = new Set(['aurora', 'ocean', 'ember', 'forest', 'magenta', 'slate']);
    const cwRaw = String(this.config.accentColorway || 'aurora').trim().toLowerCase();
    this.selectedColorway = allowedCw.has(cwRaw) ? cwRaw : 'aurora';
    if (this.elements.accentColorwayOptions) {
      this.elements.accentColorwayOptions.querySelectorAll('.colorway-option').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.colorway === this.selectedColorway);
      });
    }

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
      const list = await window.navio.mcpConfig({ op: 'list-tools' });
      const g = await window.navio.mcpConfig({ op: 'get' });
      const n = (list.tools || []).length;
      const srv = Array.isArray(g?.servers) ? g.servers.length : 0;
      if (!g?.enabled) {
        el.textContent = 'MCP is off. Enable above and configure servers (stdio/SSE) to expose tools to the agent.';
        return;
      }
      el.textContent =
        n > 0
          ? `${n} MCP tool(s) loaded · ${srv} server(s) in config (@modelcontextprotocol/sdk).`
          : 'MCP enabled — no tools yet. Check server command/URL and that the process starts correctly.';
    } catch {
      el.textContent = '';
    }
  }

  /**
   * While typing an API key, switch Provider to match recognizable key shapes
   * (OpenAI sk-…, Anthropic sk-ant-…, Google AIza…). Skipped for custom / Ollama.
   */
  async _maybeInferProviderFromKeyField() {
    if (!window.navio || typeof window.navio.inferAiProviderFromApiKey !== 'function') return;
    const raw = this.elements.apiKey.value.trim();
    if (raw.length < 12) return;
    const prov = this.elements.provider.value;
    if (prov === 'custom' || prov === 'ollama') return;
    let inferred;
    try {
      inferred = await window.navio.inferAiProviderFromApiKey(raw);
    } catch {
      return;
    }
    if (!inferred || inferred === prov) return;
    this.elements.provider.value = inferred;
    this.elements.provider.dispatchEvent(new Event('change'));
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
    const defaults = { openai: 'gpt-5.4', anthropic: 'claude-opus-4-5', google: 'gemini-2.0-flash', ollama: 'llama3.2', custom: '__custom__' };
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

  async open(initialPanel = 'general') {
    await this.loadConfig();
    this._openedConfig = JSON.parse(JSON.stringify(this.config));
    if (this.elements.clearSiteDataStatus) this.elements.clearSiteDataStatus.textContent = '';
    if (this.elements.ledgerStatus) this.elements.ledgerStatus.textContent = '';
    const navSearch = document.getElementById('settings-nav-search');
    if (navSearch) {
      navSearch.value = '';
      this._filterSettingsNav();
    }
    const panel = this.panelIds.includes(initialPanel) ? initialPanel : 'general';
    this.showPanel(panel);
    this.modal.classList.add('visible');
    try {
      window.navioEnsureShellOnTopIfWcv?.();
    } catch {
      /* ignore */
    }
    this._renderOAuthClientIdFields();
    this._refreshAdBlockStats();
    this._loadMemoryList();
    this._bindProfileGrid();
    this._bindMemorySearchFilter();
    this._bindExtensionsSettings();
    this._bindProfilesSettings();
    this._bindSyncButtons();
    this._bindFullMigrationExport();
    this._bindCloudSyncControls();
    this._refreshExtensionsList();
    this._refreshWorkflowsList();
    this._refreshProfilesList();

    // Live ad-blocker toggle (takes effect immediately without Save)
    if (this.elements.popupBlocker && !this.elements.popupBlocker._navioPopupBound) {
      this.elements.popupBlocker._navioPopupBound = true;
      this.elements.popupBlocker.addEventListener('change', async () => {
        const on = this.elements.popupBlocker.checked;
        await window.navio.saveConfig({ popupBlockerEnabled: on });
        if (this.elements.adStrictPopup) {
          this.elements.adStrictPopup.disabled = !on;
        }
        this._refreshAdBlockStats();
      });
    }
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
      const failed = r.failed || [];
      const enabledById = Object.fromEntries(persisted.map((e) => [e.id, e.enabled !== false]));
      const failedById = Object.fromEntries(failed.map((f) => [f.id, f.error]));

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

      // Show failed-to-load extensions with a warning badge
      const failedRows = failed.map((f) => {
        const name = persisted.find((p) => p.id === f.id)?.path?.split(/[\\/]/).pop() || f.id;
        return `<div class="ext-row ext-row-rich ext-row-failed" data-id="${_escAttr(f.id)}" title="${_escAttr(f.error)}">
          <span class="ext-row-title">
            <span class="ext-error-badge" aria-label="Load failed">&#9888;</span>
            ${_esc(name)}
          </span>
          <span class="ext-row-error-msg">${_esc(f.error)}</span>
          <span class="ext-row-actions">
            <button type="button" class="btn btn-secondary ext-remove" data-id="${_escAttr(f.id)}">Remove</button>
          </span>
        </div>`;
      });

      const allRows = [...rows, ...failedRows];
      wrap.innerHTML = allRows.length ? allRows.join('') : '<p class="settings-inline-hint">No extensions loaded this session.</p>';
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

  async _refreshWorkflowsList() {
    const wrap = this.elements.workflowsListSettings;
    if (!wrap || !window.navio.workflowList) return;
    try {
      const r = await window.navio.workflowList();
      const workflows = r.workflows || [];
      wrap.innerHTML = workflows.length
        ? workflows
            .map((wf) => {
              const n = wf.name || 'Workflow';
              const steps = Array.isArray(wf.steps) ? wf.steps.length : 0;
              return `<div class="ext-row ext-row-rich wf-row">
          <span class="ext-row-title">${_esc(n)} <span class="text-muted">(${steps} steps)</span></span>
          <span class="ext-row-actions">
            <button type="button" class="btn btn-secondary wf-run">Run</button>
            <button type="button" class="btn btn-secondary wf-del">Delete</button>
          </span>
        </div>`;
            })
            .join('')
        : '<p class="settings-inline-hint">No saved workflows yet. After the assistant runs several tool steps, you may see an offer to save them.</p>';
      const rows = wrap.querySelectorAll('.wf-row');
      workflows.forEach((wf, i) => {
        const row = rows[i];
        if (!row) return;
        row.querySelector('.wf-run')?.addEventListener('click', () => {
          if (typeof AssistantManager === 'undefined') return;
          if (!Array.isArray(wf.steps) || !wf.steps.length) {
            alert('This workflow has no steps.');
            return;
          }
          AssistantManager.runWorkflowFromCommandPalette(wf);
          this.close(true);
        });
        row.querySelector('.wf-del')?.addEventListener('click', async () => {
          const delKey = wf.name && String(wf.name).trim() ? wf.name : wf.id;
          if (!delKey || !confirm(`Delete workflow "${wf.name || delKey}"?`)) return;
          const res = await window.navio.workflowDelete({ name: delKey });
          if (res && !res.ok && res.error) alert(res.error);
          this._refreshWorkflowsList();
        });
      });
    } catch {
      wrap.innerHTML = '<p class="settings-inline-hint">Could not load workflows.</p>';
    }
  }

  async _refreshProfilesList() {
    const wrap = this.elements.profilesListSettings;
    if (!wrap || !window.navio.profilesList) return;
    try {
      const r = await window.navio.profilesList();
      const rows = (r.profiles || []).map((p) => {
        const name = p.name || p.id;
        const active = !!p.active;
        return `<div class="profile-settings-row${active ? ' profile-settings-row-active' : ''}">
          <div class="profile-settings-row-main">
            <span class="profile-settings-name">${_esc(name)}</span>
            <span class="profile-settings-id">${_esc(p.id)}</span>
            ${active ? '<span class="profile-settings-badge">Active</span>' : ''}
          </div>
          <button type="button" class="btn ${active ? 'btn-secondary' : 'btn-primary'} btn-sm profile-switch" data-id="${_escAttr(p.id)}" ${active ? 'disabled' : ''}>${active ? 'Current profile' : 'Switch to this profile'}</button>
        </div>`;
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

  _bindFullMigrationExport() {
    const btn = this.elements.fullMigrationExport;
    const status = this.elements.fullMigrationExportStatus;
    if (!btn || btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', async () => {
      if (
        !confirm(
          'Export a migration folder (with ALL secrets in plaintext: API keys, OAuth, passwords)? Pick a parent directory — Navio creates navio-browser-migration-… inside it. Only continue if you will protect or delete that folder after import.'
        )
      ) {
        return;
      }
      if (status) status.textContent = 'Exporting…';
      try {
        const r = await window.navio.exportFullMigration();
        if (r && r.ok) {
          if (status) status.textContent = 'Folder: ' + r.path;
          alert('Migration folder:\n' + r.path + '\n\nDelete the whole folder after you import it into your new app.');
        } else if (r && r.cancelled) {
          if (status) status.textContent = '';
        } else {
          if (status) status.textContent = '';
          alert((r && r.error) || 'Export failed');
        }
      } catch (e) {
        if (status) status.textContent = '';
        alert(e && e.message ? e.message : String(e));
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
        // Must scope to this row: google + google_2 share the same configKey/secretKey;
        // container.querySelector would always read the first row and could wipe the secret
        // when saving from the "2nd account" row (empty password field on the first row).
        const row = btn.closest('.oauth-provider-row');
        const input = row?.querySelector(`input[data-key="${key}"]`);
        const secretInput = secretKey ? row?.querySelector(`input[data-key="${secretKey}"]`) : null;
        const val       = (input?.value || '').trim();
        const secretVal = secretInput ? (secretInput.value || '').trim() : '';
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        try {
          const savePayload = { [key]: val };
          if (secretKey) {
            const existingSecret = (this.config[secretKey] || '').trim();
            if (secretVal) {
              savePayload[secretKey] = secretVal;
            } else if (!existingSecret) {
              savePayload[secretKey] = '';
            }
            // else: omit secretKey — blank password fields are normal; avoid wiping the
            // stored secret when saving Client ID from the duplicate Google / Google (2nd) row.
          }
          await window.navio.saveConfig(savePayload);
          try {
            const merged = await window.navio.getConfig();
            Object.assign(this.config, merged);
          } catch {
            this.config[key] = val;
            if (secretKey && Object.prototype.hasOwnProperty.call(savePayload, secretKey)) {
              this.config[secretKey] = savePayload[secretKey];
            }
          }
          // Keep duplicate rows (same configKey, e.g. Google + Google 2nd) in sync in the DOM.
          container.querySelectorAll(`input[data-key="${key}"]`).forEach((el) => {
            el.value = (this.config[key] || '').trim();
          });
          if (secretKey && secretVal) {
            container.querySelectorAll(`input[data-key="${secretKey}"]`).forEach((el) => {
              el.value = secretVal;
            });
          }

          // Open sign-in when Client ID is set and either a new secret was entered, a secret
          // already exists on disk (blank password fields are normal), or no secret is required.
          const secretOnDisk = secretKey ? String(this.config[secretKey] || '').trim() : '';
          const readyToSignIn =
            !!val && (!secretKey || !!secretVal || !!secretOnDisk);
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
              const providerRow = btn.closest('.oauth-provider-row');
              // Remove any previous error
              providerRow?.querySelector('.oauth-signin-error')?.remove();
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
      const row = statusEl.closest('.oauth-provider-row');
      const clientIdInput = row?.querySelector(`input[data-key="${p.configKey}"]`);
      const hasClientId = !!(
        (clientIdInput?.value || '').trim() ||
        (this.config[p.configKey] || '').trim()
      );

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
        if (App.applyColorway) App.applyColorway(this.config.accentColorway || 'aurora');
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
      newTabMode: (() => {
        const v = this.elements.newTabMode ? String(this.elements.newTabMode.value || '').trim() : '';
        return ['home', 'chat', 'blank'].includes(v) ? v : 'home';
      })(),
      ntpWidgetTL: (() => {
        const v = this.elements.ntpWidgetTL ? String(this.elements.ntpWidgetTL.value || '').trim() : '';
        return ['inbox', 'news', 'stocks', 'sports', 'none'].includes(v) ? v : 'inbox';
      })(),
      ntpWidgetTR: (() => {
        const v = this.elements.ntpWidgetTR ? String(this.elements.ntpWidgetTR.value || '').trim() : '';
        return ['inbox', 'news', 'stocks', 'sports', 'none'].includes(v) ? v : 'news';
      })(),
      ntpWidgetBL: (() => {
        const v = this.elements.ntpWidgetBL ? String(this.elements.ntpWidgetBL.value || '').trim() : '';
        return ['inbox', 'news', 'stocks', 'sports', 'none'].includes(v) ? v : 'stocks';
      })(),
      ntpWidgetBR: (() => {
        const v = this.elements.ntpWidgetBR ? String(this.elements.ntpWidgetBR.value || '').trim() : '';
        return ['inbox', 'news', 'stocks', 'sports', 'none'].includes(v) ? v : 'sports';
      })(),
      ntpNewsSubreddit: (() => {
        const raw = this.elements.ntpNewsSubreddit ? String(this.elements.ntpNewsSubreddit.value || '').trim() : '';
        const sub = raw.toLowerCase().replace(/^r\//, '');
        const allowed = ['worldnews', 'news', 'technology', 'sports', 'business', 'science'];
        return allowed.includes(sub) ? sub : 'worldnews';
      })(),
      showLaunchIntro: false,
      downloadAskWhere: !!(this.elements.downloadAskWhere && this.elements.downloadAskWhere.checked),
      downloadRevealInFolder: !!(this.elements.downloadRevealInFolder && this.elements.downloadRevealInFolder.checked),
      tabDiscardIdleMinutes: this.elements.tabDiscardIdleMinutes
        ? parseInt(this.elements.tabDiscardIdleMinutes.value, 10) || 0
        : 0,
      translateTargetLang: this.elements.translateTargetLang
        ? this.elements.translateTargetLang.value.trim().slice(0, 16)
        : (this.config.translateTargetLang || ''),
      defaultZoom,
      aiIncludePageContext: aiDataScope !== 'none',
      aiDataScope,
      mcpServers: Array.isArray(this.config.mcpServers) ? this.config.mcpServers : [],
      aiKillSwitch: !!(this.elements.aiKillSwitch && this.elements.aiKillSwitch.checked),
      aiRedactPII: !!(this.elements.aiRedact && this.elements.aiRedact.checked),
      aiStreamResponses: !!(this.elements.aiStream && this.elements.aiStream.checked),
      aiReasoningEffort: this.elements.aiReasoningEffort
        ? (['auto', 'off', 'low', 'medium', 'high'].includes(this.elements.aiReasoningEffort.value) ? this.elements.aiReasoningEffort.value : 'auto')
        : (this.config.aiReasoningEffort || 'auto'),
      aiAutoExecute: !!(this.elements.aiAutoExecute && this.elements.aiAutoExecute.checked),
      aiAutoScreenshotAfterNavigate: !!(this.elements.aiAutoScreenshot && this.elements.aiAutoScreenshot.checked),
      aiAgentStepMode: !!(this.elements.aiAgentStepMode && this.elements.aiAgentStepMode.checked),
      ttsEnabled: !!(this.elements.ttsEnabled && this.elements.ttsEnabled.checked),
      ttsVoice: this.elements.ttsVoice
        ? typeof window.navioNormalizeTtsVoiceId === 'function'
          ? window.navioNormalizeTtsVoiceId(this.elements.ttsVoice.value)
          : String(this.elements.ttsVoice.value || 'nova')
              .trim()
              .toLowerCase()
        : typeof window.navioNormalizeTtsVoiceId === 'function'
          ? window.navioNormalizeTtsVoiceId(this.config.ttsVoice)
          : this.config.ttsVoice || 'nova',
      sttModel: (() => {
        const allowed = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];
        const v = this.elements.sttModel ? String(this.elements.sttModel.value || '').trim() : '';
        return allowed.includes(v) ? v : 'whisper-1';
      })(),
      assistantConnectorWeb: this.elements.assistantConnectorWeb
        ? this.elements.assistantConnectorWeb.value || 'auto'
        : (this.config.assistantConnectorWeb || 'auto'),
      assistantConnectorMail: this.elements.assistantConnectorMail
        ? this.elements.assistantConnectorMail.value || 'auto'
        : (this.config.assistantConnectorMail || 'auto'),
      assistantTabDigest: !!(this.elements.assistantTabDigest && this.elements.assistantTabDigest.checked),
      aiProactivity: this.elements.aiProactivity ? this.elements.aiProactivity.value : 'off',
      mcpEnabled: !!(this.elements.mcpEnabled && this.elements.mcpEnabled.checked),
      syncEnabled: !!(this.elements.syncEnabled && this.elements.syncEnabled.checked),
      extensionsAllowAI: !!(this.elements.extensionsAI && this.elements.extensionsAI.checked),
      formAutofillAssist: !!(this.elements.formAutofill && this.elements.formAutofill.checked),
      popupBlockerEnabled: !!(this.elements.popupBlocker && this.elements.popupBlocker.checked),
      adBlockEnabled: !!(this.elements.adBlock && this.elements.adBlock.checked),
      adStrictPopupBlock: !!(this.elements.adStrictPopup && this.elements.adStrictPopup.checked),
      defaultBrowserHostLines: (() => {
        if (!this.elements.defaultBrowserHosts) return this.config.defaultBrowserHostLines || [];
        const raw = String(this.elements.defaultBrowserHosts.value || '');
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (
          window.navioExternalBrowserHosts &&
          typeof window.navioExternalBrowserHosts.parseDefaultBrowserHostLines === 'function'
        ) {
          return window.navioExternalBrowserHosts.parseDefaultBrowserHostLines(lines);
        }
        return lines;
      })(),
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
      accentColorway: this.selectedColorway || 'aurora',
      assistantWidth,
      tabLayout: this.elements.tabLayout ? this.elements.tabLayout.value : 'horizontal',
      showBookmarkBar: !!(this.elements.bookmarkBar && this.elements.bookmarkBar.checked),
      memoryRetentionDays: this.elements.memoryRetention
        ? parseInt(this.elements.memoryRetention.value, 10) || 0
        : 0,
      syncFolderPath: String(this.config.syncFolderPath || '').trim(),
      crashReportingEnabled: !!(
        this.elements.crashReporting &&
        this.config.crashReportingAvailable &&
        this.elements.crashReporting.checked
      )
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
    document.dispatchEvent(new CustomEvent('navio-config-saved', { detail: this.config }));

    if (newConfig.syncEnabled && window.navio.syncRunNow) {
      try {
        await window.navio.syncRunNow();
      } catch (_) {}
    }

    this._refreshSyncSection().catch(() => {});

    if (typeof App !== 'undefined') {
      App.config = this.config;
      App.applyTheme(newConfig.theme);
      if (App.applyColorway) App.applyColorway(newConfig.accentColorway || 'aurora');
      App.applyLayoutFromConfig(newConfig);
    }

    if (typeof TabManager !== 'undefined') {
      TabManager.applyZoomFromConfig();
      if (typeof TabManager._maybeDiscardBackgroundTabs === 'function') {
        TabManager._maybeDiscardBackgroundTabs();
      }
    }

    if (typeof window.__navioApplyNewTabMode === 'function') {
      try { void window.__navioApplyNewTabMode(); } catch { /* non-critical */ }
    }

    if (typeof AssistantManager !== 'undefined') {
      AssistantManager.syncScopeFromConfig();
      AssistantManager.syncConnectorTogglesFromConfig();
    }

    this.close(false);
  }
}

const SettingsManager = new SettingsManagerClass();
