import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { CompilationResult, ProviderManifest } from '../../core/types.js';
import { ToolClass, ToolProxy } from '../../core/tool-class.js';
import { ToolCompiler } from '../../compiler/compiler.js';
import { ToolRuntime } from '../../runtime/runtime.js';
import { LocalEmbedder } from '../../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';

/**
 * MCP-compatible serve command.
 *
 * Exposes a JSON-RPC endpoint that speaks a subset of the MCP protocol:
 *   - initialize
 *   - tools/list
 *   - tools/call  (supports streaming via SSE when Accept: text/event-stream)
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const serveCommand = new Command('serve')
  .description('Start an MCP-compatible tool server with streaming support')
  .requiredOption('-s, --source <path>', 'Source directory or compiled artifact (.json)')
  .option('-p, --port <number>', 'Port to listen on', '3001')
  .option('--host <address>', 'Host to bind to', '127.0.0.1')
  .action(async (options) => {
    const sourcePath = resolve(options.source);
    const port = parseInt(options.port, 10);
    const host = options.host;

    console.log('Loading toolkit...');

    const { runtime, artifact } = await loadRuntime(sourcePath);

    console.log(`  ${artifact.stats.toolCount} tools across ${artifact.stats.providerCount} providers`);

    const server = createServer(async (req, res) => {
      // CORS headers for local dev
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', tools: artifact.stats.toolCount }));
        return;
      }

      // SSE stream endpoint for tool calls
      if (req.method === 'GET' && req.url === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

        // Keep alive
        const keepAlive = setInterval(() => {
          res.write(': keepalive\n\n');
        }, 15000);

        req.on('close', () => clearInterval(keepAlive));
        return;
      }

      // JSON-RPC endpoint
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      const body = await readBody(req);
      let rpcReq: JsonRpcRequest;

      try {
        rpcReq = JSON.parse(body);
      } catch {
        sendJsonRpc(res, null, undefined, { code: -32700, message: 'Parse error' });
        return;
      }

      const wantsStream = req.headers.accept?.includes('text/event-stream');
      const id = rpcReq.id ?? null;

      try {
        switch (rpcReq.method) {
          case 'initialize': {
            sendJsonRpc(res, id, {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: 'smallchat',
                version: '0.0.1',
              },
            });
            break;
          }

          case 'tools/list': {
            const tools = buildToolList(artifact);
            sendJsonRpc(res, id, { tools });
            break;
          }

          case 'tools/call': {
            const toolName = rpcReq.params?.name as string;
            const args = (rpcReq.params?.arguments ?? {}) as Record<string, unknown>;

            if (!toolName) {
              sendJsonRpc(res, id, undefined, { code: -32602, message: 'Missing tool name' });
              break;
            }

            if (wantsStream) {
              // SSE streaming response
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              });

              res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/progress', params: { id, status: 'started', tool: toolName } })}\n\n`);

              try {
                const result = await runtime.dispatch(toolName, args);

                // Stream chunks if content is an array, otherwise single result
                const chunks = Array.isArray(result.content) ? result.content : [result.content];
                for (let i = 0; i < chunks.length; i++) {
                  res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/progress', params: { id, status: 'streaming', chunk: i, total: chunks.length, content: chunks[i] } })}\n\n`);
                }

                res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result.content) }], isError: result.isError ?? false } })}\n\n`);
              } catch (err) {
                res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } })}\n\n`);
              }

              res.end();
            } else {
              // Standard JSON-RPC response
              try {
                const result = await runtime.dispatch(toolName, args);
                sendJsonRpc(res, id, {
                  content: [{ type: 'text', text: JSON.stringify(result.content) }],
                  isError: result.isError ?? false,
                });
              } catch (err) {
                sendJsonRpc(res, id, undefined, {
                  code: -32603,
                  message: (err as Error).message,
                });
              }
            }
            break;
          }

          default:
            sendJsonRpc(res, id, undefined, { code: -32601, message: `Unknown method: ${rpcReq.method}` });
        }
      } catch (err) {
        sendJsonRpc(res, id, undefined, { code: -32603, message: (err as Error).message });
      }
    });

    server.listen(port, host, () => {
      console.log(`\nsmallchat serve listening on http://${host}:${port}`);
      console.log(`  POST /          JSON-RPC (initialize, tools/list, tools/call)`);
      console.log(`  GET  /sse       SSE stream`);
      console.log(`  GET  /health    Health check`);
      console.log(`\nStreaming: POST tools/call with Accept: text/event-stream`);
    });
  });

async function loadRuntime(sourcePath: string): Promise<{ runtime: ToolRuntime; artifact: SerializedArtifact }> {
  const embedder = new LocalEmbedder();
  const vectorIndex = new MemoryVectorIndex();

  let artifact: SerializedArtifact;

  if (sourcePath.endsWith('.json') && !isDirectory(sourcePath)) {
    // Load pre-compiled artifact
    const content = readFileSync(sourcePath, 'utf-8');
    artifact = JSON.parse(content);
  } else {
    // Compile from source manifests on the fly
    const manifests = findManifests(sourcePath);

    if (manifests.length === 0) {
      console.error('No manifests found. Run `toolkit compile` first or point to a manifest directory.');
      process.exit(1);
    }

    const compiler = new ToolCompiler(embedder, vectorIndex);
    const result = await compiler.compile(manifests);

    // Build a minimal serialized form
    artifact = buildArtifact(result);
  }

  // Build runtime from artifact
  const runtime = new ToolRuntime(vectorIndex, embedder);

  // Re-register selectors and tools from artifact
  for (const [providerId, methods] of Object.entries(artifact.dispatchTables)) {
    const toolClass = new ToolClass(providerId);

    for (const [canonical, imp] of Object.entries(methods as Record<string, { providerId: string; toolName: string; transportType: string }>)) {
      const selectorData = artifact.selectors[canonical];
      if (!selectorData) continue;

      const vector = new Float32Array(selectorData.vector);
      const selector = runtime.selectorTable.intern(vector, canonical);

      const proxy = new ToolProxy(
        imp.providerId,
        imp.toolName,
        imp.transportType as 'mcp' | 'rest' | 'local' | 'grpc',
        async () => ({
          name: imp.toolName,
          description: canonical,
          inputSchema: { type: 'object' },
          arguments: [],
        }),
        { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
      );

      toolClass.addMethod(selector, proxy);
    }

    runtime.registerClass(toolClass);
  }

  return { runtime, artifact };
}

function findManifests(dir: string): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];

  function walk(d: string) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isFile() && entry.endsWith('.json')) {
          try {
            manifests.push(JSON.parse(readFileSync(full, 'utf-8')));
          } catch { /* skip invalid */ }
        } else if (stat.isDirectory()) {
          walk(full);
        }
      }
    } catch { /* directory might not exist */ }
  }

  walk(dir);
  return manifests;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface SerializedArtifact {
  version: string;
  stats: { toolCount: number; uniqueSelectorCount: number; providerCount: number; collisionCount: number };
  selectors: Record<string, { canonical: string; parts: string[]; arity: number; vector: number[] }>;
  dispatchTables: Record<string, Record<string, { providerId: string; toolName: string; transportType: string }>>;
}

