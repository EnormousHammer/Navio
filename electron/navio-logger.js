'use strict';

/**
 * Navio Debug Logger
 *
 * Captures errors and warnings from the main process, guest pages, and browser
 * actions, writing them to navio-debug.log in userData and pushing each entry
 * live to the renderer shell via IPC so the built-in log panel updates instantly.
 *
 * Usage:
 *   const navioLogger = require('./navio-logger');
 *   navioLogger.init(app.getPath('userData'));        // call in app.whenReady()
 *   navioLogger.setMainWindow(mainWindow);            // call after window created
 *   navioLogger.log('error', 'browser-action', msg, extraDetail);
 */

const path = require('path');
const fs = require('fs');

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB — trim when exceeded
const TRIM_KEEP_LINES = 600;             // keep the most recent N lines after trim

let _logPath = null;
let _mainWin = null;
/** Optional (entry) => void — e.g. mirror logs to Navio AI guest tabs. */
let _extraBroadcast = null;

/** Call once in app.whenReady() before any logging. */
function init(userData, win) {
  try {
    _logPath = path.join(String(userData), 'navio-debug.log');
    if (win) _mainWin = win;
  } catch {
    /* ignore */
  }
}

/** Update the reference whenever mainWindow is (re)created. */
function setMainWindow(win) {
  _mainWin = win;
}

/** Register a second sink for every log line (same payload as `navio-log-entry`). */
function setExtraLogBroadcast(fn) {
  _extraBroadcast = typeof fn === 'function' ? fn : null;
}

/**
 * Log an entry.
 * @param {'error'|'warn'|'info'} level
 * @param {string} source  Short label: 'process', 'browser-action', 'page', 'navigation', …
 * @param {string} message Human-readable description of what went wrong.
 * @param {string|null} [detail]  Extra context (stack trace, error code, url, …). Truncated.
 */
function log(level, source, message, detail) {
  const entry = {
    ts: new Date().toISOString(),
    level: String(level || 'info'),
    source: String(source || 'main').slice(0, 40),
    message: String(message || '').slice(0, 2000),
    detail: detail !== undefined && detail !== null ? String(detail).slice(0, 800) : null
  };

  _writeFile(entry);
  _pushToRenderer(entry);

  return entry;
}

function _writeFile(entry) {
  if (!_logPath) return;
  try {
    fs.appendFileSync(_logPath, JSON.stringify(entry) + '\n', 'utf8');
    _maybeRotate();
  } catch {
    /* ignore — never crash because of the logger */
  }
}

function _maybeRotate() {
  try {
    if (fs.statSync(_logPath).size < MAX_FILE_BYTES) return;
    const lines = fs.readFileSync(_logPath, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(_logPath, lines.slice(-TRIM_KEEP_LINES).join('\n') + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}

function _pushToRenderer(entry) {
  try {
    if (_mainWin && typeof _mainWin.isDestroyed === 'function' && !_mainWin.isDestroyed()) {
      _mainWin.webContents.send('navio-log-entry', entry);
    }
  } catch {
    /* ignore */
  }
  try {
    if (_extraBroadcast) _extraBroadcast(entry);
  } catch {
    /* ignore */
  }
}

/**
 * Read the most recent log entries from disk.
 * @param {number} [n=200]
 * @returns {Array<{ts,level,source,message,detail}>}
 */
function readRecent(n) {
  try {
    if (!_logPath) return [];
    const content = fs.readFileSync(_logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const count = Math.min(Math.max(1, n || 200), 500);
    return lines
      .slice(-count)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Return the absolute path to the current log file (for "open in folder" UI). */
function getLogPath() {
  return _logPath || null;
}

module.exports = { init, setMainWindow, setExtraLogBroadcast, log, readRecent, getLogPath };
