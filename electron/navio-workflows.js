/**
 * Navio Browser – Workflow Recording & Replay
 *
 * Stores named workflows as JSON files in the user data directory.
 * Each workflow is a recorded sequence of tool calls that can be replayed.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let workflowDir = null;

function ensureWorkflowDir() {
  if (workflowDir) return workflowDir;
  workflowDir = path.join(app.getPath('userData'), 'workflows');
  if (!fs.existsSync(workflowDir)) {
    fs.mkdirSync(workflowDir, { recursive: true });
  }
  return workflowDir;
}

function sanitizeName(name) {
  return (name || 'unnamed').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().slice(0, 80);
}

function workflowPath(name) {
  return path.join(ensureWorkflowDir(), `${sanitizeName(name)}.json`);
}

/**
 * Save a workflow with a name and list of tool-call steps.
 * @param {string} name
 * @param {Array<{ tool: string, args: object }>} steps
 * @param {object} [meta] - Optional metadata (description, tags, etc.)
 */
function saveWorkflow(name, steps, meta = {}) {
  const data = {
    name: sanitizeName(name),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    description: meta.description || '',
    tags: meta.tags || [],
    steps: (steps || []).map(s => ({
      tool: s.tool,
      args: s.args || {}
    }))
  };
  fs.writeFileSync(workflowPath(name), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

/**
 * Load a workflow by name. Returns null if not found.
 */
function loadWorkflow(name) {
  const p = workflowPath(name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * List all saved workflows (name, description, step count, date).
 */
function listWorkflows() {
  const dir = ensureWorkflowDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        name: data.name,
        description: data.description || '',
        steps: (data.steps || []).length,
        created: data.created,
        updated: data.updated,
        tags: data.tags || []
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Delete a workflow by name.
 */
function deleteWorkflow(name) {
  const p = workflowPath(name);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}

module.exports = {
  saveWorkflow,
  loadWorkflow,
  listWorkflows,
  deleteWorkflow
};
