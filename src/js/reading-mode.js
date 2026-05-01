/**
 * Reading mode — simplified article view from extracted page text.
 */

class ReadingModeClass {
  constructor() {
    this.pane = document.getElementById('reading-mode-pane');
    this._onPaneClick = null;
    this._onKeyDown = null;
    this._onPaneScroll = null;
    this._fontScale = 1;
    this._widthMode = this.getStoredPref('navio.reading.width', 'normal');
    this._focusMode = this.getStoredPref('navio.reading.focus', 'off') === 'on';
    document.getElementById('btn-reading-mode')?.addEventListener('click', () => this.toggle());
  }

  async toggle() {
    if (!this.pane) return;
    if (this.pane.classList.contains('visible')) {
      this.close();
      return;
    }

    const activeTab = typeof TabManager !== 'undefined' && TabManager.getActiveTab
      ? TabManager.getActiveTab()
      : null;
    const activeUrl = String(activeTab?.url || '').trim();

    // Home/new-tab/internal surfaces do not have meaningful article content.
    if (!activeUrl || activeUrl === 'about:blank' || !/^https?:\/\//i.test(activeUrl)) {
      if (typeof _showAppToast === 'function') {
        _showAppToast('Reading mode works on website articles only. Open a page first.', 'info');
      }
      return;
    }

    const page = await TabManager.getActivePageContent();
    const cleanText = this.normalizeExtractedText(page && page.text ? page.text : '');
    if (!page || page.error || !cleanText) {
      const reason = !page || page.error
        ? 'This page could not be extracted.'
        : 'No readable text was found on this page.';
      this.renderEmpty(
        reason,
        'Some web apps and dashboards do not expose article text for reader extraction.',
        activeUrl
      );
      this.openPane();
      return;
    }

    const cfg = await window.navio.getConfig();
    const scale = Math.min(1.65, Math.max(0.85, Number(cfg.readingModeFontScale) || 1));
    this._fontScale = scale;
    const title = escapeHtml(page.title || 'Article');
    const structured = this.structureText(cleanText);
    if (!structured.blocks.length) {
      this.renderEmpty(
        'No readable text was found on this page.',
        'Try another article page with longer text content.',
        activeUrl
      );
      this.openPane();
      return;
    }
    const body = this.formatStructuredHtml(structured.blocks);
    const safeUrl =
      typeof page.url === 'string' && /^https?:\/\//i.test(page.url) ? page.url : '';
    const sourceHost = this.hostFromUrl(safeUrl);
    const readMeta = this.buildReadMeta(cleanText);
    const link = safeUrl
      ? `<a class="reading-source-link" href="${escapeAttr(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(sourceHost || safeUrl)}</a>`
      : '';
    const byline = link
      ? `<div class="reading-source-row"><span class="reading-source-label">Source</span>${link}</div>`
      : '';
    const toc = structured.toc.length
      ? `<aside class="reading-toc" id="reading-toc">
          <div class="reading-toc-title">On this page</div>
          ${structured.toc
            .map((item) => `<button type="button" class="reading-toc-link" data-target="${escapeAttr(item.id)}">${escapeHtml(item.text)}</button>`)
            .join('')}
        </aside>`
      : '';
    const wordsLabel = `${readMeta.words.toLocaleString()} words`;
    const minutesLabel = `${readMeta.minutes} min read`;
    const widthLabel = this._widthMode === 'wide' ? 'Wide width' : 'Comfort width';
    const focusLabel = this._focusMode ? 'Focus mode: on' : 'Focus mode: off';
    const shellClasses = [
      'reading-shell',
      this._widthMode === 'wide' ? 'reading-shell-wide' : '',
      this._focusMode ? 'reading-shell-focus' : '',
    ]
      .filter(Boolean)
      .join(' ');

    this.pane.innerHTML = `
      <div class="${shellClasses}" id="reading-shell" style="--reading-font-size:${(18 * scale).toFixed(0)}px">
        <header class="reading-head">
          <div class="reading-head-main">
            <h1 class="reading-title">${title}</h1>
            ${byline}
            <div class="reading-meta-row">
              <span>${escapeHtml(wordsLabel)}</span>
              <span aria-hidden="true">•</span>
              <span>${escapeHtml(minutesLabel)}</span>
              <span aria-hidden="true">•</span>
              <span id="reading-progress-text">0%</span>
            </div>
          </div>
          <div class="reading-controls">
            <button type="button" class="btn btn-secondary reading-ctrl-btn" id="reading-font-dec" title="Decrease font size">A−</button>
            <button type="button" class="btn btn-secondary reading-ctrl-btn" id="reading-font-inc" title="Increase font size">A+</button>
            <button type="button" class="btn btn-secondary reading-ctrl-btn" id="reading-width-toggle" title="Toggle content width">${escapeHtml(widthLabel)}</button>
            <button type="button" class="btn btn-secondary reading-ctrl-btn" id="reading-focus-toggle" title="Toggle focus mode">${escapeHtml(focusLabel)}</button>
            <button type="button" class="btn btn-secondary reading-close" id="reading-close">Close</button>
          </div>
        </header>
        <div class="reading-progress-track" aria-hidden="true">
          <span class="reading-progress-fill" id="reading-progress-fill"></span>
        </div>
        <div class="reading-layout">
          ${toc}
          <article class="reading-article" id="reading-article">${body}</article>
        </div>
      </div>
    `;
    this.openPane();
    this.bindReaderInteractions();
    this.refreshReadingProgress();
  }

