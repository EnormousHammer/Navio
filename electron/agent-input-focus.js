'use strict';

/**
 * Move keyboard focus from the shell (e.g. assistant textarea) to the guest page
 * inside <webview>, so sendInputEvent / clipboard paste and CDP text input target the tab.
 */
async function ensureGuestWebviewKeyboardFocus(guestWc) {
  if (!guestWc || guestWc.isDestroyed()) return;
  try {
    guestWc.focus();
  } catch {
    /* ignore */
  }
  const host = guestWc.hostWebContents;
  if (!host || host.isDestroyed()) return;
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
