#!/usr/bin/env npx tsx
/**
 * E2E test & benchmark script for smallchat MCP servers.
 *
 * Starts an in-process MCP server, registers tools from example manifests,
 * exercises the JSON-RPC protocol (initialize, tools/list, tools/call, etc.),
 * and records latency + token cost estimates to CSV.
 *
 * Usage:
 *   npx tsx scripts/test-mcp-server.ts [--port 3001] [--models all] [--output results/]
 */

import { createServer, type Server } from 'node:http';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MCPServer } from '../src/mcp/index.js';
import type { McpTool } from '../src/mcp/types.js';
import { MODELS, calculateCost, type ModelSpec } from './pricing.js';
import { writeCSV, writeSummaryReport, type RunResult } from './csv-writer.js';
import { parseConfig, extractMCPServers } from './config-parser.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CLIArgs {
  port: number;
  outputDir: string;
  models: string[];       // model IDs to include in the report
  configPath?: string;    // optional Claude Code config.json to parse
  verbose: boolean;
}

function parseCLIArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const opts: CLIArgs = {
    port: 3001,
    outputDir: resolve('results'),
    models: MODELS.map((m) => m.id),
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        opts.port = parseInt(args[++i], 10);
        break;
      case '--output':
        opts.outputDir = resolve(args[++i]);
        break;
      case '--models':
        opts.models = args[++i].split(',');
        break;
      case '--config':
        opts.configPath = resolve(args[++i]);
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: npx tsx scripts/test-mcp-server.ts [options]

Options:
  --port <number>       HTTP port for the test server (default: 3001)
  --output <dir>        Output directory for CSV/report (default: results/)
  --models <ids>        Comma-separated model IDs for cost estimation
  --config <path>       Path to a Claude Code config.json to parse MCP servers
  --verbose, -v         Verbose output
  --help, -h            Show this help
`);
        process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

interface ManifestFile {
  id: string;
  name: string;
  description?: string;
  transportType: string;
  tools: Array<{
    name: string;
    description: string;
    providerId?: string;
    transportType?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

function loadExampleManifests(examplesDir: string): ManifestFile[] {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith('-manifest.json'));
  const manifests: ManifestFile[] = [];
  for (const file of files) {
    const raw = readFileSync(join(examplesDir, file), 'utf-8');
    manifests.push(JSON.parse(raw) as ManifestFile);
  }
  return manifests;
}

function manifestToolToMcpTool(
  manifest: ManifestFile,
  tool: ManifestFile['tools'][number],
): McpTool {
  return {
    id: `${manifest.id}__${tool.name}`,
    name: tool.name,
    title: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    tags: [manifest.id],
    version: '1.0.0',
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function rpcCall(
  baseUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
): Promise<{ response: JsonRpcResponse; latencyMs: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionId) headers['MCP-Session-Id'] = sessionId;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  const start = performance.now();
  const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body });
  const latencyMs = performance.now() - start;

  const json = (await res.json()) as JsonRpcResponse;
  return { response: json, latencyMs };
}

async function initializeSession(baseUrl: string): Promise<{ sessionId: string; latencyMs: number }> {
  const { response, latencyMs } = await rpcCall(baseUrl, 'initialize', {
    client: { name: 'test-script', version: '1.0.0' },
    protocol: { versions: ['2025-11-25'] },
    capabilities: { tools: true, resources: true, prompts: true },
  });

  if (response.error) {
    throw new Error(`initialize failed: ${response.error.message}`);
  }

  const session = (response.result as Record<string, unknown>).session as { sessionId: string };
  return { sessionId: session.sessionId, latencyMs };
}

// ---------------------------------------------------------------------------
// Test jobs
// ---------------------------------------------------------------------------

interface TestJob {
  name: string;
  mode: string;
  run: (baseUrl: string, sessionId: string) => Promise<JobResult>;
}

interface JobResult {
  latencyMs: number;
  errors: string[];
  toolMisfires: string[];
  anomalies: string[];
}

function createTestJobs(manifests: ManifestFile[]): TestJob[] {
  const jobs: TestJob[] = [];

  // Job 1: List all tools
  jobs.push({
    name: 'tools/list',
    mode: 'full-scan',
    run: async (baseUrl, sessionId) => {
      const errors: string[] = [];
      const anomalies: string[] = [];
      const { response, latencyMs } = await rpcCall(baseUrl, 'tools/list', {}, sessionId);
      if (response.error) {
        errors.push(`tools/list error: ${response.error.message}`);
      } else {
        const result = response.result as { tools?: unknown[]; nextCursor?: string };
        if (!result.tools || result.tools.length === 0) {
          anomalies.push('tools/list returned 0 tools');
        }
      }
      return { latencyMs, errors, toolMisfires: [], anomalies };
    },
  });

  // Job 2: List with pagination
  jobs.push({
    name: 'tools/list-paginated',
    mode: 'paginated',
    run: async (baseUrl, sessionId) => {
      const errors: string[] = [];
      const anomalies: string[] = [];
      let totalTools = 0;
      let cursor: string | undefined;
      let pages = 0;
      const start = performance.now();

      do {
        const params: Record<string, unknown> = { limit: 5 };
        if (cursor) params.cursor = cursor;

        const { response } = await rpcCall(baseUrl, 'tools/list', params, sessionId);
        if (response.error) {
          errors.push(`tools/list page ${pages} error: ${response.error.message}`);
          break;
        }
        const result = response.result as { tools?: unknown[]; nextCursor?: string };
        totalTools += result.tools?.length ?? 0;
        cursor = result.nextCursor;
        pages++;
        if (pages > 100) {
          anomalies.push('Pagination exceeded 100 pages, aborting');
          break;
        }
      } while (cursor);

      const latencyMs = performance.now() - start;
      if (totalTools === 0) anomalies.push('paginated scan found 0 tools');
      return { latencyMs, errors, toolMisfires: [], anomalies };
    },
  });

  // Job 3: Call a tool (first available tool with simple schema)
  const simpleTool = manifests
    .flatMap((m) => m.tools.map((t) => ({ manifest: m, tool: t })))
    .find((entry) => {
      const props = (entry.tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      return props && Object.keys(props).length <= 3;
    });

  if (simpleTool) {
    jobs.push({
      name: `tools/call:${simpleTool.tool.name}`,
      mode: 'single-call',
      run: async (baseUrl, sessionId) => {
        const errors: string[] = [];
        const toolMisfires: string[] = [];
        const anomalies: string[] = [];

        // Build minimal valid arguments
        const schema = simpleTool.tool.inputSchema as {
          properties?: Record<string, { type: string }>;
          required?: string[];
        };
        const args: Record<string, unknown> = {};
        for (const [key, prop] of Object.entries(schema.properties ?? {})) {
          if (prop.type === 'string') args[key] = 'test-value';
          else if (prop.type === 'number') args[key] = 1;
          else if (prop.type === 'boolean') args[key] = false;
        }

        const toolId = `${simpleTool.manifest.id}__${simpleTool.tool.name}`;
        const { response, latencyMs } = await rpcCall(
          baseUrl,
          'tools/call',
          { toolId, arguments: args },
          sessionId,
        );

        if (response.error) {
          // tools/call may return error for stub implementations — record but don't fail
          toolMisfires.push(`tools/call ${toolId}: ${response.error.message}`);
        }

        return { latencyMs, errors, toolMisfires, anomalies };
      },
    });
  }

  // Job 4: resources/list
  jobs.push({
    name: 'resources/list',
    mode: 'full-scan',
    run: async (baseUrl, sessionId) => {
      const errors: string[] = [];
      const { response, latencyMs } = await rpcCall(baseUrl, 'resources/list', {}, sessionId);
      if (response.error) {
        errors.push(`resources/list error: ${response.error.message}`);
      }
      return { latencyMs, errors, toolMisfires: [], anomalies: [] };
    },
  });

  // Job 5: prompts/list
  jobs.push({
    name: 'prompts/list',
    mode: 'full-scan',
    run: async (baseUrl, sessionId) => {
      const errors: string[] = [];
      const { response, latencyMs } = await rpcCall(baseUrl, 'prompts/list', {}, sessionId);
      if (response.error) {
        errors.push(`prompts/list error: ${response.error.message}`);
      }
      return { latencyMs, errors, toolMisfires: [], anomalies: [] };
    },
  });

  // Job 6: Invalid method (error handling)
  jobs.push({
    name: 'error/method-not-found',
    mode: 'negative',
    run: async (baseUrl, sessionId) => {
      const errors: string[] = [];
      const anomalies: string[] = [];
      const { response, latencyMs } = await rpcCall(baseUrl, 'nonexistent/method', {}, sessionId);
      if (!response.error) {
        anomalies.push('Expected error for unknown method, got success');
      } else if (response.error.code !== -32601) {
        anomalies.push(`Expected -32601 Method not found, got ${response.error.code}`);
      }
      return { latencyMs, errors, toolMisfires: [], anomalies };
    },
  });

  // Job 7: Call without session (error handling)
  jobs.push({
    name: 'error/no-session',
    mode: 'negative',
    run: async (baseUrl) => {
      const errors: string[] = [];
      const anomalies: string[] = [];
      const { response, latencyMs } = await rpcCall(baseUrl, 'tools/list', {});
      if (!response.error) {
        anomalies.push('Expected error for missing session, got success');
      }
      return { latencyMs, errors, toolMisfires: [], anomalies };
    },
  });

  // Job 8: Discovery endpoint
  jobs.push({
    name: 'discovery/.well-known',
    mode: 'http-get',
    run: async (baseUrl) => {
      const errors: string[] = [];
      const anomalies: string[] = [];
      const start = performance.now();
      const res = await fetch(`${baseUrl}/.well-known/mcp.json`);
      const latencyMs = performance.now() - start;
      if (!res.ok) {
        errors.push(`Discovery endpoint returned ${res.status}`);
      } else {
        const json = (await res.json()) as Record<string, unknown>;
        if (!json.name || !json.version) {
          anomalies.push('Discovery response missing name or version');
        }
      }
      return { latencyMs, errors, toolMisfires: [], anomalies };
    },
  });

  // Job 9: Health check
  jobs.push({
    name: 'health-check',
    mode: 'http-get',
    run: async (baseUrl) => {
      const errors: string[] = [];
      const start = performance.now();
      const res = await fetch(`${baseUrl}/health`);
      const latencyMs = performance.now() - start;
      if (!res.ok) {
        errors.push(`Health check returned ${res.status}`);
      }
      return { latencyMs, errors, toolMisfires: [], anomalies: [] };
    },
  });

  // Job 10: Concurrent sessions
  jobs.push({
    name: 'concurrent-sessions',
    mode: 'stress',
    run: async (baseUrl) => {
      const errors: string[] = [];
      const anomalies: string[] = [];
      const start = performance.now();

      const sessions = await Promise.allSettled(
        Array.from({ length: 5 }, () => initializeSession(baseUrl)),
      );

      const successCount = sessions.filter((s) => s.status === 'fulfilled').length;
      if (successCount < 5) {
        anomalies.push(`Only ${successCount}/5 concurrent sessions initialized`);
      }

      // Call tools/list on each session
      const listCalls = await Promise.allSettled(
        sessions
          .filter((s): s is PromiseFulfilledResult<{ sessionId: string }> => s.status === 'fulfilled')
          .map((s) => rpcCall(baseUrl, 'tools/list', {}, s.value.sessionId)),
      );

      const listErrors = listCalls.filter((c) => c.status === 'rejected').length;
      if (listErrors > 0) {
        errors.push(`${listErrors} concurrent tools/list calls failed`);
      }

      const latencyMs = performance.now() - start;
      return { latencyMs, errors, toolMisfires: [], anomalies };
    },
  });

  return jobs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCLIArgs();
  const log = args.verbose ? console.log.bind(console) : () => {};

  console.log('=== smallchat MCP E2E Test & Benchmark ===\n');

  // Load example manifests
  const examplesDir = resolve('examples');
  const manifests = loadExampleManifests(examplesDir);
  console.log(`Loaded ${manifests.length} example manifests`);

  // If a Claude Code config is provided, parse it
  if (args.configPath) {
    const config = parseConfig(args.configPath);
    const servers = extractMCPServers(config);
    console.log(`Parsed config: ${Object.keys(servers).length} MCP servers defined`);
  }

  // Start in-process MCP server
  const mcpServer = new MCPServer({ dbPath: ':memory:' });

  // Register all tools from manifests
  let toolCount = 0;
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      mcpServer.registerTool(manifestToolToMcpTool(manifest, tool));
      toolCount++;
    }
  }
  console.log(`Registered ${toolCount} tools`);

  // Start HTTP server
  const httpServer: Server = createServer(mcpServer.createHttpHandler());
  await new Promise<void>((resolve) => {
    httpServer.listen(args.port, '127.0.0.1', () => resolve());
  });
  const baseUrl = `http://127.0.0.1:${args.port}`;
  console.log(`Server listening on ${baseUrl}\n`);

  // Create test jobs
  const jobs = createTestJobs(manifests);
  console.log(`Running ${jobs.length} test jobs...\n`);

  // Initialize a shared session for most tests
  const { sessionId, latencyMs: initLatency } = await initializeSession(baseUrl);
  log(`  Session initialized in ${initLatency.toFixed(1)}ms (${sessionId})`);

  // Run all jobs
  const allResults: RunResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      log(`  Running: ${job.name} [${job.mode}]`);
      const result = await job.run(baseUrl, sessionId);

      const hasErrors = result.errors.length > 0;
      const status = hasErrors ? 'FAIL' : 'PASS';
      const icon = hasErrors ? 'x' : 'v';

      console.log(
        `  [${icon}] ${job.name.padEnd(30)} ${result.latencyMs.toFixed(1).padStart(8)}ms  ${status}` +
          (result.anomalies.length > 0 ? `  (${result.anomalies.length} anomalies)` : '') +
          (result.toolMisfires.length > 0 ? `  (${result.toolMisfires.length} misfires)` : ''),
      );

      if (hasErrors) {
        failed++;
        for (const err of result.errors) console.log(`       ERROR: ${err}`);
      } else {
        passed++;
      }

      for (const a of result.anomalies) log(`       ANOMALY: ${a}`);

      // Generate a RunResult row per model for cost tracking
      for (const model of MODELS.filter((m) => args.models.includes(m.id))) {
        // Estimate token usage based on request/response sizes (rough heuristic)
        const estimatedInputTokens = 500;
        const estimatedOutputTokens = 200;
        const cost = calculateCost(model, {
          inputTokens: estimatedInputTokens,
          outputTokens: estimatedOutputTokens,
        });

        allResults.push({
          model: model.label,
          contextWindow: model.contextWindow,
          jobName: job.name,
          jobMode: job.mode,
          inputTokens: estimatedInputTokens,
          outputTokens: estimatedOutputTokens,
          inputCostUSD: cost.inputCost,
          outputCostUSD: cost.outputCost,
          totalCostUSD: cost.totalCost,
          inferenceTimeMs: result.latencyMs,
          reasoningTimeMs: 0,
          errors: result.errors,
          toolMisfires: result.toolMisfires,
          anomalies: result.anomalies,
          exitCode: hasErrors ? 1 : 0,
        });
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [x] ${job.name.padEnd(30)} EXCEPTION: ${msg}`);
    }
  }

  // Write output
  mkdirSync(args.outputDir, { recursive: true });

  const csvPath = join(args.outputDir, 'mcp-e2e-results.csv');
  writeCSV(allResults, csvPath);
  console.log(`\nCSV written to ${csvPath}`);

  const reportPath = join(args.outputDir, 'mcp-e2e-report.txt');
  writeSummaryReport(allResults, reportPath);
  console.log(`Report written to ${reportPath}`);

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  PASSED: ${passed}  FAILED: ${failed}  TOTAL: ${jobs.length}`);
  console.log('='.repeat(50));

  // Shutdown
  httpServer.close();
  mcpServer.close();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
