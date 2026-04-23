'use strict';

const path = require('path');

let sentryInited = false;
let lastEnabled = false;

function getDsn() {
  return String(process.env.NAVIO_SENTRY_DSN || '').trim();
}

function isCrashReportingAvailable() {
  return !!getDsn();
}

function shutdownSentry() {
  lastEnabled = false;
  if (!sentryInited) return;
  sentryInited = false;
  try {
    const Sentry = require('@sentry/electron/main');
    void Sentry.close(2000);
  } catch (_) {
    /* ignore */
  }
}

function scrubEvent(event) {
  try {
    if (event.request && event.request.url) {
      delete event.request.url;
    }
    if (Array.isArray(event.exception?.values)) {
      for (const ex of event.exception.values) {
        if (ex && typeof ex.value === 'string' && ex.value.length > 4000) {
          ex.value = `${ex.value.slice(0, 4000)}…`;
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
  return event;
}

function applyCrashReportingFromConfig(config) {
  const dsn = getDsn();
  const want = !!(config && config.crashReportingEnabled && dsn);
  if (!want) {
    shutdownSentry();
    return;
  }
  lastEnabled = true;
  if (sentryInited) return;
  try {
    const Sentry = require('@sentry/electron/main');
    let release;
    try {
      release = `navio-browser@${require(path.join(__dirname, '..', 'package.json')).version}`;
    } catch (_) {
      release = 'navio-browser@unknown';
    }
    Sentry.init({
      dsn,
      release,
      environment: process.defaultApp ? 'development' : 'production',
      beforeSend(event) {
        return scrubEvent(event);
      }
    });
    sentryInited = true;
  } catch (e) {
    console.warn('[navio] crash reporter init failed:', e && e.message ? e.message : String(e));
  }
}

function captureRendererDiagnostics(payload) {
  if (!lastEnabled || !sentryInited) return { ok: false, reason: 'disabled' };
  const msg = payload && typeof payload.message === 'string' ? payload.message : 'renderer-error';
  const stack = payload && typeof payload.stack === 'string' ? payload.stack.slice(0, 8000) : '';
  try {
    const Sentry = require('@sentry/electron/main');
    const err = new Error(msg);
    if (stack) err.stack = stack;
    Sentry.captureException(err);
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

module.exports = {
  getDsn,
  isCrashReportingAvailable,
  applyCrashReportingFromConfig,
  shutdownSentry,
  captureRendererDiagnostics
};