  close() {
    if (!this.pane) return;
    this.pane.classList.remove('visible');
    this.pane.setAttribute('aria-hidden', 'true');
    if (this._onPaneClick) {
      this.pane.removeEventListener('click', this._onPaneClick);
      this._onPaneClick = null;
    }
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._onPaneScroll) {
      this.pane.removeEventListener('scroll', this._onPaneScroll);
      this._onPaneScroll = null;
    }
    this.pane.innerHTML = '';
  }

  openPane() {
    if (!this.pane) return;
    this.pane.classList.add('visible');
    this.pane.setAttribute('aria-hidden', 'false');
    this.bindPaneCloseHandlers();
    try {
      window.navioEnsureShellOnTopIfWcv?.();
    } catch {
      /* ignore */
    }
  }

  bindPaneCloseHandlers() {
    const closeBtn = document.getElementById('reading-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    this._onPaneClick = (e) => {
      const link = e.target && e.target.closest ? e.target.closest('.reading-toc-link') : null;
      if (link) {
        const id = link.getAttribute('data-target') || '';
        if (id) {
          const target = document.getElementById(id);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      if (e.target === this.pane) this.close();
    };
    this.pane.addEventListener('click', this._onPaneClick);

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.pane?.classList.contains('visible')) {
        e.preventDefault();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  bindReaderInteractions() {
    const shell = document.getElementById('reading-shell');
    const decBtn = document.getElementById('reading-font-dec');
    const incBtn = document.getElementById('reading-font-inc');
    const widthBtn = document.getElementById('reading-width-toggle');
    const focusBtn = document.getElementById('reading-focus-toggle');
    if (!shell) return;

    const applyFont = async () => {
      shell.style.setProperty('--reading-font-size', `${Math.round(18 * this._fontScale)}px`);
      try {
        await window.navio.saveConfig({ readingModeFontScale: this._fontScale });
      } catch {
        /* ignore */
      }
    };

    decBtn?.addEventListener('click', () => {
      this._fontScale = Math.max(0.85, Math.round((this._fontScale - 0.05) * 100) / 100);
      void applyFont();
    });
    incBtn?.addEventListener('click', () => {
      this._fontScale = Math.min(1.65, Math.round((this._fontScale + 0.05) * 100) / 100);
      void applyFont();
    });

    widthBtn?.addEventListener('click', () => {
      this._widthMode = this._widthMode === 'wide' ? 'normal' : 'wide';
      shell.classList.toggle('reading-shell-wide', this._widthMode === 'wide');
      widthBtn.textContent = this._widthMode === 'wide' ? 'Wide width' : 'Comfort width';
      this.storePref('navio.reading.width', this._widthMode);
    });

    focusBtn?.addEventListener('click', () => {
      this._focusMode = !this._focusMode;
      shell.classList.toggle('reading-shell-focus', this._focusMode);
      focusBtn.textContent = this._focusMode ? 'Focus mode: on' : 'Focus mode: off';
      this.storePref('navio.reading.focus', this._focusMode ? 'on' : 'off');
    });

    this._onPaneScroll = () => this.refreshReadingProgress();
    this.pane.addEventListener('scroll', this._onPaneScroll, { passive: true });
  }

  renderEmpty(reason, hint, sourceUrl) {
    const safeReason = escapeHtml(reason || 'Nothing readable was found on this page.');
    const safeHint = escapeHtml(hint || '');
    const host = this.hostFromUrl(sourceUrl);
    const sourcePill = host
      ? `<span class="reading-empty-source">${escapeHtml(host)}</span>`
      : '';
    this.pane.innerHTML = `
      <div class="reading-shell reading-shell-empty">
        <header class="reading-head">
          <div class="reading-head-main">
            <h1 class="reading-title">Reading mode unavailable</h1>
            ${sourcePill}
          </div>
          <button type="button" class="btn btn-secondary reading-close" id="reading-close">Close</button>
        </header>
        <article class="reading-empty-card">
          <div class="reading-empty-icon" aria-hidden="true">📄</div>
          <h2 class="reading-empty-title">${safeReason}</h2>
          <p class="reading-empty-text">${safeHint}</p>
        </article>
      </div>
    `;
  }

  hostFromUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  normalizeExtractedText(raw) {
    if (!raw) return '';
    let text = String(raw).replace(/\r\n/g, '\n').trim();
    // Collapse repeated blank lines and trim noisy whitespace-only rows.
    text = text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    // Guard: very short extracted snippets are usually nav chrome/noise.
    if (text.length < 120) return '';
    return text;
  }

  formatBodyHtml(text) {
    const blocks = text
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, 1200);
    if (!blocks.length) return '';
    return blocks
      .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  structureText(text) {
    const blocks = [];
    const toc = [];
    const rawBlocks = text
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, 1200);

    let headingCount = 0;
    for (const raw of rawBlocks) {
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;

      if (this.isListBlock(lines)) {
        const items = lines
          .map((line) => line.replace(/^([-*•]|\d+[\).\]])\s+/, '').trim())
          .filter(Boolean);
        if (items.length >= 2) {
          blocks.push({ type: 'list', items });
          continue;
        }
      }

      const compact = lines.join(' ').trim();
      if (this.isHeadingCandidate(compact)) {
        headingCount += 1;
        const id = `reading-sec-${headingCount}`;
        blocks.push({ type: 'heading', text: compact, id });
        toc.push({ id, text: compact });
        continue;
      }

      blocks.push({ type: 'paragraph', text: lines.join('\n') });
    }

    return { blocks, toc };
  }

  isListBlock(lines) {
    if (!Array.isArray(lines) || lines.length < 2) return false;
    const markerRe = /^([-*•]|\d+[\).\]])\s+/;
    const marked = lines.filter((line) => markerRe.test(line)).length;
    return marked >= Math.max(2, Math.ceil(lines.length * 0.6));
  }

  isHeadingCandidate(text) {
    const t = String(text || '').trim();
    if (!t || t.length < 4 || t.length > 90) return false;
    if (/[.?!:;]$/.test(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 12) return false;
    const allCaps = t === t.toUpperCase() && /[A-Z]/.test(t);
    const titledWords = words.filter((w) => /^[A-Z][a-zA-Z0-9'’"()-]*$/.test(w)).length;
    const titleLike = titledWords >= Math.ceil(words.length * 0.66);
    return allCaps || titleLike;
  }

  formatStructuredHtml(blocks) {
    return blocks
      .map((block) => {
        if (block.type === 'heading') {
          return `<h2 class="reading-section-title" id="${escapeAttr(block.id)}">${escapeHtml(block.text)}</h2>`;
        }
        if (block.type === 'list') {
          return `<ul>${block.items.map((it) => `<li>${escapeHtml(it)}</li>`).join('')}</ul>`;
        }
        return `<p>${escapeHtml(block.text).replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }

  buildReadMeta(text) {
    const words = String(text || '').split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / 220));
    return { words, minutes };
  }

  refreshReadingProgress() {
    const article = document.getElementById('reading-article');
    const fill = document.getElementById('reading-progress-fill');
    const text = document.getElementById('reading-progress-text');
    if (!article || !fill || !text || !this.pane) return;
    const paneRect = this.pane.getBoundingClientRect();
    const articleRect = article.getBoundingClientRect();
    const total = Math.max(1, articleRect.height - paneRect.height * 0.48);
    const read = Math.min(total, Math.max(0, paneRect.top - articleRect.top + paneRect.height * 0.22));
    const pct = Math.min(100, Math.max(0, Math.round((read / total) * 100)));
    fill.style.width = `${pct}%`;
    text.textContent = `${pct}%`;
  }

  getStoredPref(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : String(v);
    } catch {
      return fallback;
    }
  }

  storePref(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* ignore */
    }
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
