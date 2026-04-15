/**
 * Launch intro: optional full-screen video, or a short handoff animation when video is off.
 * Returning users: browser session starts before the handoff so the first tab loads underneath.
 */

const LaunchIntro = {
  _motionOk() {
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return true;
    }
  },

  /**
   * Zoom-in settle, then scale up + fade (fly-past) so the shell underneath is already live.
   */
  _playStartupHandoff() {
    const root = document.getElementById('startup-handoff');
    if (!root) return Promise.resolve();

    if (!this._motionOk()) {
      return Promise.resolve();
    }

    /* ~880ms total: quick approach, short read, decisive fly-past + fade (buffer matches longest CSS transition) */
    const ENTER_MS = 280;
    const HOLD_MS = 85;
    const EXIT_MS = 560;

    return new Promise((resolve) => {
      root.setAttribute('aria-hidden', 'false');
      root.classList.add('visible');

      const runEnter = () => {
        root.classList.add('enter');
      };
      requestAnimationFrame(() => requestAnimationFrame(runEnter));

      window.setTimeout(() => {
        root.classList.remove('enter');
        root.classList.add('exit');
      }, ENTER_MS + HOLD_MS);

      window.setTimeout(() => {
        root.classList.remove('visible', 'enter', 'exit');
        root.setAttribute('aria-hidden', 'true');
        resolve();
      }, ENTER_MS + HOLD_MS + EXIT_MS);
    });
  },

  _playVideo(url) {
    const root = document.getElementById('launch-intro');
    const video = document.getElementById('launch-intro-video');
    const skipBtn = document.getElementById('launch-intro-skip');
    if (!root || !video) return Promise.resolve();

    return new Promise((resolve) => {
      let finished = false;

      const finish = async () => {
        if (finished) return;
        finished = true;
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch (e) { /* ignore */ }
        try {
          if (window.navio && typeof window.navio.saveConfig === 'function') {
            await window.navio.saveConfig({ showLaunchIntro: false });
          }
        } catch (e) { /* ignore */ }
        root.classList.remove('visible');
        root.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('launch-intro-active');
        document.removeEventListener('keydown', onKey);
        resolve();
      };

      const onKey = (e) => {
        if (e.key === 'Escape') void finish();
      };

      document.body.classList.add('launch-intro-active');
      root.setAttribute('aria-hidden', 'false');
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

  async playIfAvailable() {
    if (!window.navio || typeof window.navio.getIntroVideoUrl !== 'function') return;

    let cfg = {};
    try {
      cfg = await window.navio.getConfig();
    } catch (e) {
      return;
    }
    const onboardingDone = !!cfg.onboardingComplete;

    let url = null;
    try {
      url = await window.navio.getIntroVideoUrl();
    } catch (e) {
      return;
    }

    if (url) {
      await this._playVideo(url);
      return;
    }

    if (onboardingDone) {
      await this._playStartupHandoff();
    }
  }
};
