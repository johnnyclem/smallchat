/**
 * n8n Integration — community node for n8n workflow automation
 *
 * Provides the node definition for a Smallchat n8n community node.
 * Compatible with n8n-nodes-base patterns (n8n >= 0.210).
 *
 * The node exposes three operations:
 *  1. Dispatch       — natural-language tool dispatch
 *  2. List Tools     — enumerate available tools
 *  3. Resolve Intent — find the best tool for an intent (without executing)
 *
 * To build a real n8n community node:
 *  1. Copy this file into a new package: n8n-nodes-smallchat/nodes/Smallchat/
 *  2. Add the n8n type annotations from @n8n/n8n-nodes-base
 *  3. npm publish n8n-nodes-smallchat
 *  4. Users install via Settings → Community Nodes → "n8n-nodes-smallchat"
 *
 * This module also exports a server-side handler for the dispatch endpoint
 * that the n8n node calls via HTTP.
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolResult } from '../../core/types.js';

// ---------------------------------------------------------------------------
// n8n node interface shims
// ---------------------------------------------------------------------------

export type N8nNodePropertyType =
  | 'string' | 'number' | 'boolean' | 'options' | 'multiOptions'
  | 'json' | 'fixedCollection' | 'collection' | 'notice' | 'color';

export interface N8nNodePropertyOption {
  name: string;
  displayName?: string;
  value?: string;
  description?: string;
  type?: string;
  default?: unknown;
}

export interface N8nNodeProperty {
  displayName: string;
  name: string;
  type: N8nNodePropertyType;
  default?: unknown;
  required?: boolean;
  description?: string;
  hint?: string;
  placeholder?: string;
  noDataExpression?: boolean;
  options?: N8nNodePropertyOption[];
  typeOptions?: Record<string, unknown>;
  displayOptions?: {
    show?: Record<string, unknown[]>;
    hide?: Record<string, unknown[]>;
  };
  routing?: {
    request?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
}

export interface N8nNodeDescription {
  displayName: string;
  name: string;
  icon: string;
  group: string[];
  version: number;
  subtitle?: string;
  description: string;
  defaults: {
    name: string;
    color?: string;
  };
  inputs: string[];
  outputs: string[];
  credentials?: Array<{
    name: string;
    required?: boolean;
  }>;
  requestDefaults?: Record<string, unknown>;
  properties: N8nNodeProperty[];
}

export interface N8nNodeExecuteContext {
  getInputData(): Array<{ json: Record<string, unknown> }>;
  getNodeParameter(paramName: string, itemIndex: number, fallback?: unknown): unknown;
  getCredentials(credentialType: string): Promise<Record<string, string>>;
  helpers: {
    request(options: Record<string, unknown>): Promise<unknown>;
    requestWithAuthentication(credentialType: string, options: Record<string, unknown>): Promise<unknown>;
  };
}

export interface N8nNodeExecuteResult {
  json: Record<string, unknown>;
  binary?: Record<string, unknown>;
  pairedItem?: { item: number };
}

// ---------------------------------------------------------------------------
// SmallchatNode — n8n node definition
// ---------------------------------------------------------------------------

export const SMALLCHAT_NODE_DESCRIPTION: N8nNodeDescription = {
  displayName: 'Smallchat',
  name: 'smallchat',
  icon: 'file:smallchat.svg',
  group: ['transform'],
  version: 1,
  subtitle: '={{$parameter["operation"]}}',
  description: 'Semantic tool dispatch via Smallchat — route natural-language intents to the best available tool',
  defaults: {
    name: 'Smallchat',
    color: '#5B5EA6',
  },
  inputs: ['main'],
  outputs: ['main'],
  credentials: [
    {
      name: 'smallchatApi',
      required: false,
    },
  ],
  requestDefaults: {
    baseURL: '={{$credentials.serverUrl}}',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  },
  properties: [
    // ---- Server URL (when not using credentials) ----
    {
      displayName: 'Server URL',
      name: 'serverUrl',
      type: 'string',
      default: 'http://localhost:3001',
      description: 'Base URL of your Smallchat MCP server',
      displayOptions: { show: { '@version': [1] } },
    },

    // ---- Operation ----
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      noDataExpression: true,
      default: 'dispatch',
      options: [
        {
          name: 'Dispatch',
          value: 'dispatch',
          description: 'Execute the best tool for a natural-language intent',
        },
        {
          name: 'List Tools',
          value: 'listTools',
          description: 'Get all available tools from Smallchat',
        },
        {
          name: 'Resolve Intent',
          value: 'resolve',
          description: 'Find the best tool for an intent without executing it',
        },
      ],
    },

    // ---- Dispatch fields ----
    {
      displayName: 'Intent',
      name: 'intent',
      type: 'string',
      required: true,
      default: '',
      description: 'Natural-language description of what you want to do',
      placeholder: 'e.g. search for recent news about TypeScript',
      displayOptions: {
        show: { operation: ['dispatch', 'resolve'] },
      },
    },
    {
      displayName: 'Arguments',
      name: 'args',
      type: 'json',
      default: '{}',
      description: 'Optional JSON arguments to pass to the resolved tool',
      displayOptions: {
        show: { operation: ['dispatch'] },
      },
    },
    {
      displayName: 'Provider Filter',
      name: 'providerId',
      type: 'string',
      default: '',
      description: 'Only use tools from this provider (leave empty for any)',
      displayOptions: {
        show: { operation: ['dispatch'] },
      },
    },

    // ---- Advanced options ----
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      placeholder: 'Add Option',
      default: {},
      displayOptions: {
        show: { operation: ['dispatch'] },
      },
      options: [
        {
          displayName: 'Timeout (ms)',
          name: 'timeout',
          type: 'number',
          default: 30000,
          description: 'Request timeout in milliseconds',
        },
        {
          displayName: 'Include Metadata',
          name: 'includeMetadata',
          type: 'boolean',
          default: false,
          description: 'Include dispatch metadata in the output',
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// n8n credential definition
// ---------------------------------------------------------------------------

export const SMALLCHAT_CREDENTIAL_DEFINITION = {
  name: 'smallchatApi',
  displayName: 'Smallchat API',
  icon: 'file:smallchat.svg',
  documentationUrl: 'https://smallchat.dev/docs/api-auth',
  properties: [
    {
      displayName: 'Server URL',
      name: 'serverUrl',
      type: 'string',
      default: 'http://localhost:3001',
      required: true,
      description: 'Base URL of your Smallchat MCP server',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: false,
      description: 'Optional API key for authenticated Smallchat servers',
    },
  ],
  authenticate: {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  },
  test: {
    request: {
      baseURL: '={{$credentials.serverUrl}}',
      url: '/health',
    },
  },
};

// ---------------------------------------------------------------------------
// execute() — the n8n node execute function
// ---------------------------------------------------------------------------

/**
 * Execute a Smallchat operation for an n8n node item.
 * This function is called by n8n for each input item.
 */
