'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function memoryPath() {
  return path.join(app.getPath('userData'), 'navio-memory.json');
}
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(memoryPath(), 'utf8')); }
  catch { return { facts: [] }; }
}
function saveMemory(data) {
  fs.writeFileSync(memoryPath(), JSON.stringify(data, null, 2), 'utf8');
}

/** Drop facts older than memoryRetentionDays (from config); 0 = keep forever. */
function pruneMemoryByRetention(loadConfig) {
  try {
    const cfg = loadConfig();
    const days = Number(cfg.memoryRetentionDays) || 0;
    if (days <= 0) return;
    const mem = loadMemory();
    const facts = mem.facts || [];
    const cutoff = Date.now() - days * 86400000;
    const next = facts.filter((f) => {
      const t = new Date(f.createdAt || f.timestamp || 0).getTime();
      if (!t || Number.isNaN(t)) return true;
      return t >= cutoff;
    });
    if (next.length !== facts.length) {
      mem.facts = next;
      saveMemory(mem);
    }
  } catch (e) {
    console.warn('pruneMemoryByRetention', e.message);
  }
}

function buildMemoryBlock(loadConfig) {
  try {
    pruneMemoryByRetention(loadConfig);
    const mem = loadMemory();
    if (!mem.facts || mem.facts.length === 0) return '';
    return '\n\nBROWSER MEMORY (remembered facts about this user — use naturally):\n' +
      mem.facts.map((f) => `- ${f.content}${f.sourceUrl ? ` (source: ${f.sourceUrl})` : ''}`).join('\n');
  } catch { return ''; }
}

const PROFILE_EXTENSIONS = {
  default:    '',
  developer:  '\n\nPROFILE: Developer\n- Prioritize code accuracy, technical depth, and doc links.\n- Use code blocks liberally. Compare tools. Walk through debugging systematically.',
  researcher: '\n\nPROFILE: Researcher\n- Prioritize accuracy, sources, and analytical depth over brevity.\n- Always cite sources. Challenge assumptions. Flag uncertain or contested claims.',
  creator:    '\n\nPROFILE: Creator\n- Help with writing, design thinking, and creative tasks.\n- Be generative — offer variations and unexpected angles. Polish tone and clarity.',
};

function buildProfileBlock(loadConfig) {
  try {
    const cfg = loadConfig();
    return PROFILE_EXTENSIONS[cfg.aiProfile] || '';
  } catch { return ''; }
}

/** Parse and save <navio-memory> blocks emitted by AI responses. */
function extractAndSaveMemory(content) {
  if (!content || typeof content !== 'string') return;
  const match = content.match(/<navio-memory>([\s\S]*?)<\/navio-memory>/i);
  if (!match) return;
  const facts = match[1].split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('save:'))
    .map(l => l.slice(5).trim())
    .filter(Boolean);
  if (facts.length === 0) return;
  const mem = loadMemory();
  if (!mem.facts) mem.facts = [];
  let changed = false;
  for (const fact of facts) {
    let factContent = fact;
    let sourceUrl = '';
    const urlM = String(fact).match(/\|\s*url\s*=\s*(\S+)/i);
    if (urlM) {
      factContent = String(fact).replace(/\|\s*url\s*=\s*\S+/i, '').trim();
      sourceUrl = urlM[1];
    }
    if (!mem.facts.find(f => f.content === factContent)) {
      mem.facts.push({
        id: Date.now() + Math.random(),
        content: factContent,
        type: 'auto',
        category: 'general',
        sourceUrl: sourceUrl || undefined,
        createdAt: new Date().toISOString(),
      });
      changed = true;
    }
  }
  if (changed) saveMemory(mem);
}

function registerMemoryIpc(ipcMain, { loadConfig }) {
  ipcMain.handle('memory-get', () => {
    pruneMemoryByRetention(loadConfig);
    return loadMemory();
  });

  ipcMain.handle('memory-add', (_, { content }) => {
    const mem = loadMemory();
    if (!mem.facts) mem.facts = [];
    if (!content || mem.facts.find(f => f.content === content)) return { ok: false };
    mem.facts.push({ id: Date.now(), content, type: 'manual', createdAt: new Date().toISOString() });
    saveMemory(mem);
    return { ok: true };
  });

  ipcMain.handle('memory-delete', (_, { id }) => {
    const mem = loadMemory();
    mem.facts = (mem.facts || []).filter(f => String(f.id) !== String(id));
    saveMemory(mem);
    return { ok: true };
  });

  ipcMain.handle('memory-clear', () => {
    saveMemory({ facts: [] });
    return { ok: true };
  });

  ipcMain.handle('memory-search', (_, { query }) => {
    const q = (query || '').toLowerCase().trim();
    pruneMemoryByRetention(loadConfig);
    const mem = loadMemory();
    const facts = mem.facts || [];
    if (!q) return { facts };
    return {
      facts: facts.filter((f) => {
        const blob = `${f.content || ''} ${f.sourceUrl || ''} ${f.category || ''}`.toLowerCase();
        return blob.includes(q);
      }),
    };
  });
}

module.exports = {
  registerMemoryIpc,
  loadMemory,
  saveMemory,
  buildMemoryBlock,
  buildProfileBlock,
  extractAndSaveMemory,
};
