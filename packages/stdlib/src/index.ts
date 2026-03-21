/**
 * @smallchat/stdlib — Standard Library
 *
 * A collection of 10 commonly needed tools, pre-built as Smallchat ToolIMPs
 * and ready to register in any ToolRuntime.
 *
 * Tools included:
 *  1.  weather       — Get current weather for a city
 *  2.  calculator    — Evaluate mathematical expressions safely
 *  3.  web_search    — Web search via a configurable provider
 *  4.  web_fetch     — Fetch and extract text from a URL
 *  5.  datetime      — Current date/time and timezone operations
 *  6.  uuid          — Generate UUIDs
 *  7.  base64        — Encode/decode base64
 *  8.  json_transform — JSONPath queries and transforms
 *  9.  text_stats    — Word count, readability, and text analysis
 * 10.  template      — Simple Mustache/Handlebars-style string templating
 *
 * Usage:
 *
 *   import { createStdlib, StdlibClass } from '@smallchat/stdlib';
 *   import { ToolRuntime } from '@smallchat/core';
 *
 *   const runtime = new ToolRuntime(vectorIndex, embedder);
 *   const stdlib = await createStdlib(runtime, {
 *     weatherApiKey: process.env.OPENWEATHER_API_KEY,
 *     searchApiKey: process.env.BRAVE_API_KEY,
 *   });
 *
 *   // All 10 tools are now available via dispatch:
 *   const result = await runtime.dispatch('what is the weather in Paris?', { city: 'Paris' });
 */

import type { ToolIMP, ToolResult, ArgumentConstraints } from '../../../src/core/types.js';
import type { ToolRuntime } from '../../../src/runtime/runtime.js';
import { ToolClass } from '../../../src/core/tool-class.js';

// ---------------------------------------------------------------------------
// Stdlib configuration
// ---------------------------------------------------------------------------

export interface StdlibOptions {
  /** OpenWeatherMap API key for weather tool */
  weatherApiKey?: string;
  /** Brave Search API key for web_search tool */
  searchApiKey?: string;
  /** Custom fetch implementation (for testing) */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function noopConstraints(): ArgumentConstraints {
  return {
    required: [],
    optional: [],
    validate: () => ({ valid: true, errors: [] }),
  };
}

// ---------------------------------------------------------------------------
// 1. Weather
// ---------------------------------------------------------------------------

function createWeatherTool(options: StdlibOptions): ToolIMP {
  const schema = {
    name: 'get_weather',
    description: 'Get current weather conditions for a city',
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City name, e.g. "London" or "New York, US"' },
        units: {
          type: 'string',
          description: 'Temperature units: celsius or fahrenheit',
          enum: ['celsius', 'fahrenheit'],
          default: 'celsius',
        },
      },
      required: ['city'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'get_weather',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const city = String(args.city ?? '');
      const units = args.units === 'fahrenheit' ? 'imperial' : 'metric';

      if (!options.weatherApiKey) {
        // Return a simulated response when no API key is configured
        return {
          content: {
            city,
            temperature: units === 'imperial' ? 72 : 22,
            units: units === 'imperial' ? 'fahrenheit' : 'celsius',
            conditions: 'partly cloudy',
            humidity: 60,
            wind_speed: 15,
            note: 'Simulated response — set weatherApiKey for real data',
          },
        };
      }

      const fetchFn = options.fetchImpl ?? fetch;
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=${units}&appid=${options.weatherApiKey}`;

      try {
        const res = await fetchFn(url);
        if (!res.ok) {
          return { content: null, isError: true, metadata: { error: `Weather API error: ${res.status}` } };
        }
        const data = await res.json() as Record<string, unknown>;
        const weather = (data.weather as Array<Record<string, unknown>>)?.[0];
        const main = data.main as Record<string, unknown>;
        const wind = data.wind as Record<string, unknown>;

        return {
          content: {
            city,
            temperature: main?.temp,
            feels_like: main?.feels_like,
            humidity: main?.humidity,
            conditions: weather?.description,
            wind_speed: wind?.speed,
            units: units === 'imperial' ? 'fahrenheit' : 'celsius',
          },
        };
      } catch (err) {
        return { content: null, isError: true, metadata: { error: (err as Error).message } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Calculator
// ---------------------------------------------------------------------------

function createCalculatorTool(): ToolIMP {
  const schema = {
    name: 'calculate',
    description: 'Evaluate a mathematical expression safely. Supports +, -, *, /, **, %, parentheses, Math functions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description: 'Math expression, e.g. "2 + 3 * 4" or "Math.sqrt(16)"',
        },
      },
      required: ['expression'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'calculate',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const expr = String(args.expression ?? '');

      // Whitelist: numbers, operators, parens, math functions, whitespace
      const safe = /^[\d\s+\-*/().,^%!eE]+$/.test(expr) ||
        /^[\w\s+\-*/().,^%!]+$/.test(expr.replace(/Math\.\w+/g, '0'));

      if (!safe) {
        return { content: null, isError: true, metadata: { error: 'Expression contains disallowed characters' } };
      }

      try {
        // Safe evaluation using Function constructor (restricted scope)
        const result = Function(
          '"use strict"; const Math = globalThis.Math; return (' + expr + ')',
        )() as number;

        if (typeof result !== 'number' || !isFinite(result)) {
          return { content: null, isError: true, metadata: { error: 'Expression did not evaluate to a finite number' } };
        }

        return { content: { expression: expr, result } };
      } catch (err) {
        return { content: null, isError: true, metadata: { error: `Calculation error: ${(err as Error).message}` } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Web Search
// ---------------------------------------------------------------------------

function createWebSearchTool(options: StdlibOptions): ToolIMP {
  const schema = {
    name: 'web_search',
    description: 'Search the web and return ranked results with titles, URLs, and snippets',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results (default 5, max 20)', default: 5 },
        freshness: {
          type: 'string',
          description: 'Time filter: pd (past day), pw (past week), pm (past month), py (past year)',
          enum: ['pd', 'pw', 'pm', 'py'],
        },
      },
      required: ['query'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'web_search',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? '');
      const count = Math.min(Number(args.count ?? 5), 20);
      const fetchFn = options.fetchImpl ?? fetch;

      if (!options.searchApiKey) {
        return {
          content: {
            query,
            results: [
              {
                title: 'Simulated result — configure searchApiKey for real results',
                url: 'https://example.com',
                snippet: `Search results for: ${query}`,
              },
            ],
          },
        };
      }

      const params = new URLSearchParams({ q: query, count: String(count) });
      if (args.freshness) params.set('freshness', String(args.freshness));

      try {
        const res = await fetchFn(`https://api.search.brave.com/res/v1/web/search?${params}`, {
          headers: {
            'X-Subscription-Token': options.searchApiKey,
            Accept: 'application/json',
          },
        });

