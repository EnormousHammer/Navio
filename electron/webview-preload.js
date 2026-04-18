'use strict';
/**
 * Webview preload — injected into every page loaded inside persist:navio webviews.
 * Detects login forms, captures credentials on submit, and handles autofill commands.
 * Communicates with the renderer (tabs.js) via ipcRenderer.sendToHost().
 */
try {
  const { ipcRenderer, contextBridge } = require('electron');

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
    try {
      contextBridge.exposeInMainWorld('navioChatTab', {
        getConfig: () => ipcRenderer.invoke('get-config'),
        postToHost: (payload) => ipcRenderer.sendToHost('navio-chat-host', payload)
      });
    } catch (e) {
      console.error('[navio] navioChatTab preload bridge failed:', e && e.message ? e.message : e);
    }
  }

  // ── Find the username field in a form ──────────────────────────────────────
  const USERNAME_SELECTORS = [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[name*="account" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[type="text"]',
  ];

  function _inputUsable(el) {
    return el && el.type !== 'password' && !el.disabled;
  }

  /** For submit capture: field must already contain a value. */
  function findUsernameField(root) {
    const scope = root || document;
    for (const sel of USERNAME_SELECTORS) {
      const el = scope.querySelector(sel);
      if (_inputUsable(el) && el.value && el.value.trim()) return el;
    }
    return null;
  }

  /**
   * For autofill: same ordering as submit, but match empty visible fields (SPA / fresh form).
   * Without this, username never fills because findUsernameField skips empty inputs.
   */
  function findUsernameFieldForAutofill(root) {
    const scope = root || document;
    for (const sel of USERNAME_SELECTORS) {
      const el = scope.querySelector(sel);
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
      const pwdField = root.querySelector('input[type="password"]');
      if (!pwdField || !pwdField.value) return null;
      const usernameEl = findUsernameField(root);
      if (!usernameEl || !usernameEl.value || !usernameEl.value.trim()) return null;
      return {
        username: usernameEl.value.trim(),
        password: pwdField.value,
        url: window.location.href,
      };
    } catch {
      return null;
    }
  }

  let _lastCredSent = '';
  function sendCredentialsOnce(payload) {
    if (!payload) return;
    const key = `${payload.url}\t${payload.username}\t${payload.password}`;
    if (key === _lastCredSent) return;
    _lastCredSent = key;
    setTimeout(() => {
      if (_lastCredSent === key) _lastCredSent = '';
    }, 2000);
    ipcRenderer.sendToHost('navio-form-submit', payload);
  }

  // ── Fill a controlled input (React/Vue/Angular-aware) ─────────────────────
  function fillField(el, value) {
    if (!el) return;
    try {
      const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {}
  }

  // ── Intercept form submissions ─────────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    try {
      const form = e.target;
      const snap = form && snapshotLoginFromRoot(form);
      if (snap) sendCredentialsOnce(snap);
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
      if (root && !root.querySelector('input[type="password"]')) root = null;
      if (!root) {
        const pwd = document.querySelector('input[type="password"]:not([disabled])');
        if (!pwd) return;
        root = loginRootForPassword(pwd);
        const inRoot = root && root !== document ? root.contains(btn) : false;
        if (!inRoot) {
          const label = (btn.innerText || btn.value || '').trim().toLowerCase();
          if (!/sign in|log in|log on|login|submit|continue|next|verify/.test(label)) return;
          root = loginRootForPassword(pwd);
        }
      }
      const snap = snapshotLoginFromRoot(root);
      if (snap) sendCredentialsOnce(snap);
    } catch {}
  }, true);

  document.addEventListener('keydown', function (e) {
    try {
      if (e.key !== 'Enter' || e.isComposing) return;
      const el = e.target;
      if (!el || el.tagName !== 'INPUT' || el.type !== 'password') return;
      const root = loginRootForPassword(el);
      const snap = snapshotLoginFromRoot(root);
      if (snap) sendCredentialsOnce(snap);
    } catch {}
  }, true);

  // ── Detect login forms on page load ───────────────────────────────────────
  let _lastLoginPing = { u: '', t: 0 };
  function checkForLoginForm() {
    try {
      if (!document.querySelector('input[type="password"]')) return;
      const u = window.location.href;
      const now = Date.now();
      if (_lastLoginPing.u === u && now - _lastLoginPing.t < 1500) return;
      _lastLoginPing = { u, t: now };
      ipcRenderer.sendToHost('navio-login-form', { url: u });
    } catch {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    checkForLoginForm();
  } else {
    window.addEventListener('DOMContentLoaded', checkForLoginForm);
  }

  let _loginObsTimer = null;
  function scheduleLoginFormCheck() {
    if (_loginObsTimer) clearTimeout(_loginObsTimer);
    _loginObsTimer = setTimeout(() => {
      _loginObsTimer = null;
      checkForLoginForm();
    }, 400);
  }
  try {
    const mo = new MutationObserver(() => scheduleLoginFormCheck());
    if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}

  // ── Text selection → inline AI toolbar ───────────────────────────────────
  document.addEventListener('mouseup', function() {
    try {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 3) {
        ipcRenderer.sendToHost('navio-selection-cleared', {});
        return;
      }
      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();
      ipcRenderer.sendToHost('navio-text-selected', {
        text: text.slice(0, 3000), // cap to avoid huge payloads
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    } catch {}
  });

  document.addEventListener('scroll', function() {
    try { ipcRenderer.sendToHost('navio-selection-cleared', {}); } catch {}
  }, { passive: true });

  // Guest clicks do not bubble to the shell — notify host so popovers (e.g. downloads) dismiss like Chrome.
  document.addEventListener(
    'pointerdown',
    function () {
      try {
        ipcRenderer.sendToHost('navio-guest-pointer-down', {});
      } catch {}
    },
    true
  );

  // ── Handle autofill command sent from the renderer ─────────────────────────
  ipcRenderer.on('navio-autofill', (_, { username, password }) => {
    try {
      const pwdField = document.querySelector('input[type="password"]:not([disabled])');
      if (!pwdField) return;
      const root = loginRootForPassword(pwdField);
      const usernameEl = findUsernameFieldForAutofill(root);
      if (usernameEl) {
        usernameEl.focus();
        fillField(usernameEl, username);
      }
      pwdField.focus();
      fillField(pwdField, password);
    } catch {}
  });

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
