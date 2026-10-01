import { Command, Option } from 'commander';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelServer } from '../../channel/channel-server.js';
import type { ChannelServerConfig } from '../../channel/types.js';

/** Environment variable holding the shared HTTP bridge secret. */
export const CHANNEL_SECRET_ENV = 'SMALLCHAT_CHANNEL_SECRET';

const MIN_SECRET_LENGTH = 16;

/**
 * Channel command — run a stdio MCP channel server for Claude Code.
 *
 * This command starts a JSON-RPC 2.0 server over stdin/stdout that implements
 * the Claude Code channel protocol. Claude Code spawns this as a subprocess.
 *
 * Optional HTTP bridge (always authenticated) provides:
 *   POST /event       — inject inbound events (webhooks, chat messages)
 *   POST /permission  — submit permission verdicts (approvers only)
 *   GET  /sse         — observe outbound events (replies, permission requests)
 *   GET  /health      — health check
 *
 * Secrets never come from the command line, where other local users can
 * read them (ps, /proc) and where .mcp.json files get committed: the shared
 * secret is read from $SMALLCHAT_CHANNEL_SECRET or --http-bridge-secret-file,
 * per-sender tokens from --http-bridge-tokens-file.
 */
export const channelCommand = new Command('channel')
  .description('Run a stdio MCP channel server for Claude Code')
  .requiredOption('-n, --name <name>', 'Channel name/identifier')
  .option('--two-way', 'Enable two-way mode with reply tool', false)
  .option('--reply-tool <name>', 'Reply tool name (default: "reply")', 'reply')
  .option('--permission-relay', 'Enable permission relay', false)
  .option('--instructions <text>', 'Channel instructions for the LLM')
  .option('--http-bridge', 'Enable the HTTP bridge for inbound webhooks (needs a secret)', false)
  .option('--http-bridge-port <number>', 'HTTP bridge port', '3002')
  .option('--http-bridge-host <address>', 'HTTP bridge host', '127.0.0.1')
  .option('--http-bridge-secret-file <path>', `File holding the shared bridge secret (mode 0600); default: $${CHANNEL_SECRET_ENV}`)
  .option('--http-bridge-secret-identity <name>', 'Sender identity of requests that present the shared secret', 'bridge')
  .option('--http-bridge-tokens-file <path>', 'JSON file of per-sender tokens: {"<identity>": "<token>"} (mode 0600)')
  .option('--http-bridge-allowed-host <hostnames>', 'Comma-separated Host names the bridge accepts (required for a 0.0.0.0 bind)')
  .option('--permission-approvers <identities>', 'Comma-separated identities allowed to approve or deny tool use over the bridge')
  .option('--sender-allowlist <senders>', 'Comma-separated sender allowlist')
  .option('--sender-allowlist-file <path>', 'Path to sender allowlist file')
  .option('--max-payload-size <bytes>', 'Max payload size in bytes', '65536')
  .addOption(new Option('--http-bridge-secret <token>').hideHelp())
  .action(async (options) => {
    let credentials: BridgeCredentials;
    try {
      credentials = resolveBridgeCredentials(options);
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    }

    const config: ChannelServerConfig = {
      channelName: options.name,
      twoWay: options.twoWay,
      replyToolName: options.replyTool,
      permissionRelay: options.permissionRelay,
      instructions: options.instructions,
      httpBridge: options.httpBridge,
      httpBridgePort: parseInt(options.httpBridgePort, 10),
      httpBridgeHost: options.httpBridgeHost,
      httpBridgeSecret: credentials.secret,
      httpBridgeSecretIdentity: options.httpBridgeSecretIdentity,
      httpBridgeTokens: credentials.tokens,
      httpBridgeAllowedHosts: splitList(options.httpBridgeAllowedHost),
      permissionApprovers: splitList(options.permissionApprovers),
      senderAllowlist: splitList(options.senderAllowlist),
      senderAllowlistFile: options.senderAllowlistFile
        ? resolve(options.senderAllowlistFile)
        : undefined,
      maxPayloadSize: parseInt(options.maxPayloadSize, 10),
    };

    if (config.permissionRelay && config.httpBridge && !config.permissionApprovers?.length) {
      process.stderr.write(
        'Warning: --permission-relay is enabled but no --permission-approvers are configured.\n' +
        'Every verdict submitted over the HTTP bridge will be refused.\n\n',
      );
    }
    if (config.httpBridge && !config.senderAllowlist?.length && !config.senderAllowlistFile) {
      process.stderr.write(
        'Note: no sender allowlist; every authenticated identity can post events.\n\n',
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
      process.stderr.write(`[channel] Event injected from ${event.sender ?? 'local'}: ${event.channel} (${event.content.slice(0, 80)}...)\n`);
    });

    server.on('reply', (reply) => {
      process.stderr.write(`[channel] Reply: ${reply.message.slice(0, 80)}\n`);
    });

    server.on('permission-request', (req) => {
      process.stderr.write(`[channel] Permission request ${req.request_id}: ${req.description}\n`);
    });

    server.on('permission-verdict', (verdict) => {
      process.stderr.write(`[channel] Permission verdict ${verdict.request_id}: ${verdict.behavior} (approver: ${verdict.approver ?? 'local'})\n`);
    });

    server.on('approver-rejected', (identity) => {
      process.stderr.write(`[channel] Permission verdict refused: ${identity} is not an approver\n`);
    });

    server.on('sender-rejected', (sender) => {
      process.stderr.write(`[channel] Sender rejected: ${sender}\n`);
    });

    try {
      await server.start();
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    }

    process.stderr.write(
      `[channel] ${config.channelName} channel server started (stdio)\n` +
      `  Two-way: ${config.twoWay ? 'yes' : 'no'}\n` +
      `  Permission relay: ${config.permissionRelay ? 'yes' : 'no'}\n` +
      `  HTTP bridge: ${config.httpBridge ? `http://${config.httpBridgeHost}:${config.httpBridgePort}` : 'disabled'}\n`,
    );
  });

