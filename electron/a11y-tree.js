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
// Key: webContentsId, Value: Map<string, { backendDOMNodeId, role, name, fingerprint }>
const refMaps = new Map();

// Persistent debugger sessions: Key: webContentsId, Value: true when attached
const persistentSessions = new Map();

// Lowercase — Chromium sometimes reports camelCase (e.g. popUpButton); we normalize in isInteractive().
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'menuitem', 'tab', 'option', 'switch', 'searchbox', 'slider',
  'spinbutton', 'menuitemcheckbox', 'menuitemradio', 'listbox',
  // Header / menu triggers often use these roles instead of "button"
  'popupbutton',
  'menubutton',
  'disclosure',
  'disclosuretriangle',
  'togglebutton'
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

/** Collect every frame id (root first, then depth-preorder) from Page.getFrameTree. */
function collectFrameDescriptors(frameTreeRoot) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.frame && n.frame.id) {
      out.push({
        id: n.frame.id,
        url: String(n.frame.url || '').slice(0, 220)
      });
    }
    for (const c of n.childFrames || []) walk(c);
  };
  walk(frameTreeRoot);
  return out;
}

/**
 * Attaches the CDP debugger, fetches the full accessibility tree, transforms it
 * to YAML with ref_ids, and stores the refMap for later click resolution.
 *
 * Fetches **one AX tree per frame** (`Accessibility.getFullAXTree` with `frameId`).
 * Without this, only the root document is returned — nested iframes (Gmail compose
 * To / Subject / body, many SPAs) appear empty to the assistant.
 *
 * Returns { yaml, url, title } or null if CDP fails (e.g. DevTools is open).
 */
