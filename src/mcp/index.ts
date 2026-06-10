/**
 * MCP module barrel — single entry point for the smallchat MCP server.
 *
 * There is one MCPServer: the production server in server.ts. It serves a
 * compiled toolkit (via ToolRuntime) and also supports programmatic
 * registration of tools and MCP Apps views:
 *
 *   const server = new MCPServer({ port: 3001, host: '127.0.0.1', sourcePath: './manifests' });
 *   server.registerApp({ tool, uiContent: '<html>…</html>', executor });
 *   await server.start();                 // standalone
 *   // …or embed: createServer(server.createHttpHandler()).listen(3001)
 *
 * The lower-level JSON-RPC engine (McpRouter, SessionManager, SseBroker,
 * transports/) remains available as internal machinery for the experimental
 * next-generation protocol surface; import those modules directly if needed.
 */

export {
  MCPServer,
  type MCPServerConfig,
  type McpApp,
  type McpToolExecutor,
} from './server.js';

// Re-export public types
export type { McpTool, McpResource, McpPrompt, McpUiToolMeta, McpUiResourceMeta } from './types.js';
export { MCP_PROTOCOL_VERSIONS, MCP_ERROR } from './types.js';
export { UIResourceRegistry } from './ui-resources.js';
export type { UIContentProvider, UIResourceContent, UIResourceEntry } from './ui-resources.js';