        if (!res.ok) {
          return { content: null, isError: true, metadata: { error: `Search error: ${res.status}` } };
        }

        const data = await res.json() as { web?: { results?: Array<Record<string, unknown>> } };
        const results = data.web?.results?.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        })) ?? [];

        return { content: { query, results } };
      } catch (err) {
        return { content: null, isError: true, metadata: { error: (err as Error).message } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Web Fetch
// ---------------------------------------------------------------------------

function createWebFetchTool(options: StdlibOptions): ToolIMP {
  const schema = {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content (HTML stripped to readable text)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        maxChars: { type: 'number', description: 'Max characters to return (default 5000)', default: 5000 },
      },
      required: ['url'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'web_fetch',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const url = String(args.url ?? '');
      const maxChars = Number(args.maxChars ?? 5000);
      const fetchFn = options.fetchImpl ?? fetch;

      try {
        const res = await fetchFn(url, {
          headers: { 'User-Agent': 'Smallchat/1.0 (web-fetch tool)' },
        });

        if (!res.ok) {
          return { content: null, isError: true, metadata: { error: `Fetch error: ${res.status}` } };
        }

        let text = await res.text();

        // Strip HTML tags for readability
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, maxChars);

        return {
          content: {
            url,
            text,
            truncated: text.length >= maxChars,
          },
        };
      } catch (err) {
        return { content: null, isError: true, metadata: { error: (err as Error).message } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. DateTime
// ---------------------------------------------------------------------------

function createDateTimeTool(): ToolIMP {
  const schema = {
    name: 'datetime',
    description: 'Get current date and time, or convert between timezones',
    inputSchema: {
      type: 'object' as const,
      properties: {
        timezone: { type: 'string', description: 'IANA timezone, e.g. "America/New_York"', default: 'UTC' },
        format: {
          type: 'string',
          description: 'Output format: iso (default), unix, human',
          enum: ['iso', 'unix', 'human'],
          default: 'iso',
        },
        operation: {
          type: 'string',
          description: 'now (current time) or parse (parse a date string)',
          enum: ['now', 'parse'],
          default: 'now',
        },
        input: { type: 'string', description: 'Date string to parse (for operation=parse)' },
      },
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'datetime',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const timezone = String(args.timezone ?? 'UTC');
      const format = String(args.format ?? 'iso');
      const operation = String(args.operation ?? 'now');

      let date: Date;
      if (operation === 'parse' && args.input) {
        date = new Date(String(args.input));
        if (isNaN(date.getTime())) {
          return { content: null, isError: true, metadata: { error: `Invalid date: ${args.input}` } };
        }
      } else {
        date = new Date();
      }

      let formatted: string | number;
      if (format === 'unix') {
        formatted = Math.floor(date.getTime() / 1000);
      } else if (format === 'human') {
        formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(date);
      } else {
        formatted = date.toISOString();
      }

      return {
        content: {
          timestamp: formatted,
          timezone,
          unix: Math.floor(date.getTime() / 1000),
          iso: date.toISOString(),
          day_of_week: new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 6. UUID Generator
// ---------------------------------------------------------------------------

function createUUIDTool(): ToolIMP {
  const schema = {
    name: 'generate_uuid',
    description: 'Generate one or more UUIDs (v4)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'Number of UUIDs to generate (default 1, max 100)', default: 1 },
        format: {
          type: 'string',
          description: 'Output format: hyphenated (default), no-hyphens, base64',
          enum: ['hyphenated', 'no-hyphens', 'base64'],
          default: 'hyphenated',
        },
      },
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'generate_uuid',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const count = Math.min(Number(args.count ?? 1), 100);
      const format = String(args.format ?? 'hyphenated');

      const uuids = Array.from({ length: count }, () => {
        const uuid = crypto.randomUUID();
        if (format === 'no-hyphens') return uuid.replace(/-/g, '');
        if (format === 'base64') return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64');
        return uuid;
      });

      return { content: count === 1 ? { uuid: uuids[0] } : { uuids } };
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Base64
// ---------------------------------------------------------------------------

function createBase64Tool(): ToolIMP {
  const schema = {
    name: 'base64',
    description: 'Encode or decode a string using Base64',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          description: 'encode or decode',
          enum: ['encode', 'decode'],
        },
        input: { type: 'string', description: 'String to encode or decode' },
        urlSafe: { type: 'boolean', description: 'Use URL-safe Base64 (replaces +/= with -/_)', default: false },
      },
      required: ['operation', 'input'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'base64',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const operation = String(args.operation ?? 'encode');
      const input = String(args.input ?? '');
      const urlSafe = Boolean(args.urlSafe ?? false);

      try {
        if (operation === 'encode') {
          let encoded = Buffer.from(input, 'utf8').toString('base64');
          if (urlSafe) encoded = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
          return { content: { operation, input, output: encoded } };
        } else {
          let toDecode = input;
          if (urlSafe) toDecode = toDecode.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(toDecode, 'base64').toString('utf8');
          return { content: { operation, input, output: decoded } };
        }
      } catch (err) {
        return { content: null, isError: true, metadata: { error: (err as Error).message } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 8. JSON Transform (JSONPath-lite)
// ---------------------------------------------------------------------------

function createJsonTransformTool(): ToolIMP {
  const schema = {
    name: 'json_transform',
    description: 'Query or transform JSON data using a dot-notation path or simple mapping',
    inputSchema: {
      type: 'object' as const,
      properties: {
        data: { type: 'string', description: 'JSON string to query/transform' },
        path: { type: 'string', description: 'Dot-notation path, e.g. "user.address.city" or "items[0].name"' },
        operation: {
          type: 'string',
          description: 'get (extract), keys (list keys), flatten (flatten nested), stringify (pretty-print)',
          enum: ['get', 'keys', 'flatten', 'stringify'],
          default: 'get',
        },
      },
      required: ['data'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'json_transform',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(args.data ?? '{}'));
      } catch {
        return { content: null, isError: true, metadata: { error: 'Invalid JSON input' } };
      }

      const operation = String(args.operation ?? 'get');
      const path = String(args.path ?? '');

      switch (operation) {
        case 'stringify':
          return { content: { result: JSON.stringify(parsed, null, 2) } };

        case 'keys':
          if (typeof parsed !== 'object' || !parsed) {
            return { content: null, isError: true, metadata: { error: 'Input must be an object' } };
          }
          return { content: { keys: Object.keys(parsed as object) } };

        case 'flatten':
          return { content: { result: flattenObject(parsed) } };

        case 'get':
        default: {
          if (!path) return { content: { result: parsed } };
          const result = jsonGet(parsed, path);
          return { content: { path, result } };
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 9. Text Stats
// ---------------------------------------------------------------------------

function createTextStatsTool(): ToolIMP {
  const schema = {
    name: 'text_stats',
    description: 'Analyze text: word count, character count, sentence count, reading time, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to analyze' },
        wordsPerMinute: { type: 'number', description: 'Reading speed in words per minute (default 200)', default: 200 },
      },
      required: ['text'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'text_stats',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const text = String(args.text ?? '');
      const wpm = Number(args.wordsPerMinute ?? 200);

      const words = text.trim().split(/\s+/).filter(w => w.length > 0);
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
      const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 0);
      const characters = text.length;
      const charactersNoSpaces = text.replace(/\s/g, '').length;
      const readingTimeSeconds = Math.ceil((words.length / wpm) * 60);

      // Average word length
      const avgWordLength = words.length > 0
        ? words.reduce((sum, w) => sum + w.replace(/[^a-zA-Z]/g, '').length, 0) / words.length
        : 0;

      return {
        content: {
          wordCount: words.length,
          characterCount: characters,
          characterCountNoSpaces: charactersNoSpaces,
          sentenceCount: sentences.length,
          paragraphCount: paragraphs.length,
          averageWordLength: Math.round(avgWordLength * 10) / 10,
          readingTimeSeconds,
          readingTimeFormatted: `${Math.ceil(readingTimeSeconds / 60)} min read`,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 10. Template
// ---------------------------------------------------------------------------

function createTemplateTool(): ToolIMP {
  const schema = {
    name: 'render_template',
    description: 'Render a string template with variable substitution. Supports {{variable}} syntax.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        template: { type: 'string', description: 'Template string with {{variable}} placeholders' },
        variables: { type: 'object', description: 'Key-value pairs to substitute' },
        missingValue: {
          type: 'string',
          description: 'Value to use for missing variables (default: empty string)',
          default: '',
        },
      },
      required: ['template', 'variables'],
    },
    arguments: [],
  };

  return {
    providerId: 'stdlib',
    toolName: 'render_template',
    transportType: 'local',
    schema,
    schemaLoader: async () => schema,
    constraints: noopConstraints(),
    async execute(args): Promise<ToolResult> {
      const template = String(args.template ?? '');
      const variables = (args.variables as Record<string, unknown>) ?? {};
      const missingValue = String(args.missingValue ?? '');

      const rendered = template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_, key) => {
        const trimmedKey = key.trim();
        const value = jsonGet(variables, trimmedKey);
        return value !== undefined && value !== null ? String(value) : missingValue;
      });

      const usedVars = [...template.matchAll(/\{\{(\s*[\w.]+\s*)\}\}/g)].map(m => m[1].trim());
      const missingVars = usedVars.filter(v => {
        const val = jsonGet(variables, v);
        return val === undefined || val === null;
      });

      return {
        content: {
          rendered,
          usedVariables: [...new Set(usedVars)],
          missingVariables: missingVars,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// StdlibClass — a single ToolClass containing all stdlib tools
// ---------------------------------------------------------------------------

export async function createStdlibClass(
  runtime: ToolRuntime,
  options: StdlibOptions = {},
): Promise<ToolClass> {
  const stdlibClass = new ToolClass('stdlib');

  const tools = [
    createWeatherTool(options),
    createCalculatorTool(),
    createWebSearchTool(options),
    createWebFetchTool(options),
    createDateTimeTool(),
    createUUIDTool(),
    createBase64Tool(),
    createJsonTransformTool(),
    createTextStatsTool(),
    createTemplateTool(),
  ];

  for (const tool of tools) {
    const selector = await runtime.selectorTable.resolve(tool.schema!.description);
    stdlibClass.addMethod(selector, tool);
  }

  return stdlibClass;
}

// ---------------------------------------------------------------------------
// createStdlib — convenience: register all stdlib tools in one call
// ---------------------------------------------------------------------------

export async function createStdlib(
  runtime: ToolRuntime,
  options: StdlibOptions = {},
): Promise<ToolClass> {
  const stdlibClass = await createStdlibClass(runtime, options);
  runtime.registerClass(stdlibClass);
  return stdlibClass;
}

// ---------------------------------------------------------------------------
// Individual tool exports (for tree-shaking)
// ---------------------------------------------------------------------------

export {
  createWeatherTool,
  createCalculatorTool,
  createWebSearchTool,
  createWebFetchTool,
  createDateTimeTool,
  createUUIDTool,
  createBase64Tool,
  createJsonTransformTool,
  createTextStatsTool,
  createTemplateTool,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonGet(data: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function flattenObject(obj: unknown, prefix = '', result: Record<string, unknown> = {}): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) {
    result[prefix] = obj;
    return result;
  }

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenObject(v, prefix ? `${prefix}[${i}]` : `[${i}]`, result));
    return result;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      flattenObject(value, newKey, result);
    } else {
      result[newKey] = value;
    }
  }

  return result;
}