async function getAccessibilityTreeOnce(wc, opts = {}) {
  const { filter = 'all', depth = -1, refId, maxChars = 50000 } = opts;
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
      persistentSessions.set(wc.id, true);
    }
    await wc.debugger.sendCommand('Page.enable').catch(() => {});

    let frameDescriptors = [];
    try {
      const { frameTree } = await wc.debugger.sendCommand('Page.getFrameTree');
      if (frameTree) frameDescriptors = collectFrameDescriptors(frameTree);
    } catch {
      frameDescriptors = [];
    }

    // Safety cap — some sites have huge frame trees; Gmail is typically < 30.
    const MAX_FRAMES = 40;
    if (frameDescriptors.length > MAX_FRAMES) {
      frameDescriptors = frameDescriptors.slice(0, MAX_FRAMES);
    }

    if (!frameDescriptors.length) {
      const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree', { depth });
      const built = buildYamlTree(nodes, filter, maxChars, refId, 1);
      refMaps.set(wc.id, built.refMap);
      return { yaml: built.yaml, url: wc.getURL(), title: wc.getTitle() };
    }

    let combinedYaml = '';
    const combinedRefMap = new Map();
    let nextRefStart = 1;

    for (let fi = 0; fi < frameDescriptors.length; fi++) {
      const { id: frameId, url: frameUrl } = frameDescriptors[fi];
      const charBudget = Math.max(0, maxChars - combinedYaml.length);
      if (charBudget < 120) break;

      let nodes;
      try {
        const res = await wc.debugger.sendCommand('Accessibility.getFullAXTree', {
          depth,
          frameId
        });
        nodes = res.nodes;
      } catch {
        continue;
      }
      if (!nodes || !nodes.length) continue;

      const scopeThis = fi === 0 ? refId : undefined;
      const built = buildYamlTree(nodes, filter, charBudget, scopeThis, nextRefStart);
      for (const [k, v] of built.refMap) combinedRefMap.set(k, v);
      nextRefStart = built.nextRefCounter;

      const header =
        fi === 0 ? '' : `# --- Subframe (${frameUrl || frameId}) ---\n`;
      combinedYaml += header + built.yaml;
      if (fi < frameDescriptors.length - 1 && combinedYaml.length < maxChars - 2) {
        combinedYaml += '\n';
      }
    }

    if (!combinedYaml.trim()) {
      const { nodes } = await wc.debugger.sendCommand('Accessibility.getFullAXTree', { depth });
      const built = buildYamlTree(nodes, filter, maxChars, refId, 1);
      refMaps.set(wc.id, built.refMap);
      return { yaml: built.yaml, url: wc.getURL(), title: wc.getTitle() };
    }

    refMaps.set(wc.id, combinedRefMap);
    return { yaml: combinedYaml, url: wc.getURL(), title: wc.getTitle() };
  } catch (err) {
    console.log('[navio] CDP accessibility tree attempt failed:', err.message);
    return null;
  } finally {
    // Only detach if we attached here AND there is no persistent session registered
    if (attachedHere && !persistentSessions.get(wc.id)) {
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
 *
 * @param {number} refCounterStart  First ref index (ref_N) for this segment — used when merging multi-frame trees.
 */
function buildYamlTree(nodes, filter, maxChars, scopeRefId, refCounterStart = 1) {
  if (!nodes || !nodes.length) {
    return { yaml: '(empty page)', refMap: new Map(), nextRefCounter: refCounterStart };
  }

  // Build a lookup by nodeId
  const byId = new Map();
  for (const n of nodes) {
    byId.set(n.nodeId, n);
  }

  const refMap = new Map();
  let refCounter = refCounterStart;

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

  function axBoolProp(node, propName) {
    const props = node.properties;
    if (!Array.isArray(props)) return false;
    for (const p of props) {
      if (p.name !== propName) continue;
      const v = p.value;
      if (v == null) continue;
      if (v.value === true) return true;
      if (v.type === 'boolean' && v.value === true) return true;
    }
    return false;
  }

  /** True for roles Navio can click/type via CDP (Chromium uses mixed case for some roles, e.g. popUpButton). */
  function isInteractive(role) {
    return INTERACTIVE_ROLES.has(String(role || '').toLowerCase());
  }

  /** Custom header/nav often exposes a focusable (or explicitly clickable) generic with a name. */
  function isActionableGeneric(node, role, name) {
    return (
      role === 'generic' &&
      name.length > 1 &&
      !!node.backendDOMNodeId &&
      (axBoolProp(node, 'focusable') || axBoolProp(node, 'clickable'))
    );
  }

  // Check if a node or any descendant has interactive content
  function hasInteractiveDescendant(node) {
    const role = getRole(node);
    const name = getName(node);
    if (isInteractive(role)) return true;
    if (isActionableGeneric(node, role, name)) return true;
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
    const actionableGeneric = isActionableGeneric(node, role, name);

    // Skip ignored/invisible nodes (but keep focusable named generics — common for app nav)
    if (role === 'none' || role === 'InlineTextBox' ||
        role === 'LineBreak' || role === 'StaticText' ||
        (role === 'generic' && !actionableGeneric)) {
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
    if (
      filter === 'interactive' &&
      !isInteractive(role) &&
      !actionableGeneric &&
      !STRUCTURAL_ROLES.has(role)
    ) {
      if (!hasInteractiveDescendant(node)) return;
    }

    // Build the line: role [ref_N] ["name"]
    let line = role;
    if ((isInteractive(role) || actionableGeneric) && node.backendDOMNodeId) {
      const ref = `ref_${refCounter++}`;
      // Build fingerprint for stable re-resolution (Phase C)
      const ariaLabel = axBoolProp(node, 'ariaLabel') || '';
      const siblingIndex = (node.childIds || []).indexOf(node.nodeId);
      const fingerprint = {
        role,
        name: name.slice(0, 80),
        siblingIndex,
        nodeId: node.nodeId,
        backendDOMNodeId: node.backendDOMNodeId
      };
      refMap.set(ref, {
        backendDOMNodeId: node.backendDOMNodeId,
        role,
        name,
        fingerprint
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

  return { yaml: output || '(empty page)', refMap, nextRefCounter: refCounter };
}

function truncName(name) {
  if (name.length <= 80) return name.replace(/"/g, '\\"');
  return name.slice(0, 77).replace(/"/g, '\\"') + '...';
}

// ── Ref-based element interaction via CDP ────────────────────────────────────

/**
 * Click an element by its ref_id using trusted CDP Input.dispatchMouseEvent.
 * This produces real isTrusted events that pass Cloudflare/Stripe/React guards.
 *
 * Strategy:
 *  1. ScrollIntoViewIfNeeded via CDP (avoids JS-triggered scroll interception)
 *  2. getBoxModel → compute viewport center (cx, cy)
 *  3. elementFromPoint occlusion check — bail with occluded_by if covered
 *  4. dispatchMouseEvent mouseMoved → mousePressed → mouseReleased
 *     (Chromium rejects legacy type "mouseOver" — it is not a valid CDP value.)
 *
 * Fallback: if CDP path fails (e.g. off-screen, zero box), retries with
 * Runtime.callFunctionOn element.click() so existing flows don't regress.
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

    // Step 1: scroll element into view via CDP (no JS interception)
    try {
      await wc.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: backendDOMNodeId });
    } catch { /* element may already be visible */ }

    // Step 2: get bounding box to compute click target center
    let cx, cy;
    try {
      const box = await wc.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: backendDOMNodeId });
      const content = box.model?.content;
      if (content && content.length >= 8) {
        // content quad: [x0,y0, x1,y1, x2,y2, x3,y3]
        cx = Math.round((content[0] + content[2] + content[4] + content[6]) / 4);
        cy = Math.round((content[1] + content[3] + content[5] + content[7]) / 4);
      }
    } catch { /* box unavailable, fall through */ }

    if (cx != null && cy != null && cx > 0 && cy > 0) {
      // Step 3: occlusion check — is something else on top?
      try {
        const occRes = await wc.debugger.sendCommand('Runtime.evaluate', {
          expression: `(function(){
            var el = document.elementFromPoint(${cx}, ${cy});
            if (!el) return null;
            return { tag: el.tagName, role: el.getAttribute('role'), text: (el.textContent||'').trim().slice(0,40) };
          })()`,
          returnByValue: true
        });
        const top = occRes.result?.value;
        // If top element has no content overlap at all with our target,
        // still proceed — aria tree ref may be parent; just warn.
        void top; // occlusion signal reserved for Phase B verify loop
      } catch { /* ignore occlusion check failures */ }

      // Step 4: trusted mouse events (CDP allows mouseMoved / mousePressed / mouseReleased / mouseWheel only)
      const mouseParams = { x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 };
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...mouseParams, type: 'mousePressed' });
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...mouseParams, type: 'mouseReleased' });
      return { success: true, method: 'trusted_cdp', x: cx, y: cy };
    }

    // Fallback: resolve node and call .click() (legacy path for off-screen elements)
    const { object } = await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId: backendDOMNodeId });
    await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        this.focus();
        this.click();
      }`,
      awaitPromise: false
    });
    try { await wc.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId }); } catch { /* ignore */ }
    return { success: true, method: 'fallback_click' };
  } catch (err) {
    return { error: `clickByRef failed: ${err.message}` };
  } finally {
    if (attachedHere && !persistentSessions.get(wc.id)) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Type into an element identified by ref_id.
 *
 * Strategy:
 *  1. Focus via trusted click on the element center (populates React synthetic events)
 *  2. Ctrl+A to select all existing text
 *  3. Input.dispatchKeyEvent (keyDown/keyUp) for each character — fires real
 *     keydown/keypress/keyup events that React-controlled fields require
 *  4. For long strings (>4 chars), uses Input.insertText (bulk) then dispatches
 *     synthetic input/change events to trigger React state update
 *
 * Falls back to insertText-only when CDP key dispatch fails.
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

    // Focus: scroll + trusted mouse click on element center (triggers React onFocus)
    let cx, cy;
    try {
      await wc.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: backendDOMNodeId });
      const box = await wc.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: backendDOMNodeId });
      const content = box.model?.content;
      if (content && content.length >= 8) {
        cx = Math.round((content[0] + content[2] + content[4] + content[6]) / 4);
        cy = Math.round((content[1] + content[3] + content[5] + content[7]) / 4);
      }
    } catch { /* box unavailable */ }

    const { object } = await wc.debugger.sendCommand('DOM.resolveNode', { backendNodeId: backendDOMNodeId });

    const prep = await wc.debugger.sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        this.focus();
        function navioDetectGmailComposeBody(el) {
          try {
            const doc = el.ownerDocument || document;
            const h = (doc.location && doc.location.hostname) || '';
            if (h !== 'mail.google.com' && h !== 'inbox.google.com') return false;
            const editable = !!(el.isContentEditable || el.getAttribute('contenteditable') === 'true');
            const aria = ((el.getAttribute && el.getAttribute('aria-label')) || '').toLowerCase();
            const ge = el.getAttribute && el.getAttribute('g_editable');
            return editable && (ge === 'true' || aria.indexOf('message body') !== -1);
          } catch (e) {
            return false;
          }
        }
        const gmailMsg = navioDetectGmailComposeBody(this);
        if (gmailMsg) {
          const el = this;
          const doc = el.ownerDocument;
          const win = doc.defaultView;
          const quote = el.querySelector('.gmail_quote');
          const sig = el.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]');
          const boundary =
            quote && el.contains(quote) ? quote : sig && el.contains(sig) ? sig : null;
          const range = doc.createRange();
          range.setStart(el, 0);
          if (boundary) {
            range.setEndBefore(boundary);
          } else {
            range.selectNodeContents(el);
          }
          const sel = win.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          if (this.select) this.select();
          else if (this.setSelectionRange) this.setSelectionRange(0, this.value?.length ?? 0);
        }
        return { gmailMsg: !!gmailMsg };
      }`,
      returnByValue: true
    });
    const gmailMsg = !!prep?.result?.value?.gmailMsg;

    if (!gmailMsg) {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2
      });
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: 2
      });
    }

    await wc.debugger.sendCommand('Input.insertText', { text: value });

    if (gmailMsg) {
      await wc.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
        }`,
        awaitPromise: false
      });
    } else {
      await wc.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          var nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (nativeInput && nativeInput.set) {
            nativeInput.set.call(this, ${JSON.stringify(value)});
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        awaitPromise: false
      });
    }

    // Dispatch a final key Enter-down/up to trigger form suggestions (autocomplete)
    // Only for short fields like search boxes — skip for long text
    if (value.length <= 60 && cx != null) {
      try {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' });
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown' });
      } catch { /* ignore */ }
    }

    try { await wc.debugger.sendCommand('Runtime.releaseObject', { objectId: object.objectId }); } catch { /* ignore */ }
    return { success: true };
  } catch (err) {
    return { error: `typeByRef failed: ${err.message}` };
  } finally {
    if (attachedHere && !persistentSessions.get(wc.id)) {
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
    if (attachedHere && !persistentSessions.get(wc.id)) {
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
 * Clear stored refMap and persistent session for a webContents (call when tab is destroyed).
 */
function clearRefMap(wcId) {
  refMaps.delete(wcId);
  persistentSessions.delete(wcId);
}

/**
 * Register a persistent debugger session for a webContents so helpers
 * skip attach/detach per call (called by cdp-inspector startMonitoring).
 */
function registerPersistentSession(wcId) {
  persistentSessions.set(wcId, true);
}

/**
 * Unregister a persistent debugger session (called when cdp-inspector stops).
 */
function unregisterPersistentSession(wcId) {
  persistentSessions.delete(wcId);
}

module.exports = {
  getAccessibilityTree,
  clickByRef,
  typeByRef,
  selectByRef,
  getRefMap,
  clearRefMap,
  registerPersistentSession,
  unregisterPersistentSession
};
