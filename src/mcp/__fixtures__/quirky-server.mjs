#!/usr/bin/env node
/**
 * Fixture stdio MCP server with the habits real servers have, for the
 * outbound-client tests. Behaviour is chosen through environment variables:
 *
 *   FIXTURE_STDERR_BYTES=<n>     write n bytes to stderr before answering
 *                                initialize (a client that never reads
 *                                stderr leaves us blocked on a full pipe)
 *   FIXTURE_PAGE_SIZE=<n>        paginate tools/list n tools per page
 *   FIXTURE_FAIL_ONCE_FILE=<p>   exit 1 at startup unless <p> exists, and
 *                                create it — the next start succeeds
 *   FIXTURE_TOOL_COUNT=<n>       serve tools t1..tn (default 5)
 *
 * The `sleep` tool writes `sleep:cancelled` to stderr when the client
 * cancels it (notifications/cancelled).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, writeFileSync } from 'node:fs';

const failOnce = process.env.FIXTURE_FAIL_ONCE_FILE;
if (failOnce && !existsSync(failOnce)) {
  writeFileSync(failOnce, 'failed once\n');
  process.stderr.write('quirky: failing the first start on purpose\n');
  process.exit(1);
}

const noise = Number(process.env.FIXTURE_STDERR_BYTES ?? 0);
if (noise > 0) {
  const line = 'quirky: very verbose startup logging '.padEnd(1023, '.') + '\n';
  // Block on a full pipe the way Python/Go servers do (Node would buffer
  // the writes in memory instead), so a client that never drains stderr hangs.
  process.stderr._handle?.setBlocking?.(true);
  for (let written = 0; written < noise; written += line.length) process.stderr.write(line);
}

const count = Number(process.env.FIXTURE_TOOL_COUNT ?? 5);
const pageSize = Number(process.env.FIXTURE_PAGE_SIZE ?? 0);

const tools = Array.from({ length: count }, (_, i) => ({
  name: `t${i + 1}`,
  description: `Fixture tool number ${i + 1}`,
  inputSchema: { type: 'object', properties: {} },
}));
tools.push({
  name: 'sleep',
  description: 'Wait for the given number of milliseconds unless cancelled',
  inputSchema: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] },
});

const server = new Server({ name: 'quirky', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (!pageSize) return { tools };
  const start = Number(request.params?.cursor ?? 0);
  const page = tools.slice(start, start + pageSize);
  const next = start + pageSize;
  return next < tools.length ? { tools: page, nextCursor: String(next) } : { tools: page };
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === 'sleep') {
    const ms = Number(request.params.arguments?.ms ?? 0);
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('slept'), ms);
      extra.signal.addEventListener('abort', () => { clearTimeout(timer); resolve('cancelled'); }, { once: true });
    });
    process.stderr.write(`sleep:${outcome}\n`);
    return { content: [{ type: 'text', text: outcome }] };
  }
  return { content: [{ type: 'text', text: `ran ${request.params.name}` }] };
});

await server.connect(new StdioServerTransport());
