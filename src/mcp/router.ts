/**
 * McpRouter — JSON-RPC 2.0 dispatcher for all MCP methods.
 *
 * Returns null for notifications (requests without an id).
 * Throws never — all errors are returned as JSON-RPC error objects.
 */

import {
  MCP_ERROR,
  MCP_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpClientCapabilities,
  type McpSession,
  type RouterOptions,
} from './types.js';
import type { SessionManager } from './session.js';
import type { ToolRegistry, ResourceRegistry, PromptRegistry } from './registry.js';
import type { SseBroker } from './sse-broker.js';
import type { UIResourceRegistry } from './ui-resources.js';
import { negotiate, parseFormatParam, type Json } from './wire-format.js';
import {
  assembleWithinBudget,
  scoreByQuery,
  type ToolDescriptor,
} from '../runtime/budgeted-assembly.js';

export class McpRouter {
  constructor(
    private readonly sessions: SessionManager,
    private readonly tools: ToolRegistry,
    private readonly resources: ResourceRegistry,
    private readonly prompts: PromptRegistry,
    private readonly broker: SseBroker,
    private readonly opts: RouterOptions,
    private readonly uiResources?: UIResourceRegistry,
  ) {}

  /**
   * Handle a parsed JSON-RPC request. Returns null for notifications.
   * The sessionId is extracted from the transport layer (e.g. MCP-Session-Id header).
   */
  async handle(
    raw: unknown,
    sessionId: string | null,
  ): Promise<JsonRpcResponse | null> {
    // Validate JSON-RPC envelope
    const validated = validateRpcEnvelope(raw);
    if ('error' in validated) {
      const id = (raw as Record<string, unknown>)?.id;
      const safeId =
        typeof id === 'string' || typeof id === 'number' ? id : null;
      return rpcError(safeId, validated.error.code, validated.error.message);
    }

    const req = validated.req;
    const id = req.id ?? null;

    // Notifications (no id) — process and return null (no response)
    if (req.id === undefined) {
      // Nothing to do for unknown notification methods
      return null;
    }

    // Route to method handler
    try {
      switch (req.method) {
        case 'initialize':
          return this.handleInitialize(id, req.params ?? {}, sessionId);
        case 'ping':
          return this.handlePing(id, sessionId);
        case 'shutdown':
          return this.handleShutdown(id, req.params ?? {}, sessionId);
        case 'tools/list':
          return this.handleToolsList(id, req.params ?? {}, sessionId);
        case 'tools/listRanked':
          return this.handleToolsListRanked(id, req.params ?? {}, sessionId);
        case 'tools/call':
          return this.handleToolsCall(id, req.params ?? {}, sessionId);
        case 'resources/list':
          return this.handleResourcesList(id, req.params ?? {}, sessionId);
        case 'resources/read':
          return this.handleResourcesRead(id, req.params ?? {}, sessionId);
        case 'resources/subscribe':
          return this.handleResourcesSubscribe(id, req.params ?? {}, sessionId);
        case 'prompts/list':
          return this.handlePromptsList(id, req.params ?? {}, sessionId);
        case 'prompts/get':
          return this.handlePromptsGet(id, req.params ?? {}, sessionId);
        case 'prompts/render':
          return this.handlePromptsRender(id, req.params ?? {}, sessionId);
        default:
          return rpcError(id, MCP_ERROR.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
      }
    } catch (err) {
      return rpcError(id, MCP_ERROR.INTERNAL_ERROR, safeMessage(err));
    }
  }

  // ---------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------

  private handleInitialize(
    id: string | number | null,
    params: Record<string, unknown>,
    incomingSessionId: string | null,
  ): JsonRpcResponse {
    const client = params.client as Record<string, unknown> | undefined;
    const protocol = params.protocol as Record<string, unknown> | undefined;

    if (
      !client ||
      typeof client.name !== 'string' ||
      typeof client.version !== 'string'
    ) {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'client.name and client.version are required');
    }

    if (!protocol || !Array.isArray(protocol.versions)) {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'protocol.versions array is required');
    }

    const clientVersions = protocol.versions as string[];
    const selectedVersion = selectVersion(clientVersions);

