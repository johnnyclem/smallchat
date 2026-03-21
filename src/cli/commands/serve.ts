import { Command } from 'commander';
import { resolve } from 'node:path';
import { MCPServer, type MCPServerConfig } from '../../mcp/server.js';
import { validateServerConfig, formatValidationErrors } from '../../config/validator.js';
import { rootLogger } from '../../observability/logger.js';

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
  .option('--metrics', 'Enable Prometheus /metrics endpoint', false)
  .option('--session-ttl <hours>', 'Session TTL in hours', '24')
  .option('--max-concurrent <number>', 'Max concurrent tool executions (0=unlimited)', '0')
  .option('--max-queue-depth <number>', 'Max dispatch queue depth (0=unlimited)', '0')
  .option('--hot-reload', 'Watch sourcePath for changes and reload without restart', false)
  .option('--hot-reload-debounce <ms>', 'Hot-reload debounce delay in ms', '500')
  .option('--graceful-shutdown-timeout <ms>', 'Graceful shutdown timeout in ms', '30000')
  .option('--validate-config', 'Validate and print config then exit', false)
  .action(async (options) => {
    const log = rootLogger.child({ command: 'serve' });
    const sourcePath = resolve(options.source);
    const port = parseInt(options.port, 10);
    const host = options.host;

    const rawConfig: MCPServerConfig = {
      port,
      host,
      sourcePath,
      dbPath: options.dbPath,
      enableAuth: options.auth,
      enableRateLimit: options.rateLimit,
      rateLimitRPM: parseInt(options.rateLimitRpm, 10),
      enableAudit: options.audit,
      enableMetrics: options.metrics,
      sessionTTLMs: parseFloat(options.sessionTtl) * 60 * 60 * 1000,
      maxConcurrentExecutions: parseInt(options.maxConcurrent, 10),
      maxQueueDepth: parseInt(options.maxQueueDepth, 10),
      enableHotReload: options.hotReload,
      hotReloadDebounceMs: parseInt(options.hotReloadDebounce, 10),
      gracefulShutdownTimeoutMs: parseInt(options.gracefulShutdownTimeout, 10),
    };

    // Validate configuration
    const validation = validateServerConfig(rawConfig);
    if (options.validateConfig) {
      if (validation.valid) {
        console.log('Configuration is valid.');
        if (validation.warnings.length > 0) {
          console.log(formatValidationErrors(validation));
        }
      } else {
        console.error(formatValidationErrors(validation));
        process.exit(1);
      }
      return;
    }

    if (!validation.valid) {
      console.error('Configuration errors found:');
      console.error(formatValidationErrors(validation));
      process.exit(1);
    }

    if (validation.warnings.length > 0) {
      log.warn({ warnings: validation.warnings.map(w => w.message) }, 'Configuration warnings');
    }

    const config = validation.config!;
    const server = new MCPServer(config);

    // Handle graceful shutdown
    let shutdownInProgress = false;
    const shutdown = async (signal: string) => {
      if (shutdownInProgress) return;
      shutdownInProgress = true;
      log.info({ signal }, 'Shutdown signal received');
      await server.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await server.start();
  });
