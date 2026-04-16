'use strict';

const { ipcMain, webContents: electronWebContents } = require('electron');
const { wcCanGoBack, wcCanGoForward } = require('./wc-nav-history');

/**
 * Sequential low-risk agent steps (scroll, back, forward).
 * Risky actions (navigate, click, type) continue to use the existing assistant action cards + browser-action IPC.
 */
function registerAgentPlanIpc(ipcMain, { store }) {
  ipcMain.handle('agent-run-plan', async (event, { webContentsId, steps, userConfirmed }) => {
    if (!userConfirmed) {
      return { ok: false, error: 'User confirmation required before running agent plan.' };
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, error: 'No steps' };
    }
    if (steps.length > 25) {
      return { ok: false, error: 'Too many steps (max 25)' };
    }
    const wc = electronWebContents.fromId(webContentsId);
    if (!wc) return { ok: false, error: 'WebContents not found' };

    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const action = step.action;
      const params = step.params || {};
      const r = await executeStep(wc, action, params, store);
      results.push({ step: i, action, ...r });
      if (r.error) return { ok: false, stoppedAt: i, results, error: r.error };
    }
    return { ok: true, results };
  });
}

async function executeStep(wc, action, params, store) {
  if (store) {
    store.appendLedger({
      type: 'agent_step',
      action,
      url: wc.getURL?.() || ''
    });
  }

  // Try to use tool executors from main.js if available
  try {
    const { getToolExecutors } = require('./main');
    const executors = getToolExecutors?.();
    if (executors && executors[action]) {
      return await executors[action](wc, params);
    }
  } catch { /* fall through to built-in actions */ }

  switch (action) {
    case 'goBack':
      if (wcCanGoBack(wc)) wc.goBack();
      return { success: true };
    case 'goForward':
      if (wcCanGoForward(wc)) wc.goForward();
      return { success: true };
    case 'scroll': {
      const dir = (params && params.direction) || 'down';
      await wc.executeJavaScript(
        `window.scrollBy(0, ${dir === 'up' ? '-400' : '400'}); true;`
      );
      return { success: true };
    }
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(100, Number(params.ms) || 500))));
      return { success: true };
    case 'click':
    case 'type_text':
    case 'read_page':
    case 'get_page_text':
    case 'select_option':
    case 'press_key':
    case 'screenshot':
    case 'insert_text':
    case 'navigate':
    case 'go_back':
    case 'go_forward':
      return { error: `Action "${action}" requires the full tool executor context. Use the assistant tool-calling mode instead.` };
    default:
      return {
        error: `Unsupported agent action "${action}". Supported: goBack, goForward, scroll, wait, and all tool-calling actions via assistant.`
      };
  }
}

module.exports = { registerAgentPlanIpc };
