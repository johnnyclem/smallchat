/**
 * Zapier Integration — Zapier app that triggers Smallchat dispatches
 *
 * Provides the Zapier app definition, triggers, actions, and searches
 * needed to build a Zapier integration for Smallchat.
 *
 * This module exports:
 *  1. ZapierApp       — the full Zapier app definition object
 *  2. ZapierSmallchatAction — executes a dispatch when a Zap fires
 *  3. ZapierSmallchatTrigger — polls for Smallchat events
 *  4. createZapierWebhook  — register a Zapier webhook with SmallchatRouter
 *
 * Usage (with zapier-platform-core installed):
 *
 *   import { ZapierApp } from './integrations/zapier';
 *   const App = createSmallChatZapierApp(runtime);
 *   module.exports = App;
 *
 * The Zapier developer CLI then packages this for upload to zapier.com.
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolResult } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Zapier interface shims (zapier-platform-core types)
// ---------------------------------------------------------------------------

export interface ZapierBundle {
  authData: Record<string, string>;
  inputData: Record<string, unknown>;
  meta: {
    isFillingDynamicDropdown?: boolean;
    isLoadingSample?: boolean;
    page?: number;
  };
  rawRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    content: string;
  };
}

export interface ZapierZ {
  request(url: string, options?: Record<string, unknown>): Promise<ZapierResponse>;
  JSON: { parse(str: string): unknown };
  console: { log(...args: unknown[]): void };
}

export interface ZapierResponse {
  status: number;
  content: string;
  json(): unknown;
}

export interface ZapierInputField {
  key: string;
  label: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'text' | 'code' | 'file' | 'password' | 'datetime' | 'copy';
  required?: boolean;
  helpText?: string;
  default?: string;
  choices?: string[] | Array<{ value: string; label: string }>;
  dynamic?: string;
  altersDynamicFields?: boolean;
  list?: boolean;
  children?: ZapierInputField[];
}

export interface ZapierOutputField {
  key: string;
  label: string;
  type?: string;
}

export interface ZapierAction {
  key: string;
  noun: string;
  display: {
    label: string;
    description: string;
    hidden?: boolean;
  };
  operation: {
    inputFields: ZapierInputField[];
    outputFields?: ZapierOutputField[];
    sample: Record<string, unknown>;
    perform(z: ZapierZ, bundle: ZapierBundle): Promise<unknown>;
  };
}

export interface ZapierTrigger extends ZapierAction {
  operation: ZapierAction['operation'] & {
    type?: 'polling' | 'hook';
    performSubscribe?: (z: ZapierZ, bundle: ZapierBundle) => Promise<unknown>;
    performUnsubscribe?: (z: ZapierZ, bundle: ZapierBundle) => Promise<unknown>;
    performList?: (z: ZapierZ, bundle: ZapierBundle) => Promise<unknown[]>;
  };
}

export interface ZapierSearch extends ZapierAction {
  operation: ZapierAction['operation'] & {
    performGet?: (z: ZapierZ, bundle: ZapierBundle) => Promise<unknown>;
  };
}

export interface ZapierAuthentication {
  type: 'custom' | 'session' | 'basic' | 'digest' | 'oauth2' | 'oauth1' | 'api_key';
  fields?: ZapierInputField[];
  test?: string | ((z: ZapierZ, bundle: ZapierBundle) => Promise<unknown>);
  connectionLabel?: string | ((z: ZapierZ, bundle: ZapierBundle) => string);
  sessionConfig?: {
    perform: (z: ZapierZ, bundle: ZapierBundle) => Promise<Record<string, string>>;
  };
}

export interface ZapierApp {
  version: string;
  platformVersion: string;
  authentication?: ZapierAuthentication;
  triggers?: Record<string, ZapierTrigger>;
  actions?: Record<string, ZapierAction>;
  searches?: Record<string, ZapierSearch>;
  beforeRequest?: unknown[];
  afterResponse?: unknown[];
}

// ---------------------------------------------------------------------------
// createSmallChatZapierApp — build the full Zapier app definition
// ---------------------------------------------------------------------------

export interface ZapierAppOptions {
  /** Base URL of your Smallchat MCP server (for API calls from Zapier) */
  serverUrl: string;
  /** App version string */
  version?: string;
}

