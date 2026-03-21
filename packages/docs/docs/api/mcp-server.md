---
title: MCPServer
sidebar_label: MCPServer
---

# MCPServer API Reference

`MCPServer` provides a MCP 2025-11-25 compliant HTTP server. It handles JSON-RPC requests, Server-Sent Events, and the MCP discovery endpoint.

## Constructor

```typescript
import { MCPServer } from '@smallchat/core';
import type { MCPServerOptions } from '@smallchat/core';

const server = new MCPServer({
  dbPath: './mcp-sessions.db',   // optional — path for session persistence
  name: 'my-tools',              // optional — server name in discovery
  version: '1.0.0',              // optional — version in discovery
});
```

### `MCPServerOptions`

```typescript
interface MCPServerOptions {
  dbPath?: string;      // SQLite database path for session storage
  name?: string;        // Server name (shown in discovery)
  version?: string;     // Server version (shown in discovery)
  basePath?: string;    // URL base path, default '/mcp'
}
```

## Registering tools

### `server.registerTool(tool)`

Register a single tool:

```typescript
import type { McpTool } from '@smallchat/core';

const tool: McpTool = {
  name: 'search_code',
  description: 'Search for code across GitHub repositories',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    // Your implementation
    const results = await github.searchCode(args.query);
    return {
      content: [{ type: 'text', text: JSON.stringify(results) }],
    };
  },
};

server.registerTool(tool);
```

### `McpTool`

```typescript
interface McpTool {
  name: string;
  description: string;
  inputSchema: JSONSchemaType;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
```

## Creating the HTTP handler

### `server.createHttpHandler()`

Returns a standard Node.js `http.RequestListener` / Express-compatible handler:

```typescript
import http from 'http';

const handler = server.createHttpHandler();
const httpServer = http.createServer(handler);
httpServer.listen(3001, () => {
  console.log('smallchat MCP server on http://localhost:3001');
});
```

With Express:

```typescript
import express from 'express';

const app = express();
app.use('/mcp', server.createHttpHandler());
app.listen(3001);
```

## Closing the server

### `server.close()`

Gracefully shut down the server, closing any open SSE connections and the session database:

```typescript
process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});
```

## MCP protocol endpoints

The server mounts the following routes:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/mcp.json` | Discovery document |
| `POST` | `/mcp` | JSON-RPC 2.0 — all MCP methods |
| `GET` | `/mcp/sse` | Server-Sent Events for streaming |
| `GET` | `/health` | Health check — returns `{ status: "ok" }` |

## Supported JSON-RPC methods

| Method | Description |
|--------|-------------|
| `initialize` | Protocol handshake |
| `tools/list` | List all registered tools |
| `tools/call` | Invoke a tool by name |
| `resources/list` | List resources (if any registered) |
| `prompts/list` | List prompts (if any registered) |
| `ping` | Keepalive |

## MCP constants

```typescript
import { MCP_PROTOCOL_VERSIONS, MCP_ERROR } from '@smallchat/core';

MCP_PROTOCOL_VERSIONS.LATEST   // '2025-11-25'

MCP_ERROR.PARSE_ERROR          // -32700
MCP_ERROR.INVALID_REQUEST      // -32600
MCP_ERROR.METHOD_NOT_FOUND     // -32601
MCP_ERROR.INVALID_PARAMS       // -32602
MCP_ERROR.INTERNAL_ERROR       // -32603
MCP_ERROR.TOOL_NOT_FOUND       // -32001
```

## Full example

```typescript
import { MCPServer, ToolRuntime, LocalEmbedder, MemoryVectorIndex } from '@smallchat/core';
import http from 'http';

// Create the runtime and load tools
const runtime = new ToolRuntime({
  embedder: new LocalEmbedder(),
  vectorIndex: new MemoryVectorIndex(),
});
await runtime.load('./tools.json');

// Create the MCP server
const mcp = new MCPServer({ name: 'my-tools', version: '1.0.0' });

// Bridge runtime tools into the MCP server
for (const cls of runtime.getClasses()) {
  for (const method of cls.getMethods()) {
    mcp.registerTool({
      name: `${cls.id}.${method.name}`,
      description: method.description,
      inputSchema: method.inputSchema,
      handler: (args) => runtime.dispatch(method.name, args),
    });
  }
}

// Start
const httpServer = http.createServer(mcp.createHttpHandler());
httpServer.listen(3001, () => {
  console.log('Ready on http://localhost:3001');
});
```