export async function executeSmallchatNode(
  this_context: N8nNodeExecuteContext,
  itemIndex: number,
): Promise<N8nNodeExecuteResult[]> {
  const operation = this_context.getNodeParameter('operation', itemIndex) as string;
  const serverUrl = this_context.getNodeParameter('serverUrl', itemIndex, 'http://localhost:3001') as string;

  let credentials: Record<string, string> = {};
  try {
    credentials = await this_context.getCredentials('smallchatApi');
  } catch {
    // No credentials configured — use serverUrl from node params
  }

  const baseUrl = credentials.serverUrl ?? serverUrl;
  const apiKey = credentials.apiKey;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  switch (operation) {
    case 'dispatch': {
      const intent = this_context.getNodeParameter('intent', itemIndex, '') as string;
      const argsRaw = this_context.getNodeParameter('args', itemIndex, '{}') as string;
      const providerId = this_context.getNodeParameter('providerId', itemIndex, '') as string;

      let args: unknown = {};
      try { args = JSON.parse(argsRaw); } catch { /* */ }

      const body: Record<string, unknown> = { intent, args };
      if (providerId) body.provider = providerId;

      const result = await this_context.helpers.request({
        method: 'POST',
        url: `${baseUrl}/dispatch`,
        headers,
        body: JSON.stringify(body),
        json: true,
      }) as ToolResult;

      return [{
        json: {
          content: result.content ?? null,
          isError: result.isError ?? false,
          ...((result.metadata ?? {})),
        },
        pairedItem: { item: itemIndex },
      }];
    }

    case 'listTools': {
      const result = await this_context.helpers.request({
        method: 'GET',
        url: `${baseUrl}/tools`,
        headers,
        json: true,
      }) as { tools: unknown[] };

      return (result.tools ?? []).map((tool, i) => ({
        json: tool as Record<string, unknown>,
        pairedItem: { item: itemIndex + i },
      }));
    }

    case 'resolve': {
      const intent = this_context.getNodeParameter('intent', itemIndex, '') as string;
      const result = await this_context.helpers.request({
        method: 'GET',
        url: `${baseUrl}/tools/resolve?intent=${encodeURIComponent(intent)}`,
        headers,
        json: true,
      }) as Record<string, unknown>;

      return [{ json: result, pairedItem: { item: itemIndex } }];
    }

    default:
      return [{ json: { error: `Unknown operation: ${operation}` }, pairedItem: { item: itemIndex } }];
  }
}

