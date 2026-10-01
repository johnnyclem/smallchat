import { Command } from 'commander';
import { resolve } from 'node:path';
import { MCPServer, type MCPServerConfig } from '../../mcp/server.js';
import { AuditLog } from '../../mcp/audit-log.js';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_TOKEN_FILE, ensureTokenFile } from '../../mcp/http-guard.js';
import { runtimeOptionsFromPolicy } from '../../runtime/runtime.js';
import { findSmallChatManifest } from './compile.js';

/**
 * `smallchat serve` — serve a compiled artifact as one MCP server that
 * forwards every tool call, by exact name, to the upstream MCP server that
 * owns the tool.
 *
 *   - stdio by default (what MCP hosts launch); Streamable HTTP with --http,
 *     at /mcp only, behind Host/Origin validation and a bearer token.
 *   - Tools are `<providerId>__<toolName>`; --provider <id> serves one
 *     provider under its upstream tool names, verbatim.
 *   - smallchat_resolve proposes a tool for an intent and never runs it.
 */
export const serveCommand = new Command('serve')
  .description('Serve a compiled toolkit as an MCP server (stdio by default, Streamable HTTP with --http)')
  .requiredOption('-s, --source <path>', 'Compiled artifact (.json or .db) or a directory of manifests')
  .option('--provider <id>', 'Serve only this provider, with its upstream tool names verbatim')
  .option('--no-resolve-tool', 'Do not offer the smallchat_resolve tool')
  .option('--allow-duplicates', 'With a manifest directory: keep near-duplicate tools instead of failing to compile')
  .option('--upstream-timeout <ms>', 'Timeout for each upstream tool call (progress resets it)', '60000')
  .option('--http', 'Serve Streamable HTTP at /mcp instead of stdio')
  .option('-p, --port <number>', 'HTTP: port to listen on', '3001')
  .option('--host <address>', 'HTTP: address to bind', '127.0.0.1')
  .option('--token-file <path>', 'HTTP: bearer token file (generated, mode 0600, if missing)', DEFAULT_TOKEN_FILE)
  .option('--http-insecure', 'HTTP: serve without a bearer token (any local process can call your tools)')
  .option('--allowed-host <hostname...>', 'HTTP: hostnames accepted in the Host header (default: loopback names)')
  .option('--allowed-origin <origin...>', 'HTTP: browser origins allowed to call the server (default: none)')
  .option('--max-body-bytes <bytes>', 'HTTP: maximum request body; larger requests get 413', String(DEFAULT_MAX_BODY_BYTES))
  .option('--max-sessions <number>', 'HTTP: maximum concurrent sessions', '100')
  .option('--session-idle-timeout <minutes>', 'HTTP: close sessions idle this long', '30')
  .option('--rate-limit', 'HTTP: rate-limit requests per session (or per address before a session)')
  .option('--rate-limit-rpm <number>', 'HTTP: requests per minute with --rate-limit', '600')
  .option('--audit-log <file>', 'Append every request and its outcome (including rejections) to this JSONL file')
  .option('--rtk', 'Enable RTK output compression (reduces LLM token usage 60-90%)', false)
  .option('--rtk-path <path>', 'Path to rtk binary (default: resolved from PATH)')
  .option('--rtk-filter-level <level>', 'RTK filter aggressiveness: default | aggressive', 'default')
  .option('--rtk-threshold <bytes>', 'Minimum content size in bytes before RTK filters', '512')
  .action(async (options) => {
    const useHttp = options.http === true;
    if (!useHttp) {
      // stdout is the protocol channel: anything a library prints must go to stderr.
      console.log = console.error;
      console.info = console.error;
      console.debug = console.error;
    }
    const log = (line: string) => process.stderr.write(`${line}\n`);
    const sourcePath = resolve(options.source);

    log(`Loading ${sourcePath}...`);

    // smallchat.json "policy" block (nearest one upward from the cwd)
    const project = findSmallChatManifest(process.cwd());
    const runtimeOptions = project?.manifest.policy ? runtimeOptionsFromPolicy(project.manifest.policy) : undefined;
    if (runtimeOptions) {
      log(`  Dispatch policy from ${project!.path}: ${JSON.stringify(project!.manifest.policy)}`);
    }

    const config: MCPServerConfig = {
      sourcePath,
      provider: options.provider,
      resolveTool: options.resolveTool !== false,
      allowDuplicates: options.allowDuplicates === true,
      runtimeOptions,
      upstream: { requestTimeoutMs: parseInt(options.upstreamTimeout, 10) },
      log,
      ...(options.auditLog ? { auditLog: new AuditLog({ file: resolve(options.auditLog) }) } : {}),
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
    const shutdown = async (code: number) => {
      await server.stop();
      process.exit(code);
    };
    process.on('SIGINT', () => { void shutdown(0); });
    process.on('SIGTERM', () => { void shutdown(0); });

    try {
      await server.load();
    } catch (e) {
      // e.g. a pre-1.0 artifact, an artifact whose embedder is unavailable, an unknown provider
      log(`Failed to load ${sourcePath}: ${(e as Error).message}`);
      await shutdown(1);
      return;
    }

    if (!useHttp) {
      await server.startStdio();
      log('smallchat MCP server on stdio');
      await server.closed();
      await shutdown(0);
      return;
    }

    let token: string | null = null;
    let tokenNote = 'no bearer token (--http-insecure): any local process can call your tools';
    if (options.httpInsecure !== true) {
      try {
        const tokenFile = resolve(options.tokenFile);
        const { token: value, created } = ensureTokenFile(tokenFile);
        token = value;
        tokenNote = `${created ? 'generated' : 'using'} bearer token in ${tokenFile}; send "Authorization: Bearer <token>"`;
      } catch (e) {
        log(`Bearer token: ${(e as Error).message}`);
        await shutdown(1);
        return;
      }
    }

    try {
      const { url } = await server.startHttp({
        port: parseInt(options.port, 10),
        host: options.host,
        token,
        allowedHosts: options.allowedHost,
        allowedOrigins: options.allowedOrigin ?? [],
        maxBodyBytes: parseInt(options.maxBodyBytes, 10),
        maxSessions: parseInt(options.maxSessions, 10),
        sessionIdleTimeoutMs: parseFloat(options.sessionIdleTimeout) * 60_000,
        ...(options.rateLimit ? { rateLimitRPM: parseInt(options.rateLimitRpm, 10) } : {}),
      });
      log(`\nsmallchat MCP server (Streamable HTTP) at ${url}`);
      log(`  ${tokenNote}`);
    } catch (e) {
      log(`Failed to start HTTP server: ${(e as Error).message}`);
      await shutdown(1);
    }
  });
