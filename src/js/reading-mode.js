/**
 * Reading mode — simplified article view from extracted page text.
 */

class ReadingModeClass {
  constructor() {
    this.pane = document.getElementById('reading-mode-pane');
    document.getElementById('btn-reading-mode')?.addEventListener('click', () => this.toggle());
  }

  async toggle() {
    if (!this.pane) return;
    if (this.pane.classList.contains('visible')) {
      this.close();
      return;
    }
    const page = await TabManager.getActivePageContent();
    if (!page || page.error || !page.text) {
      const reason = (!page || page.error) ? 'This page could not be extracted.' : 'No readable text was found on this page.';
      this.pane.innerHTML = `
        <button type="button" class="btn btn-secondary reading-close" id="reading-close">Close</button>
        <article style="text-align:center;padding:80px 24px">
          <div style="font-size:40px;margin-bottom:16px;opacity:.4">📄</div>
          <h1 style="font-size:17px;font-weight:600;margin-bottom:8px">Nothing to read</h1>
          <p style="font-size:13px;color:var(--text-secondary);max-width:280px;margin:0 auto">${reason} Navigate to an article or web page and try again.</p>
        </article>
      `;
      document.getElementById('reading-close')?.addEventListener('click', () => this.close());
      this.pane.classList.add('visible');
      this.pane.setAttribute('aria-hidden', 'false');
      try {
        window.navioEnsureShellOnTopIfWcv?.();
      } catch {
        /* ignore */
      }
      return;
    }
    const cfg = await window.navio.getConfig();
    const scale = Number(cfg.readingModeFontScale) || 1;
    const title = escapeHtml(page.title || 'Article');
    const body = escapeHtml(page.text).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
    const safeUrl =
      typeof page.url === 'string' && /^https?:\/\//i.test(page.url) ? page.url : '';
    const link = safeUrl
      ? `<p><a href="${escapeAttr(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(safeUrl)}</a></p>`
      : '';
    this.pane.innerHTML = `
      <button type="button" class="btn btn-secondary reading-close" id="reading-close">Close</button>
      <article style="font-size:${(18 * scale).toFixed(0)}px">
        <h1>${title}</h1>
        ${link}
        <p>${body}</p>
      </article>
    `;
    document.getElementById('reading-close')?.addEventListener('click', () => this.close());
    this.pane.classList.add('visible');
    this.pane.setAttribute('aria-hidden', 'false');
    try {
      window.navioEnsureShellOnTopIfWcv?.();
    } catch {
      /* ignore */
    }
  }

  close() {
    if (!this.pane) return;
    this.pane.classList.remove('visible');
    this.pane.setAttribute('aria-hidden', 'true');
    this.pane.innerHTML = '';
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  if (!s) return '';
  return String(s).replace(/"/g, '&quot;');
}

const ReadingMode = new ReadingModeClass();
