---
title: MCPServer
sidebar_label: MCPServer
---

# MCPServer API Reference

`MCPServer` is what `smallchat serve` runs. It is an MCP aggregator built on the official SDK (`@modelcontextprotocol/sdk`): it serves a compiled toolkit's tools and forwards each `tools/call`, by exact name, to the upstream MCP server that owns the tool. It also serves tools and MCP Apps views you register programmatically. See [`serve`](../cli/serve) for the behaviour a client sees.

> Looking for Swift? The Swift implementation lives in its own repository: [github.com/johnnyclem/smallchat-swift](https://github.com/johnnyclem/smallchat-swift).

## Constructor

```typescript
import { MCPServer } from '@smallchat/core';

const server = new MCPServer({
  sourcePath: './tools.toolkit.json',   // compiled artifact (.json/.db) or a manifest directory
});
```

### `MCPServerConfig`

```typescript
interface MCPServerConfig {
  sourcePath?: string;            // artifact or manifest dir; omit to serve only registered tools
  allowDuplicates?: boolean;      // manifest dir: keep near-duplicate tools
  runtimeOptions?: RuntimeOptions; // dispatch policy for smallchat_resolve and argument coercion, decisionLog, rateLimiter
  provider?: string;              // serve one provider, upstream tool names verbatim
  resolveTool?: boolean;          // list smallchat_resolve (default true with an artifact)
  upstream?: UpstreamPoolOptions; // requestTimeoutMs, env, stderr, headers (per provider), clientInfo
  rtkConfig?: RtkConfig;          // RTK compression of successful text results
  auditLog?: AuditLog;            // default: in-memory; new AuditLog({ file }) appends JSONL
  log?: (line: string) => void;   // operator messages (default: stderr)
}
```

## Serving

```typescript
// stdio — one client on this process's stdin/stdout
await server.startStdio();
await server.closed();      // resolves when the client goes away
await server.stop();        // closes sessions, every upstream client (stdio upstreams exit) and a decision log opened from a path

// Streamable HTTP at /mcp
const { url } = await server.startHttp({
  port: 3001,
  host: '127.0.0.1',
  token,                    // required bearer token, or null for no auth
  allowedHosts: ['localhost', '127.0.0.1', '[::1]'],  // default for a loopback bind
  allowedOrigins: [],       // default: browsers refused
  maxBodyBytes: 4 * 1024 * 1024,
  maxSessions: 100,
  sessionIdleTimeoutMs: 30 * 60_000,
  rateLimitRPM: 600,        // optional
});
```

`ensureTokenFile(path?)` (from `@smallchat/core/mcp`) reads the bearer token from a file, or generates it there with mode 0600.

To embed in an existing `http.Server`, call `await server.load()` and then `createServer(server.createHttpHandler(options))`. The handler serves `/mcp` only.

## What is served

- `tools/list`: the artifact's tools as `<providerId>__<toolName>` (or verbatim with `provider`), with upstream `title`, `description`, `inputSchema`, `outputSchema` and `annotations`. Then `smallchat_resolve`, then registered tools. `server.listTools()` returns exactly this list. `server.toolTable` maps names to canonical tool ids.
- `tools/call`: an exact name only. Artifact tools run through `runtime.dispatchById` (argument validation, then the upstream call). The upstream `CallToolResult` passes through with `_meta["dev.smallchat/resolution"]` added. Unknown names return an `isError` result with close names.
- `smallchat_resolve { intent, args? }`: a `ResolveProposal` in `structuredContent`. Never executes.
- `resources/*`: `server.resources` handlers plus `ui://` views. Subscriptions belong to the session that made them and are released when it closes.
- `prompts/*`: `server.prompts`.
- Capabilities: `tools`, `resources` (`subscribe`, `listChanged`), `prompts` (`listChanged`). `server.broadcastListChanged(type)` notifies every session.

Protocol versions are the SDK's: `MCP_PROTOCOL_VERSIONS` (from `@smallchat/core/mcp`) is exactly the list it negotiates.

## Registering tools

### `server.registerTool(tool, executor?)`

```typescript
import type { McpTool, McpToolExecutor } from '@smallchat/core/mcp';

const tool: McpTool = {
  name: 'search_code',
  title: 'Search Code',
  description: 'Search for code across GitHub repositories',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
};

const executor: McpToolExecutor = async (args) => {
  const results = await github.searchCode(args.query as string);
  return { content: results };
};

server.registerTool(tool, executor);
```

Registered tools appear in `tools/list` after the artifact's. A name that is already served is refused (it throws). A tool registered without an executor returns an `isError` result when called.

### `server.registerApp(app)` (MCP Apps)

Registers a tool together with its interactive HTML view. The tool is stamped with `_meta.ui`, and the HTML is served as a `ui://` resource with MIME type `text/html;profile=mcp-app`:

```typescript
server.registerApp({
  tool: {
    name: 'weather_view',
    title: 'Weather',
    description: 'Show current weather with an interactive view',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
  uiContent: '<html><body>…</body></html>',  // or async () => Promise<string>
  uiOptions: { description: 'Weather card' },
  executor: async (args) => ({ content: await getWeather(args.city as string) }),
});
```

The view is served at `ui://smallchat/weather_view` (override with `uiUri`).

### `server.registerUIResource(toolName, content, options?)`

Registers a standalone `ui://` resource without a tool. Returns the canonical URI.

## Upstream execution outside serve

`loadRuntime(path)` returns `{ runtime, artifact, embedder, upstreams }`. MCP tools of the runtime execute through `upstreams` (an `UpstreamPool`), so `runtime.dispatchById('github/create_issue', args)` runs the tool on the upstream server. Call `await upstreams.close()` when done; it stops stdio upstream processes.
