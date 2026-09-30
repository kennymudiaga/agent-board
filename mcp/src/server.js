/**
 * agentboard-mcp — Model Context Protocol server (stdio transport).
 * Any MCP-capable agent (OpenCode, Claude Code, VS Code Copilot, Cursor,
 * OpenDevin) mounts it and gets AgentBoard tools as structured capabilities.
 * Identity comes from env vars (AB_SERVER, AB_TOKEN, AB_AGENT_ID) — the
 * server never writes config files.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, callTool } from './tools.js';

const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

const server = new McpServer({
  name: 'agentboard-mcp',
  version: pkg.version,
});

for (const [name, tool] of Object.entries(tools)) {
  server.registerTool(name, {
    title: `AgentBoard ${name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }, async (args) => callTool(name, args));
}

const transport = new StdioServerTransport();
await server.connect(transport);