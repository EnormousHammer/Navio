'use strict';

/**
 * Electron deprecates webContents.canGoBack / canGoForward in favor of
 * webContents.navigationHistory.* — use these helpers everywhere in main.
 */
function wcCanGoBack(wc) {
  if (!wc) return false;
  const nh = wc.navigationHistory;
  if (nh && typeof nh.canGoBack === 'function') return nh.canGoBack();
  return typeof wc.canGoBack === 'function' && wc.canGoBack();
}

function wcCanGoForward(wc) {
  if (!wc) return false;
  const nh = wc.navigationHistory;
  if (nh && typeof nh.canGoForward === 'function') return nh.canGoForward();
  return typeof wc.canGoForward === 'function' && wc.canGoForward();
}

module.exports = { wcCanGoBack, wcCanGoForward };
