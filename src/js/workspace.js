/**
 * Workspace overlay — tasks, quick notes, projects (local JSON via main process).
 */

class WorkspaceManagerClass {
  constructor() {
    this.overlay = document.getElementById('workspace-overlay');
    this.body = document.getElementById('workspace-body');
    this.taskList = document.getElementById('workspace-task-list');
    this.projectList = document.getElementById('workspace-project-list');
    this.notesList = document.getElementById('workspace-notes-list');

    const close = document.getElementById('workspace-close');
    if (close) close.addEventListener('click', () => this.close());

    if (this.overlay) {
      this.overlay.addEventListener('mousedown', (e) => {
        if (e.target === this.overlay) this.close();
      });
    }

    document.getElementById('workspace-save-note')?.addEventListener('click', () => this.saveQuickNote());
    document.getElementById('workspace-add-task')?.addEventListener('click', () => this.addTask());
    document.getElementById('workspace-add-project')?.addEventListener('click', () => this.addProject());
    document.getElementById('workspace-draft-tasks')?.addEventListener('click', () => this.draftTasksFromPage());

    document.getElementById('workspace-task-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.addTask();
      }
    });
    document.getElementById('workspace-project-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.addProject();
      }
    });

    this.body?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-ws-fill]');
      if (!chip || !this.body?.contains(chip)) return;
      const kind = chip.getAttribute('data-ws-fill');
      const val = chip.getAttribute('data-ws-value') || '';
      if (kind === 'note') {
        const ta = document.getElementById('workspace-quick-note');
        if (ta) {
          ta.value = val;
          ta.focus();
        }
      } else if (kind === 'task') {
        const inp = document.getElementById('workspace-task-input');
        if (inp) {
          inp.value = val;
          inp.focus();
          inp.select();
        }
      } else if (kind === 'project') {
        const inp = document.getElementById('workspace-project-input');
        if (inp) {
          inp.value = val;
          inp.focus();
          inp.select();
        }
      }
    });

    document.getElementById('btn-workspace')?.addEventListener('click', () => this.toggle());
  }

  toggle() {
    if (!this.overlay) return;
    this.overlay.classList.contains('visible') ? this.close() : this.open();
  }

  async open() {
    if (!this.overlay) return;
    this.overlay.classList.add('visible');
    this.overlay.setAttribute('aria-hidden', 'false');
    try {
      window.navioEnsureShellOnTopIfWcv?.();
    } catch {
      /* ignore */
    }
    await this.render();
  }

  close() {
    if (!this.overlay) return;
    this.overlay.classList.remove('visible');
    this.overlay.setAttribute('aria-hidden', 'true');
  }

  async render() {
    let r;
    try { r = await window.navio.workspace({ op: 'get' }); }
    catch (e) { console.error('[Workspace] IPC error:', e); return; }
    const w = r.workspace || { tasks: [], projects: [], notes: [] };

    if (this.taskList) {
      this.taskList.innerHTML = (w.tasks || [])
        .map(
          (t) => `
        <div class="workspace-task-row" data-id="${t.id}">
          <input type="checkbox" ${t.done ? 'checked' : ''} data-task-toggle="${t.id}">
          <span style="flex:1;text-decoration:${t.done ? 'line-through' : 'none'}">${escapeHtml(t.title)}</span>
        </div>`
        )
        .join('');
      this.taskList.querySelectorAll('[data-task-toggle]').forEach((cb) => {
        cb.addEventListener('change', async () => {
          await window.navio.workspace({ op: 'toggleTask', taskId: cb.getAttribute('data-task-toggle') });
          this.render();
        });
      });
    }

    if (this.projectList) {
      const proj = w.projects || [];
      const folderSvg =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
      this.projectList.innerHTML =
        proj.length === 0
          ? '<span class="workspace-notes-empty">No projects yet.</span>'
          : proj
            .map(
              (p) =>
                `<div class="workspace-project-card" role="listitem">${folderSvg}<span>${escapeHtml(p.name)}</span></div>`
            )
            .join('');
    }

    if (this.notesList) {
      const notes = (w.notes || []).slice().reverse();
      if (notes.length === 0) {
        this.notesList.innerHTML = '<span class="workspace-notes-empty">No notes yet.</span>';
      } else {
        this.notesList.innerHTML = notes.map((n) => `
          <div class="workspace-note-row">
            <div class="workspace-note-body">${escapeHtml(n.body)}</div>
            ${n.tabUrl ? `<div class="workspace-note-url">${escapeHtml(n.tabUrl)}</div>` : ''}
            <div class="workspace-note-time">${new Date(n.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </div>`).join('');
      }
    }
  }

  async saveQuickNote() {
    const ta = document.getElementById('workspace-quick-note');
    const body = (ta && ta.value) || '';
    const tab = TabManager.getActiveTab();
    await window.navio.workspace({
      op: 'addWorkspaceNote',
      body,
      tabUrl: tab?.url || ''
    });
    if (ta) ta.value = '';
    await this.render();
  }

  async addTask() {
    const input = document.getElementById('workspace-task-input');
    const title = (input && input.value.trim()) || '';
    if (!title) return;
    const tab = TabManager.getActiveTab();
    await window.navio.workspace({
      op: 'addTask',
      title,
      sourceUrl: tab?.url || ''
    });
    input.value = '';
    await this.render();
  }

  async addProject() {
    const input = document.getElementById('workspace-project-input');
    const name = (input && input.value.trim()) || '';
    if (!name) return;
    await window.navio.workspace({ op: 'addProject', name });
    input.value = '';
    await this.render();
  }

  async draftTasksFromPage() {
    if (typeof AssistantManager === 'undefined') return;
    AssistantManager.open();
    const page = await TabManager.getActivePageContent();
    if (!page || page.error) {
      AssistantManager.addMessage('assistant', 'Load a page first to draft tasks.');
      return;
    }
    const prompt = `From the following page text, propose a short bullet list of actionable tasks (max 8). Output only bullets, no preamble.\n\nTitle: ${page.title}\nURL: ${page.url}\n\n${(page.text || '').slice(0, 6000)}`;
    AssistantManager.addMessage('user', 'Draft tasks from this page');
    await AssistantManager.processMessage(prompt, true, 'Draft tasks from this page');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const WorkspaceManager = new WorkspaceManagerClass();
