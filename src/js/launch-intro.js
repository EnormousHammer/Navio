/**
 * Startup sequence: branded shell prelude (always) → optional intro video → fade to browser.
 * Prelude runs before App.startBrowser so no empty webview flashes before the new tab page.
 */

const LaunchIntro = {
  MIN_PRELUDE_MS: 780,
  PRELUDE_MS_REDUCED: 320,

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  _motionOk() {
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return true;
    }
  },

  _preludeHoldMs() {
    return this._motionOk() ? this.MIN_PRELUDE_MS : this.PRELUDE_MS_REDUCED;
  },

  _stripPrelude() {
    const el = document.getElementById('shell-prelude');
    document.body.classList.remove('shell-prelude-active');
    if (el) {
      el.classList.remove('shell-prelude-exiting');
      el.setAttribute('aria-hidden', 'true');
    }
  },

  /**
   * Fade out the shell prelude overlay; removes `shell-prelude-active` from body when done.
   */
  async _fadeOutPrelude() {
    const el = document.getElementById('shell-prelude');
    if (!el || !document.body.classList.contains('shell-prelude-active')) {
      this._stripPrelude();
      return;
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('transitionend', onEnd);
        clearTimeout(fallback);
        this._stripPrelude();
        resolve();
      };
      const onEnd = (e) => {
        if (e.target !== el || e.propertyName !== 'opacity') return;
        finish();
      };
      el.addEventListener('transitionend', onEnd);
      const fallback = setTimeout(finish, 700);
      el.classList.add('shell-prelude-exiting');
    });
  },

  _playVideo(url) {
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
        } catch (e) {
          /* ignore */
        }
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
        } catch (e) {
          /* ignore */
        }

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

  /**
   * Full startup: prelude (always) → optional video → ready for first tab.
   */
  async playIfAvailable() {
    if (!window.navio) {
      this._stripPrelude();
      return;
    }

    await this._sleep(this._preludeHoldMs());

    let url = null;
    try {
      url = await window.navio.getIntroVideoUrl();
    } catch (e) {
      url = null;
    }

    await this._fadeOutPrelude();

    if (url) {
      await this._playVideo(url);
    }
  }
};
