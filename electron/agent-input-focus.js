'use strict';

/**
 * Prepare the guest webContents for agent input.
 *
 * Default (soft): `guestWc.focus()` only — keeps host shell focus (e.g. assistant
 * composer) so the user can keep typing in the sidebar.
 *
 * With `stealHostKeyboardFocus`: also blurs host INPUT/TEXTAREA and focuses the
 * matching `<webview>` — needed for real Ctrl/Cmd+V paste and some `sendInputEvent`
 * key paths (Google Docs canvas, etc.).
 *
 * @param {import('electron').WebContents} guestWc
 * @param {{ stealHostKeyboardFocus?: boolean }} [opts]
 */
async function ensureGuestWebviewKeyboardFocus(guestWc, opts = {}) {
  const stealHostKeyboardFocus = !!(opts && opts.stealHostKeyboardFocus);
  if (!guestWc || guestWc.isDestroyed()) return;
  try {
    guestWc.focus();
  } catch {
    /* ignore */
  }
  if (!stealHostKeyboardFocus) {
    await new Promise((r) => setTimeout(r, 45));
    return;
  }
  const host = guestWc.hostWebContents;
  if (!host || host.isDestroyed()) {
    await new Promise((r) => setTimeout(r, 45));
    return;
  }
  const gid = guestWc.id;
  try {
    // Focus the webview for sendInputEvent delivery but do NOT blur the
    // assistant textarea — the overlay blocks user keystrokes on the page
    // side, and keeping the assistant input focused lets the user keep
    // composing advice / corrections while the agent works.
    await host.executeJavaScript(`
      (function () {
        var id = ${gid};
        var ae = document.activeElement;
        var isAssistantInput = ae && (ae.id === 'assistant-input');
        if (!isAssistantInput && ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
          try { ae.blur(); } catch (e) {}
        }
        var wvs = document.querySelectorAll('webview');
        for (var i = 0; i < wvs.length; i++) {
          var w = wvs[i];
          try {
            if (typeof w.getWebContentsId === 'function' && w.getWebContentsId() === id) {
              w.focus();
              return true;
            }
          } catch (e) {}
        }
        return false;
      })()
    `);
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 45));
}

module.exports = { ensureGuestWebviewKeyboardFocus };
