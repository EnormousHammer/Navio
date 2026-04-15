/**
 * Launch intro: optional full-screen video, or a subtle shell handoff when the video is off.
 * Prelude cover shows immediately for returning users (masks IPC delay + empty webview flash).
 */

const LaunchIntro = {
  _motionOk() {
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return true;
    }
  },

  _wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  _waitForOpacityTransition(el, fallbackMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const t = setTimeout(finish, fallbackMs);
      const onEnd = (e) => {
        if (e.target !== el || e.propertyName !== 'opacity') return;
        clearTimeout(t);
        el.removeEventListener('transitionend', onEnd);
        finish();
      };
      el.addEventListener('transitionend', onEnd);
    });
  },

  _resetStartupHandoff(root) {
    if (!root) return;
    root.classList.remove(
      'is-active',
      'is-exiting',
      'reveal-brand',
      'startup-handoff--prelude'
    );
    root.setAttribute('aria-hidden', 'true');
  },

  /** Solid cover, no animation — masks shell until we know video vs handoff. */
  _showPreludeCover(root) {
    if (!root) return;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-active', 'startup-handoff--prelude');
  },

  /**
   * No video: prelude is already up → gentle brand in → crossfade whole layer out.
   */
  async _runNoVideoHandoff(root) {
    if (!root) return;

    if (!this._motionOk()) {
      root.classList.remove('startup-handoff--prelude');
      root.classList.add('is-exiting');
      await this._waitForOpacityTransition(root, 80);
      this._resetStartupHandoff(root);
      return;
    }

    await this._wait(16);
    root.classList.remove('startup-handoff--prelude');
    root.classList.add('reveal-brand');

    await this._wait(420);

    root.classList.add('is-exiting');
    await this._waitForOpacityTransition(root, 620);
    this._resetStartupHandoff(root);
  },

  _playVideo(url, handoffRoot) {
    const root = document.getElementById('launch-intro');
    const video = document.getElementById('launch-intro-video');
    const skipBtn = document.getElementById('launch-intro-skip');
    if (!root || !video) return Promise.resolve();

    return new Promise((resolve) => {
      let finished = false;

      const cleanup = () => {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch (e) { /* ignore */ }
        root.classList.remove('visible', 'exiting');
        root.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('launch-intro-active');
        document.removeEventListener('keydown', onKey);
        resolve();
      };

      const finish = async () => {
        if (finished) return;
        finished = true;
        try {
          if (window.navio && typeof window.navio.saveConfig === 'function') {
            await window.navio.saveConfig({ showLaunchIntro: false });
          }
        } catch (e) { /* ignore */ }

        if (!this._motionOk()) {
          cleanup();
          return;
        }

        const t = setTimeout(() => {
          root.removeEventListener('transitionend', onEnd);
          cleanup();
        }, 650);
        const onEnd = (e) => {
          if (e.target !== root || e.propertyName !== 'opacity') return;
          clearTimeout(t);
          root.removeEventListener('transitionend', onEnd);
          cleanup();
        };
        root.addEventListener('transitionend', onEnd);
        root.classList.add('exiting');
      };

      const onKey = (e) => {
        if (e.key === 'Escape') void finish();
      };

      document.body.classList.add('launch-intro-active');
      root.setAttribute('aria-hidden', 'false');
      root.classList.remove('exiting');
      root.classList.add('visible');
      if (handoffRoot) this._resetStartupHandoff(handoffRoot);

      video.addEventListener('ended', () => void finish(), { once: true });
      video.addEventListener('error', () => void finish(), { once: true });
      if (skipBtn) skipBtn.addEventListener('click', () => void finish(), { once: true });
      document.addEventListener('keydown', onKey);

      video.src = url;
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => void finish());
      });

      requestAnimationFrame(() => skipBtn?.focus());
    });
  },

  async playIfAvailable() {
    if (!window.navio || typeof window.navio.getIntroVideoUrl !== 'function') return;

    let cfg = {};
    try {
      cfg = await window.navio.getConfig();
    } catch (e) {
      return;
    }

    const onboardingDone = !!cfg.onboardingComplete;
    const handoffRoot = document.getElementById('startup-handoff');

    if (onboardingDone) {
      this._showPreludeCover(handoffRoot);
    }

    let url = null;
    try {
      url = await window.navio.getIntroVideoUrl();
    } catch (e) {
      url = null;
    }

    if (url) {
      await this._playVideo(url, onboardingDone ? handoffRoot : null);
      return;
    }

    if (onboardingDone) {
      await this._runNoVideoHandoff(handoffRoot);
    }
  }
};
