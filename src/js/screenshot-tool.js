/**
 * Screenshot active tab + open DevTools.
 */

class ScreenshotToolClass {
  constructor() {
    document.getElementById('btn-screenshot')?.addEventListener('click', () => this.capture());
    document.getElementById('btn-devtools')?.addEventListener('click', () => this.openDevtools());
  }

  async capture() {
    const wv = TabManager.getActiveWebview();
    if (!wv) return;
    try {
      const id = wv.getWebContentsId();
      const r = await window.navio.browserAction({
        webContentsId: id,
        action: 'screenshot',
        params: {}
      });
      if (r.screenshot) {
        const w = window.open('');
        if (w) {
          w.document.write(`<img src="${r.screenshot}" style="max-width:100%"/>`);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  async openDevtools() {
    const wv = TabManager.getActiveWebview();
    if (!wv) return;
    const now = Date.now();
    if (this._lastOpenDevtoolsAt && now - this._lastOpenDevtoolsAt < 400) return;
    this._lastOpenDevtoolsAt = now;
    try {
      await window.navio.openDevtoolsActive(wv.getWebContentsId());
    } catch (e) {
      console.error(e);
    }
  }
}

const ScreenshotTool = new ScreenshotToolClass();
