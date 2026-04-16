/**
 * Startup sequence: smooth prelude fade-in → preload first tab under the hood →
 * wait for paint / first load → crossfade prelude out while the shell fades in →
 * optional intro video.
 */

const LaunchIntro = {
  /** Parallel minimum with first-tab load — keeps intro feeling premium even on fast SSDs. */
  MIN_HOLD_WITH_BROWSER_MS: 1880,
  MIN_HOLD_REDUCED_MS: 420,
  /** Prelude-only path (e.g. first-run onboarding next): shorter but still smooth. */
  MIN_HOLD_NO_BROWSER_MS: 1020,
  MIN_HOLD_NO_BROWSER_REDUCED_MS: 280,
  /** Brief beat so the crossfade doesn’t cut off the first paint. */
  POST_READY_SETTLE_MS: 220,

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

  _holdWithBrowserMs() {
    return this._motionOk() ? this.MIN_HOLD_WITH_BROWSER_MS : this.MIN_HOLD_REDUCED_MS;
  },

  _holdNoBrowserMs() {
    return this._motionOk() ? this.MIN_HOLD_NO_BROWSER_MS : this.MIN_HOLD_NO_BROWSER_REDUCED_MS;
  },

  _stripPrelude() {
    const el = document.getElementById('shell-prelude');
    document.body.classList.remove(
      'shell-prelude-active',
      'shell-prelude-in',
      'shell-browser-reveal',
      'launch-intro-active'
    );
    if (el) {
      el.classList.remove('shell-prelude-exiting');
      el.setAttribute('aria-hidden', 'true');
    }
  },

  /**
   * Crossfade: shell chrome fades in while prelude fades out (same duration feels premium).
   */
  async _crossfadePreludeOut() {
    const el = document.getElementById('shell-prelude');
    if (!el || !document.body.classList.contains('shell-prelude-active')) {
      this._stripPrelude();
      return;
    }

    document.body.classList.add('shell-browser-reveal');

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
      const fallback = setTimeout(finish, 900);
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
   * @param {{ preloadBrowser?: (() => void | Promise<void>) | null }} [opts]
   */
  async playIfAvailable(opts = {}) {
    if (!window.navio) {
      this._stripPrelude();
      return;
    }

    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    document.body.classList.add('shell-prelude-in');

    await this._sleep(this._motionOk() ? 520 : 120);

    const preload = opts.preloadBrowser;
    if (typeof preload === 'function') {
      await Promise.all([preload(), this._sleep(this._holdWithBrowserMs())]);
    } else {
      await this._sleep(this._holdNoBrowserMs());
    }
    await this._sleep(this._motionOk() ? this.POST_READY_SETTLE_MS : 40);

    let url = null;
    try {
      url = await window.navio.getIntroVideoUrl();
    } catch (e) {
      url = null;
    }

    await this._crossfadePreludeOut();

    if (url) {
      await this._playVideo(url);
    }
  }
};