export function createSmallChatZapierApp(options: ZapierAppOptions): ZapierApp {
  const { serverUrl } = options;

  return {
    version: options.version ?? '1.0.0',
    platformVersion: '14.0.0',

    authentication: {
      type: 'api_key',
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          required: true,
          helpText: 'Your Smallchat API key (configured in your MCP server)',
        },
        {
          key: 'serverUrl',
          label: 'Server URL',
          type: 'string',
          required: false,
          helpText: `Your Smallchat MCP server URL (default: ${serverUrl})`,
          default: serverUrl,
        },
      ],
      test: async (z: ZapierZ, bundle: ZapierBundle) => {
        const url = `${bundle.authData.serverUrl ?? serverUrl}/health`;
        const response = await z.request(url, {
          headers: { Authorization: `Bearer ${bundle.authData.apiKey}` },
        });
        return response.json();
      },
      connectionLabel: (_z: ZapierZ, bundle: ZapierBundle) =>
        `Smallchat (${bundle.authData.serverUrl ?? serverUrl})`,
    },

    triggers: {
      tool_event: buildToolEventTrigger(serverUrl),
    },

    actions: {
      dispatch: buildDispatchAction(serverUrl),
      dispatch_stream: buildDispatchStreamAction(serverUrl),
      list_tools: buildListToolsAction(serverUrl),
    },

    searches: {
      find_tool: buildFindToolSearch(serverUrl),
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function buildDispatchAction(serverUrl: string): ZapierAction {
  return {
    key: 'dispatch',
    noun: 'Dispatch',
    display: {
      label: 'Dispatch Tool Intent',
      description: 'Send a natural-language intent to Smallchat and execute the best matching tool.',
    },
    operation: {
      inputFields: [
        {
          key: 'intent',
          label: 'Intent',
          type: 'text',
          required: true,
          helpText: 'Natural-language description of what you want to do. Example: "search for recent news about TypeScript"',
        },
        {
          key: 'args',
          label: 'Arguments (JSON)',
          type: 'code',
          required: false,
          helpText: 'Optional JSON object with arguments to pass to the resolved tool.',
          default: '{}',
        },
        {
          key: 'provider',
          label: 'Provider Filter',
          type: 'string',
          required: false,
          helpText: 'Only use tools from this provider ID (leave empty for any provider).',
        },
      ],
      outputFields: [
        { key: 'content', label: 'Result Content' },
        { key: 'isError', label: 'Is Error', type: 'boolean' },
        { key: 'toolName', label: 'Resolved Tool' },
        { key: 'providerId', label: 'Provider ID' },
      ],
      sample: {
        content: '{"temperature":22,"city":"London","conditions":"partly cloudy"}',
        isError: false,
        toolName: 'get_weather',
        providerId: 'weather',
      },
      perform: async (z: ZapierZ, bundle: ZapierBundle) => {
        const url = `${bundle.authData.serverUrl ?? serverUrl}/dispatch`;
        let args: unknown = {};
        try {
          args = JSON.parse(String(bundle.inputData.args ?? '{}'));
        } catch { /* keep empty */ }

        const response = await z.request(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bundle.authData.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            intent: bundle.inputData.intent,
            args,
            provider: bundle.inputData.provider,
          }),
        });

        const data = response.json() as Record<string, unknown>;
        return {
          content: typeof data.content === 'string' ? data.content : JSON.stringify(data.content),
          isError: data.isError ?? false,
          toolName: (data.metadata as Record<string, unknown>)?.toolName ?? '',
          providerId: (data.metadata as Record<string, unknown>)?.providerId ?? '',
          raw: data,
        };
      },
    },
  };
}

function buildDispatchStreamAction(serverUrl: string): ZapierAction {
  return {
    key: 'dispatch_stream',
    noun: 'Stream',
    display: {
      label: 'Stream Tool Dispatch',
      description: 'Stream a tool dispatch result — returns the full assembled text response.',
    },
    operation: {
      inputFields: [
        {
          key: 'intent',
          label: 'Intent',
          type: 'text',
          required: true,
        },
        {
          key: 'args',
          label: 'Arguments (JSON)',
          type: 'code',
          required: false,
          default: '{}',
        },
      ],
      outputFields: [
        { key: 'text', label: 'Assembled Text' },
        { key: 'isError', label: 'Is Error', type: 'boolean' },
      ],
      sample: { text: 'The weather in London is 22°C and partly cloudy.', isError: false },
      perform: async (z: ZapierZ, bundle: ZapierBundle) => {
        const url = `${bundle.authData.serverUrl ?? serverUrl}/dispatch/stream`;
        let args: unknown = {};
        try { args = JSON.parse(String(bundle.inputData.args ?? '{}')); } catch { /* */ }

        const response = await z.request(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bundle.authData.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ intent: bundle.inputData.intent, args }),
        });

        const data = response.json() as Record<string, unknown>;
        return { text: String(data.text ?? data.content ?? ''), isError: data.isError ?? false };
      },
    },
  };
}

