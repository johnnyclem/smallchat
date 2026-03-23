# Claude Code Channel — Webhook Example

Run a smallchat channel server that receives webhook events and surfaces them
in Claude Code as real-time notifications.

## Quick start

### 1. Start the channel server (standalone, for testing)

```bash
# One-way (events only):
npx smallchat channel --name webhook --http-bridge

# Two-way (with reply tool):
npx smallchat channel --name webhook --two-way --http-bridge --http-bridge-port 3002

# With permission relay and sender gating:
npx smallchat channel --name webhook \
  --two-way \
  --permission-relay \
  --http-bridge \
  --http-bridge-secret "my-secret" \
  --sender-allowlist "alice@example.com,bob@example.com"
```

### 2. Configure Claude Code

Copy `mcp.json` to your project as `.mcp.json`:

```bash
cp mcp.json /path/to/your/project/.mcp.json
```

Then launch Claude Code with the development flag:

```bash
claude --mcp-debug
```

### 3. Send test events

```bash
# Inject a channel event
curl -X POST http://127.0.0.1:3002/event \
  -H "Content-Type: application/json" \
  -H "X-Channel-Secret: change-me-in-production" \
  -d '{
    "content": "New PR #42 opened by alice: Fix memory leak in dispatcher",
    "meta": {
      "sender": "github",
      "repo": "smallchat",
      "event_type": "pull_request"
    }
  }'

# Observe outbound events (replies, etc.) via SSE
curl -N http://127.0.0.1:3002/sse

# Check health
curl http://127.0.0.1:3002/health
```

### 4. Test permission relay

```bash
# The SSE stream will show permission requests like:
# event: permission-request
# data: {"request_id":"abcde","description":"Run shell command: rm -rf /tmp/old"}

# Approve or deny:
curl -X POST http://127.0.0.1:3002/permission \
  -H "Content-Type: application/json" \
  -H "X-Channel-Secret: change-me-in-production" \
  -d '{"message": "yes abcde"}'

# Or use explicit format:
curl -X POST http://127.0.0.1:3002/permission \
  -H "Content-Type: application/json" \
  -H "X-Channel-Secret: change-me-in-production" \
  -d '{"request_id": "abcde", "behavior": "allow"}'
```

## Architecture

```
┌──────────────┐  stdio (JSON-RPC)  ┌───────────────────┐
│  Claude Code  │◄─────────────────►│  smallchat channel │
└──────────────┘                    │  (MCP server)      │
                                    │                    │
    Webhook ──► POST /event ───────►│  HTTP bridge       │
                                    │  (localhost:3002)  │
    Browser ◄── GET /sse ◄──────────│                    │
                                    └───────────────────┘
```

The channel server communicates with Claude Code over stdio (JSON-RPC 2.0)
and exposes a local HTTP bridge for external integrations.

## Non-goals

- Claude Code channels require Claude Code and claude.ai login; this server
  cannot emulate that auth. It is host-agnostic but compatible with Claude
  Code's expectations when run as a channel server.
- Console/API key auth for Claude Code channels is not supported.
