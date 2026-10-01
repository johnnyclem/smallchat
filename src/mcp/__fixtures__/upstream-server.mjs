#!/usr/bin/env node
/**
 * Fixture upstream MCP server for the serve conformance tests.
 *
 * Built on the official SDK so the tests exercise a real, spec-conformant
 * upstream. Run directly it serves over stdio; tests also import
 * createFixtureServer() to serve the same tools over Streamable HTTP.
 *
 *   node upstream-server.mjs            # stdio
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

// A 1x1 transparent PNG — exercises non-text content passthrough.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const FIXTURE_TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo the given text back unchanged',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'add',
    description: 'Add two numbers and return their sum',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail',
    description: 'Always fails with a tool-level error explaining why',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pixel',
    description: 'Return a one-pixel PNG image',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sleep',
    description: 'Wait for the given number of milliseconds, reporting progress, unless cancelled',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0 } }, required: ['ms'] },
  },
  {
    name: 'env_probe',
    description: 'Report whether the FIXTURE_SECRET environment variable reached the server',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** What in-process fixture servers observed (calls cancelled by the client). */
export const fixtureEvents = [];

/** A low-level SDK Server exposing FIXTURE_TOOLS. */
export function createFixtureServer(name = 'fixture-upstream') {
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FIXTURE_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case 'sleep': {
        const ms = Number(args.ms);
        const progressToken = request.params._meta?.progressToken;
        if (progressToken !== undefined) {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: 0, total: ms, message: 'sleeping' } });
        }
        const outcome = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve('slept'), ms);
          extra.signal.addEventListener('abort', () => { clearTimeout(timer); resolve('cancelled'); }, { once: true });
        });
        fixtureEvents.push(`sleep:${outcome}`);
        return { content: [{ type: 'text', text: outcome }] };
      }
      case 'echo':
        return { content: [{ type: 'text', text: String(args.text) }] };
      case 'add': {
        const sum = Number(args.a) + Number(args.b);
        return { content: [{ type: 'text', text: JSON.stringify({ sum }) }], structuredContent: { sum } };
      }
      case 'fail':
        return { content: [{ type: 'text', text: 'fixture failure: the disk is full' }], isError: true };
      case 'pixel':
        return { content: [{ type: 'image', data: PIXEL_PNG, mimeType: 'image/png' }] };
      case 'env_probe':
        return { content: [{ type: 'text', text: process.env.FIXTURE_SECRET ? 'secret:set' : 'secret:unset' }] };
      default:
        return { content: [{ type: 'text', text: `unknown tool ${request.params.name}` }], isError: true };
    }
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const server = createFixtureServer();
  await server.connect(new StdioServerTransport());
}
