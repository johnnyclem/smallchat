---
title: serve
sidebar_label: serve
---

# `serve`

Starts a MCP 2025-11-25 compliant HTTP server that exposes your compiled tools to any MCP-aware client.

## Usage

```bash
npx @smallchat/core serve --source <path> --port <port> [--host <host>]
```

## Options

| Option | Alias | Default | Description |
|--------|-------|---------|-------------|
| `--source <path>` | `-s` | — | Path to a compiled artifact **or** a directory of manifests (compiles on the fly) |
| `--port <port>` | `-p` | `3000` | Port to listen on |
| `--host <host>` | — | `0.0.0.0` | Host/interface to bind |

## Examples

### Serve from a compiled artifact

```bash
npx @smallchat/core serve -s tools.json -p 3001
```

Output:

```
smallchat server running on http://localhost:3001 ✓
MCP discovery: http://localhost:3001/.well-known/mcp.json
JSON-RPC:      http://localhost:3001/mcp
SSE stream:    http://localhost:3001/mcp/sse
Health check:  http://localhost:3001/health
```

### Serve from a source directory (compiles on startup)

```bash
npx @smallchat/core serve -s ./tools -p 3001
```

The directory is compiled in memory on startup. No artifact file is written.

### Bind to localhost only

```bash
npx @smallchat/core serve -s tools.json -p 3001 --host 127.0.0.1
```

## MCP endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/mcp.json` | `GET` | MCP discovery document |
| `/mcp` | `POST` | JSON-RPC 2.0 endpoint |
| `/mcp/sse` | `GET` | Server-Sent Events stream |
| `/health` | `GET` | Health check — returns `{ status: "ok" }` |

## MCP protocol

The server implements the [MCP 2025-11-25](https://spec.modelcontextprotocol.io/) specification:

### Discovery

```bash
curl http://localhost:3001/.well-known/mcp.json
```

```json
{
  "schema_version": "2025-11-25",
  "name": "smallchat",
  "capabilities": {
    "tools": { "listChanged": true },
    "resources": {},
    "prompts": {}
  }
}
```

### Initialize (JSON-RPC)

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "my-app", "version": "1.0.0" }
    }
  }'
```

### List tools

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### Call a tool

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "search_code",
      "arguments": { "query": "typescript generics" }
    }
  }'
```

### SSE stream

Connect to the SSE endpoint to receive real-time events:

```bash
curl -N http://localhost:3001/mcp/sse
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `SMALLCHAT_PORT` | Default port (overridden by `--port`) |
| `SMALLCHAT_HOST` | Default host (overridden by `--host`) |
