---
title: MCPServer
sidebar_label: MCPServer
---

# MCPServer API Reference

`MCPServer` is smallchat's production MCP server. It serves a compiled toolkit over JSON-RPC 2.0 + SSE, and also supports programmatic registration of tools and MCP Apps interactive views.

> Looking for Swift? The Swift implementation lives in its own repository: [github.com/johnnyclem/smallchat-swift](https://github.com/johnnyclem/smallchat-swift).

## Constructor

```typescript
import { MCPServer } from '@smallchat/core';
import type { MCPServerConfig } from '@smallchat/core';

const server = new MCPServer({
  port: 3001,
  host: '127.0.0.1',
  sourcePath: './manifests',     // directory of manifests or a compiled .toolkit artifact
  dbPath: './smallchat.db',      // optional — SQLite session persistence (default 'smallchat.db')
});
```

### `MCPServerConfig`

```typescript
interface MCPServerConfig {
  port: number;            // port to listen on
  host: string;            // host to bind to
  sourcePath: string;      // source directory or compiled artifact
  dbPath?: string;         // SQLite database path for sessions
  enableAuth?: boolean;    // OAuth 2.1 authentication
  enableRateLimit?: boolean;
  rateLimitRPM?: number;   // max requests/minute per client (default 600)
  enableAudit?: boolean;   // in-memory request audit trail
  sessionTTLMs?: number;   // session TTL (default 24h)
  rtkConfig?: RtkConfig;   // RTK output compression
  corsOrigin?: string | null;
  maxBodyBytes?: number;   // POST body limit (default 4 MiB)
}
```

## Lifecycle

```typescript
await server.start();   // loads the toolkit from sourcePath and listens
await server.stop();    // closes SSE clients, the session DB, and the HTTP server
```

## Registering tools

Tools compiled into the toolkit at `sourcePath` are served automatically and executed through the semantic dispatch runtime. You can register additional tools directly:

### `server.registerTool(tool, executor?)`

```typescript
import type { McpTool, McpToolExecutor } from '@smallchat/core';

const tool: McpTool = {
  id: 'github:search_code',
  name: 'search_code',
  title: 'Search Code',
  description: 'Search for code across GitHub repositories',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
};

const executor: McpToolExecutor = async (args) => {
  const results = await github.searchCode(args.query as string);
  return { content: JSON.stringify(results), isError: false };
};

server.registerTool(tool, executor);
```

Registered tools appear in `tools/list` alongside the compiled toolkit. `tools/call` invokes the executor; a tool registered without one returns an explanatory error when called.

### `server.registerApp(app)` — MCP Apps

Register a tool together with its interactive HTML view in one call. The tool is stamped with `_meta.ui` so MCP Apps clients can discover the view, and the HTML is served as a `ui://` resource:

```typescript
server.registerApp({
  tool: {
    id: 'weather:view',
    name: 'weather_view',
    title: 'Weather',
    description: 'Show current weather with an interactive view',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
  uiContent: '<html><body>…</body></html>',  // or async () => Promise<string> for lazy loading
  uiOptions: { description: 'Weather card' },
  executor: async (args) => ({ content: await getWeather(args.city as string), isError: false }),
});
```

The view is served at `ui://smallchat/weather_view` (override with `uiUri`) with MIME type `text/html;profile=mcp-app`, so hosts render it in a sandboxed iframe.

### `server.registerUIResource(toolName, content, options?)`

Register a standalone `ui://` resource without a tool. Returns the canonical URI.

## Embedding

### `server.createHttpHandler()`

Returns a standard Node.js `http.RequestListener` for embedding in an existing server instead of calling `start()`:

```typescript
import http from 'http';

const httpServer = http.createServer(server.createHttpHandler());
httpServer.listen(3001);
```

## Resources and prompts

Handler-based registries are exposed for resources and prompts:

```typescript
server.resources.registerHandler(/* ResourceHandler */);
server.prompts.registerPrompt(/* StaticPrompt */);
```

## HTTP endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` or `/rpc` | JSON-RPC 2.0 — all MCP methods |
| `GET` | `/.well-known/mcp.json` | Discovery document |
| `GET` | `/sse` | Server-Sent Events stream |
| `GET` | `/health` | Health check |
| `POST` | `/oauth/token` | OAuth 2.1 token endpoint |

## Supported JSON-RPC methods

| Method | Description |
|--------|-------------|
| `initialize` | Protocol handshake (returns `Mcp-Session-Id` header) |
| `tools/list` | List compiled + registered tools (cursor-paginated) |
| `tools/call` | Invoke a tool by name (SSE streaming when `Accept: text/event-stream`) |
| `resources/list` | List resources, including `ui://` app views |
| `resources/read` | Read a resource (serves `ui://` HTML for MCP Apps) |
| `resources/templates/list` | List resource templates |
| `resources/subscribe` / `unsubscribe` | Resource change notifications over SSE |
| `prompts/list` / `prompts/get` | Prompt registry access |
| `ping`, `shutdown` | Keepalive / session teardown |

## MCP constants

```typescript
import { MCP_PROTOCOL_VERSIONS, MCP_ERROR } from '@smallchat/core';

MCP_PROTOCOL_VERSIONS.LATEST   // '2025-11-25'

MCP_ERROR.PARSE_ERROR          // -32700
MCP_ERROR.INVALID_REQUEST      // -32600
MCP_ERROR.METHOD_NOT_FOUND     // -32601
MCP_ERROR.INVALID_PARAMS       // -32602
MCP_ERROR.INTERNAL_ERROR       // -32603
MCP_ERROR.TOOL_NOT_FOUND       // -32040
```

## Full example

```typescript
import { MCPServer } from '@smallchat/core';

const server = new MCPServer({
  port: 3001,
  host: '127.0.0.1',
  sourcePath: './toolkit.json',   // compiled with `smallchat compile`
});

// Add a custom tool with an interactive view
server.registerApp({
  tool: {
    id: 'demo:hello',
    name: 'hello_view',
    title: 'Hello',
    description: 'Say hello with a rendered card',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  uiContent: '<html><body><h1>Hello!</h1></body></html>',
  executor: async (args) => ({ content: `Hello, ${args.name ?? 'world'}!`, isError: false }),
});

await server.start();
// smallchat MCP server listening on http://127.0.0.1:3001
```
