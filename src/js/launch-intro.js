/**
 * Optional full-screen launch video only (public/intro_video + Settings).
 * First tab / webviews start after this resolves via normal App + Onboarding flow
 * — no second overlay, prelude, or early startBrowser (avoids empty-shell flashes).
 */

const LaunchIntro = {
  _motionOk() {
    try {
      return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return true;
    }
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

    let url = null;
    try {
      url = await window.navio.getIntroVideoUrl();
    } catch (e) {
      return;
    }

    if (!url) return;

    await this._playVideo(url);
  }
};
