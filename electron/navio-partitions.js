'use strict';

/** Keep in sync with `<webview partition>` in renderer (tabs.js). */
const NAVIO_PARTITION_MAIN = 'persist:navio';
/** In-memory session shared by all private tabs (no `persist:` prefix). */
const NAVIO_PARTITION_INCOGNITO = 'navio-incognito';

module.exports = { NAVIO_PARTITION_MAIN, NAVIO_PARTITION_INCOGNITO };
