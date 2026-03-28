---
title: MCPServer
sidebar_label: MCPServer
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# MCPServer API Reference

`MCPServer` provides a MCP 2025-11-25 compliant HTTP server. It handles JSON-RPC requests, Server-Sent Events, and the MCP discovery endpoint.

## Constructor

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { MCPServer } from '@smallchat/core';
import type { MCPServerOptions } from '@smallchat/core';

const server = new MCPServer({
  dbPath: './mcp-sessions.db',   // optional — path for session persistence
  name: 'my-tools',              // optional — server name in discovery
  version: '1.0.0',              // optional — version in discovery
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChatMCP

let server = MCPServer(
    name: "my-tools",
    version: "1.0.0",
    dbPath: "./mcp-sessions.db"
)
```

</TabItem>
</Tabs>

### `MCPServerOptions`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
interface MCPServerOptions {
  dbPath?: string;      // SQLite database path for session storage
  name?: string;        // Server name (shown in discovery)
  version?: string;     // Server version (shown in discovery)
  basePath?: string;    // URL base path, default '/mcp'
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// In Swift, options are passed directly as init parameters on MCPServer:
let server = MCPServer(
    name: "my-tools",          // Server name (shown in discovery)
    version: "1.0.0",          // Server version (shown in discovery)
    dbPath: "./mcp-sessions.db" // SQLite database path for session storage
)
```

</TabItem>
</Tabs>

## Registering tools

### `server.registerTool(tool)`

Register a single tool:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let tool = McpTool(
    name: "search_code",
    description: "Search for code across GitHub repositories",
    inputSchema: JSONSchema(
        type: .object,
        properties: ["query": .init(type: .string, description: "Search query")],
        required: ["query"]
    )
) { args in
    let results = try await github.searchCode(args["query"] as! String)
    return McpToolResult(content: [.text(String(describing: results))])
}
server.registerTool(tool)
```

</TabItem>
</Tabs>

### `McpTool`

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// McpTool is a struct in Swift
struct McpTool {
    let name: String
    let description: String
    let inputSchema: JSONSchema
    let handler: ([String: Any]) async throws -> McpToolResult
}

// McpToolResult usage:
McpToolResult(content: [.text("result string")])
```

</TabItem>
</Tabs>

## Creating the HTTP handler

### `server.createHttpHandler()`

Returns a standard Node.js `http.RequestListener` / Express-compatible handler (TypeScript) or starts a SwiftNIO server (Swift):

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import NIO

try await server.start(port: 3001)
print("smallchat MCP server on http://localhost:3001")
```

> Swift uses SwiftNIO directly rather than Express. You can also integrate with Vapor if you need a full web framework.

</TabItem>
</Tabs>

## Closing the server

### `server.close()`

Gracefully shut down the server, closing any open SSE connections and the session database:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
// Graceful shutdown with structured concurrency
try await server.shutdown()
```

</TabItem>
</Tabs>

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

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChatMCP

MCPProtocolVersions.latest   // "2025-11-25"

MCPError.parseError          // -32700
MCPError.invalidRequest      // -32600
MCPError.methodNotFound      // -32601
MCPError.invalidParams       // -32602
MCPError.internalError       // -32603
MCPError.toolNotFound        // -32001
```

</TabItem>
</Tabs>

## Full example

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

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

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat
import SmallChatMCP

let runtime = ToolRuntime(
    vectorIndex: MemoryVectorIndex(),
    embedder: LocalEmbedder()
)
try await runtime.load("./tools.json")

let mcp = MCPServer(name: "my-tools", version: "1.0.0")

for cls in runtime.getClasses() {
    for method in cls.getMethods() {
        mcp.registerTool(McpTool(
            name: "\(cls.id).\(method.name)",
            description: method.description,
            inputSchema: method.inputSchema
        ) { args in
            let result = try await runtime.dispatch(method.name, args: args)
            return McpToolResult(content: [.text(String(describing: result.output))])
        })
    }
}

try await mcp.start(port: 3001)
print("Ready on http://localhost:3001")
```

</TabItem>
</Tabs>
