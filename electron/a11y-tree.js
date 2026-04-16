/**
 * Navio Browser – CDP Accessibility Tree extraction, YAML formatting, and
 * ref-id based element resolution.
 *
 * Uses Chromium DevTools Protocol via Electron's webContents.debugger API to
 * get the real accessibility tree (the same data screen readers consume).
 * Outputs a compact YAML representation with ref_N IDs for every interactive
 * element, and provides click/type helpers that resolve ref_N → exact DOM node.
 */

'use strict';

const { ensureGuestWebviewKeyboardFocus } = require('./agent-input-focus');

// ── Module-level ref maps ────────────────────────────────────────────────────
// Key: webContentsId, Value: Map<string, { backendDOMNodeId, role, name }>
const refMaps = new Map();

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'menuitem', 'tab', 'option', 'switch', 'searchbox', 'slider',
  'spinbutton', 'menuitemcheckbox', 'menuitemradio', 'listbox'
]);

// Roles that provide structural context but are not themselves interactive
const STRUCTURAL_ROLES = new Set([
  'navigation', 'main', 'complementary', 'banner', 'contentinfo',
  'search', 'form', 'region', 'dialog', 'alertdialog', 'toolbar',
  'menu', 'menubar', 'tablist', 'tabpanel', 'list', 'listitem',
  'tree', 'treeitem', 'grid', 'row', 'cell', 'columnheader',
  'rowheader', 'group', 'heading', 'article', 'figure'
]);

// ── CDP tree extraction ──────────────────────────────────────────────────────

/**
 * Attaches the CDP debugger, fetches the full accessibility tree, transforms it
 * to YAML with ref_ids, and stores the refMap for later click resolution.
 *
 * Returns { yaml, url, title } or null if CDP fails (e.g. DevTools is open).
 */
async function getAccessibilityTreeOnce(wc, opts = {}) {
  const { filter = 'all', depth = 15, refId, maxChars = 50000 } = opts;
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree', {
      depth
    });
    const { yaml, refMap } = buildYamlTree(nodes, filter, maxChars, refId);
    refMaps.set(wc.id, refMap);
    return { yaml, url: wc.getURL(), title: wc.getTitle() };
  } catch (err) {
    console.log('[navio] CDP accessibility tree attempt failed:', err.message);
    return null;
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

async function getAccessibilityTree(wc, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await getAccessibilityTreeOnce(wc, opts);
    if (res) return res;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 220 * (attempt + 1)));
  }
  console.log('[navio] CDP accessibility tree failed after retries, will use fallback');
  return null;
}

/**
 * Transforms the flat CDP AXNode[] into a compact YAML tree with ref_ids for
 * interactive elements.
 *
 * Each AXNode has: { nodeId, backendDOMNodeId, parentId, role, name, childIds, ... }
 * (backendDOMNodeId is the DOM node identifier used by DOM.resolveNode)
 */
function buildYamlTree(nodes, filter, maxChars, scopeRefId) {
  if (!nodes || !nodes.length) return { yaml: '(empty page)', refMap: new Map() };

  // Build a lookup by nodeId
  const byId = new Map();
  for (const n of nodes) {
    byId.set(n.nodeId, n);
  }

  const refMap = new Map();
  let refCounter = 1;

  // Determine the effective role string from an AXNode
  function getRole(node) {
    if (!node.role) return 'none';
    return node.role.value || 'none';
  }

  // Extract the accessible name
  function getName(node) {
    if (!node.name) return '';
    return (node.name.value || '').trim();
  }

  // Check if a role is interactive
  function isInteractive(role) {
    return INTERACTIVE_ROLES.has(role);
  }

  // Check if a node or any descendant has interactive content
  function hasInteractiveDescendant(node) {
    const role = getRole(node);
    if (isInteractive(role)) return true;
    const children = node.childIds || [];
    for (const cid of children) {
      const child = byId.get(cid);
      if (child && hasInteractiveDescendant(child)) return true;
    }
    return false;
  }

  // Recursive YAML builder
  let output = '';
  let charCount = 0;
  let truncated = false;

  function emitLine(indent, text) {
    if (truncated) return;
    const line = '  '.repeat(indent) + text + '\n';
    if (charCount + line.length > maxChars) {
      output += '  '.repeat(indent) + '... (truncated)\n';
      truncated = true;
      return;
    }
    output += line;
    charCount += line.length;
  }

  function walkNode(nodeId, indentLevel) {
    if (truncated) return;
    const node = byId.get(nodeId);
    if (!node) return;

    const role = getRole(node);
    const name = getName(node);

    // Skip ignored/invisible nodes
    if (role === 'none' || role === 'generic' || role === 'InlineTextBox' ||
        role === 'LineBreak' || role === 'StaticText') {
      // For StaticText, emit if filter is 'all' and has meaningful content
      if (role === 'StaticText' && filter === 'all' && name && name.length > 1) {
        emitLine(indentLevel, `text "${truncName(name)}"`);
      }
      // Walk children for 'generic'/'none' containers
      if (role === 'none' || role === 'generic') {
        const children = node.childIds || [];
        for (const cid of children) walkNode(cid, indentLevel);
      }
      return;
    }

    // In 'interactive' filter mode, skip non-interactive subtrees entirely
    if (filter === 'interactive' && !isInteractive(role) && !STRUCTURAL_ROLES.has(role)) {
      if (!hasInteractiveDescendant(node)) return;
    }

    // Build the line: role [ref_N] ["name"]
    let line = role;
    if (isInteractive(role) && node.backendDOMNodeId) {
      const ref = `ref_${refCounter++}`;
      refMap.set(ref, {
        backendDOMNodeId: node.backendDOMNodeId,
        role,
        name
      });
      line += ` ${ref}`;
    }
    if (name) {
      line += ` "${truncName(name)}"`;
    }

    // In interactive filter, skip non-interactive structural nodes that have
    // no name and only pass through to children
    if (filter === 'interactive' && !isInteractive(role) && !name && STRUCTURAL_ROLES.has(role)) {
      const children = node.childIds || [];
      if (children.length === 1) {
        walkNode(children[0], indentLevel);
        return;
      }
    }

    emitLine(indentLevel, line);

    const children = node.childIds || [];
    for (const cid of children) {
      walkNode(cid, indentLevel + 1);
    }
  }

  // Find the root (first node, usually WebArea / RootWebArea)
  const root = nodes[0];
  if (root) {
    walkNode(root.nodeId, 0);
  }

  return { yaml: output || '(empty page)', refMap };
}

