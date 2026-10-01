/**
 * MCP module barrel — `smallchat serve` and its building blocks.
 *
 * MCPServer is an exact MCP aggregator on the official SDK: it serves a
 * compiled artifact's tools (aggregate names `<providerId>__<toolName>`, or
 * one provider's names verbatim), forwards tools/call by exact name to the
 * upstream MCP servers (UpstreamPool), and offers semantic resolution only
 * through the `smallchat_resolve` tool, which never executes.
 *
 *   const server = new MCPServer({ sourcePath: 'tools.toolkit.json' });
 *   await server.startStdio();                       // stdio (default for hosts)
 *   await server.startHttp({ port: 3001, token });   // Streamable HTTP at /mcp
 */

export {
  MCPServer,
  MCP_HTTP_PATH,
  SERVER_NAME,
  SERVER_VERSION,
  type MCPServerConfig,
  type HttpServeOptions,
  type McpApp,
  type McpToolExecutor,
  type ResolveProposal,
} from './server.js';
export { UpstreamPool, withUpstreamCallContext, UPSTREAM_RESULT_KEY } from './upstream.js';
export type { UpstreamPoolOptions, UpstreamCallContext } from './upstream.js';
export {
  buildToolTable,
  aggregateToolName,
  isAggregateProviderId,
  closeMatches,
  MCP_TOOL_NAME_PATTERN,
  RESOLVE_TOOL_NAME,
} from './tool-names.js';
export type { ToolTable, ToolTableEntry, SkippedTool } from './tool-names.js';
export { toCallToolResult, compactResolution, RESOLUTION_META_KEY } from './results.js';
export type { CompactResolution } from './results.js';
export { ensureTokenFile, DEFAULT_TOKEN_FILE } from './http-guard.js';
export { runConformance } from './conformance.js';
export type { ConformanceCheck, ConformanceTarget, ConformanceOptions } from './conformance.js';
export { AuditLog } from './audit-log.js';
export type { AuditEntry, AuditLogOptions } from './audit-log.js';

// Re-export public types
export type { McpTool, McpUiToolMeta, McpUiResourceMeta } from './types.js';
export { MCP_PROTOCOL_VERSIONS } from './types.js';
export { UIResourceRegistry } from './ui-resources.js';
export type { UIContentProvider, UIResourceContent, UIResourceEntry } from './ui-resources.js';
