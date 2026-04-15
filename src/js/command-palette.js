/**
 * Command palette — fuzzy-ish filter over tabs and built-in commands.
 */

class CommandPaletteClass {
  constructor() {
    this.overlay = document.getElementById('command-palette-overlay');
    this.input = document.getElementById('command-palette-input');
    this.list = document.getElementById('command-palette-list');
    this.activeIndex = 0;
    this.items = [];
    this.visible = false;

    if (!this.overlay || !this.input || !this.list) return;

    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveActive(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveActive(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this.runActive();
        return;
      }
    });

    this.input.addEventListener('input', () => {
      void this.refresh();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.visible) {
        e.preventDefault();
        this.close();
      }
    });
  }

  open() {
    if (!this.overlay) return;
    this.visible = true;
    this.overlay.classList.add('visible');
    this.overlay.setAttribute('aria-hidden', 'false');
    this.input.value = '';
    void this.refresh();
    setTimeout(() => this.input.focus(), 50);
  }

  close() {
    if (!this.overlay) return;
    this.visible = false;
    this.overlay.classList.remove('visible');
    this.overlay.setAttribute('aria-hidden', 'true');
  }

  toggle() {
    this.visible ? this.close() : this.open();
  }

  baseCommands() {
    return [
      { id: 'new-tab', label: 'New tab', run: () => TabManager.createTab() },
      {
        id: 'new-private-tab',
        label: 'New private tab',
        run: () => TabManager.createTab(null, { incognito: true })
      },
      { id: 'reload', label: 'Reload page (Ctrl+R)', run: () => TabManager.reloadActive(false) },
      { id: 'hard-reload', label: 'Hard reload — empty cache (Ctrl+Shift+R)', run: () => TabManager.reloadActive(true) },
      { id: 'close-tab', label: 'Close active tab', run: () => TabManager.closeActiveTab() },
      { id: 'reopen-last-tab', label: 'Reopen last closed tab (Ctrl+Shift+T)', run: () => TabManager.reopenLastClosedTab() },
      { id: 'focus-url', label: 'Focus address bar', run: () => document.getElementById('url-input').focus() },
      { id: 'assistant', label: 'Toggle Navio AI', run: () => AssistantManager.toggle() },
      { id: 'connectors', label: 'Open Connectors Hub', run: () => ConnectorsManager.toggleHub?.() },
      { id: 'workspace', label: 'Open Workspace', run: () => WorkspaceManager.open?.() },
      { id: 'reading', label: 'Toggle reading mode', run: () => ReadingMode.toggle?.() },
      { id: 'screenshot', label: 'Screenshot active tab', run: () => ScreenshotTool.capture?.() },
      { id: 'devtools', label: 'Open DevTools (active tab)', run: () => ScreenshotTool.openDevtools?.() },
      { id: 'settings', label: 'Open Settings', run: () => SettingsManager.open() },
      {
        id: 'open-history',
        label: 'Open history (Ctrl+H)',
        run: () => window.__navioOpenHistoryOverlay?.()
      },
      {
        id: 'open-bookmarks-manager',
        label: 'Manage bookmarks (Ctrl+Shift+B)',
        run: () => window.__navioOpenBookmarksOverlay?.()
      },
      {
        id: 'toggle-bookmark-bar',
        label: 'Toggle bookmark bar',
        run: () => window.__navioToggleBookmarkBar?.()
      },
      {
        id: 'ai-organize-tabs',
        label: 'AI: Organize tabs into groups',
        run: () => TabManager.autoOrganizeTabsWithAi?.()
      },
      {
        id: 'ai-close-dup-tabs',
        label: 'AI: Suggest closing duplicate tabs',
        run: () => TabManager.suggestCloseDuplicateTabsWithAi?.()
      },
      {
        id: 'tab-search-palette',
        label: 'Search open tabs (Ctrl+Shift+O or Ctrl+Shift+E)',
        run: () => {
          const o = document.getElementById('tab-search-overlay');
          const inp = document.getElementById('tab-search-input');
          if (o && inp) {
            o.hidden = false;
            inp.value = '';
            inp.dispatchEvent(new Event('input'));
            inp.focus();
          }
        }
      }
    ];
  }

  async refresh() {
    const raw = (this.input.value || '').trim().toLowerCase();
    const isAsk = raw.startsWith('?');
    const q = isAsk ? raw.slice(1).trim() : raw;
    this.items = [];

    if (isAsk) {
      this.items.push({
        id: 'ask-ai',
        label: `Ask AI: ${q || '…'}`,
        meta: 'assistant',
        run: () => {
          AssistantManager.open();
          if (q) {
            AssistantManager.inputEl.value = q;
            AssistantManager.sendMessage();
          }
        }
      });
    }

    const cmds = this.baseCommands();
    cmds.forEach((c) => {
      if (!q || c.label.toLowerCase().includes(q) || c.id.includes(q)) {
        this.items.push({ ...c, meta: 'command' });
      }
    });

    try {
      const wl = await window.navio.workflowList();
      const workflows = wl.workflows || [];
      workflows.forEach((wf) => {
        const name = (wf.name || 'Workflow').toLowerCase();
        if (!q || name.includes(q)) {
          this.items.push({
            id: `wf-${wf.id}`,
            label: `Run workflow: ${wf.name || 'Untitled'}`,
            meta: 'workflow',
            run: () => {
              if (typeof AssistantManager !== 'undefined') {
                AssistantManager.runWorkflowFromCommandPalette(wf);
              }
            }
          });
        }
      });
    } catch {
      /* ignore */
    }

    if (typeof TabManager !== 'undefined' && TabManager.tabs) {
      TabManager.tabs.forEach((tab) => {
        const label = TabManager.getTabDisplayTitle(tab);
        const hay = `${label} ${tab.title || ''} ${tab.url}`.toLowerCase();
        if (!q || hay.includes(q)) {
          this.items.push({
            id: `tab-${tab.id}`,
            label: label || 'Untitled',
            meta: tab.url || 'tab',
            run: () => TabManager.switchToTab(tab.id)
          });
        }
      });
    }

    this.activeIndex = 0;
    this.render();
  }

  render() {
    this.list.innerHTML = '';
    this.items.slice(0, 80).forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'command-palette-item' + (i === this.activeIndex ? ' active' : '');
      el.textContent = item.label;
      const meta = document.createElement('span');
      meta.className = 'command-palette-meta';
      meta.textContent = item.meta || '';
      el.appendChild(meta);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.activeIndex = i;
        this.runActive();
      });
      this.list.appendChild(el);
    });
  }

  moveActive(delta) {
    if (!this.items.length) return;
    this.activeIndex = (this.activeIndex + delta + this.items.length) % this.items.length;
    this.render();
  }

  runActive() {
    const item = this.items[this.activeIndex];
    if (!item || !item.run) return;
    this.close();
    try {
      item.run();
    } catch (e) {
      console.error(e);
    }
  }
}

const CommandPalette = new CommandPaletteClass();
