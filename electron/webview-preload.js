'use strict';
/**
 * Webview preload — injected into every page loaded inside persist:navio webviews.
 * Detects login forms, captures credentials on submit, and handles autofill commands.
 * Communicates with the renderer (tabs.js) via ipcRenderer.sendToHost().
 */
try {
  const { ipcRenderer } = require('electron');

  // ── Find the username field in a form ──────────────────────────────────────
  function findUsernameField(root) {
    const selectors = [
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input[name*="user" i]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[name*="account" i]',
      'input[type="text"]',
    ];
    for (const sel of selectors) {
      const el = root ? root.querySelector(sel) : document.querySelector(sel);
      if (el && el.value && el.value.trim()) return el;
    }
    return null;
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
  document.addEventListener('submit', function(e) {
    try {
      const form = e.target;
      const pwdField = form && form.querySelector('input[type="password"]');
      if (!pwdField || !pwdField.value) return;

      const usernameEl = findUsernameField(form);
      if (!usernameEl || !usernameEl.value) return;

      ipcRenderer.sendToHost('navio-form-submit', {
        username: usernameEl.value.trim(),
        password: pwdField.value,
        url: window.location.href,
      });
    } catch {}
  }, true /* capture phase — runs before the page's own handlers */);

  // ── Detect login forms on page load ───────────────────────────────────────
  function checkForLoginForm() {
    try {
      if (document.querySelector('input[type="password"]')) {
        ipcRenderer.sendToHost('navio-login-form', { url: window.location.href });
      }
    } catch {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    checkForLoginForm();
  } else {
    window.addEventListener('DOMContentLoaded', checkForLoginForm);
  }

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

  // ── Handle autofill command sent from the renderer ─────────────────────────
  ipcRenderer.on('navio-autofill', (_, { username, password }) => {
    try {
      const pwdField = document.querySelector('input[type="password"]');
      if (!pwdField) return;
      const form = pwdField.closest('form') || document;
      const usernameEl = findUsernameField(form);
      if (usernameEl) { usernameEl.focus(); fillField(usernameEl, username); }
      pwdField.focus();
      fillField(pwdField, password);
    } catch {}
  });

} catch { /* require not available — graceful no-op */ }
