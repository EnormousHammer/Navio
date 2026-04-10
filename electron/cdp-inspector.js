/**
 * Navio Browser – CDP Console & Network Inspector
 *
 * Maintains per-webContents circular buffers of console messages and network
 * requests using the Chrome DevTools Protocol.  The tool executors in main.js
 * call startMonitoring(wc) once at the beginning of a tool loop and query the
 * buffers via getConsoleMessages / getNetworkRequests.
 */

'use strict';

const MAX_CONSOLE = 100;
const MAX_NETWORK = 60;

// Key: webContentsId → { console: [], network: [], monitoring: boolean }
const inspectorData = new Map();

function ensureEntry(wcId) {
  if (!inspectorData.has(wcId)) {
    inspectorData.set(wcId, { console: [], network: [], monitoring: false });
  }
  return inspectorData.get(wcId);
}

/**
 * Begin monitoring console and network events for a webContents via CDP.
 * Safe to call multiple times — will only attach once per webContents.
 */
async function startMonitoring(wc) {
  const entry = ensureEntry(wc.id);
  if (entry.monitoring) return;
  entry.monitoring = true;

  let attachedHere = false;
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      attachedHere = true;
    }

    await wc.debugger.sendCommand('Runtime.enable');
    await wc.debugger.sendCommand('Log.enable');
    await wc.debugger.sendCommand('Network.enable');

    wc.debugger.on('message', (event, method, params) => {
      const data = inspectorData.get(wc.id);
      if (!data) return;

      if (method === 'Runtime.consoleAPICalled') {
        const msg = {
          level: params.type || 'log',
          text: (params.args || []).map(a => a.value ?? a.description ?? '').join(' '),
          timestamp: params.timestamp || Date.now(),
          url: params.stackTrace?.callFrames?.[0]?.url || ''
        };
        data.console.push(msg);
        if (data.console.length > MAX_CONSOLE) data.console.shift();
      }

      if (method === 'Runtime.exceptionThrown') {
        const ex = params.exceptionDetails || {};
        const msg = {
          level: 'error',
          text: ex.text || ex.exception?.description || 'Unknown exception',
          timestamp: params.timestamp || Date.now(),
          url: ex.url || ''
        };
        data.console.push(msg);
        if (data.console.length > MAX_CONSOLE) data.console.shift();
      }

      if (method === 'Log.entryAdded') {
        const e = params.entry || {};
        const msg = {
          level: e.level || 'log',
          text: e.text || '',
          timestamp: e.timestamp || Date.now(),
          url: e.url || ''
        };
        data.console.push(msg);
        if (data.console.length > MAX_CONSOLE) data.console.shift();
      }

      if (method === 'Network.requestWillBeSent') {
        const req = params.request || {};
        const entry = {
          requestId: params.requestId,
          method: req.method || 'GET',
          url: req.url || '',
          type: params.type || '',
          timestamp: params.timestamp || Date.now(),
          status: null,
          statusText: '',
          responseSize: 0,
          timing: null
        };
        data.network.push(entry);
        if (data.network.length > MAX_NETWORK) data.network.shift();
      }

      if (method === 'Network.responseReceived') {
        const resp = params.response || {};
        const existing = data.network.find(n => n.requestId === params.requestId);
        if (existing) {
          existing.status = resp.status || 0;
          existing.statusText = resp.statusText || '';
          existing.responseSize = resp.encodedDataLength || 0;
          existing.mimeType = resp.mimeType || '';
          if (resp.timing) {
            existing.timing = {
              dns: resp.timing.dnsEnd - resp.timing.dnsStart,
              connect: resp.timing.connectEnd - resp.timing.connectStart,
              ttfb: resp.timing.receiveHeadersEnd - resp.timing.sendStart,
              total: resp.timing.receiveHeadersEnd
            };
          }
        }
      }

      if (method === 'Network.loadingFailed') {
        const existing = data.network.find(n => n.requestId === params.requestId);
        if (existing) {
          existing.status = 0;
          existing.statusText = params.errorText || 'Failed';
          existing.failed = true;
        }
      }
    });

    // Don't detach — keep monitoring active for the duration of the tool loop
  } catch (err) {
    console.log('[navio] CDP inspector startMonitoring failed:', err.message);
    entry.monitoring = false;
    if (attachedHere) {
      try { wc.debugger.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Get console messages for a webContents, optionally filtered by level.
 */
function getConsoleMessages(wcId, level, limit) {
  const data = inspectorData.get(wcId);
  if (!data) return [];
  let msgs = data.console;
  if (level && level !== 'all') {
    msgs = msgs.filter(m => m.level === level);
  }
  return msgs.slice(-(limit || 50));
}

/**
 * Get network requests for a webContents, optionally filtered.
 */
function getNetworkRequests(wcId, filter, limit) {
  const data = inspectorData.get(wcId);
  if (!data) return [];
  let reqs = data.network;
  if (filter && filter !== 'all') {
    if (filter === 'failed') {
      reqs = reqs.filter(r => r.failed || (r.status && r.status >= 400));
    } else if (filter === 'xhr') {
      reqs = reqs.filter(r => r.type === 'XHR' || r.type === 'Fetch');
    } else {
      const typeMap = {
        document: 'Document', script: 'Script',
        stylesheet: 'Stylesheet', image: 'Image'
      };
      const t = typeMap[filter] || filter;
      reqs = reqs.filter(r => r.type === t);
    }
  }
  return reqs.slice(-(limit || 30)).map(r => ({
    method: r.method,
    url: r.url,
    type: r.type,
    status: r.status,
    statusText: r.statusText,
    mimeType: r.mimeType || '',
    failed: r.failed || false,
    timing: r.timing
  }));
}

/**
 * Stop monitoring and clear data for a webContents (call when tab is destroyed).
 */
function stopMonitoring(wcId) {
  inspectorData.delete(wcId);
}

module.exports = {
  startMonitoring,
  getConsoleMessages,
  getNetworkRequests,
  stopMonitoring
};
