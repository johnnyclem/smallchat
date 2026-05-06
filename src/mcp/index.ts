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
import type { McpTool, McpResource, McpPrompt, McpUiResourceMeta } from './types.js';
import { UIResourceRegistry } from './ui-resources.js';
import type { UIContentProvider } from './ui-resources.js';

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

/**
 * McpApp — a tool + its associated MCP Apps interactive view.
 *
 * Passed to MCPServer.registerApp() to atomically register both the tool
 * and its ui:// resource in a single call.
 *
 * Obj-C analogy: McpApp ≈ NSViewController subclass declaration — it bundles
 * the model (tool) with its view (HTML resource) and declares how they connect.
 */
export interface McpApp {
  tool: McpTool;
  /** HTML content for the view (string or async loader for lazy loading) */
  uiContent: UIContentProvider;
  /** Optional custom uri; defaults to ui://<serverName>/<toolName> */
  uiUri?: string;
  /** CSP/permission metadata for the sandboxed iframe */
  uiOptions?: {
    description?: string;
    meta?: McpUiResourceMeta;
  };
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
  /** Registry for MCP Apps ui:// resources */
  readonly uiResources: UIResourceRegistry;

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
    this.uiResources = new UIResourceRegistry(serverName);

    this.router = new McpRouter(
      this.sessions,
      this.tools,
      this.resources,
      this.prompts,
      this.broker,
      { serverName, serverVersion, sessionTtlMs },
      this.uiResources,
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
   * Register a tool together with its MCP Apps interactive view.
   *
   * Atomically registers the McpTool (with _meta.ui populated) and its
   * ui:// HTML resource so both are available to clients in a single call.
   *
   * Obj-C analogy: registerApp() ≈ [UIViewController class] + NIB registration —
   * it binds the controller (tool) to its view (HTML resource).
   */
  registerApp(app: McpApp): void {
    const uri = this.uiResources.register(
      app.tool.name,
      app.uiContent,
      { description: app.uiOptions?.description, meta: app.uiOptions?.meta, customUri: app.uiUri },
    );

    // Stamp the tool with _meta.ui so clients can discover the view
    const toolWithMeta: McpTool = {
      ...app.tool,
      _meta: {
        ...app.tool._meta,
        ui: {
          resourceUri: uri,
          visibility: app.uiOptions?.meta ? ['model', 'app'] : undefined,
        },
      },
    };

    this.tools.register(toolWithMeta);
  }

  /**
   * Register a standalone ui:// resource (without registering a tool).
   * Returns the canonical ui:// URI assigned to this resource.
   */
  registerUIResource(
    toolName: string,
    content: UIContentProvider,
    options?: { description?: string; meta?: McpUiResourceMeta; customUri?: string },
  ): string {
    return this.uiResources.register(toolName, content, options);
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
export type { McpTool, McpResource, McpPrompt, McpUiToolMeta, McpUiResourceMeta } from './types.js';
export { MCP_PROTOCOL_VERSIONS, MCP_ERROR } from './types.js';
export { UIResourceRegistry } from './ui-resources.js';
export type { UIContentProvider, UIResourceContent, UIResourceEntry } from './ui-resources.js';

