---
title: serve
sidebar_label: serve
---

# `serve`

Serves a compiled toolkit as **one MCP server** that forwards every tool call, by exact name, to the upstream MCP server that owns the tool. It is built on the official MCP SDK (`@modelcontextprotocol/sdk`) and speaks stdio by default, or Streamable HTTP with `--http`.

## Usage

```bash
# stdio (what MCP hosts launch)
smallchat serve --source tools.toolkit.json

# Streamable HTTP at http://127.0.0.1:3001/mcp, bearer token required
smallchat serve --source tools.toolkit.json --http
```

A typical flow is `smallchat compile --source ~/.mcp.json` (which records how to start each server) followed by `serve`. Hosts then see every upstream tool through one server:

```json
{
  "mcpServers": {
    "smallchat": { "command": "smallchat", "args": ["serve", "--source", "/abs/path/tools.toolkit.json"] }
  }
}
```

## What a client sees

| | Aggregate mode (default) | `--provider <id>` |
|---|---|---|
| Tool names | `<providerId>__<toolName>`, e.g. `github__create_issue` (always matches `^[A-Za-z0-9_-]{1,128}$`) | the upstream names, verbatim |
| Tools served | every provider in the artifact | that provider only |
| Definitions | upstream `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, unchanged | same |

- **`tools/call` is exact.** The name must be one `tools/list` returned. The arguments are validated against the tool's `inputSchema` (invalid arguments return an `isError` result listing each violation; nothing runs), then the call is forwarded to the upstream server. Its result passes through unchanged: every content block, `structuredContent`, `isError`.
- **Unknown names never run anything.** An unknown name returns an `isError` result that lists close names (for example `github__create_issue` for `create_issue`). There is no fuzzy execution.
- **Name collisions are impossible by construction.** A provider id prefixes aggregate names only if it is `[A-Za-z0-9_-]`, has no `__` and does not end in `_`, so every name maps back to exactly one tool. A tool whose aggregate name would be invalid (a dot in its name, more than 128 characters) is left out with a startup message, and never renamed. Serve that provider with `--provider` to reach it.
- **Proof on every result.** `_meta["dev.smallchat/resolution"]` holds `{ toolId, ran, outcome, decision, tier, callDigest, proofDigest, artifactHash }`. `callDigest` is the [canonical call digest](https://github.com/johnnyclem/smallchat/tree/main/spec/call-digest) of what ran. Arguments are never recorded.

### `smallchat_resolve`

Semantic resolution is a separate, read-only tool. `smallchat_resolve { intent, args? }` returns a proposal: `outcome` (`resolved` / `needs-disambiguation` / `unresolved`, or `throttled` with `retryAfterMs` when a programmatic `runtimeOptions.rateLimiter` refuses the intent), `toolId`, `name` (the name to call it by on this server), `tier`, `confidence`, ranked `candidates` and a `proofDigest`. **It never executes**. The client calls the proposed name itself. It applies the same dispatch policy as the runtime (by default a sub-HIGH match is not proposed without an LLM verifier). Turn it off with `--no-resolve-tool`.

## Upstream servers

Each provider's launch spec in the artifact says how to reach it:

| Launch spec | How serve connects |
|---|---|
| `stdio` (`command`, `args`, `env` names) | spawns the server on first use. The environment is the SDK's safe default plus the variables the spec **names**, read from serve's own environment. Artifacts never contain values. |
| `streamable-http` (or a bare MCP `endpoint`) | Streamable HTTP client |
| `sse` | legacy HTTP+SSE client |

Clients connect lazily and reconnect after an upstream exits. Cancellation and progress from the downstream client reach the upstream call. If an upstream no longer lists a tool the artifact has, serve logs it: recompile. Upstream stderr is passed through to serve's stderr.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-s, --source <path>` | required | Compiled artifact (`.json` / `.db`) or a directory of manifests |
| `--provider <id>` | | Serve one provider, upstream names verbatim |
| `--no-resolve-tool` | | Do not offer `smallchat_resolve` |
| `--upstream-timeout <ms>` | `60000` | Per upstream call; progress notifications reset it |
| `--http` | | Streamable HTTP instead of stdio |
| `-p, --port <n>` | `3001` | HTTP port |
| `--host <addr>` | `127.0.0.1` | HTTP bind address |
| `--token-file <path>` | `~/.smallchat/serve-token` | Bearer token, generated (mode 0600) if missing |
| `--http-insecure` | | Serve HTTP without a token |
| `--allowed-host <name...>` | loopback names | Hostnames accepted in `Host` (required for a `0.0.0.0` bind) |
| `--allowed-origin <origin...>` | none | Browser origins allowed to call the server |
| `--max-body-bytes <n>` | `4194304` | Larger POST bodies get 413 |
| `--max-sessions <n>` | `100` | Concurrent HTTP sessions |
| `--session-idle-timeout <min>` | `30` | Idle HTTP sessions are closed |
| `--rate-limit`, `--rate-limit-rpm <n>` | off, `600` | Requests per minute per session (per address before a session) |
| `--audit-log <file>` | | Append every request and its outcome, rejections included, as JSON lines |
| `--decision-log <file>` | | Append every `tools/call` and `smallchat_resolve` decision to a hash-chained JSONL [decision log](./replay#decision-logs) before anything runs |
| `--rtk`, `--rtk-*` | off | RTK compression of successful text results |

## HTTP transport

`--http` serves the MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) transport on a single endpoint, `/mcp` (`POST`, `GET` for the server-to-client stream, `DELETE` to end a session). Protocol versions are negotiated by the SDK: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07.

