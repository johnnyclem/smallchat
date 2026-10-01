# Claude Code Channel — Webhook Example

Run a smallchat channel server that receives webhook events and surfaces them
in Claude Code as real-time notifications.

## Quick start

The HTTP bridge always requires a credential. Secrets are never passed on
the command line, where other local users can read them (`ps`) and where
`.mcp.json` files get committed. Generate one and keep it in your
environment (or in a file with mode 0600):

```bash
export SMALLCHAT_CHANNEL_SECRET="$(openssl rand -hex 32)"
```

### 1. Start the channel server (standalone, for testing)

```bash
# One-way (events only):
npx -y @smallchat/core channel --name webhook --http-bridge

# Two-way (with reply tool):
npx -y @smallchat/core channel --name webhook --two-way --http-bridge --http-bridge-port 3002
```

With permission relay, give every sender its own token, so the bridge
knows who is posting and who is approving. The sender identity comes from
the token, never from the request body:

```bash
mkdir -p ~/.smallchat
cat > ~/.smallchat/channel-tokens.json <<JSON
{ "alice@example.com": "$(openssl rand -hex 32)",
  "bob@example.com":   "$(openssl rand -hex 32)" }
JSON
chmod 600 ~/.smallchat/channel-tokens.json

npx -y @smallchat/core channel --name webhook \
  --two-way \
  --permission-relay \
  --http-bridge \
  --http-bridge-tokens-file ~/.smallchat/channel-tokens.json \
  --sender-allowlist "alice@example.com,bob@example.com" \
  --permission-approvers "alice@example.com"
```

Here alice and bob can post events, and only alice can approve or deny a
tool call. Each verdict is logged on stderr with the approver's identity.

### 2. Configure Claude Code

Copy `mcp.json` to your project as `.mcp.json`:

```bash
cp mcp.json /path/to/your/project/.mcp.json
```

It passes `SMALLCHAT_CHANNEL_SECRET` from your environment
(`"${SMALLCHAT_CHANNEL_SECRET}"`), so the secret itself is never in the
file. Then launch Claude Code with the development flag:

```bash
claude --mcp-debug
```

### 3. Send test events

```bash
# Inject a channel event (application/json only; the sender is the
# credential's identity — "bridge" for the shared secret)
curl -X POST http://127.0.0.1:3002/event \
  -H "Content-Type: application/json" \
  -H "X-Channel-Secret: $SMALLCHAT_CHANNEL_SECRET" \
  -d '{
    "content": "New PR #42 opened by alice: Fix memory leak in dispatcher",
    "meta": {
      "repo": "smallchat",
      "event_type": "pull_request"
    }
  }'

# Observe the channel via SSE — also authenticated. Every credential sees
# all channel events and replies; permission requests go to approvers only.
curl -N -H "X-Channel-Secret: $SMALLCHAT_CHANNEL_SECRET" http://127.0.0.1:3002/sse

# Check health (the only unauthenticated endpoint)
curl http://127.0.0.1:3002/health
```

`meta.source` is reserved (it is the channel name in the `<channel
source="...">` tag) and is dropped. So are `meta.sender` and `meta.user`:
the bridge sets `meta.sender` on the notification Claude Code receives to
the credential's identity, so the tag reads `<channel source="webhook"
sender="bridge" ...>` whatever the body claims. A `channel` or `sender`
field in the body is ignored.

### 4. Test permission relay

```bash
# An approver's SSE stream shows permission requests like:
# event: permission-request
# data: {"request_id":"abcde","description":"Run shell command: rm -rf /tmp/old"}

# Approve or deny, as an approver (alice's token):
curl -X POST http://127.0.0.1:3002/permission \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"message": "yes abcde"}'

# Or use explicit format:
curl -X POST http://127.0.0.1:3002/permission \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -d '{"request_id": "abcde", "behavior": "allow"}'
```

A verdict from an identity that is not in `--permission-approvers` gets
`403`.

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
