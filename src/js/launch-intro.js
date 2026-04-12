/**
 * Plays public/intro_video/intro_final.mp4 on startup before onboarding / main UI.
 */

const LaunchIntro = {
  async playIfAvailable() {
    if (!window.navio || typeof window.navio.getIntroVideoUrl !== 'function') return;

    let url;
    try {
      url = await window.navio.getIntroVideoUrl();
    } catch (e) {
      return;
    }
    if (!url) return;

    const root = document.getElementById('launch-intro');
    const video = document.getElementById('launch-intro-video');
    const skipBtn = document.getElementById('launch-intro-skip');
    if (!root || !video) return;

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
  }
};