// ---------------------------------------------------------------------------
// Bridge credentials
// ---------------------------------------------------------------------------

export interface BridgeCredentials {
  secret?: string;
  tokens?: Record<string, string>;
}

/**
 * The HTTP bridge credentials for the CLI options: the shared secret from
 * --http-bridge-secret-file or $SMALLCHAT_CHANNEL_SECRET, per-sender tokens
 * from --http-bridge-tokens-file. Throws for a secret on the command line,
 * a credential file other users can read, a short secret, or a bridge
 * with no credential at all.
 */
export function resolveBridgeCredentials(
  options: {
    httpBridge?: boolean;
    httpBridgeSecret?: string;
    httpBridgeSecretFile?: string;
    httpBridgeTokensFile?: string;
  },
  env: Record<string, string | undefined> = process.env,
): BridgeCredentials {
  if (options.httpBridgeSecret !== undefined) {
    throw new Error(
      `--http-bridge-secret is no longer accepted: command-line secrets are visible to other users and end up in committed .mcp.json files. ` +
      `Set ${CHANNEL_SECRET_ENV} or use --http-bridge-secret-file <path>.`,
    );
  }

  let secret: string | undefined;
  if (options.httpBridgeSecretFile) {
    secret = readPrivateFile(options.httpBridgeSecretFile).trim();
  } else if (env[CHANNEL_SECRET_ENV]) {
    secret = env[CHANNEL_SECRET_ENV]!.trim();
  }
  if (secret !== undefined && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`The HTTP bridge secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  let tokens: Record<string, string> | undefined;
  if (options.httpBridgeTokensFile) {
    const raw = readPrivateFile(options.httpBridgeTokensFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${options.httpBridgeTokensFile} is not valid JSON (expected {"<identity>": "<token>"})`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${options.httpBridgeTokensFile} must be a JSON object of {"<identity>": "<token>"}`);
    }
    tokens = {};
    for (const [identity, token] of Object.entries(parsed)) {
      if (typeof token !== 'string' || token.length < MIN_SECRET_LENGTH) {
        throw new Error(`${options.httpBridgeTokensFile}: the token for "${identity}" must be a string of at least ${MIN_SECRET_LENGTH} characters`);
      }
      tokens[identity] = token;
    }
  }

  if (options.httpBridge && secret === undefined && !tokens) {
    throw new Error(
      `--http-bridge needs a secret: set ${CHANNEL_SECRET_ENV}, or pass --http-bridge-secret-file <path> ` +
      'or --http-bridge-tokens-file <path>. The bridge never runs unauthenticated.',
    );
  }
  return { ...(secret !== undefined ? { secret } : {}), ...(tokens ? { tokens } : {}) };
}

/** Read a credential file, refusing one that group or others can read (POSIX). */
function readPrivateFile(path: string): string {
  const abs = resolve(path);
  const mode = statSync(abs).mode;
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error(`${abs} is readable by other users (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${abs}`);
  }
  return readFileSync(abs, 'utf-8');
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