function buildListToolsAction(serverUrl: string): ZapierAction {
  return {
    key: 'list_tools',
    noun: 'Tools',
    display: {
      label: 'List Available Tools',
      description: 'Get a list of all tools available in Smallchat.',
      hidden: true,
    },
    operation: {
      inputFields: [],
      outputFields: [
        { key: 'name', label: 'Tool Name' },
        { key: 'description', label: 'Description' },
        { key: 'provider', label: 'Provider' },
      ],
      sample: { name: 'get_weather', description: 'Get current weather', provider: 'weather' },
      perform: async (z: ZapierZ, bundle: ZapierBundle) => {
        const url = `${bundle.authData.serverUrl ?? serverUrl}/tools`;
        const response = await z.request(url, {
          headers: { Authorization: `Bearer ${bundle.authData.apiKey}` },
        });
        const data = response.json() as { tools: Array<Record<string, string>> };
        return data.tools ?? [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function buildToolEventTrigger(serverUrl: string): ZapierTrigger {
  return {
    key: 'tool_event',
    noun: 'Tool Event',
    display: {
      label: 'New Tool Dispatch Event',
      description: 'Triggers when a Smallchat tool is dispatched (polling).',
    },
    operation: {
      type: 'polling',
      inputFields: [
        {
          key: 'toolName',
          label: 'Tool Name Filter',
          type: 'string',
          required: false,
          helpText: 'Only trigger for this tool name (leave empty for all tools).',
        },
      ],
      outputFields: [
        { key: 'id', label: 'Event ID' },
        { key: 'toolName', label: 'Tool Name' },
        { key: 'intent', label: 'Intent' },
        { key: 'timestamp', label: 'Timestamp' },
        { key: 'result', label: 'Result' },
      ],
      sample: {
        id: 'evt_001',
        toolName: 'get_weather',
        intent: 'weather in London',
        timestamp: new Date().toISOString(),
        result: '{"temperature":22}',
      },
      perform: async (z: ZapierZ, bundle: ZapierBundle) => {
        const params = new URLSearchParams();
        if (bundle.inputData.toolName) {
          params.set('toolName', String(bundle.inputData.toolName));
        }

        const url = `${bundle.authData.serverUrl ?? serverUrl}/events/recent?${params}`;
        const response = await z.request(url, {
          headers: { Authorization: `Bearer ${bundle.authData.apiKey}` },
        });
        const data = response.json() as { events: unknown[] };
        return data.events ?? [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Searches
// ---------------------------------------------------------------------------

function buildFindToolSearch(serverUrl: string): ZapierSearch {
  return {
    key: 'find_tool',
    noun: 'Tool',
    display: {
      label: 'Find Tool',
      description: 'Search for a Smallchat tool by name or description.',
    },
    operation: {
      inputFields: [
        {
          key: 'query',
          label: 'Search Query',
          type: 'string',
          required: true,
          helpText: 'Natural-language search query to find the best matching tool.',
        },
      ],
      outputFields: [
        { key: 'name', label: 'Tool Name' },
        { key: 'description', label: 'Description' },
        { key: 'provider', label: 'Provider' },
        { key: 'confidence', label: 'Confidence' },
      ],
      sample: { name: 'get_weather', description: 'Get weather', provider: 'weather', confidence: '0.95' },
      perform: async (z: ZapierZ, bundle: ZapierBundle) => {
        const url = `${bundle.authData.serverUrl ?? serverUrl}/tools/resolve?intent=${encodeURIComponent(String(bundle.inputData.query))}`;
        const response = await z.request(url, {
          headers: { Authorization: `Bearer ${bundle.authData.apiKey}` },
        });
        const data = response.json() as { tool?: Record<string, unknown> };
        return data.tool ? [data.tool] : [];
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Local runtime variant (no HTTP server required)
// ---------------------------------------------------------------------------

/**
 * Build a Zapier action that calls a ToolRuntime directly (for testing /
 * server-side execution in the same Node.js process).
 */
export function createLocalDispatchAction(runtime: ToolRuntime): ZapierAction {
  return {
    key: 'local_dispatch',
    noun: 'LocalDispatch',
    display: {
      label: 'Local Dispatch',
      description: 'Dispatch directly to a local ToolRuntime (no HTTP).',
      hidden: true,
    },
    operation: {
      inputFields: [
        { key: 'intent', label: 'Intent', type: 'text', required: true },
        { key: 'args', label: 'Args', type: 'code', required: false, default: '{}' },
      ],
      outputFields: [{ key: 'content', label: 'Content' }],
      sample: { content: 'ok' },
      perform: async (_z: ZapierZ, bundle: ZapierBundle) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(String(bundle.inputData.args ?? '{}')); } catch { /* */ }

        const result: ToolResult = await runtime.dispatch(String(bundle.inputData.intent), args);
        return {
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          isError: result.isError ?? false,
        };
      },
    },
  };
}