function buildArtifact(result: CompilationResult): SerializedArtifact {
  const selectors: SerializedArtifact['selectors'] = {};
  for (const [key, sel] of result.selectors) {
    selectors[key] = {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      vector: Array.from(sel.vector),
    };
  }

  const dispatchTables: SerializedArtifact['dispatchTables'] = {};
  for (const [providerId, table] of result.dispatchTables) {
    const methods: Record<string, { providerId: string; toolName: string; transportType: string }> = {};
    for (const [canonical, imp] of table) {
      methods[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        transportType: imp.transportType,
      };
    }
    dispatchTables[providerId] = methods;
  }

  return {
    version: '0.0.1',
    stats: {
      toolCount: result.toolCount,
      uniqueSelectorCount: result.uniqueSelectorCount,
      providerCount: result.dispatchTables.size,
      collisionCount: result.collisions.length,
    },
    selectors,
    dispatchTables,
  };
}

function buildToolList(artifact: SerializedArtifact): object[] {
  const tools: object[] = [];
  for (const [_providerId, methods] of Object.entries(artifact.dispatchTables)) {
    for (const [canonical, imp] of Object.entries(methods)) {
      tools.push({
        name: imp.toolName,
        description: `${canonical} [${imp.providerId}]`,
        inputSchema: { type: 'object', properties: {} },
      });
    }
  }
  return tools;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJsonRpc(
  res: ServerResponse,
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): void {
  const body: JsonRpcResponse = { jsonrpc: '2.0', id };
  if (error) body.error = error;
  else body.result = result;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
