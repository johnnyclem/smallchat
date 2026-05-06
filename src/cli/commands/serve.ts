import { Command } from 'commander';
import { resolve } from 'node:path';
import { MCPServer, type MCPServerConfig } from '../../mcp/server.js';

/**
 * MCP-compatible serve command.
 *
 * Starts a production-grade MCP 2026 compliant JSON-RPC server with:
 *   - /.well-known/mcp.json discovery
 *   - Session management (SQLite-backed, survives restarts)
 *   - tools/list, tools/call (paginated, with SSE streaming)
 *   - resources/list, resources/read, resources/subscribe
 *   - prompts/list, prompts/get
 *   - OAuth 2.1 bearer token authentication
 *   - Rate limiting and audit logging
 *   - Progress notifications and listChanged events
 */
export const serveCommand = new Command('serve')
  .description('Start an MCP 2026 compliant tool server with streaming support')
  .requiredOption('-s, --source <path>', 'Source directory or compiled artifact (.json)')
  .option('-p, --port <number>', 'Port to listen on', '3001')
  .option('--host <address>', 'Host to bind to', '127.0.0.1')
  .option('--db-path <path>', 'SQLite database path for sessions', 'smallchat.db')
  .option('--auth', 'Enable OAuth 2.1 authentication', false)
  .option('--rate-limit', 'Enable rate limiting', false)
  .option('--rate-limit-rpm <number>', 'Max requests per minute', '600')
  .option('--audit', 'Enable audit logging', false)
  .option('--session-ttl <hours>', 'Session TTL in hours', '24')
  .option('--rtk', 'Enable RTK output compression (reduces LLM token usage 60-90%)', false)
  .option('--rtk-path <path>', 'Path to rtk binary (default: resolved from PATH)')
  .option('--rtk-filter-level <level>', 'RTK filter aggressiveness: default | aggressive', 'default')
  .option('--rtk-threshold <bytes>', 'Minimum content size in bytes before RTK filters', '512')
  .action(async (options) => {
    const sourcePath = resolve(options.source);
    const port = parseInt(options.port, 10);
    const host = options.host;

    console.log('Loading toolkit...');

    const config: MCPServerConfig = {
      port,
      host,
      sourcePath,
      dbPath: options.dbPath,
      enableAuth: options.auth,
      enableRateLimit: options.rateLimit,
      rateLimitRPM: parseInt(options.rateLimitRpm, 10),
      enableAudit: options.audit,
      sessionTTLMs: parseFloat(options.sessionTtl) * 60 * 60 * 1000,
      ...(options.rtk && {
        rtkConfig: {
          enabled: true,
          binaryPath: options.rtkPath,
          filterLevel: options.rtkFilterLevel as 'default' | 'aggressive',
          filterThresholdBytes: parseInt(options.rtkThreshold, 10),
        },
      }),
    };

    const server = new MCPServer(config);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await server.start();
  });
