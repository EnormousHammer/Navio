'use strict';

const { net } = require('electron');

function registerSearchSuggestionsIpc(ipcMain) {
  ipcMain.handle('search-suggestions', async (_, { q, searchEngine }) => {
    if (!q || q.length < 2) return [];
    try {
      const se = String(searchEngine || '').toLowerCase();
      let apiUrl;
      if (se.includes('bing.com')) {
        apiUrl = `https://api.bing.com/qsonhs.aspx?q=${encodeURIComponent(q)}`;
      } else if (se.includes('duckduckgo.com')) {
        apiUrl = `https://ac.duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`;
      } else {
        apiUrl = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
      }
      const res = await net.fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const suggestions = Array.isArray(data[1]) ? data[1] : [];
      return suggestions.slice(0, 6).map(s => String(s));
    } catch {
      return [];
    }
  });
}

module.exports = { registerSearchSuggestionsIpc };
