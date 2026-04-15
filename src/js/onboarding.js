/**
 * Navio Browser - Onboarding Flow
 * First-run setup: cinematic intro, name, browser import, AI config
 */

class OnboardingManager {
  constructor() {
    this.el = document.getElementById('onboarding');
    this.currentStep = 0;
    this.userName = '';
    this.selectedBrowser = null;
    this.detectedBrowsers = [];
    this.selectedProvider = null;
    this.apiKey = '';
    this.ready = false;
  }

  async checkFirstRun() {
    try {
      const config = await window.navio.getConfig();
      if (config.onboardingComplete) {
        this.dismiss();
        return false;
      }
    } catch (e) { /* proceed with onboarding */ }

    document.body.classList.add('onboarding-active');
    if (this.el) this.el.classList.remove('hidden');
    this.initStarField('ob-stars');
    this.initStarField('ob-stars-2');
    this.bindEvents();
    return true;
  }

  initStarField(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const count = 80;
    for (let i = 0; i < count; i++) {
      const star = document.createElement('div');
      star.className = 'ob-star';
      star.style.left = Math.random() * 100 + '%';
      star.style.top = Math.random() * 100 + '%';
      star.style.setProperty('--dur', (2 + Math.random() * 4) + 's');
      star.style.setProperty('--peak', (0.3 + Math.random() * 0.7).toFixed(2));
      star.style.animationDelay = (Math.random() * 3) + 's';
      star.style.width = star.style.height = (1 + Math.random() * 2) + 'px';
      container.appendChild(star);
    }
  }

  bindEvents() {
    document.getElementById('ob-btn-start').addEventListener('click', () => this.goTo(1));

    const nameInput = document.getElementById('ob-name-input');
    const nameNext = document.getElementById('ob-name-next');
    nameInput.addEventListener('input', () => {
      this.userName = nameInput.value.trim();
      nameNext.disabled = this.userName.length === 0;
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.userName.length > 0) this.goTo(2);
    });
    nameNext.addEventListener('click', () => { if (this.userName.length > 0) this.goTo(2); });

    document.getElementById('ob-import-skip').addEventListener('click', () => this.goTo(3));
    document.getElementById('ob-import-next').addEventListener('click', () => this.importAndContinue());

    document.getElementById('ob-ai-skip').addEventListener('click', () => this.goTo(4));
    document.getElementById('ob-ai-next').addEventListener('click', () => this.saveAIAndFinish());

    document.querySelectorAll('.ob-provider').forEach(btn => {
      btn.addEventListener('click', () => this.selectProvider(btn.dataset.provider));
    });

    const apiKeyInput = document.getElementById('ob-api-key');
    apiKeyInput.addEventListener('input', () => {
      this.apiKey = apiKeyInput.value.trim();
      document.getElementById('ob-ai-next').disabled = this.apiKey.length < 8;
    });

