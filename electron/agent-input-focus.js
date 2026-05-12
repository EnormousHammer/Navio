'use strict';

/**
 * Prepare the guest webContents for agent input.
 *
 * Default (soft): `guestWc.focus()` only — keeps host shell focus (e.g. assistant
 * composer) so the user can keep typing in the sidebar.
 *
 * With `stealHostKeyboardFocus`: blurs ALL host inputs (including the assistant
 * composer) and focuses the matching `<webview>` — needed for CDP Input.insertText
 * in typeByRef, real Ctrl/Cmd+V paste, and sendInputEvent key paths.
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
    await host.executeJavaScript(`
      (function () {
        var id = ${gid};
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
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
