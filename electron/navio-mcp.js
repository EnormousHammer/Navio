/**
 * Navio Browser – MCP (Model Context Protocol) Integration
 *
 * Manages MCP server connections, discovers tools from connected servers,
 * and proxies tool calls from the AI agent loop to MCP servers.
 *
 * Uses the official @modelcontextprotocol/sdk package.
 */

'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

// Active MCP clients: Map<serverId, { client, transport, tools, status }>
const mcpClients = new Map();

/**
 * Connect to an MCP server by configuration.
 * @param {object} serverConfig - { id, name, command, args, env, url, type }
 *   type: 'stdio' (default) or 'sse'
 *   stdio: { command, args, env }
 *   sse:   { url }
 */
async function connectServer(serverConfig) {
  const id = serverConfig.id || serverConfig.name;
  if (mcpClients.has(id) && mcpClients.get(id).status === 'connected') {
    return mcpClients.get(id);
  }

  const client = new Client(
    { name: 'navio-browser', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  let transport;
  const type = serverConfig.type || 'stdio';

  if (type === 'sse' && serverConfig.url) {
    transport = new SSEClientTransport(new URL(serverConfig.url));
  } else {
    transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args || [],
      env: { ...process.env, ...(serverConfig.env || {}) }
    });
  }

  const entry = { client, transport, tools: [], status: 'connecting', id, name: serverConfig.name || id };
  mcpClients.set(id, entry);

  try {
    await client.connect(transport);
    entry.status = 'connected';

    // Discover tools
    const toolsResult = await client.listTools();
    entry.tools = (toolsResult.tools || []).map(t => ({
      name: `mcp_${id}_${t.name}`,
      originalName: t.name,
      serverId: id,
      description: `[MCP: ${serverConfig.name || id}] ${t.description || ''}`,
      parameters: t.inputSchema || { type: 'object', properties: {} }
    }));

    console.log(`[navio-mcp] Connected to "${id}" — ${entry.tools.length} tools discovered`);
    return entry;
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    console.error(`[navio-mcp] Failed to connect to "${id}":`, err.message);
    return entry;
  }
}

/**
 * Disconnect an MCP server.
 */
async function disconnectServer(id) {
  const entry = mcpClients.get(id);
  if (!entry) return;
  try {
    await entry.client.close();
  } catch { /* ignore */ }
  entry.status = 'disconnected';
  mcpClients.delete(id);
}

/**
 * Disconnect all MCP servers.
 */
async function disconnectAll() {
  for (const id of mcpClients.keys()) {
    await disconnectServer(id);
  }
}

/**
 * Get all discovered MCP tools in the canonical Navio format.
 */
function getMcpTools() {
  const tools = [];
  for (const entry of mcpClients.values()) {
    if (entry.status === 'connected') {
      tools.push(...entry.tools);
    }
  }
  return tools;
}

/**
 * Call an MCP tool. The tool name should be in the format mcp_{serverId}_{toolName}.
 */
async function callMcpTool(fullName, args) {
  for (const entry of mcpClients.values()) {
    const tool = entry.tools.find(t => t.name === fullName);
    if (tool && entry.status === 'connected') {
      try {
        const result = await entry.client.callTool({
          name: tool.originalName,
          arguments: args || {}
        });
        return { success: true, content: result.content || result };
      } catch (err) {
        return { error: `MCP tool call failed: ${err.message}` };
      }
    }
  }
  return { error: `MCP tool "${fullName}" not found or server disconnected.` };
}

/**
 * Check if a tool name is an MCP tool.
 */
function isMcpTool(name) {
  return name && name.startsWith('mcp_');
}

/**
 * Get status of all MCP connections.
 */
function getStatus() {
  const status = {};
  for (const [id, entry] of mcpClients) {
    status[id] = {
      name: entry.name,
      status: entry.status,
      toolCount: entry.tools.length,
      error: entry.error || null
    };
  }
  return status;
}

/**
 * Initialize MCP connections from config.
 * @param {Array} servers - Array of server configs from navio-config.json
 */
async function initFromConfig(servers) {
  if (!Array.isArray(servers)) return;
  for (const server of servers) {
    if (server.enabled !== false) {
      await connectServer(server).catch(err => {
        console.error(`[navio-mcp] Init failed for "${server.id || server.name}":`, err.message);
      });
    }
  }
}

/**
 * Register IPC handlers for MCP management.
 */
function registerMcpIpc(ipcMain, loadConfig, saveConfig) {
  ipcMain.handle('mcp-config', async (event, payload) => {
    const cfg = loadConfig();
    if (payload?.op === 'get') {
      return {
        enabled: !!cfg.mcpEnabled,
        servers: Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [],
        status: getStatus()
      };
    }
    if (payload?.op === 'set') {
      saveConfig({
        mcpEnabled: !!payload.enabled,
        mcpServers: Array.isArray(payload.servers) ? payload.servers : []
      });
      // Reconnect based on new config
      await disconnectAll();
      if (payload.enabled && Array.isArray(payload.servers)) {
        await initFromConfig(payload.servers);
      }
      return { ok: true, status: getStatus() };
    }
    if (payload?.op === 'list-tools') {
      return { tools: getMcpTools() };
    }
    if (payload?.op === 'connect') {
      const result = await connectServer(payload.server);
      return { ok: result.status === 'connected', status: result.status, tools: result.tools.length };
    }
    if (payload?.op === 'disconnect') {
      await disconnectServer(payload.serverId);
      return { ok: true };
    }
    return { error: 'Unknown MCP operation' };
  });
}

module.exports = {
  connectServer,
  disconnectServer,
  disconnectAll,
  getMcpTools,
  callMcpTool,
  isMcpTool,
  getStatus,
  initFromConfig,
  registerMcpIpc
};