    document.getElementById('ob-btn-launch').addEventListener('click', () => this.launch());
  }

  goTo(step) {
    const current = this.el.querySelector('.ob-step.active');
    if (current) {
      current.classList.add('exiting');
      current.classList.remove('active');
    }

    setTimeout(() => {
      if (current) current.classList.remove('exiting');
      const next = this.el.querySelector(`.ob-step[data-step="${step}"]`);
      if (next) next.classList.add('active');
      this.currentStep = step;
      this.onStepEnter(step);
    }, 350);
  }

  onStepEnter(step) {
    if (step === 1) {
      setTimeout(() => document.getElementById('ob-name-input').focus(), 400);
    }
    if (step === 2) {
      this.detectBrowsers();
    }
    if (step === 4) {
      const title = document.getElementById('ob-launch-title');
      title.textContent = `You're all set, ${this.userName}!`;
    }
  }

  async detectBrowsers() {
    const container = document.getElementById('ob-browsers');
    try {
      const browsers = await window.navio.detectBrowsers();
      this.detectedBrowsers = browsers;

      if (browsers.length === 0) {
        container.innerHTML = `
          <div class="ob-browsers-empty">
            No compatible browsers detected on this device
          </div>`;
        return;
      }

      const colors = {
        chrome: 'linear-gradient(135deg, #4285f4, #34a853)',
        edge: 'linear-gradient(135deg, #0078d4, #00bcf2)',
        brave: 'linear-gradient(135deg, #fb542b, #ff7654)',
        opera: 'linear-gradient(135deg, #ff1b2d, #ff6b6b)',
        vivaldi: 'linear-gradient(135deg, #ef3939, #ff6b6b)'
      };

      const icons = { chrome: 'CH', edge: 'ED', brave: 'BR', opera: 'OP', vivaldi: 'VI' };

      container.innerHTML = browsers.map(b => `
        <div class="ob-browser-item" data-id="${b.id}" data-path="${b.path}">
          <div class="ob-browser-icon" style="background: ${colors[b.id] || 'linear-gradient(135deg, #666, #999)'}">${icons[b.id] || '?'}</div>
          <div class="ob-browser-info">
            <span class="ob-browser-name">${b.name}</span>
            <span class="ob-browser-meta">${b.bookmarkCount} bookmark${b.bookmarkCount !== 1 ? 's' : ''}</span>
          </div>
          <div class="ob-browser-check">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.ob-browser-item').forEach(item => {
        item.addEventListener('click', () => {
          container.querySelectorAll('.ob-browser-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          this.selectedBrowser = { id: item.dataset.id, path: item.dataset.path };
        });
      });
    } catch (e) {
      container.innerHTML = `<div class="ob-browsers-empty">Could not detect browsers</div>`;
    }
  }

  async importAndContinue() {
    if (!this.selectedBrowser) {
      this.goTo(3);
      return;
    }

    const btn = document.getElementById('ob-import-next');
    btn.innerHTML = '<span>Importing...</span>';
    btn.disabled = true;

    try {
      const result = await window.navio.importBookmarks(this.selectedBrowser.path);
      if (result.bookmarks && result.bookmarks.length > 0) {
        const config = await window.navio.getConfig();
        config.importedBookmarks = result.bookmarks;
        config.importSource = this.selectedBrowser.id;
        await window.navio.saveConfig(config);

        const container = document.getElementById('ob-browsers');
        const status = document.createElement('div');
        status.className = 'ob-import-status';
        status.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Imported ${result.bookmarks.length} bookmarks`;
        container.prepend(status);

        setTimeout(() => this.goTo(3), 800);
        return;
      }
    } catch (e) { /* proceed anyway */ }

    this.goTo(3);
  }

  selectProvider(provider) {
    this.selectedProvider = provider;
    document.querySelectorAll('.ob-provider').forEach(p => {
      p.classList.toggle('selected', p.dataset.provider === provider);
    });

    const keySection = document.getElementById('ob-key-section');
    keySection.style.display = 'block';

    const labels = {
      openai: { name: 'OpenAI API Key', placeholder: 'sk-...', link: 'https://platform.openai.com/api-keys' },
      anthropic: { name: 'Anthropic API Key', placeholder: 'sk-ant-...', link: 'https://console.anthropic.com/settings/keys' },
      google: { name: 'Google AI API Key', placeholder: 'AI...', link: 'https://aistudio.google.com/apikey' }
    };

    const info = labels[provider];
    document.getElementById('ob-key-label').textContent = info.name;
    document.getElementById('ob-api-key').placeholder = info.placeholder;
    document.getElementById('ob-key-link').onclick = (e) => {
      e.preventDefault();
      if (typeof TabManager !== 'undefined') {
        this.dismiss();
        TabManager.createTab(info.link);
      }
    };

    document.getElementById('ob-api-key').focus();
  }

  async saveAIAndFinish() {
    if (!this.selectedProvider || this.apiKey.length < 8) return;

    const modelDefaults = {
      openai: 'gpt-5.4',
      anthropic: 'claude-opus-4-5',
      google: 'gemini-2.0-flash'
    };

    try {
      const config = await window.navio.getConfig();
      config.aiProvider = this.selectedProvider;
      config.apiKey = this.apiKey;
      config.aiModel = modelDefaults[this.selectedProvider] || 'gpt-5.4';
      await window.navio.saveConfig(config);
    } catch (e) { /* proceed */ }

    this.goTo(4);
  }

  async launch() {
    try {
      const config = await window.navio.getConfig();
      config.onboardingComplete = true;
      config.userName = this.userName;
      await window.navio.saveConfig(config);
    } catch (e) { /* proceed */ }

    this.dismiss();
  }

  dismiss() {
    document.body.classList.remove('onboarding-active');
    this.el.classList.add('hidden');
    this.ready = true;

    if (typeof App !== 'undefined' && App.onOnboardingComplete) {
      App.onOnboardingComplete();
    }
  }
}

const Onboarding = new OnboardingManager();