    if (!selectedVersion) {
      return rpcError(id, MCP_ERROR.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
        supportedVersions: [...MCP_PROTOCOL_VERSIONS],
      });
    }

    const capabilities = (params.capabilities ?? {}) as McpClientCapabilities;
    const sessionResume = params.session as Record<string, unknown> | undefined;
    const resumeId = sessionResume?.sessionId as string | undefined;
    const wantsResume = Boolean(sessionResume?.resume);

    // Resume path
    if (wantsResume && resumeId) {
      const result = this.sessions.resume(resumeId);
      if (result === 'expired') {
        return rpcError(id, MCP_ERROR.SESSION_EXPIRED, 'Session expired', {
          action: 'reinitialize',
        });
      }
      if (result === 'closed') {
        return rpcError(id, MCP_ERROR.SESSION_CLOSED, 'Session closed', {
          action: 'reinitialize',
        });
      }
      if (result === 'not_found') {
        return rpcError(id, MCP_ERROR.SESSION_EXPIRED, 'Session not found', {
          action: 'reinitialize',
        });
      }

      // Idempotent: same sessionId already initialized — return existing session
      if (incomingSessionId === resumeId) {
        return rpcOk(id, buildInitializeResult(result, 'resumed', this.opts));
      }

      return rpcOk(id, buildInitializeResult(result, 'resumed', this.opts));
    }

    // New session
    const session = this.sessions.create({
      clientName: client.name,
      clientVersion: client.version,
      selectedVersion,
      capabilities,
      ttlMs: this.opts.sessionTtlMs,
    });

    return rpcOk(id, buildInitializeResult(session, 'new', this.opts));
  }

  // ---------------------------------------------------------------------------
  // ping
  // ---------------------------------------------------------------------------

  private handlePing(
    id: string | number | null,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;
    this.sessions.touch(session.sessionId);
    return rpcOk(id, { ok: true, ts: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  private handleShutdown(
    id: string | number | null,
    _params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;
    this.sessions.close(session.sessionId);
    this.broker.disconnectSession(session.sessionId);
    return rpcOk(id, { ok: true });
  }

  // ---------------------------------------------------------------------------
  // tools/list
  // ---------------------------------------------------------------------------

  private handleToolsList(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const cursor = params.cursor as string | undefined;
    const rawLimit = params.limit as number | undefined;

    if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1)) {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'limit must be a positive integer');
    }

    try {
      const result = this.tools.list(cursor, rawLimit);
      return rpcOk(
        id,
        applyWireFormat(params, {
          tools: result.items as unknown as Json,
          nextCursor: result.nextCursor ?? null,
          snapshot: result.snapshot,
        }),
      );
    } catch (err) {
      if (isCursorError(err)) {
        return rpcError(id, err.code, err.message, err.data);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // tools/listRanked — TOON-inspired token-budgeted slice of the tool registry,
  // ranked by BM25 against `query`. Returns only the tools that fit within
  // `tokenBudget` so callers can stream a single context bundle of bounded
  // size instead of fetching all tools and truncating.
  // ---------------------------------------------------------------------------

  private handleToolsListRanked(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const query = params.query;
    if (typeof query !== 'string' || query.length === 0) {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'query must be a non-empty string');
    }

    const rawBudget = params.tokenBudget;
    if (
      typeof rawBudget !== 'number' ||
      !Number.isFinite(rawBudget) ||
      rawBudget <= 0
    ) {
      return rpcError(
        id,
        MCP_ERROR.INVALID_PARAMS,
        'tokenBudget must be a positive number',
      );
    }

    const all = this.tools.all();
    const descriptors: ToolDescriptor[] = all.map((t) => ({
      id: t.id,
      name: t.name,
      providerId: idToProviderId(t.id),
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const ranked = scoreByQuery(descriptors, query);
    const result = assembleWithinBudget(ranked, rawBudget);

    return rpcOk(
      id,
      applyWireFormat(params, {
        tools: result.included as unknown as Json,
        excluded: result.excluded.map((d) => ({ id: d.id })) as unknown as Json,
        totalTokens: result.totalTokens,
        tokenBudget: result.tokenBudget,
        exhausted: result.exhausted,
        snapshot: this.tools.snapshot(),
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // tools/call
  // ---------------------------------------------------------------------------

  private handleToolsCall(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const toolId = params.toolId as string | undefined;
    if (!toolId || typeof toolId !== 'string') {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'toolId is required');
    }

    const tool = this.tools.get(toolId);
    if (!tool) {
      return rpcError(id, MCP_ERROR.TOOL_NOT_FOUND, `Tool not found: ${toolId}`);
    }

    if (params.arguments !== undefined && (typeof params.arguments !== 'object' || Array.isArray(params.arguments))) {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'arguments must be an object');
    }

    const invocationId = crypto.randomUUID();
    const streamMode =
      (params.stream as Record<string, unknown> | undefined)?.mode ?? 'sse';

    // Streaming: return "started" immediately; execution via SSE
    if (streamMode === 'sse') {
      return rpcOk(id, {
        invocationId,
        status: 'started',
        stream: {
          type: 'sse',
          invocationId,
          sessionId: session.sessionId,
        },
      });
    }

    // Non-streaming: not yet implemented (would need actual execution pipeline)
    return rpcOk(id, {
      invocationId,
      status: 'ok',
      result: { note: 'Non-streaming tool execution not yet implemented' },
    });
  }

  // ---------------------------------------------------------------------------
  // resources/list
  // ---------------------------------------------------------------------------

  private handleResourcesList(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const cursor = params.cursor as string | undefined;
    const rawLimit = params.limit as number | undefined;

    try {
      const result = this.resources.list(cursor, rawLimit);
      return rpcOk(
        id,
        applyWireFormat(params, {
          resources: result.items as unknown as Json,
          nextCursor: result.nextCursor ?? null,
          snapshot: result.snapshot,
        }),
      );
    } catch (err) {
      if (isCursorError(err)) {
        return rpcError(id, err.code, err.message, err.data);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // resources/read
  // ---------------------------------------------------------------------------

  private async handleResourcesRead(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): Promise<JsonRpcResponse> {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const resourceId = params.resourceId as string | undefined;
    const uri = params.uri as string | undefined;
    const target = uri ?? resourceId;

    if (!target || typeof target !== 'string') {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'resourceId or uri is required');
    }

    // MCP Apps: ui:// URIs are served by the UIResourceRegistry
    if (target.startsWith('ui://') && this.uiResources?.isUIUri(target)) {
      const content = await this.uiResources.read(target);
      if (!content) {
        return rpcError(id, MCP_ERROR.RESOURCE_NOT_FOUND, `UI resource not found: ${target}`);
      }
      return rpcOk(id, {
        uri: target,
        contents: [{
          uri: content.uri,
          mimeType: content.mimeType,
          text: content.text,
        }],
      });
    }

    // Standard resource lookup by ID
    const resource = this.resources.get(target);
    if (!resource) {
      return rpcError(id, MCP_ERROR.RESOURCE_NOT_FOUND, `Resource not found: ${target}`);
    }

    return rpcOk(id, {
      resourceId: target,
      content: {
        mimeType: resource.mimeType ?? 'application/octet-stream',
        data: '',
        encoding: 'utf8',
      },
      etag: resource.version ?? '0',
    });
  }

  // ---------------------------------------------------------------------------
  // resources/subscribe
  // ---------------------------------------------------------------------------

  private handleResourcesSubscribe(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const resourceId = params.resourceId as string | undefined;
    if (!resourceId || typeof resourceId !== 'string') {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'resourceId is required');
    }

    if (!this.resources.get(resourceId)) {
      return rpcError(id, MCP_ERROR.RESOURCE_NOT_FOUND, `Resource not found: ${resourceId}`);
    }

    const subscriptionId = this.sessions.subscribe(session.sessionId, resourceId);
    return rpcOk(id, { ok: true, subscriptionId });
  }

  // ---------------------------------------------------------------------------
  // prompts/list
  // ---------------------------------------------------------------------------

  private handlePromptsList(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const cursor = params.cursor as string | undefined;
    const rawLimit = params.limit as number | undefined;

    try {
      const result = this.prompts.list(cursor, rawLimit);
      return rpcOk(
        id,
        applyWireFormat(params, {
          prompts: result.items as unknown as Json,
          nextCursor: result.nextCursor ?? null,
          snapshot: result.snapshot,
        }),
      );
    } catch (err) {
      if (isCursorError(err)) {
        return rpcError(id, err.code, err.message, err.data);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // prompts/get
  // ---------------------------------------------------------------------------

  private handlePromptsGet(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const promptId = params.promptId as string | undefined;
    if (!promptId || typeof promptId !== 'string') {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'promptId is required');
    }

    const prompt = this.prompts.get(promptId);
    if (!prompt) {
      return rpcError(id, MCP_ERROR.PROMPT_NOT_FOUND, `Prompt not found: ${promptId}`);
    }

    return rpcOk(id, { prompt });
  }

  // ---------------------------------------------------------------------------
  // prompts/render
  // ---------------------------------------------------------------------------

  private handlePromptsRender(
    id: string | number | null,
    params: Record<string, unknown>,
    sessionId: string | null,
  ): JsonRpcResponse {
    const session = this.requireSession(id, sessionId);
    if (isErrorResponse(session)) return session;

    const promptId = params.promptId as string | undefined;
    if (!promptId || typeof promptId !== 'string') {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'promptId is required');
    }

    const prompt = this.prompts.get(promptId);
    if (!prompt) {
      return rpcError(id, MCP_ERROR.PROMPT_NOT_FOUND, `Prompt not found: ${promptId}`);
    }

    if (
      params.arguments !== undefined &&
      (typeof params.arguments !== 'object' || Array.isArray(params.arguments))
    ) {
      return rpcError(id, MCP_ERROR.INVALID_PARAMS, 'arguments must be an object');
    }

    return rpcOk(id, {
      promptId,
      rendered: {
        messages: [{ role: 'user', content: prompt.template ?? '' }],
        metadata: {},
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Session guard helper
  // ---------------------------------------------------------------------------

  private requireSession(
    id: string | number | null,
    sessionId: string | null,
  ): McpSession | JsonRpcResponse {
    if (!sessionId) {
      return rpcError(id, MCP_ERROR.NOT_INITIALIZED, 'Not initialized');
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return rpcError(id, MCP_ERROR.NOT_INITIALIZED, 'Not initialized');
    }

    if (session.status === 'closed') {
      return rpcError(id, MCP_ERROR.SESSION_CLOSED, 'Session closed');
    }

    if (new Date(session.expiresAt) <= new Date()) {
      this.sessions.close(session.sessionId);
      return rpcError(id, MCP_ERROR.SESSION_EXPIRED, 'Session expired', {
        action: 'reinitialize',
      });
    }

    return session;
  }
}

function isErrorResponse(value: McpSession | JsonRpcResponse): value is JsonRpcResponse {
  return 'jsonrpc' in value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectVersion(clientVersions: string[]): string | null {
  for (const v of MCP_PROTOCOL_VERSIONS) {
    if (clientVersions.includes(v)) return v;
  }
  return null;
}

function buildInitializeResult(
  session: McpSession,
  state: 'new' | 'resumed',
  opts: RouterOptions,
): Record<string, unknown> {
  return {
    server: {
      name: opts.serverName,
      version: opts.serverVersion,
      provider: { name: opts.serverName },
    },
    protocol: {
      selectedVersion: session.selectedVersion,
      supportedVersions: [...MCP_PROTOCOL_VERSIONS],
    },
    session: {
      sessionId: session.sessionId,
      state,
      expiresAt: session.expiresAt,
    },
    endpoints: {
      rpc: '/mcp',
      sse: '/mcp/sse',
      discovery: '/.well-known/mcp.json',
    },
    features: {
      tools: true,
      resources: true,
      prompts: true,
      apps: false,
      sessions: true,
      streaming: {
        sse: true,
        stdio: false,
        progressNotifications: true,
        tokenDeltas: false,
      },
    },
    auth: {
      mode: 'none',
      scopesSupported: [],
    },
  };
}

function validateRpcEnvelope(
  raw: unknown,
): { req: JsonRpcRequest } | { error: { code: number; message: string } } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { code: MCP_ERROR.INVALID_REQUEST, message: 'Invalid Request' } };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0') {
    return { error: { code: MCP_ERROR.INVALID_REQUEST, message: 'Invalid Request: jsonrpc must be "2.0"' } };
  }

  if (typeof obj.method !== 'string') {
    return { error: { code: MCP_ERROR.INVALID_REQUEST, message: 'Invalid Request: method must be a string' } };
  }

  if (obj.params !== undefined && (typeof obj.params !== 'object' || Array.isArray(obj.params) || obj.params === null)) {
    return { error: { code: MCP_ERROR.INVALID_PARAMS, message: 'Invalid params: params must be an object' } };
  }

  return { req: raw as JsonRpcRequest };
}

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const err: JsonRpcResponse['error'] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function safeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Honour an optional `format: "auto" | "compact" | "json"` parameter on list
 * methods, returning either the original payload (no envelope) or a wrapped
 * compact envelope. Defaults to JSON for clients that don't opt in.
 */
function applyWireFormat(
  params: Record<string, unknown>,
  payload: Record<string, Json>,
): Json {
  const format = parseFormatParam(params);
  return negotiate(format, payload).payload;
}

/**
 * Best-effort extraction of a provider id from a tool's stable id.
 * smallchat's compiled artifact uses `providerId.toolName` form; the live
 * `McpTool` type doesn't carry a provider field separately, so we split.
 */
function idToProviderId(id: string): string {
  const sepIdx = id.indexOf(':');
  if (sepIdx > 0) return id.slice(0, sepIdx);
  const dotIdx = id.indexOf('.');
  if (dotIdx > 0) return id.slice(0, dotIdx);
  return 'unknown';
}

interface CursorErrorShape {
  code: number;
  message: string;
  data: { snapshotExpected: string; action: string };
}

function isCursorError(err: unknown): err is CursorErrorShape {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    'message' in err &&
    'data' in err &&
    (err as CursorErrorShape).code === MCP_ERROR.INVALID_CURSOR
  );
}
