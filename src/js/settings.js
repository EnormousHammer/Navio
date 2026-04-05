/**
 * Navio Browser - Settings Manager
 * Handles configuration persistence, API key management, and settings UI
 */

class SettingsManagerClass {
  constructor() {
    this.modal = document.getElementById('settings-modal');
    this.config = {};

    this.elements = {
      provider: document.getElementById('setting-provider'),
      apiKey: document.getElementById('setting-api-key'),
      model: document.getElementById('setting-model'),
      endpoint: document.getElementById('setting-endpoint'),
      endpointRow: document.getElementById('custom-endpoint-row'),
      searchEngine: document.getElementById('setting-search-engine'),
      homepage: document.getElementById('setting-homepage'),
      toggleKey: document.getElementById('btn-toggle-key')
    };

    this.bindEvents();
    this.loadConfig();
  }

  bindEvents() {
    document.getElementById('btn-settings').addEventListener('click', () => this.open());
    document.getElementById('btn-close-settings').addEventListener('click', () => this.close());
    document.getElementById('btn-cancel-settings').addEventListener('click', () => this.close());
    document.getElementById('btn-save-settings').addEventListener('click', () => this.save());

    // Close on overlay click
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });

    // Provider change shows/hides custom endpoint
    this.elements.provider.addEventListener('change', () => {
      this.elements.endpointRow.style.display =
        this.elements.provider.value === 'custom' ? 'block' : 'none';
      this.updateModelOptions();
    });

    // Toggle API key visibility
    this.elements.toggleKey.addEventListener('click', () => {
      const input = this.elements.apiKey;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.classList.contains('visible')) {
        this.close();
      }
    });
  }

  async loadConfig() {
    this.config = await window.navio.getConfig();
    this.populateFields();
  }

  populateFields() {
    this.elements.provider.value = this.config.aiProvider || 'openai';
    this.elements.apiKey.value = this.config.apiKey || '';
    this.elements.model.value = this.config.aiModel || 'gpt-4o';
    this.elements.endpoint.value = this.config.customEndpoint || '';
    this.elements.searchEngine.value = this.config.searchEngine || 'https://www.google.com/search?q=';
    this.elements.homepage.value = this.config.homepage || 'https://www.google.com';

    this.elements.endpointRow.style.display =
      this.config.aiProvider === 'custom' ? 'block' : 'none';

    this.updateModelOptions();
  }

  updateModelOptions() {
    const provider = this.elements.provider.value;
    const modelSelect = this.elements.model;
    const currentValue = modelSelect.value;

    // Show relevant model groups
    const optgroups = modelSelect.querySelectorAll('optgroup');
    optgroups.forEach(group => {
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

    // Auto-select first visible model if current selection is hidden
    const visibleOptions = Array.from(modelSelect.querySelectorAll('optgroup:not([style*="none"]) option'));
    if (visibleOptions.length > 0 && !visibleOptions.find(o => o.value === currentValue)) {
      modelSelect.value = visibleOptions[0].value;
    }
  }

  open() {
    this.loadConfig();
    this.modal.classList.add('visible');
  }

  close() {
    this.modal.classList.remove('visible');
    this.elements.apiKey.type = 'password';
  }

  async save() {
    const newConfig = {
      ...this.config,
      aiProvider: this.elements.provider.value,
      apiKey: this.elements.apiKey.value.trim(),
      aiModel: this.elements.model.value,
      customEndpoint: this.elements.endpoint.value.trim(),
      searchEngine: this.elements.searchEngine.value,
      homepage: this.elements.homepage.value.trim() || 'https://www.google.com'
    };

    await window.navio.saveConfig(newConfig);
    this.config = newConfig;

    // Update app config reference
    if (typeof App !== 'undefined') {
      App.config = newConfig;
    }

    this.close();
  }
}

const SettingsManager = new SettingsManagerClass();