Before a request reaches MCP:

1. **Host** must be an allowed hostname. This blocks DNS rebinding: a web page's own hostname resolving to 127.0.0.1 gets 403.
2. **Origin**, when present, must be an allowed origin. This blocks cross-site requests from browsers (403).
3. **`Authorization: Bearer <token>`** must match the token file (401 with `WWW-Authenticate` otherwise). This also applies to `initialize`: no session exists before authentication.
4. `POST` bodies must be `application/json` (415), at most `--max-body-bytes` (413), and a JSON-RPC message or batch (400). A client that disconnects mid-body is dropped.
5. Sessions are capped, expire when idle, and unknown `Mcp-Session-Id`s get 404.

```bash
TOKEN=$(cat ~/.smallchat/serve-token)
claude mcp add --transport http smallchat http://127.0.0.1:3001/mcp --header "Authorization: Bearer $TOKEN"
```

Authorization is a static bearer token. Acting as an OAuth 2.1 resource server (RFC 9728 metadata, tokens from an external authorization server) is future work.

## OpenAPPA

[OpenAPPA](https://github.com/archestra-ai/openappa) batteries key their policies by upstream server and tool, `mcp/<server>/<tool>`. Aggregate names (`github__create_issue`) would not match them. Serve each provider separately so APPA sees the upstream names unchanged:

```json
{
  "mcpServers": {
    "github": { "command": "smallchat", "args": ["serve", "--source", "/abs/tools.toolkit.json", "--provider", "github"] },
    "filesystem": { "command": "smallchat", "args": ["serve", "--source", "/abs/tools.toolkit.json", "--provider", "filesystem"] }
  }
}
```

Name each entry after the provider id, and `mcp/github/create_issue` then applies unchanged. Check with `appa describe --check` against the live inventory. `smallchat_resolve` is read-only and never executes. Disable it with `--no-resolve-tool` if you want the served tool list to match the upstream exactly.

## Checking a server

```bash
smallchat doctor --mcp-source tools.toolkit.json          # spawns serve over stdio
smallchat doctor --mcp http://127.0.0.1:3001/mcp          # a running serve --http (reads --token-file)
smallchat doctor --mcp-source tools.toolkit.json --mcp-call github__get_me
```

These run the conformance checks the test suite runs: the SDK client connects, lists tools, calls an unknown tool (it must be refused), calls `smallchat_resolve`, optionally calls a real tool. Over HTTP they also check a notification (202) and the refusals above. Each step has a timeout, so a hang is a failure.

## Audit log

`--audit-log <file>` appends one JSON line per request after its response: `transport`, `method`, `requestId`, `sessionId`, `remoteAddress`, `outcome` (`ok` / `error` / `rejected`), `httpStatus` and `errorCode` where relevant, and for `tools/call` the `toolName` called, the `toolId` that ran and its `callDigest`. Arguments are not recorded. The file is mode 0600 and append-only by convention. It is not hash-chained.
