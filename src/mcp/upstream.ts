/**
 * UpstreamPool — the MCP clients `smallchat serve` forwards tool calls to.
 *
 * One official-SDK Client per MCP provider, started or reached from the
 * provider's launch spec in the artifact (through transport/mcp-connect):
 *   - stdio: `command args`, with the platform's safe environment plus the
 *     variables the spec names, read from serve's own environment (an
 *     artifact records variable NAMES only, never values). `${VAR}` and
 *     `${VAR:-default}` in the command and args are expanded from that
 *     environment too, as Claude Code expands them;
 *   - streamable-http (or a bare MCP endpoint): Streamable HTTP;
 *   - sse: the legacy HTTP+SSE transport.
 *
 * Clients connect lazily on the first call to their provider. A client
 * that closes (process exit, connection loss) or fails to connect is
 * dropped, so the next call reconnects. close() shuts every client down
 * (and with it every stdio child process).
 *
 * The pool executes exactly the upstream tool it is asked for; it never
 * renames or resolves. Cancellation and progress of a downstream request
 * reach the upstream call through withUpstreamCallContext().
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, type CallToolResult, type Progress } from '@modelcontextprotocol/sdk/types.js';
import { connectMcp, expandEnvRefs, listAllTools, type McpConnectSpec } from '../transport/mcp-connect.js';
import type { ExecuteOptions, ToolResult, ToolTransport } from '../core/types.js';
import type { ArtifactProvider, ArtifactV1 } from '../artifact/types.js';

/** Key under ToolResult.metadata holding the upstream CallToolResult verbatim. */
export const UPSTREAM_RESULT_KEY = 'mcpResult';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface UpstreamPoolOptions {
  /** Per-request timeout for upstream calls (default 60 s; progress resets it) */
  requestTimeoutMs?: number;
  /** Where the variables named by stdio launch specs are read from (default process.env) */
  env?: Record<string, string | undefined>;
  /**
   * What to do with stdio upstreams' stderr (default 'inherit': serve's
   * stderr). 'pipe' drains it into a bounded tail that connection errors
   * quote, so a chatty server can never fill the pipe and stall.
   */
  stderr?: 'inherit' | 'ignore' | 'pipe';
  /** Also forward proxy/CA settings (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, ...) to stdio upstreams */
  forwardProxyEnv?: boolean;
  /** Extra HTTP headers per provider id, for remote upstreams (e.g. Authorization) */
  headers?: Record<string, Record<string, string>>;
  /** clientInfo sent to upstreams */
  clientInfo?: { name: string; version: string };
  /** Operator messages (missing env vars, tool drift); default: stderr */
  log?: (line: string) => void;
}

/** Cancellation and progress of the downstream request an upstream call serves. */
export interface UpstreamCallContext {
  signal?: AbortSignal;
  onprogress?: (progress: Progress) => void;
}

const callContext = new AsyncLocalStorage<UpstreamCallContext>();

/** Run `fn` so that upstream calls it makes honour `context`. */
export function withUpstreamCallContext<T>(context: UpstreamCallContext, fn: () => T): T {
  return callContext.run(context, fn);
}

export class UpstreamPool {
  private readonly clients = new Map<string, Promise<Client>>();
  /** Connected clients, to tell a stale onclose from the current client's */
  private readonly live = new Map<string, Client>();
  private readonly log: (line: string) => void;
  private closed = false;

  constructor(
    private readonly artifact: Pick<ArtifactV1, 'providers' | 'tools'>,
    private readonly options: UpstreamPoolOptions = {},
  ) {
    this.log = options.log ?? (line => process.stderr.write(`${line}\n`));
  }

  /** Whether calls to this provider go through an MCP client from this pool. */
  handles(providerId: string): boolean {
    return this.artifact.providers[providerId]?.transportType === 'mcp';
  }

  /** Provider ids with a live (or connecting) client. */
  connectedProviders(): string[] {
    return [...this.clients.keys()].sort();
  }

  /** The connected client for a provider, connecting on first use. */
  client(providerId: string): Promise<Client> {
    if (this.closed) return Promise.reject(new Error('upstream pool is closed'));
    let pending = this.clients.get(providerId);
    if (!pending) {
      pending = this.connect(providerId);
      this.clients.set(providerId, pending);
      pending.catch(() => {
        if (this.clients.get(providerId) === pending) this.clients.delete(providerId);
      });
    }
    return pending;
  }

  /**
   * Call exactly `toolName` on the provider's upstream server. The call is
   * cancelled upstream when `options.signal` or the call context's signal
   * (withUpstreamCallContext) fires.
   */
  async callTool(
    providerId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: ExecuteOptions = {},
  ): Promise<CallToolResult> {
    const context = callContext.getStore();
    const signals = [context?.signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    const client = await this.client(providerId);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      CallToolResultSchema,
      {
        timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        ...(context?.onprogress ? { onprogress: context.onprogress, resetTimeoutOnProgress: true } : {}),
      },
    );
    return result as CallToolResult;
  }