function truncName(name) {
  if (name.length <= 80) return name.replace(/"/g, '\\"');
  return name.slice(0, 77).replace(/"/g, '\\"') + '...';
}

// ── Ref-based element interaction via CDP ────────────────────────────────────

/**
 * Click an element by its ref_id using CDP DOM.resolveNode → Runtime.callFunctionOn.
 * More reliable than coordinate-based clicking: auto-scrolls, uses exact node.
 */
async function clickByRef(wc, refId) {
  const refMap = refMaps.get(wc.id);
  if (!refMap || !refMap.has(refId)) {
    return { error: `Unknown ref "${refId}". Call read_page to refresh the element list.` };
  }
  await ensureGuestWebviewKeyboardFocus(wc);
  const { backendDOMNodeId } = refMap.get(refId);
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    const { object } = await wc.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: backendDOMNodeId
    });
    await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        this.focus();
        this.click();
      }`,
      awaitPromise: false
    });
    try {
      await wc.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
    } catch { /* ignore */ }
    return { success: true };
  } catch (err) {
    return { error: `clickByRef failed: ${err.message}` };
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Type into an element identified by ref_id.
 * Focuses the element, clears it, then inserts text via Input.insertText CDP.
 */
async function typeByRef(wc, refId, value) {
  const refMap = refMaps.get(wc.id);
  if (!refMap || !refMap.has(refId)) {
    return { error: `Unknown ref "${refId}". Call read_page to refresh the element list.` };
  }
  await ensureGuestWebviewKeyboardFocus(wc);
  const { backendDOMNodeId } = refMap.get(refId);
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    const { object } = await wc.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: backendDOMNodeId
    });
    // Focus, select all existing text, then insert new value
    await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        this.focus();
        if (this.select) this.select();
        else if (this.setSelectionRange) this.setSelectionRange(0, this.value?.length || 0);
      }`,
      awaitPromise: false
    });
    await wc.debugger.sendCommand('Input.insertText', { text: value });
    try {
      await wc.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
    } catch { /* ignore */ }
    return { success: true };
  } catch (err) {
    return { error: `typeByRef failed: ${err.message}` };
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Select an option in a <select> element identified by ref_id.
 */
async function selectByRef(wc, refId, optionValue) {
  const refMap = refMaps.get(wc.id);
  if (!refMap || !refMap.has(refId)) {
    return { error: `Unknown ref "${refId}". Call read_page to refresh the element list.` };
  }
  const { backendDOMNodeId } = refMap.get(refId);
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    const { object } = await wc.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId: backendDOMNodeId
    });
    const optVal = JSON.stringify(optionValue);
    await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        this.focus();
        const val = ${optVal};
        for (const opt of this.options || []) {
          if (opt.value === val || opt.textContent.trim() === val) {
            opt.selected = true;
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }`,
      awaitPromise: false
    });
    try {
      await wc.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId });
    } catch { /* ignore */ }
    return { success: true };
  } catch (err) {
    return { error: `selectByRef failed: ${err.message}` };
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Get the refMap for a given webContentsId (used externally by tool executors).
 */
function getRefMap(wcId) {
  return refMaps.get(wcId);
}

/**
 * Clear stored refMap for a webContents (call when tab is destroyed).
 */
function clearRefMap(wcId) {
  refMaps.delete(wcId);
}

module.exports = {
  getAccessibilityTree,
  clickByRef,
  typeByRef,
  selectByRef,
  getRefMap,
  clearRefMap
};