// ---------------------------------------------------------------------------
// createN8nDispatchEndpoints — HTTP endpoints needed by the n8n node
// ---------------------------------------------------------------------------

/**
 * Register the HTTP endpoints that the n8n node calls.
 * Call this when setting up your Smallchat server.
 *
 * Works with Express-style routers.
 */
export function createN8nDispatchEndpoints(runtime: ToolRuntime): {
  dispatch: (req: unknown, res: unknown) => Promise<void>;
  listTools: (req: unknown, res: unknown) => Promise<void>;
  resolve: (req: unknown, res: unknown) => Promise<void>;
} {
  return {
    async dispatch(req: unknown, res: unknown): Promise<void> {
      const r = req as Record<string, unknown>;
      const response = res as Record<string, unknown>;
      try {
        const body = r.body as { intent: string; args?: Record<string, unknown> };
        const result = await runtime.dispatch(body.intent, body.args);
        (response.json as (data: unknown) => void)(result);
      } catch (err) {
        (response.status as (code: number) => typeof response)(500);
        (response.json as (data: unknown) => void)({ error: (err as Error).message });
      }
    },

    async listTools(_req: unknown, res: unknown): Promise<void> {
      const response = res as Record<string, unknown>;
      const tools = [];
      for (const toolClass of runtime.context.getClasses()) {
        for (const [, imp] of toolClass.dispatchTable) {
          tools.push({
            name: imp.toolName,
            description: imp.schema?.description ?? '',
            provider: imp.providerId,
          });
        }
      }
      (response.json as (data: unknown) => void)({ tools });
    },

    async resolve(req: unknown, res: unknown): Promise<void> {
      const r = req as Record<string, unknown>;
      const response = res as Record<string, unknown>;
      const query = r.query as Record<string, string>;
      const intent = query.intent ?? '';

      try {
        const selector = await runtime.selectorTable.resolve(intent);
        (response.json as (data: unknown) => void)({
          intent,
          selector: selector.canonical,
          parts: selector.parts,
          arity: selector.arity,
        });
      } catch (err) {
        (response.status as (code: number) => typeof response)(500);
        (response.json as (data: unknown) => void)({ error: (err as Error).message });
      }
    },
  };
}