  /** A ToolTransport (for ToolProxy) that runs tools on this provider's upstream. */
  transport(providerId: string): ToolTransport {
    return new UpstreamToolTransport(this, providerId);
  }

  /** Close every upstream client (and stop every stdio server). */
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.clients.values()];
    this.clients.clear();
    this.live.clear();
    await Promise.all(pending.map(async p => {
      try {
        await (await p).close();
      } catch {
        // already closed or never connected
      }
    }));
  }

  private async connect(providerId: string): Promise<Client> {
    const provider = this.artifact.providers[providerId];
    if (!provider) throw new Error(`unknown provider "${providerId}"`);
    const { client } = await connectMcp(this.connectSpec(provider), {
      clientInfo: this.options.clientInfo,
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      stderr: this.options.stderr === 'pipe' ? 'tail' : this.options.stderr ?? 'inherit',
    });
    this.live.set(providerId, client);
    client.onclose = () => {
      // Drop the dead client so the next call reconnects.
      if (this.live.get(providerId) === client) {
        this.live.delete(providerId);
        this.clients.delete(providerId);
      }
    };
    await this.reportDrift(providerId, client);
    return client;
  }

  private connectSpec(provider: ArtifactProvider): McpConnectSpec {
    const launch = provider.launch;
    if (!launch) {
      throw new Error(
        `provider "${provider.id}" has no launch spec in the artifact, so serve cannot start or reach it. ` +
        'Recompile from an MCP config (smallchat compile --source .mcp.json) or give the manifest a "launch" or "endpoint".',
      );
    }
    const source = this.options.env ?? process.env;
    if (launch.transport === 'stdio') {
      const env: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of launch.env) {
        const value = source[name];
        if (value === undefined) missing.push(name);
        else env[name] = value;
      }
      if (missing.length > 0) {
        this.log(`upstream ${provider.id}: ${missing.join(', ')} not set in serve's environment; starting without ${missing.length === 1 ? 'it' : 'them'}`);
      }
      return {
        transport: 'stdio',
        command: expandEnvRefs(launch.command, source),
        args: launch.args.map(arg => expandEnvRefs(arg, source)),
        env,
        forwardProxyEnv: this.options.forwardProxyEnv,
      };
    }
    const headers = this.options.headers?.[provider.id];
    return {
      // 'streamable-http', or an MCP provider recorded with a bare endpoint
      transport: launch.transport === 'sse' ? 'sse' : 'streamable-http',
      url: expandEnvRefs(launch.url, source),
      ...(headers ? { headers } : {}),
    };
  }

  /**
   * List the upstream's tools (which also primes the client's outputSchema
   * validation) and report tools the artifact has but the server no
   * longer lists — calls to those will fail upstream; recompile.
   */
  private async reportDrift(providerId: string, client: Client): Promise<void> {
    if (!client.getServerCapabilities()?.tools) return;
    const listed = new Set<string>();
    try {
      const tools = await listAllTools(client, { timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS });
      for (const tool of tools) listed.add(tool.name);
    } catch (err) {
      this.log(`upstream ${providerId}: tools/list failed (${(err as Error).message})`);
      return;
    }
    const missing = Object.values(this.artifact.tools)
      .filter(t => t.providerId === providerId && !listed.has(t.name))
      .map(t => t.name);
    if (missing.length > 0) {
      this.log(`upstream ${providerId}: no longer lists ${missing.join(', ')}; recompile the artifact`);
    }
  }
}

/** Executes a provider's tools through the pool's client. */
class UpstreamToolTransport implements ToolTransport {
  constructor(private readonly pool: UpstreamPool, private readonly providerId: string) {}

  async execute(toolName: string, args: Record<string, unknown>, options?: ExecuteOptions): Promise<ToolResult> {
    try {
      const result = await this.pool.callTool(this.providerId, toolName, args, options);
      return {
        content: result.structuredContent ?? result.content,
        isError: result.isError === true,
        metadata: { [UPSTREAM_RESULT_KEY]: result },
      };
    } catch (err) {
      const message = (err as Error).message;
      return {
        content: { error: `Upstream "${this.providerId}" could not run ${toolName}: ${message}` },
        isError: true,
        metadata: { error: message, upstreamError: true },
      };
    }
  }

  async *executeStream(toolName: string, args: Record<string, unknown>, options?: ExecuteOptions): AsyncGenerator<ToolResult> {
    yield await this.execute(toolName, args, options);
  }
}
