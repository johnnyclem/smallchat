/**
 * MCPServer — top-level entry point for the MCP 2025-11-25 compliant server.
 *
 * Usage:
 *   const server = new MCPServer({ dbPath: ':memory:' });
 *   server.registerTool({ id: 'my-tool', name: 'my_tool', ... });
 *   const handler = server.createHttpHandler();
 *   createServer(handler).listen(3001);
 */

import type { RequestListener } from 'node:http';
import { SessionManager } from './session.js';
import { ToolRegistry, ResourceRegistry, PromptRegistry } from './registry.js';
import { SseBroker } from './sse-broker.js';
import { McpRouter } from './router.js';
import { createHttpHandler } from './transports/http.js';
import { startStdioTransport } from './transports/stdio.js';
import type { McpTool, McpResource, McpPrompt } from './types.js';

export interface MCPServerOptions {
  /** SQLite database path. Use ':memory:' for tests. Default: ':memory:' */
  dbPath?: string;
  /** Session TTL in milliseconds. Default: 24h */
  sessionTtlMs?: number;
  /** Server name returned in initialize. Default: 'smallchat' */
  serverName?: string;
  /** Server version returned in initialize. Default: '0.5.0' */
  serverVersion?: string;
}

export class MCPServer {
  private readonly sessions: SessionManager;
  private readonly tools: ToolRegistry;
  private readonly resources: ResourceRegistry;
  private readonly prompts: PromptRegistry;
  private readonly broker: SseBroker;
  private readonly router: McpRouter;
  private readonly serverName: string;
  private readonly serverVersion: string;

  constructor(opts: MCPServerOptions = {}) {
    const {
      dbPath = ':memory:',
      sessionTtlMs = 86_400_000,
      serverName = 'smallchat',
      serverVersion = '0.5.0',
    } = opts;

    this.serverName = serverName;
    this.serverVersion = serverVersion;

    this.sessions = new SessionManager(dbPath);
    this.tools = new ToolRegistry();
    this.resources = new ResourceRegistry();
    this.prompts = new PromptRegistry();
    this.broker = new SseBroker();

    this.router = new McpRouter(
      this.sessions,
      this.tools,
      this.resources,
      this.prompts,
      this.broker,
      { serverName, serverVersion, sessionTtlMs },
    );

    // Start background janitor (fires every 60s, unref'd so it doesn't block exit)
    this.sessions.startJanitor(60_000);
  }

  registerTool(tool: McpTool): void {
    this.tools.register(tool);
  }

  registerResource(resource: McpResource): void {
    this.resources.register(resource);
  }

  registerPrompt(prompt: McpPrompt): void {
    this.prompts.register(prompt);
  }

  /**
   * Returns a Node.js http.RequestListener for use with createServer().
   */
  createHttpHandler(): RequestListener {
    return createHttpHandler(
      this.router,
      this.broker,
      this.sessions,
      this.tools,
      { serverName: this.serverName, serverVersion: this.serverVersion },
    );
  }

  /**
   * Start STDIO transport (reads from stdin, writes to stdout).
   * Typically used for `smallchat serve --stdio`.
   */
  startStdio(): void {
    startStdioTransport(this.router);
  }

  /**
   * Shut down: close DB and disconnect all SSE streams.
   */
  close(): void {
    this.sessions.close_db();
  }
}

// Re-export public types
export type { McpTool, McpResource, McpPrompt } from './types.js';
export { MCP_PROTOCOL_VERSIONS, MCP_ERROR } from './types.js';

