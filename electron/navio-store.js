/**
 * Local JSON stores: context graph, workspace, action ledger (append-only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LEDGER_LINES = 5000;

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (e) {
    console.error('navio-store readJson', file, e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('navio-store writeJson', file, e.message);
    return false;
  }
}

function createStore(userData) {
  const graphPath = path.join(userData, 'navio-context-graph.json');
  const workspacePath = path.join(userData, 'navio-workspace.json');
  const ledgerPath = path.join(userData, 'navio-action-ledger.jsonl');
  const assistantChatPath = path.join(userData, 'navio-assistant-chat.json');

  const defaultGraph = {
    version: 1,
    pinnedTabIds: [],
    sessions: [],
    notes: [],
    turns: []
  };

  const defaultWorkspace = {
    version: 1,
    projects: [],
    tasks: [],
    notes: []
  };

  function loadGraph() {
    return readJson(graphPath, { ...defaultGraph });
  }

  function saveGraph(g) {
    return writeJson(graphPath, g);
  }

  function loadWorkspace() {
    return readJson(workspacePath, { ...defaultWorkspace });
  }

  function saveWorkspace(w) {
    return writeJson(workspacePath, w);
  }

  function appendLedger(entry) {
    try {
      const line = JSON.stringify({
        t: Date.now(),
        ...entry
      }) + '\n';
      fs.appendFileSync(ledgerPath, line, 'utf-8');
      trimLedger();
    } catch (e) {
      console.error('appendLedger', e.message);
    }
  }

  function trimLedger() {
    try {
      if (!fs.existsSync(ledgerPath)) return;
      const lines = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean);
      if (lines.length <= MAX_LEDGER_LINES) return;
      const keep = lines.slice(-MAX_LEDGER_LINES);
      fs.writeFileSync(ledgerPath, keep.join('\n') + '\n', 'utf-8');
    } catch (e) { /* ignore */ }
  }

  function hashSnippet(text) {
    if (!text || typeof text !== 'string') return '';
    return crypto.createHash('sha256').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
  }

  /** Persisted OpenAI-style turns for the sidebar assistant (user + assistant string content only). */
  function loadAssistantChat() {
    const fallback = { version: 1, messages: [] };
    const data = readJson(assistantChatPath, fallback);
    if (!data || typeof data !== 'object') return fallback;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    return { version: 1, messages };
  }

  function saveAssistantChat(data) {
    const raw = data && typeof data === 'object' ? data.messages : null;
    let messages = Array.isArray(raw) ? raw : [];
    messages = messages
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string'
      )
      .map((m) => ({ role: m.role, content: m.content }));
    if (messages.length > 80) messages = messages.slice(-60);
    return writeJson(assistantChatPath, { version: 1, messages });
  }

  return {
    graphPath,
    workspacePath,
    ledgerPath,
    assistantChatPath,
    loadGraph,
    saveGraph,
    loadWorkspace,
    saveWorkspace,
    appendLedger,
    hashSnippet,
    loadAssistantChat,
    saveAssistantChat
  };
}

module.exports = { createStore };
