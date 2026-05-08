'use strict';
/**
 * Webview preload — injected into every page loaded inside persist:navio webviews
 * and WebContentsView tabs (Phase 1 WCV migration).
 * Detects login forms, captures credentials on submit, and handles autofill commands.
 * Communicates with the renderer (tabs.js) via ipcRenderer.sendToHost() in classic
 * <webview> mode, or via ipcRenderer.send('wcv-tab-preload-message', ...) in WCV mode.
 *
 * Per-site Compatibility Mode (kill switch): if the user marked the current
 * origin via the page context menu, we bail out at the very top and do not
 * attach ANY listener. The page then runs as plain Chromium (apart from
 * session-level UA / Sec-CH-UA alignment, which is required for many sites
 * to load at all). The Navio chat-tab bridge is exempted because that's our
 * own internal page, not third-party content.
 */
try {
  const { ipcRenderer, contextBridge } = require('electron');

  // Opaque shells used inside Turnstile / bot UI: run **no** preload code at all here
  // (including navigator/chrome patches). Even defineProperty in these documents can
  // perturb Trusted Types + nonce CSP and reproduces about:srcdoc inline-script blocks.
  try {
    const _h0 = String((typeof location !== 'undefined' && location.href) || '').toLowerCase();
    const _p0 = String((typeof location !== 'undefined' && location.protocol) || '').toLowerCase();
    if (_h0 === 'about:srcdoc' || _p0 === 'data:' || _p0 === 'blob:') {
      throw new Error('navio_site_compat_skip_preload');
    }
  } catch (e) {
    if (e && e.message === 'navio_site_compat_skip_preload') throw e;
  }

  // challenges.cloudflare.com: do not patch navigator / window in JS — Cloudflare
  // probes for instrumentation; main.js already disables AutomationControlled globally.
  let _navioSkipFingerprintJs = false;
  try {
    const ch = String((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
    _navioSkipFingerprintJs =
      ch === 'challenges.cloudflare.com' || ch.endsWith('.challenges.cloudflare.com');
  } catch {
    _navioSkipFingerprintJs = false;
  }

  if (!_navioSkipFingerprintJs) {
    // ── Anti-bot-detection hardening ───────────────────────────────────────
    // Skipped on challenges.cloudflare.com (see above). Opaque shells bail out earlier.
    //
    // 1. navigator.webdriver — belt-and-suspenders; primary fix is main-process switch.
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    } catch {
      /* ignore if already non-configurable */
    }
    //
    // 2. window.chrome — Electron may not populate; most third-party sites only.
    try {
      if (typeof window.chrome === 'undefined' || !window.chrome) {
        Object.defineProperty(window, 'chrome', {
          value: { runtime: {}, loadTimes: function () {}, csi: function () {}, app: {} },
          configurable: true,
          writable: true,
          enumerable: true
        });
      } else if (!window.chrome.runtime) {
        window.chrome.runtime = {};
      }
    } catch {
      /* ignore */
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cloudflare Turnstile and similar widgets nest `about:srcdoc` / cross-origin iframes
   * with strict CSP + Trusted Types. The rest of this preload (MutationObservers, DOM
   * tweaks, cosmetic filters) must NOT run there — it trips TrustedScript / inline CSP
   * errors, yields 403 follow-ups, and surfaces as "Cannot find widget" / verify loops.
   * Same-origin subframes still get hooks (embedded login boxes on the site origin).
   */
  function _navioGuestShouldSkipRestOfPreload() {
    try {
      const href = String((typeof location !== 'undefined' && location.href) || '').toLowerCase();
      const proto = String((typeof location !== 'undefined' && location.protocol) || '').toLowerCase();
      if (_navioSkipFingerprintJs) return true;
      if (href === 'about:srcdoc') return true;
      if (proto === 'data:' || proto === 'blob:') return true;
      if (typeof window !== 'undefined' && window !== window.top) {
        try {
          if (location.origin === window.top.location.origin) return false;
        } catch {
          /* cross-origin iframe */
        }
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }

  if (_navioGuestShouldSkipRestOfPreload()) {
    throw new Error('navio_site_compat_skip_preload');
  }

  /**
   * In classic <webview> mode, process.guestInstanceId is set to a non-zero integer.
   * In WebContentsView (WCV) mode, there is no embedding webview, so it is falsy.
   * sendToHost() delivers directly in webview mode but silently drops messages in WCV mode.
   * In WCV mode we route via ipcMain → tab-manager → renderer instead.
   */
  const _isWcvMode = !process.guestInstanceId;

  function _sendToTabHost(channel, payload) {
    if (_isWcvMode) {
      try {
        ipcRenderer.send('wcv-tab-preload-message', { channel, args: [payload] });
      } catch { /* ignore */ }
    } else {
      try {
        ipcRenderer.sendToHost(channel, payload);
      } catch { /* ignore */ }
    }
  }

  function isNavioChatTabPage() {
    try {
      const pn = String((typeof location !== 'undefined' && location.pathname) || '')
        .replace(/\\/g, '/')
        .toLowerCase();
      const href = String((typeof location !== 'undefined' && location.href) || '').toLowerCase();
      return pn.endsWith('navio-chat-tab.html') || href.includes('navio-chat-tab.html');
    } catch {
      return false;
    }
  }

  /** Full-page in-tab chat — host runs the full agent (tools, connectors); guest only renders + postToHost. */
  if (isNavioChatTabPage()) {
    const navioChatTabApi = {
      getConfig: () => ipcRenderer.invoke('get-config'),
      saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
      /**
       * Full-page chat → shell. Prefer main-process relay: `sendToHost` / `<webview>` `ipc-message`
       * can fail in some embedder stacks; main forwards to the shell with a stable WebContents id.
       */
      postToHost: (payload) => {
        try {
          ipcRenderer.send('navio-chat-host-relay-from-guest', payload);
        } catch {
          _sendToTabHost('navio-chat-host', payload);
        }
      },
      getRecentLogs: (n) => ipcRenderer.invoke('navio-log-get-recent', n || 200),
      /** Same live stream as the shell debug panel (Ctrl+Shift+L), forwarded by main. */
      onLogEntry: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const handler = (_event, entry) => {
          try {
            callback(entry);
          } catch (_) {
            /* ignore */
          }
        };
        ipcRenderer.on('navio-log-entry', handler);
        return () => {
          try {
            ipcRenderer.removeListener('navio-log-entry', handler);
          } catch (_) {
            /* ignore */
          }
        };
      },
      navioTTS: (params) => ipcRenderer.invoke('navio-tts', params),
      readFileForAttachment: (filePath) => ipcRenderer.invoke('read-file-for-attachment', filePath),
      extractAttachmentText: (args) => ipcRenderer.invoke('extract-attachment-text', args)
    };
    /** After reload / in-place navigations, a stale bridged key can make the second expose throw — chat then has no postToHost. */
    function _stripStaleNavioChatTabFromMainWorld() {
      try {
        if (typeof contextBridge.executeInMainWorld !== 'function') return;
        contextBridge.executeInMainWorld({
          func: () => {
            try {
              Reflect.deleteProperty(window, 'navioChatTab');
            } catch (_) {
              /* ignore */
            }
          }
        });
      } catch (_) {
        /* ignore */
      }
    }
    try {
      _stripStaleNavioChatTabFromMainWorld();
      contextBridge.exposeInMainWorld('navioChatTab', navioChatTabApi);
    } catch (e) {
      const msg = String(e && e.message != null ? e.message : e || '');
      if (/exists|already|duplicate|registered/i.test(msg)) {
        try {
          _stripStaleNavioChatTabFromMainWorld();
          contextBridge.exposeInMainWorld('navioChatTab', navioChatTabApi);
        } catch (e2) {
          console.error('[navio] navioChatTab preload re-bridge failed:', e2 && e2.message ? e2.message : e2);
        }
      } else {
        console.error('[navio] navioChatTab preload bridge failed:', msg);
      }
    }
  }

  // ── Per-site Compatibility Mode kill switch ────────────────────────────────
  // Synchronous probe at startup. If the user previously toggled
  // "Compatibility mode" for this origin in the page context menu, we skip
  // every page-level injection so the site behaves like plain Chromium.
  // The Navio internal chat tab is always instrumented (it's our own page).
  //
  // ALWAYS-COMPAT sites: carrier portals and Cloudflare-protected logistics
  // sites where Navio's page-level injections reliably trigger bot walls or
  // break forms. These are auto-opted in regardless of the user preference
  // file — the user can still manually toggle compat off if needed (their
  // explicit choice in the JSON file overrides this default).
  const NAVIO_ALWAYS_COMPAT_RE =
    /[./]purolator\.com(\/|$)|[./]eshiponline\.purolator\.com(\/|$)|[./]tql\.com(\/|$)|^https?:\/\/challenges\.cloudflare\.com\//i;

  if (!isNavioChatTabPage()) {
    let _navioCompatEnabled = false;
    try {
      const here = (typeof location !== 'undefined' && location.href) ? String(location.href) : '';
      _navioCompatEnabled = !!ipcRenderer.sendSync('navio-site-compat-is-enabled-sync', { url: here });
      // Auto-compat for known carrier portals even before the user manually enables it.
      // This prevents Navio's preload listeners (selection toolbar, login observer, etc.)
      // from triggering Cloudflare bot walls on these specific sites.
      if (!_navioCompatEnabled && NAVIO_ALWAYS_COMPAT_RE.test(here)) {
        _navioCompatEnabled = true;
      }
    } catch {
      _navioCompatEnabled = false;
    }
    if (_navioCompatEnabled) {
      try {
        console.info('[navio] Compatibility Mode is ON for this site — skipping page-level injections.');
      } catch {}
      // Bail out of the entire preload. The throw is caught by the outer
      // try/catch (`/* require not available */`) which graceful-no-ops.
      throw new Error('navio_site_compat_skip_preload');
    }
  }

  // ── Find the username field in a form ──────────────────────────────────────
  const USERNAME_SELECTORS = [
    'input[type="email"]',
    'input[type="tel"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[name*="account" i]',
    'input[name*="ident" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[id*="ident" i]',
    'input[type="text"]',
  ];

  function _inputUsable(el) {
    return el && el.type !== 'password' && !el.disabled;
  }

  /** All password inputs under `container` (document order, open shadow roots). */
  function queryPasswordFieldsInTree(container) {
    const out = [];
    if (!container) return out;
    const walk = (root) => {
      if (!root || !root.querySelectorAll) return;
      try {
        root.querySelectorAll('input[type="password"]').forEach((pwd) => {
          if (pwd && !pwd.disabled && !out.includes(pwd)) out.push(pwd);
        });
      } catch {
        return;
      }
      let els;
      try {
        els = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el && el.shadowRoot) walk(el.shadowRoot);
      }
    };
    try {
      walk(container);
    } catch {
      /* ignore */
    }
    return out;
  }

  /** First password field inside `container` or any descendant open shadow root. */
  function queryPasswordInTree(container) {
    const all = queryPasswordFieldsInTree(container);
    return all[0] || null;
  }

  function _pwdAutocomplete(el) {
    return String((el && el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase().trim();
  }

  /** For autofill: prefer login field (`current-password`), not "new password" / confirm on account forms. */
  function pickPasswordFieldForAutofill(container) {
    const usable = queryPasswordFieldsInTree(container || document).filter((el) => !el.disabled);
    if (!usable.length) return null;
    const empty = usable.filter((el) => !el.value);
    const pool = empty.length ? empty : usable;
    const cur = pool.find((el) => _pwdAutocomplete(el) === 'current-password');
    if (cur) return cur;
    const notNew = pool.find((el) => {
      const ac = _pwdAutocomplete(el);
      return ac !== 'new-password';
    });
    if (notNew) return notNew;
    return pool[0] || usable[0];
  }

  /** For save-on-submit: prefer the filled field that looks like the actual login password. */
  function pickPasswordFieldForSnapshot(container) {
    const usable = queryPasswordFieldsInTree(container || document).filter((el) => !el.disabled && el.value);
    if (!usable.length) return null;
    const cur = usable.find((el) => _pwdAutocomplete(el) === 'current-password');
    if (cur) return cur;
    return usable[0];
  }

  /**
   * For submit capture: field must already contain a value.
   * `pwdField` anchors which text box is the username (first filled input before it in tree order).
   */
  function findUsernameField(scope, pwdField) {
    const root = scope || document;
    const strongSelectors = USERNAME_SELECTORS.slice(0, -1);
    for (const sel of strongSelectors) {
      try {
        const el = root.querySelector(sel);
        if (_inputUsable(el) && el.value && el.value.trim()) return el;
      } catch {
        /* continue */
      }
    }
    const candidates = [];
    try {
      root
        .querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input:not([type])')
        .forEach((el) => candidates.push(el));
    } catch {
      return null;
    }
    let bestBefore = null;
    for (const el of candidates) {
      if (!_inputUsable(el) || !el.value || !el.value.trim()) continue;
      if (!pwdField) return el;
      try {
        const pos = pwdField.compareDocumentPosition(el);
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) bestBefore = el;
      } catch {
        if (!bestBefore) bestBefore = el;
      }
    }
    if (bestBefore) return bestBefore;
    for (const el of candidates) {
      if (_inputUsable(el) && el.value && el.value.trim()) return el;
    }
    return null;
  }

  /**
   * For autofill: match empty visible fields (SPA / fresh form).
   */
  function findUsernameFieldForAutofill(root) {
    const pwdField = pickPasswordFieldForAutofill(root || document);
    if (!pwdField) {
      const scope = root || document;
      for (const sel of USERNAME_SELECTORS) {
        try {
          const el = scope.querySelector(sel);
          if (_inputUsable(el)) return el;
        } catch {
          /* continue */
        }
      }
      return null;
    }
    const scope =
      pwdField.getRootNode && pwdField.getRootNode() instanceof ShadowRoot
        ? pwdField.getRootNode()
        : root || document;
    const strongSelectors = USERNAME_SELECTORS.slice(0, -1);
    for (const sel of strongSelectors) {
      try {
        const el = scope.querySelector(sel);
        if (_inputUsable(el)) return el;
      } catch {
        /* continue */
      }
    }
    const candidates = [];
    try {
      scope
        .querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input:not([type])')
        .forEach((el) => candidates.push(el));
    } catch {
      return null;
    }
    for (const el of candidates) {
      if (!_inputUsable(el)) continue;
      try {
        if (pwdField.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) return el;
      } catch {
        return el;
      }
    }
    for (const el of candidates) {
      if (_inputUsable(el)) return el;
    }
    return null;
  }

  /** Nearest login root: real <form>, else a wrapper around the password field (SPA). */
  function loginRootForPassword(pwdField) {
    if (!pwdField) return null;
    const form = pwdField.closest('form');
    if (form) return form;
    const wrap = pwdField.closest(
      'section,article,main,[role="dialog"],[role="main"],[class*="login" i],[class*="signin" i],[class*="sign-in" i],[id*="login" i],[id*="signin" i]'
    );
    return wrap || document;
  }

  function snapshotLoginFromRoot(root) {
    try {
      const container = root || document;
      const pwdField = pickPasswordFieldForSnapshot(container);
      if (!pwdField || !pwdField.value) return null;
      const scope =
        pwdField.getRootNode && pwdField.getRootNode() instanceof ShadowRoot
          ? pwdField.getRootNode()
          : container;
      const usernameEl = findUsernameField(scope, pwdField);
      const u = usernameEl && usernameEl.value ? usernameEl.value.trim() : '';
      return {
        username: u,
        password: pwdField.value,
        url: window.location.href,
      };
    } catch {
      return null;
    }
  }

  /** React/Vue often flush controlled input values after the event tick — retry a few times. */
  function scheduleSnapshotAndSend(root) {
    const run = () => {
      try {
        const snap = snapshotLoginFromRoot(root);
        if (snap) sendCredentialsOnce(snap);
      } catch {
        /* ignore */
      }
    };
    run();
    try {
      queueMicrotask(run);
    } catch {
      setTimeout(run, 0);
    }
    setTimeout(run, 0);
    setTimeout(run, 50);
    setTimeout(run, 120);
  }

  let _lastCredSent = '';
  function sendCredentialsOnce(payload) {
    if (!payload) return;
    if (!String(payload.password || '').trim()) return;
    const key = `${payload.url}\t${payload.username}\t${payload.password}`;
    if (key === _lastCredSent) return;
    _lastCredSent = key;
    setTimeout(() => {
      if (_lastCredSent === key) _lastCredSent = '';
    }, 2000);
    _sendToTabHost('navio-form-submit', payload);
  }

  // ── Fill a controlled input (React/Vue/Angular-aware) ─────────────────────
  function fillField(el, value) {
    if (!el) return;
    try {
      try {
        el.focus({ preventScroll: true });
      } catch {
        try {
          el.focus();
        } catch {
          /* ignore */
        }
      }
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertFromPaste' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
  }

  // ── Intercept form submissions ─────────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    try {
      const form = e.target;
      if (form) scheduleSnapshotAndSend(form);
    } catch {}
  }, true /* capture phase — runs before the page's own handlers */);

  // SPAs often use button-driven POST without a native submit event — capture phase.
  document.addEventListener('click', function (e) {
    try {
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest('button, input[type="submit"]');
      if (!btn) return;
      const tag = btn.tagName;
      let isSubmit = false;
      if (tag === 'INPUT' && btn.type === 'submit') isSubmit = true;
      else if (tag === 'BUTTON') {
        const ty = (btn.getAttribute('type') || 'submit').toLowerCase();
        if (ty === 'submit' || ty === '') isSubmit = true;
      }
      if (!isSubmit) return;

      let root = btn.form || btn.closest('form');
      if (root && !queryPasswordFieldsInTree(root).length) root = null;
      if (!root) {
        const pwd = queryPasswordInTree(document);
        if (!pwd) return;
        root = loginRootForPassword(pwd);
        const inRoot = root && root !== document ? root.contains(btn) : false;
        if (!inRoot) {
          const label = (btn.innerText || btn.value || '').trim().toLowerCase();
          if (!/sign in|log in|log on|login|submit|continue|next|verify/.test(label)) return;
          root = loginRootForPassword(pwd);
        }
      }
      scheduleSnapshotAndSend(root);
    } catch {}
  }, true);

  document.addEventListener('keydown', function (e) {
    try {
      if (e.key !== 'Enter' || e.isComposing) return;
      const el = e.target;
      if (!el || el.tagName !== 'INPUT' || el.type !== 'password') return;
      const root = loginRootForPassword(el);
      scheduleSnapshotAndSend(root);
    } catch {}
  }, true);

  // ── Detect login forms on page load ───────────────────────────────────────
  //
  // Used to observe `document.documentElement` permanently with childList +
  // subtree, which fires on every DOM mutation of any heavy SPA (Gmail, Drive,
  // shipping portals, dashboards). On Purolator's logged-in dashboards that
  // observer would re-fire constantly, contributing to perceived lag.
  //
  // Now we observe `document.body` (skips <head> noise), and we DISCONNECT
  // once we've found a password field on this page or after a 30 s grace
  // window — whichever happens first. A subsequent SPA route change re-arms
  // the observer for the new document via the navigation hook below.
  let _lastLoginPing = { u: '', t: 0 };
  let _navioLoginObserver = null;
  let _navioLoginObserverArmedFor = '';
  let _navioLoginObserverDisarmTimer = null;

  function checkForLoginForm() {
    try {
      if (!queryPasswordFieldsInTree(document).length) return false;
      const u = window.location.href;
      const now = Date.now();
      if (_lastLoginPing.u === u && now - _lastLoginPing.t < 1500) return true;
      _lastLoginPing = { u, t: now };
      _sendToTabHost('navio-login-form', { url: u });
      return true;
    } catch {
      return false;
    }
  }

  function _navioDisconnectLoginObserver() {
    if (_navioLoginObserverDisarmTimer) {
      clearTimeout(_navioLoginObserverDisarmTimer);
      _navioLoginObserverDisarmTimer = null;
    }
    if (_navioLoginObserver) {
      try { _navioLoginObserver.disconnect(); } catch {}
      _navioLoginObserver = null;
    }
  }

  let _loginObsTimer = null;
  function scheduleLoginFormCheck() {
    if (_loginObsTimer) clearTimeout(_loginObsTimer);
    _loginObsTimer = setTimeout(() => {
      _loginObsTimer = null;
      if (checkForLoginForm()) {
        // Found it — stop watching. The page (or any SPA route change) can
        // re-arm via _navioArmLoginObserver below.
        _navioDisconnectLoginObserver();
      }
    }, 400);
  }

  function _navioArmLoginObserver() {
    const u = window.location.href;
    if (_navioLoginObserverArmedFor === u && _navioLoginObserver) return;
    _navioDisconnectLoginObserver();
    _navioLoginObserverArmedFor = u;
    try {
      _navioLoginObserver = new MutationObserver(() => scheduleLoginFormCheck());
      const target = document.body || document.documentElement;
      if (target) _navioLoginObserver.observe(target, { childList: true, subtree: true });
      // Hard stop: even on SPAs that never paint a password field, give up
      // after 30 s so we're not eating perf forever.
      _navioLoginObserverDisarmTimer = setTimeout(() => {
        _navioDisconnectLoginObserver();
      }, 30000);
    } catch {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    if (!checkForLoginForm()) _navioArmLoginObserver();
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      if (!checkForLoginForm()) _navioArmLoginObserver();
    });
  }

  // SPA route changes (pushState / replaceState / back-forward) re-arm the
  // observer so we still notice login forms loaded after navigation.
  try {
    const _origPush = history.pushState;
    const _origReplace = history.replaceState;
    history.pushState = function () {
      const r = _origPush.apply(this, arguments);
      try { _navioArmLoginObserver(); } catch {}
      return r;
    };
    history.replaceState = function () {
      const r = _origReplace.apply(this, arguments);
      try { _navioArmLoginObserver(); } catch {}
      return r;
    };
    window.addEventListener('popstate', () => { try { _navioArmLoginObserver(); } catch {} });
  } catch {}

  // ── Inline AI: remember the guest selection without mutating the page DOM ──
  //
  // Earlier versions wrapped the selection in <span contenteditable="false"> on
  // every mouseup so the host could "Replace" later. That eager DOM mutation
  // broke React/Vue state, page MutationObservers, double-click word selection,
  // contenteditable handlers, and many third-party form widgets across many
  // sites (carrier portals like Purolator/FedEx, gov forms, web mail, etc.).
  //
  // We now only remember the live Range (no DOM change) at selection time, and
  // wrap it into a bookmark span LAZILY — only when the host explicitly asks
  // (when the user clicks an action that will Replace). That window is short
  // (a single mousedown on the toolbar), so the selection is still alive and
  // the page never sees a phantom <span> appear under the user's cursor.
  const NAVIO_BOOKMARK_ID = 'navio-inline-sel-bookmark';
  /** Last live Range cloned at mouseup; null when no fresh selection is pending. */
  let _navioLastSelectionRange = null;

  function removeNavioInlineBookmark() {
    try {
      const el = document.getElementById(NAVIO_BOOKMARK_ID);
      if (!el || !el.parentNode) return;
      const p = el.parentNode;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
    } catch {}
  }

  /** True when both endpoints of the saved range still live in the document. */
  function _navioRangeStillAttached(range) {
    if (!range) return false;
    try {
      return (
        range.startContainer &&
        range.endContainer &&
        document.contains(range.startContainer) &&
        document.contains(range.endContainer)
      );
    } catch {
      return false;
    }
  }

  /**
   * Snapshot the current Range without mutating the DOM. Called from mouseup —
   * cheap, side-effect free.
   */
  function rememberNavioSelectionRange() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) {
        _navioLastSelectionRange = null;
        return;
      }
      const range = sel.getRangeAt(0);
      if (range.collapsed) {
        _navioLastSelectionRange = null;
        return;
      }
      _navioLastSelectionRange = range.cloneRange();
    } catch {
      _navioLastSelectionRange = null;
    }
  }

  /**
   * Wrap the currently-live selection (or the remembered range as a fallback)
   * into a non-editable <span> the host can later target for Replace. Only
   * runs when the host explicitly requests it (toolbar action mousedown).
   */
  function tryInstallNavioInlineBookmark() {
    removeNavioInlineBookmark();
    let range = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const live = sel.getRangeAt(0);
        if (live && !live.collapsed) range = live.cloneRange();
      }
    } catch {
      range = null;
    }
    if (!range && _navioRangeStillAttached(_navioLastSelectionRange)) {
      try {
        range = _navioLastSelectionRange.cloneRange();
      } catch {
        range = null;
      }
    }
    if (!range) return false;
    try {
      const holder = document.createElement('span');
      holder.id = NAVIO_BOOKMARK_ID;
      holder.setAttribute('data-navio-bookmark', '1');
      holder.setAttribute('contenteditable', 'false');
      const contents = range.extractContents();
      holder.appendChild(contents);
      range.insertNode(holder);
      return true;
    } catch {
      try {
        removeNavioInlineBookmark();
      } catch {}
      return false;
    }
  }

  ipcRenderer.on('navio-inline-clear-bookmark', () => {
    try {
      removeNavioInlineBookmark();
    } catch {}
    _navioLastSelectionRange = null;
  });

  /** Host requests lazy bookmark installation just before invoking Replace. */
  ipcRenderer.on('navio-inline-install-bookmark', () => {
    try {
      tryInstallNavioInlineBookmark();
    } catch {}
  });

  // ── Text selection → inline AI toolbar ───────────────────────────────────
  function _isEditableNode(node) {
    if (!node) return false;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || typeof el.closest !== 'function') return false;
    if (el.closest('input, textarea, [contenteditable]')) return true;
    // Also check the element itself
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  document.addEventListener('mouseup', function() {
    try {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 3) {
        removeNavioInlineBookmark();
        _navioLastSelectionRange = null;
        _sendToTabHost('navio-selection-cleared', {});
        return;
      }
      // Don't show the toolbar when selecting inside editable fields
      if (sel.anchorNode && _isEditableNode(sel.anchorNode)) {
        removeNavioInlineBookmark();
        _navioLastSelectionRange = null;
        _sendToTabHost('navio-selection-cleared', {});
        return;
      }
      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();
      // Snapshot the range only — do NOT mutate the DOM here. The bookmark
      // span is installed lazily when the host requests it via
      // `navio-inline-install-bookmark` (typically on toolbar action mousedown).
      // A fresh selection invalidates any previous bookmark — clean it up so
      // a stale one doesn't get targeted by Replace.
      removeNavioInlineBookmark();
      rememberNavioSelectionRange();
      _sendToTabHost('navio-text-selected', {
        text: text.slice(0, 3000), // cap to avoid huge payloads
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    } catch {}
  });

  document.addEventListener('scroll', function() {
    try {
      removeNavioInlineBookmark();
      _navioLastSelectionRange = null;
      _sendToTabHost('navio-selection-cleared', {});
    } catch {}
  }, { passive: true });

  // Guest clicks do not bubble to the shell — notify host so popovers (e.g. downloads) dismiss like Chrome.
  document.addEventListener(
    'pointerdown',
    function () {
      try {
        _sendToTabHost('navio-guest-pointer-down', {});
      } catch {}
    },
    true
  );

  function trySubmitLoginAfterAutofill(root) {
    if (!root) return;
    try {
      const candidates = root.querySelectorAll('button[type="submit"],input[type="submit"],button');
      for (const btn of candidates) {
        const t = (btn.innerText || btn.value || '').trim().toLowerCase();
        if (/log ?(in| on)|sign ?in|continue( with)?|submit|next|verify/.test(t)) {
          btn.click();
          return;
        }
      }
      const submit = root.querySelector('button[type="submit"],input[type="submit"]');
      if (submit) submit.click();
    } catch {
      /* ignore */
    }
  }

  // ── Handle autofill command sent from the renderer ─────────────────────────
  ipcRenderer.on('navio-autofill', (_, { username, password, autoSubmit }) => {
    try {
      const pwdField = pickPasswordFieldForAutofill(document);
      if (!pwdField) return;
      const root = loginRootForPassword(pwdField);
      const usernameEl = findUsernameFieldForAutofill(root);
      if (usernameEl) {
        usernameEl.focus();
        fillField(usernameEl, username);
      }
      pwdField.focus();
      fillField(pwdField, password);
      if (autoSubmit) {
        setTimeout(() => trySubmitLoginAfterAutofill(root), 140);
      }
    } catch {
      /* ignore */
    }
  });

  // ── Cosmetic ad blocking (streaming / embed-player overlay removal) ──────────
  // Hides overlay and interstitial ad elements injected into the DOM by streaming
  // embed pages. These are invisible to network blocking because they are created
  // by page scripts after load — no outbound network request to cancel.
  //
  // Two layers:
  //   1. A <style> tag with CSS attribute selectors targeting explicit "ad" names.
  //   2. A MutationObserver that checks newly-added nodes against the same patterns,
  //      catching ads injected after the initial paint (click-triggered overlays).
  //
  // Selectors use explicit ad-keyword substrings so legitimate page elements are
  // not affected. The case-insensitive `i` modifier requires Chromium 49+ (fine here).
  function initCosmeticAdBlock() {
    const CSS_HIDE = [
      // Full-screen / positioned overlay ads
      '[class*="ad-overlay"i]', '[id*="ad-overlay"i]',
      '[class*="overlay-ad"i]', '[id*="overlay-ad"i]',
      '[class*="adv-overlay"i]', '[id*="adv-overlay"i]',
      // Pre-roll and VAST video ad containers
      '[class*="preroll-ad"i]', '[id*="preroll-ad"i]',
      '[class*="vast-ad"i]',    '[id*="vast-ad"i]',
      // Script-injected popup / modal ad wrappers
      '[class*="ad-popup"i]',   '[id*="ad-popup"i]',
      '[class*="adv-popup"i]',  '[id*="adv-popup"i]',
      '[class*="ad-modal"i]',   '[id*="ad-modal"i]',
      // Adblock-detection walls (urge to whitelist — hide instead)
      '[class*="adblock-wall"i]',  '[id*="adblock-wall"i]',
      '[class*="anti-adblock"i]',  '[id*="anti-adblock"i]',
      // Google AdSense fallback
      'ins.adsbygoogle',
    ].join(',');

    try {
      const style = document.createElement('style');
      style.id = 'navio-cosmetic-block';
      style.textContent = CSS_HIDE + '{display:none!important}';
      (document.head || document.documentElement).appendChild(style);
    } catch { /* ignore — CSP may block; network layer still active */ }

    // Regex mirrors the CSS patterns for the MutationObserver path.
    const _OBS_RE = /\bad[-_]?(overlay|popup|modal)\b|\b(overlay|popup)[-_]?ad\b|\bpreroll[-_]ad\b|\bvast[-_]ad\b|\badblock[-_]wall\b|\banti[-_]adblock\b/i;

    function _checkNode(node) {
      if (!node || node.nodeType !== 1 /* ELEMENT_NODE */) return;
      const c = typeof node.className === 'string' ? node.className : '';
      const id = node.id || '';
      if (_OBS_RE.test(c) || _OBS_RE.test(id)) {
        try { node.style.setProperty('display', 'none', 'important'); } catch {}
      }
      try {
        for (const child of node.children || []) _checkNode(child);
      } catch {}
    }

    const _cObs = new MutationObserver((records) => {
      for (const rec of records) {
        for (const n of rec.addedNodes) _checkNode(n);
      }
    });

    function _armCosmeticObs() {
      const target = document.body || document.documentElement;
      if (target) _cObs.observe(target, { childList: true, subtree: true });
    }

    if (document.body) _armCosmeticObs();
    else document.addEventListener('DOMContentLoaded', _armCosmeticObs, { once: true });
  }

  initCosmeticAdBlock();

  // ── YouTube: auto-skip ads ────────────────────────────────────────────────
  // Watches for the skip button on YouTube ads and clicks it as soon as it
  // becomes available. Runs only on youtube.com domains.
  function initYouTubeAdSkipper() {
    if (!location.hostname.includes('youtube.com')) return;

    const SKIP_SELECTORS = [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      'button.ytp-ad-skip-button-modern',
      '.videoAdUiSkipButton',
      '[id="skip-button:8"]',
      'button[data-tooltip-target-id="a]"]',
    ];

    function trySkip() {
      for (const sel of SKIP_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }
      const allBtns = document.querySelectorAll('button, .ytp-ad-overlay-close-button');
      for (const btn of allBtns) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if ((text === 'skip' || text === 'skip ad' || text === 'skip ads' || text.startsWith('skip ad')) && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }
      return false;
    }

    const observer = new MutationObserver(() => { trySkip(); });
    function startObserving() {
      observer.observe(document.body, { childList: true, subtree: true });
      setInterval(trySkip, 1000);
    }

    if (document.body) startObserving();
    else document.addEventListener('DOMContentLoaded', startObserving);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initYouTubeAdSkipper();
  } else {
    window.addEventListener('DOMContentLoaded', initYouTubeAdSkipper);
  }

} catch { /* require not available — graceful no-op */ }
