/**
 * Screenshot tool — click opens a dropdown menu:
 *  • Full page (scrolls & stitches the current tab)
 *  • Visible tab area
 *  • Entire screen (uses OS desktopCapturer — outside Navio too)
 *  • Window… (picker — any open window on the system)
 *
 * Results are copied to the clipboard and offered as a download.
 * DevTools button kept as its original action.
 */

class ScreenshotToolClass {
  constructor() {
    this._menu = null;
    const btn = document.getElementById('btn-screenshot');
    if (btn) {
      btn.addEventListener('click', (e) => this._openMenu(btn, e));
    }
    document.getElementById('btn-devtools')?.addEventListener('click', () => this.openDevtools());
  }

  _openMenu(anchor) {
    this._closeMenu();
    const menu = document.createElement('div');
    menu.className = 'screenshot-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <button type="button" class="sm-item" data-act="page">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9"/><path d="M14 3v7h6"/><path d="M8 13h8M8 17h6"/></svg>
        <span>Capture full page</span>
        <span class="sm-sub">Scrolling</span>
      </button>
      <button type="button" class="sm-item" data-act="visible">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8"/></svg>
        <span>Capture visible area</span>
        <span class="sm-sub">Tab</span>
      </button>
      <div class="sm-sep"></div>
      <button type="button" class="sm-item" data-act="screen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <span>Capture entire screen</span>
        <span class="sm-sub">Desktop</span>
      </button>
      <button type="button" class="sm-item" data-act="window">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>
        <span>Pick a window…</span>
      </button>
    `;

    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth || 260;
    let left = rect.right - mw;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${rect.bottom + 4}px`;

    menu.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        this._closeMenu();
        try {
          if (act === 'page') await this._capturePage(true);
          else if (act === 'visible') await this._capturePage(false);
          else if (act === 'screen') await this._captureScreen({ save: true });
          else if (act === 'window') await this._pickWindow();
        } catch (e) {
          this._toast(`Screenshot failed: ${e.message || e}`);
        }
      });
    });

    const off = (ev) => { if (!menu.contains(ev.target)) this._closeMenu(); };
    const offKey = (ev) => { if (ev.key === 'Escape') this._closeMenu(); };
    setTimeout(() => {
      document.addEventListener('mousedown', off, { capture: true, once: true });
      document.addEventListener('keydown', offKey, { once: true });
    }, 0);
    this._menu = { el: menu, off, offKey };
  }

  _closeMenu() {
    if (!this._menu) return;
    try { this._menu.el.remove(); } catch (_) { /* ignore */ }
    if (this._menu.off) document.removeEventListener('mousedown', this._menu.off, true);
    if (this._menu.offKey) document.removeEventListener('keydown', this._menu.offKey);
    this._menu = null;
  }

  async _capturePage(fullPage) {
    if (typeof TabManager === 'undefined') return;
    const wv = TabManager.getActiveWebview();
    if (!wv) return;
    const id = wv.getWebContentsId();
    const r = await window.navio.browserAction({
      webContentsId: id,
      action: 'screenshot',
      params: { full_page: !!fullPage }
    });
    let dataURL = null;
    if (r && r.screenshot) dataURL = r.screenshot;
    else if (r && r.image) dataURL = `data:${r.mimeType || 'image/png'};base64,${r.image}`;
    if (!dataURL) {
      this._toast(r?.error || 'Could not capture page');
      return;
    }
    this._showPreview(dataURL, fullPage ? 'Full page' : 'Visible area');
  }

  async _captureScreen(opts = {}) {
    if (!window.navio || typeof window.navio.captureScreen !== 'function') {
      this._toast('Screen capture is unavailable');
      return;
    }
    const r = await window.navio.captureScreen({ save: !!opts.save });
    if (!r || !r.ok) {
      this._toast(r?.error || 'Screen capture failed');
      return;
    }
    this._showPreview(r.dataURL, r.sourceName || 'Screen', r.savedPath);
  }

  async _pickWindow() {
    if (!window.navio || typeof window.navio.captureScreenSources !== 'function') {
      this._toast('Window picker is unavailable');
      return;
    }
    const r = await window.navio.captureScreenSources({ screens: true, windows: true });
    if (!r || !r.ok || !r.sources || r.sources.length === 0) {
      this._toast(r?.error || 'No windows or screens available');
      return;
    }
    this._showSourcePicker(r.sources);
  }

  _showSourcePicker(sources) {
    const overlay = document.createElement('div');
    overlay.className = 'screenshot-picker-overlay';
    overlay.innerHTML = `
      <div class="screenshot-picker">
        <div class="screenshot-picker-head">
          <span>Choose a screen or window</span>
          <button type="button" class="screenshot-picker-close" aria-label="Close">×</button>
        </div>
        <div class="screenshot-picker-grid"></div>
      </div>
    `;
    const grid = overlay.querySelector('.screenshot-picker-grid');
    sources.forEach((s) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'screenshot-picker-card';
      card.innerHTML = `
        <div class="screenshot-picker-thumb" style="background-image:url('${s.thumbnail || ''}')"></div>
        <div class="screenshot-picker-name">${(s.kind === 'screen' ? '🖥️ ' : '🪟 ') + (s.name || 'Source')}</div>
      `;
      card.addEventListener('click', async () => {
        overlay.remove();
        const r = await window.navio.captureScreen({
          save: true,
          window: s.kind === 'window',
          sourceId: s.id
        });
        if (r && r.ok) this._showPreview(r.dataURL, s.name, r.savedPath);
        else this._toast(r?.error || 'Capture failed');
      });
      grid.appendChild(card);
    });
    overlay.querySelector('.screenshot-picker-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  _showPreview(dataURL, label, savedPath) {
    const overlay = document.createElement('div');
    overlay.className = 'screenshot-preview-overlay';
    const msg = savedPath
      ? `Saved to ${savedPath} · copied to clipboard`
      : 'Copied to clipboard';
    overlay.innerHTML = `
      <div class="screenshot-preview">
        <div class="screenshot-preview-head">
          <span class="screenshot-preview-title">${this._escape(label || 'Screenshot')}</span>
          <div class="screenshot-preview-actions">
            <button type="button" data-act="copy">Copy</button>
            <button type="button" data-act="save">Save as…</button>
            <button type="button" data-act="close" aria-label="Close">×</button>
          </div>
        </div>
        <div class="screenshot-preview-body">
          <img alt="${this._escape(label || '')}" />
        </div>
        <div class="screenshot-preview-foot">${this._escape(msg)}</div>
      </div>
    `;
    overlay.querySelector('img').src = dataURL;
    overlay.querySelector('[data-act="close"]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try {
        const blob = await (await fetch(dataURL)).blob();
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        }
        overlay.querySelector('.screenshot-preview-foot').textContent = 'Copied';
      } catch (err) {
        overlay.querySelector('.screenshot-preview-foot').textContent = `Copy failed: ${err.message || err}`;
      }
    });
    overlay.querySelector('[data-act="save"]').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = dataURL;
      a.download = `navio-screenshot-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    document.body.appendChild(overlay);
  }

  _toast(message) {
    const t = document.createElement('div');
    t.className = 'screenshot-toast';
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 400); }, 2200);
  }

  _escape(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  async openDevtools() {
    if (typeof TabManager === 'undefined') return;
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
