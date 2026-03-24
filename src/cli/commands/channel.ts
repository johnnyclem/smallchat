import { Command } from 'commander';
import { resolve } from 'node:path';
import { ChannelServer } from '../../channel/channel-server.js';
import type { ChannelServerConfig } from '../../channel/types.js';

/**
 * Channel command — run a stdio MCP channel server for Claude Code.
 *
 * This command starts a JSON-RPC 2.0 server over stdin/stdout that implements
 * the Claude Code channel protocol. Claude Code spawns this as a subprocess.
 *
 * Optional HTTP bridge provides:
 *   POST /event       — inject inbound events (webhooks, chat messages)
 *   POST /permission  — submit permission verdicts
 *   GET  /sse         — observe outbound events (replies, permission requests)
 *   GET  /health      — health check
 */
export const channelCommand = new Command('channel')
  .description('Run a stdio MCP channel server for Claude Code')
  .requiredOption('-n, --name <name>', 'Channel name/identifier')
  .option('--two-way', 'Enable two-way mode with reply tool', false)
  .option('--reply-tool <name>', 'Reply tool name (default: "reply")', 'reply')
  .option('--permission-relay', 'Enable permission relay', false)
  .option('--instructions <text>', 'Channel instructions for the LLM')
  .option('--http-bridge', 'Enable HTTP bridge for inbound webhooks', false)
  .option('--http-bridge-port <number>', 'HTTP bridge port', '3002')
  .option('--http-bridge-host <address>', 'HTTP bridge host', '127.0.0.1')
  .option('--http-bridge-secret <token>', 'Shared secret for HTTP bridge authentication')
  .option('--sender-allowlist <senders>', 'Comma-separated sender allowlist')
  .option('--sender-allowlist-file <path>', 'Path to sender allowlist file')
  .option('--max-payload-size <bytes>', 'Max payload size in bytes', '65536')
  .action(async (options) => {
    const config: ChannelServerConfig = {
      channelName: options.name,
      twoWay: options.twoWay,
      replyToolName: options.replyTool,
      permissionRelay: options.permissionRelay,
      instructions: options.instructions,
      httpBridge: options.httpBridge,
      httpBridgePort: parseInt(options.httpBridgePort, 10),
      httpBridgeHost: options.httpBridgeHost,
      httpBridgeSecret: options.httpBridgeSecret,
      senderAllowlist: options.senderAllowlist?.split(',').map((s: string) => s.trim()),
      senderAllowlistFile: options.senderAllowlistFile
        ? resolve(options.senderAllowlistFile)
        : undefined,
      maxPayloadSize: parseInt(options.maxPayloadSize, 10),
    };

    // Validate: permission relay requires sender gating
    if (config.permissionRelay && !config.senderAllowlist?.length && !config.senderAllowlistFile) {
      process.stderr.write(
        'Warning: --permission-relay is enabled but no sender allowlist is configured.\n' +
        'Permission relay will reject all verdicts until sender gating is set up.\n' +
        'Use --sender-allowlist or --sender-allowlist-file to configure.\n\n',
      );
    }

    const server = new ChannelServer(config);

    // Graceful shutdown
    const shutdown = () => {
      server.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Log events to stderr (stdout is reserved for JSON-RPC)
    server.on('event-injected', (event) => {
      process.stderr.write(`[channel] Event injected: ${event.channel} (${event.content.slice(0, 80)}...)\n`);
    });

    server.on('reply', (reply) => {
      process.stderr.write(`[channel] Reply: ${reply.message.slice(0, 80)}\n`);
    });

    server.on('permission-request', (req) => {
      process.stderr.write(`[channel] Permission request ${req.request_id}: ${req.description}\n`);
    });

    server.on('permission-verdict', (verdict) => {
      process.stderr.write(`[channel] Permission verdict ${verdict.request_id}: ${verdict.behavior}\n`);
    });

    server.on('sender-rejected', (sender) => {
      process.stderr.write(`[channel] Sender rejected: ${sender}\n`);
    });

    await server.start();

    process.stderr.write(
      `[channel] ${config.channelName} channel server started (stdio)\n` +
      `  Two-way: ${config.twoWay ? 'yes' : 'no'}\n` +
      `  Permission relay: ${config.permissionRelay ? 'yes' : 'no'}\n` +
      `  HTTP bridge: ${config.httpBridge ? `http://${config.httpBridgeHost}:${config.httpBridgePort}` : 'disabled'}\n`,
    );
  });
