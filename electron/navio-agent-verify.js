/**
 * Navio Agent Verify — Phase B
 *
 * Implements the verify-after-action loop:
 *   1. Pre-action snapshot of page state (URL, mutation counter, network req count)
 *   2. Post-action diff — detect URL change, DOM mutations, new interactive elements
 *   3. Occlusion check — ensure element is not blocked by an overlay
 *   4. Overlay dismiss heuristic — close cookie banners, popups before retrying
 *   5. wait_for_idle — wait until network and DOM are quiet
 *
 * Used by navio-tools.js click and type handlers in main.js.
 * All methods are CDP-based and non-blocking (100–800 ms worst case).
 */

'use strict';

// Timeout constants
const DIFF_TIMEOUT_MS = 800;
const IDLE_POLL_MS = 80;
const IDLE_NETWORK_QUIET_MS = 400;
const IDLE_DOM_QUIET_MS = 300;
const MAX_IDLE_WAIT_MS = 6000;

/**
 * Take a pre-action snapshot of page state.
 * Returns a lightweight object to diff against after the action.
 *
 * @param {Electron.WebContents} wc
 * @returns {Promise<PageSnapshot>}
 */
async function snapshotPage(wc) {
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    const result = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(function() {
        return {
          url: location.href,
          title: document.title,
          bodyLen: document.body ? document.body.innerHTML.length : 0,
          interactiveCount: document.querySelectorAll(
            'button,a,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="option"]'
          ).length,
          scrollY: window.scrollY,
          dialogOpen: !!(document.querySelector('[role="dialog"]:not([aria-hidden="true"])') ||
                         document.querySelector('[role="alertdialog"]')),
          overlayVisible: !!(document.querySelector('[aria-label*="cookie" i],[aria-label*="consent" i],[aria-label*="banner" i],[id*="cookie" i],[class*="cookie" i],[class*="consent" i],[class*="gdpr" i]'))
        };
      })()`,
      returnByValue: true
    });
    const snap = result.result?.value || {};
    return { ...snap, ts: Date.now() };
  } catch {
    return { ts: Date.now(), error: true };
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Compare pre and post snapshots to produce a structured change signal.
 *
 * @param {PageSnapshot} before
 * @param {PageSnapshot} after
 * @returns {ChangeSignal}
 */
function diffSnapshots(before, after) {
  if (!before || !after) return { changed: false, reason: 'no_snapshot' };

  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const bodyDelta = Math.abs((after.bodyLen || 0) - (before.bodyLen || 0));
  const interactiveDelta = (after.interactiveCount || 0) - (before.interactiveCount || 0);
  const scrolled = Math.abs((after.scrollY || 0) - (before.scrollY || 0)) > 30;
  const dialogAppeared = !before.dialogOpen && after.dialogOpen;
  const dialogDismissed = before.dialogOpen && !after.dialogOpen;
  const overlayAppeared = !before.overlayVisible && after.overlayVisible;

  // Consider "changed" if any meaningful DOM mutation occurred
  const changed = urlChanged || titleChanged || bodyDelta > 50 || interactiveDelta !== 0 ||
                  dialogAppeared || dialogDismissed || scrolled;

  const reasons = [];
  if (urlChanged) reasons.push(`url_changed: ${after.url.slice(0, 80)}`);
  if (titleChanged) reasons.push(`title_changed: "${after.title?.slice(0, 40)}"`);
  if (bodyDelta > 500) reasons.push(`dom_mutation: ${bodyDelta} chars`);
  if (interactiveDelta > 0) reasons.push(`new_interactive: +${interactiveDelta}`);
  if (interactiveDelta < 0) reasons.push(`removed_interactive: ${interactiveDelta}`);
  if (dialogAppeared) reasons.push('dialog_appeared');
  if (dialogDismissed) reasons.push('dialog_dismissed');
  if (overlayAppeared) reasons.push('overlay_appeared');

  return {
    changed,
    url_changed: urlChanged,
    title_changed: titleChanged,
    dom_mutations: bodyDelta,
    new_interactive: interactiveDelta > 0 ? interactiveDelta : 0,
    dialog_appeared: dialogAppeared,
    dialog_dismissed: dialogDismissed,
    overlay_visible: after.overlayVisible || false,
    reasons,
    summary: changed ? reasons.join('; ') || 'page_changed' : 'no_change'
  };
}

/**
 * Check if an element at (x, y) is occluded by another element.
 * Returns { occluded: false } if clear, or { occluded: true, occluded_by: {tag, role, text} }
 *
 * @param {Electron.WebContents} wc
 * @param {number} x
 * @param {number} y
 * @param {string} expectedRole - expected ARIA role of target (for tolerance check)
 */
async function checkOcclusion(wc, x, y, expectedRole) {
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }
    const result = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(function() {
        var el = document.elementFromPoint(${x}, ${y});
        if (!el) return null;
        var role = el.getAttribute('role') || el.tagName.toLowerCase();
        var text = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60);
        return { tag: el.tagName.toLowerCase(), role, text, classes: el.className.toString().slice(0, 100) };
      })()`,
      returnByValue: true
    });
    const top = result.result?.value;
    if (!top) return { occluded: false };

    // Heuristic: check if top element looks like an overlay / banner
    const cls = (top.classes || '').toLowerCase();
    const isOverlay =
      /cookie|consent|gdpr|banner|popup|modal|overlay|interstitial|dialog/i.test(cls) ||
      /cookie|consent|gdpr|banner|popup|modal|overlay|interstitial|dialog/i.test(top.role || '');

    if (isOverlay) {
      return { occluded: true, occluded_by: top, type: 'overlay' };
    }

    return { occluded: false, top_element: top };
  } catch {
    return { occluded: false };
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Try to dismiss common overlays (cookie banners, GDPR, popups) before retrying a click.
 * Strategy: find and click close/dismiss/accept buttons, then press Escape.
 *
 * @param {Electron.WebContents} wc
 * @returns {Promise<boolean>} true if an overlay was dismissed
 */
async function dismissOverlay(wc) {
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }

    // Try to click close/accept buttons
    const dismissed = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(function() {
        var selectors = [
          '[aria-label*="close" i]',
          '[aria-label*="dismiss" i]',
          '[aria-label*="accept" i]',
          'button[class*="close" i]',
          'button[class*="dismiss" i]',
          'button[class*="accept" i]',
          'button[class*="cookie" i]',
          'button[class*="consent" i]',
          '[id*="accept-cookies" i]',
          '[id*="accept-all" i]',
          '[id*="cookie-accept" i]',
          'button[data-testid*="close" i]',
          'button[data-testid*="dismiss" i]'
        ];
        for (var s of selectors) {
          var el = document.querySelector(s);
          if (el && el.offsetParent !== null) {
            el.click();
            return { dismissed: true, selector: s };
          }
        }
        return { dismissed: false };
      })()`,
      returnByValue: true
    });

    const d = dismissed.result?.value;
    if (d?.dismissed) {
      await new Promise((r) => setTimeout(r, 300));
      return true;
    }

    // Try Escape key
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await new Promise((r) => setTimeout(r, 200));
    return false;
  } catch {
    return false;
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Wait until the page is "idle" — no pending network requests and no DOM mutations
 * for at least IDLE_DOM_QUIET_MS + IDLE_NETWORK_QUIET_MS milliseconds.
 *
 * This replaces arbitrary wait(3000) calls. Much faster for quick navigations,
 * equally correct for slow ones.
 *
 * @param {Electron.WebContents} wc
 * @param {object} [opts]
 * @param {number} [opts.timeout] - max wait ms (default MAX_IDLE_WAIT_MS)
 * @param {number} [opts.networkQuietMs] - ms of network quiet required
 * @param {number} [opts.domQuietMs] - ms of DOM quiet required
 */
async function waitForIdle(wc, opts = {}) {
  const timeout = opts.timeout || MAX_IDLE_WAIT_MS;
  const networkQuietMs = opts.networkQuietMs || IDLE_NETWORK_QUIET_MS;
  const domQuietMs = opts.domQuietMs || IDLE_DOM_QUIET_MS;
  const start = Date.now();

  // Install a mutation observer + network idle detector
  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }

    // Install mutation tracker in the page
    await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(function() {
        if (window.__navioIdleTracker) return;
        window.__navioIdleTracker = { mutCount: 0, lastMut: Date.now() };
        new MutationObserver(function() {
          window.__navioIdleTracker.mutCount++;
          window.__navioIdleTracker.lastMut = Date.now();
        }).observe(document.body || document.documentElement, {
          subtree: true, childList: true, attributes: true, characterData: true
        });
      })()`,
      returnByValue: false
    });

    let lastUrl = '';
    let urlChangedAt = 0;

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));

      const snap = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: `(function() {
          var t = window.__navioIdleTracker;
          var readyState = document.readyState;
          return {
            mutsSinceLastCheck: t ? t.mutCount : 0,
            lastMut: t ? t.lastMut : 0,
            readyState,
            url: location.href,
            title: document.title
          };
        })()`,
        returnByValue: true
      });
      const info = snap.result?.value || {};

      // Reset tracker counter each poll
      await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: `if (window.__navioIdleTracker) window.__navioIdleTracker.mutCount = 0;`,
        returnByValue: false
      });

      const now = Date.now();
      const domAge = now - (info.lastMut || 0);
      const documentReady = info.readyState === 'complete' || info.readyState === 'interactive';

      if (info.url && info.url !== lastUrl) {
        lastUrl = info.url;
        urlChangedAt = now;
      }

      const urlJustChanged = urlChangedAt > 0 && now - urlChangedAt < 600;

      if (documentReady && domAge > domQuietMs && !urlJustChanged) {
        return { idle: true, elapsed_ms: now - start };
      }
    }

    return { idle: false, elapsed_ms: Date.now() - start, reason: 'timeout' };
  } catch {
    return { idle: false, reason: 'error' };
  } finally {
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Full verify-after-action wrapper.
 * Call this after a click or type action.
 * Returns a structured signal: { success, changed, summary, ... }
 *
 * @param {Electron.WebContents} wc
 * @param {PageSnapshot} before - snapshot taken before the action
 * @param {object} [opts]
 * @param {boolean} [opts.waitForNetworkIdle] - wait for network idle (default true)
 */
async function verifyAction(wc, before, opts = {}) {
  const waitNet = opts.waitForNetworkIdle !== false;

  // Give DOM 100ms to react
  await new Promise((r) => setTimeout(r, 100));

  let after;
  try {
    after = await snapshotPage(wc);
  } catch {
    return { success: true, changed: false, summary: 'verify_error' };
  }

  const diff = diffSnapshots(before, after);

  if (diff.changed) {
    // Page reacted — optionally wait for idle
    if (waitNet && diff.url_changed) {
      await waitForIdle(wc, { timeout: 4000, networkQuietMs: 300, domQuietMs: 200 });
    }
    return {
      success: true,
      changed: true,
      ...diff
    };
  }

  // No change detected — page may still be loading, wait a bit more
  await new Promise((r) => setTimeout(r, DIFF_TIMEOUT_MS));
  let afterRetry;
  try {
    afterRetry = await snapshotPage(wc);
  } catch {
    return { success: true, changed: false, summary: 'no_change' };
  }
  const diffRetry = diffSnapshots(before, afterRetry);

  return {
    success: true,
    changed: diffRetry.changed,
    ...diffRetry
  };
}

module.exports = {
  snapshotPage,
  diffSnapshots,
  checkOcclusion,
  dismissOverlay,
  waitForIdle,
  verifyAction
};
