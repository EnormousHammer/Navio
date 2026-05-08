'use strict';

const { Menu, MenuItem, shell, clipboard, session, webContents } = require('electron');
const { NAVIO_PARTITION_INCOGNITO } = require('./navio-partitions');
const { resolveTranslateTargetLang } = require('./translate-locale');
const { wcCanGoBack, wcCanGoForward } = require('./wc-nav-history');
const { navioIsExternalProtocolUrl, navioNormalizeTabOpenUrl } = require('./navio-url-utils');
const navioSiteCompat = require('./site-compat');

function registerContextMenuIpc(ipcMain, { getMainWindow, loadConfig, app }) {
  ipcMain.handle('show-webview-context-menu', (event, { webContentsId, x, y, params }) => {
    try {
      const wc = webContents.fromId(webContentsId);
      if (!wc) return;
      const mainWindow = getMainWindow();

      const menu = new Menu();

      const openInNewTab = (url) => {
        if (!url || !mainWindow) return;
        if (navioIsExternalProtocolUrl(url)) {
          try { shell.openExternal(url); } catch { /* ignore */ }
          return;
        }
        const openUrl = navioNormalizeTabOpenUrl(url);
        if (!openUrl) return;
        try {
          const incognito = wc.session === session.fromPartition(NAVIO_PARTITION_INCOGNITO);
          mainWindow.webContents.send('open-url-in-new-tab', { url: openUrl, incognito });
        } catch {
          mainWindow.webContents.send('open-url-in-new-tab', { url: openUrl, incognito: false });
        }
      };

      if (params.selectionText) {
        const selText = params.selectionText.trim();
        menu.append(new MenuItem({ label: 'Copy', role: 'copy', click: () => wc.copy() }));
        if (selText.length > 0) {
          const preview = selText.length > 40 ? selText.slice(0, 40) + '…' : selText;
          const cfg = loadConfig();
          const se = cfg.searchEngine || 'https://www.google.com/search?q=';
          menu.append(new MenuItem({
            label: `Search for "${preview}"`,
            click: () => openInNewTab(se + encodeURIComponent(selText.slice(0, 500))),
          }));
        }
        menu.append(new MenuItem({ type: 'separator' }));
      }

      if (params.isEditable) {
        menu.append(new MenuItem({ label: 'Cut',        role: 'cut',       click: () => wc.cut() }));
        menu.append(new MenuItem({ label: 'Copy',       role: 'copy',      click: () => wc.copy() }));
        menu.append(new MenuItem({ label: 'Paste',      role: 'paste',     click: () => wc.paste() }));
        menu.append(new MenuItem({ label: 'Select All', role: 'selectAll', click: () => wc.selectAll() }));
        menu.append(new MenuItem({ type: 'separator' }));
      }

      if (params.linkURL) {
        menu.append(new MenuItem({ label: 'Open Link in New Tab', click: () => openInNewTab(params.linkURL) }));
        menu.append(new MenuItem({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }));
        menu.append(new MenuItem({ type: 'separator' }));
      }

      if (params.mediaType === 'image' && params.srcURL) {
        menu.append(new MenuItem({ label: 'Open Image in New Tab', click: () => openInNewTab(params.srcURL) }));
        menu.append(new MenuItem({
          label: 'Copy Image',
          click: () => { try { wc.copyImageAt(x, y); } catch { clipboard.writeText(params.srcURL); } },
        }));
        menu.append(new MenuItem({
          label: 'Save Image As…',
          click: () => { try { wc.downloadURL(params.srcURL); } catch { /* ignore */ } },
        }));
        menu.append(new MenuItem({ type: 'separator' }));
      }

      try {
        const pageUrl = (params && params.pageURL) || wc.getURL() || '';
        if (/^https?:\/\//i.test(pageUrl)) {
          const tl = resolveTranslateTargetLang(app, loadConfig());
          const trUrl =
            'https://translate.google.com/translate?sl=auto&tl=' +
            encodeURIComponent(tl) +
            '&u=' +
            encodeURIComponent(pageUrl);
          menu.append(new MenuItem({ label: 'Translate page', click: () => openInNewTab(trUrl) }));
          menu.append(new MenuItem({
            label: 'Open page in default browser',
            click: () => {
              try {
                shell.openExternal(pageUrl);
              } catch {
                /* ignore */
              }
            }
          }));
          menu.append(new MenuItem({ type: 'separator' }));
        }
      } catch { /* ignore */ }

      menu.append(new MenuItem({ label: 'Back',    click: () => { if (wcCanGoBack(wc))    wc.goBack();    }, enabled: wcCanGoBack(wc) }));
      menu.append(new MenuItem({ label: 'Forward', click: () => { if (wcCanGoForward(wc)) wc.goForward(); }, enabled: wcCanGoForward(wc) }));
      menu.append(new MenuItem({ label: 'Reload',  click: () => wc.reload() }));
      menu.append(new MenuItem({ label: 'Print…',  click: () => wc.print({ silent: false, printBackground: true }) }));

      try {
        const srcUrl = wc.getURL();
        if (/^https?:\/\//i.test(srcUrl)) {
          menu.append(new MenuItem({
            label: 'View Page Source',
            click: () => openInNewTab(`view-source:${srcUrl}`),
          }));
        }
      } catch { /* ignore */ }

      try {
        const curZoom = wc.getZoomFactor();
        const zoomSub = new Menu();
        zoomSub.append(new MenuItem({
          label: 'Zoom In',
          click: () => { wc.setZoomFactor(Math.min(3, curZoom + 0.1)); mainWindow.webContents.send('shortcut', 'refresh-zoom-label'); },
        }));
        zoomSub.append(new MenuItem({
          label: 'Zoom Out',
          click: () => { wc.setZoomFactor(Math.max(0.25, curZoom - 0.1)); mainWindow.webContents.send('shortcut', 'refresh-zoom-label'); },
        }));
        zoomSub.append(new MenuItem({
          label: `Reset Zoom (${Math.round(curZoom * 100)}%)`,
          click: () => { wc.setZoomFactor(1); mainWindow.webContents.send('shortcut', 'refresh-zoom-label'); },
        }));
        menu.append(new MenuItem({ label: 'Zoom', submenu: zoomSub }));
      } catch { /* ignore */ }

      // Per-site Compatibility Mode toggle: lets the user opt out of all
      // Navio page-level injections for the current origin (selection toolbar,
      // password autofill detection, login form observer, etc.) when those
      // injections break a third-party site (carrier portals, banking, gov
      // forms, etc.). Toggling reloads the tab so the preload picks up the
      // new state from the main-process store.
      try {
        const pageUrl = (params && params.pageURL) || wc.getURL() || '';
        const compatOrigin = navioSiteCompat.originFromUrl(pageUrl);
        if (compatOrigin) {
          const userData = app.getPath('userData');
          const isOn = navioSiteCompat.isCompat(userData, pageUrl);
          let host = compatOrigin;
          try { host = new URL(compatOrigin).host || compatOrigin; } catch { /* keep origin */ }
          menu.append(new MenuItem({ type: 'separator' }));
          menu.append(new MenuItem({
            label: isOn
              ? `Compatibility Mode is ON for ${host} (click to disable)`
              : `Use Compatibility Mode for ${host}`,
            type: 'checkbox',
            checked: isOn,
            click: () => {
              try {
                navioSiteCompat.setCompat(userData, pageUrl, !isOn);
                if (mainWindow && !mainWindow.isDestroyed()) {
                  // Notify the renderer so the URL bar badge can update.
                  try {
                    mainWindow.webContents.send('navio-site-compat-changed', {
                      origin: compatOrigin,
                      enabled: !isOn
                    });
                  } catch { /* ignore */ }
                }
                // Reload the page so webview-preload re-evaluates the kill switch.
                try { wc.reload(); } catch { /* ignore */ }
              } catch (err) {
                console.error('[navio] toggle compat mode failed:', err && err.message ? err.message : err);
              }
            }
          }));
        }
      } catch { /* ignore */ }

      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Inspect Element', click: () => wc.openDevTools({ mode: 'detach' }) }));

      menu.popup({ window: mainWindow });
    } catch (e) {
      console.error('[navio] context-menu error:', e.message);
    }
  });
}

module.exports = { registerContextMenuIpc };
