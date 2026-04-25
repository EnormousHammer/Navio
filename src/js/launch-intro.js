/**
 * Startup sequence: show branded prelude → preload first tab → one paint → remove prelude (no opacity crossfade — avoids jank).
 * Optional intro video after.
 */

const LaunchIntro = {
  /** Minimum time after preload completes — keep near zero for fastest cold start. */
  MIN_HOLD_WITH_BROWSER_MS: 0,
  MIN_HOLD_REDUCED_MS: 0,
  /** Prelude-only path (e.g. first-run onboarding next). */
  MIN_HOLD_NO_BROWSER_MS: 0,
  MIN_HOLD_NO_BROWSER_REDUCED_MS: 0,
  /** Short settle after hold before stripping prelude. */
  POST_READY_SETTLE_MS: 0,

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
      'shell-prelude-fading',
      'launch-intro-active'
    );
    if (el) {
      el.classList.remove('shell-prelude-exiting');
      el.setAttribute('aria-hidden', 'true');
      el.style.removeProperty('pointer-events');
    }
  },

  /** Drop the splash in one shot after the next frames paint (no CSS fade — avoids transition glitches). */
  async _revealShellNow() {
    if (!document.body.classList.contains('shell-prelude-active')) {
      this._stripPrelude();
      return;
    }
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    this._stripPrelude();
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
    document.body.classList.add('shell-prelude-in');

    await this._sleep(this._motionOk() ? 32 : 0);

    const preload = opts.preloadBrowser;
    const holdMs = typeof preload === 'function' ? this._holdWithBrowserMs() : this._holdNoBrowserMs();
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (typeof preload === 'function') {
      await Promise.resolve(preload());
    }
    const elapsed =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const remaining = Math.max(0, holdMs - elapsed);
    if (remaining > 0) await this._sleep(remaining);
    await this._sleep(this._motionOk() ? this.POST_READY_SETTLE_MS : 0);

    await new Promise((r) => requestAnimationFrame(r));

    /* Dismiss prelude before optional intro video. If getIntroVideoUrl IPC never returns,
       we must not leave the splash covering the shell (onboarding or first tab). */
    await this._revealShellNow();

    let url = null;
    try {
      const p = window.navio.getIntroVideoUrl();
      url = await Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ]);
    } catch (e) {
      url = null;
    }

    if (url) {
      await this._playVideo(url);
    }
  }
};
