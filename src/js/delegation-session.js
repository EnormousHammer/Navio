/**
 * Browser delegation session — single snapshot for agentic takeover HUD and strict/ observe mode.
 * Renderer-only ledger; main process optional in a later phase.
 */
(() => {
  'use strict';

  /** @type {NavioDelegationSnapshot | null} */
  let session = null;

  /** @type {Set<(s: NavioDelegationSnapshot|null) => void>} */
  const listeners = new Set();

  /** @typedef {{ sessionId: string, startedAt: number, tabId: string|null, paused: boolean, mode: 'observe'|'strict', stepIndex: number, stepTotal: number, verb: string, waitingLoginHost: string|null }} NavioDelegationSnapshot */

  function genId() {
    return 'dlg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function emit() {
    const snap = session ? { ...session } : null;
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (e) {
        console.warn('[delegation-session]', e);
      }
    }
  }

  /**
   * @returns {NavioDelegationSnapshot|null}
   */
  function getSnapshot() {
    return session ? { ...session } : null;
  }

  /**
   * @param {{ tabId?: string|null, mode?: 'observe'|'strict', waitingLoginHost?: string|null }} opts
   * @returns {NavioDelegationSnapshot|null}
   */
  function start(opts = {}) {
    const mode = opts.mode === 'strict' ? 'strict' : 'observe';
    session = {
      sessionId: genId(),
      startedAt: Date.now(),
      tabId: opts.tabId != null ? opts.tabId : null,
      paused: false,
      mode,
      stepIndex: 0,
      stepTotal: 0,
      verb: '',
      waitingLoginHost: opts.waitingLoginHost ? String(opts.waitingLoginHost) : null
    };
    emit();
    return getSnapshot();
  }

  /** @param {string|null} tabId */
  function syncTab(tabId) {
    if (!session) return;
    session.tabId = tabId != null ? tabId : null;
    emit();
  }

  /**
   * @param {{ stepIndex?: number, stepTotal?: number, verb?: string, waitingLoginHost?: string|null }} patch
   */
  function updateStep(patch = {}) {
    if (!session) return;
    if (patch.stepIndex != null) session.stepIndex = Math.max(0, patch.stepIndex | 0);
    if (patch.stepTotal != null) session.stepTotal = Math.max(0, patch.stepTotal | 0);
    if (patch.verb != null) session.verb = String(patch.verb || '');
    if ('waitingLoginHost' in patch) session.waitingLoginHost = patch.waitingLoginHost ? String(patch.waitingLoginHost) : null;
    emit();
  }

  /** @param {boolean} paused */
  function setPaused(paused) {
    if (!session) return;
    session.paused = !!paused;
    emit();
  }

  /** @param {'observe'|'strict'} mode */
  function setMode(mode) {
    if (!session) return;
    session.mode = mode === 'strict' ? 'strict' : 'observe';
    emit();
  }

  /** @param {string|null} host */
  function setWaitingLoginHost(host) {
    if (!session) return;
    session.waitingLoginHost = host ? String(host) : null;
    emit();
  }

  function end() {
    session = null;
    emit();
  }

  /** @param {(s: NavioDelegationSnapshot|null) => void} fn */
  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  window.NavioDelegationController = {
    start,
    syncTab,
    updateStep,
    setPaused,
    setMode,
    setWaitingLoginHost,
    end,
    getSnapshot,
    subscribe,
    isActive: () => !!session
  };
})();
