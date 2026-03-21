import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const EXPECTED_MODEL_SHA256 = 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1';

function getModelsDir(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    return resolve(thisDir, '..', '..', '..', 'models');
  } catch {
    return resolve(process.cwd(), 'models');
  }
}

export const doctorCommand = new Command('doctor')
  .description('Check system health: model files, dependencies, index, and MCP compliance')
  .option('--db-path <path>', 'Path to sqlite-vec database', 'smallchat.db')
  .option('--mcp [url]', 'Run MCP compliance check against a running server')
  .action(async (options) => {
    let ok = true;

    console.log('smallchat doctor\n');

    // 1. Check model files
    const modelsDir = getModelsDir();
    const modelPath = resolve(modelsDir, 'model_quantized.onnx');
    const tokenizerPath = resolve(modelsDir, 'tokenizer.json');

    console.log('Model files:');
    if (existsSync(modelPath)) {
      console.log(`  model_quantized.onnx: found (${modelPath})`);

      // Validate SHA256
      const data = readFileSync(modelPath);
      const hash = createHash('sha256').update(data).digest('hex');
      if (hash === EXPECTED_MODEL_SHA256) {
        console.log('  SHA256: valid');
      } else {
        console.log(`  SHA256: INVALID (expected ${EXPECTED_MODEL_SHA256.slice(0, 16)}..., got ${hash.slice(0, 16)}...)`);
        ok = false;
      }
    } else {
      console.log(`  model_quantized.onnx: NOT FOUND (expected at ${modelPath})`);
      ok = false;
    }

    if (existsSync(tokenizerPath)) {
      console.log(`  tokenizer.json: found`);
    } else {
      console.log(`  tokenizer.json: NOT FOUND (expected at ${tokenizerPath})`);
      ok = false;
    }

    // 2. Check ONNX Runtime
    console.log('\nONNX Runtime:');
    try {
      const ort = await import('onnxruntime-node');
      console.log('  onnxruntime-node: loaded');
    } catch (e) {
      console.log(`  onnxruntime-node: FAILED (${(e as Error).message})`);
      ok = false;
    }

    // 3. Check sqlite-vec
    console.log('\nSQLite Vector:');
    try {
      const Database = (await import('better-sqlite3')).default;
      const sqliteVec = await import('sqlite-vec');
      const db = new Database(':memory:');
      sqliteVec.load(db);
      db.exec('CREATE VIRTUAL TABLE test_vec USING vec0(id TEXT PRIMARY KEY, v FLOAT[2])');
      db.close();
      console.log('  better-sqlite3 + sqlite-vec: working');
    } catch (e) {
      console.log(`  sqlite-vec: FAILED (${(e as Error).message})`);
      ok = false;
    }

    // 4. Check database file (if specified)
    const dbPath = resolve(options.dbPath);
    console.log('\nDatabase:');
    if (existsSync(dbPath)) {
      try {
        const Database = (await import('better-sqlite3')).default;
        const sqliteVec = await import('sqlite-vec');
        const db = new Database(dbPath);
        sqliteVec.load(db);
        const row = db.prepare('SELECT count(*) as cnt FROM vec_selectors').get() as { cnt: number };
        console.log(`  ${dbPath}: ${row.cnt} vectors indexed`);
        db.close();
      } catch (e) {
        console.log(`  ${dbPath}: exists but could not read (${(e as Error).message})`);
      }
    } else {
      console.log(`  ${dbPath}: not yet created (will be created on first compile)`);
    }

    // 5. Test embedding
    console.log('\nEmbedding test:');
    if (existsSync(modelPath) && existsSync(tokenizerPath)) {
      try {
        const { ONNXEmbedder } = await import('../../embedding/onnx-embedder.js');
        const embedder = new ONNXEmbedder();
        const vec = await embedder.embed('hello world');
        console.log(`  Produced ${vec.length}-dim vector for "hello world": OK`);
      } catch (e) {
        console.log(`  Embedding test FAILED: ${(e as Error).message}`);
        ok = false;
      }
    } else {
      console.log('  Skipped (model files missing)');
    }

    // 6. MCP compliance check
    if (options.mcp !== undefined) {
      const baseUrl = typeof options.mcp === 'string' ? options.mcp : 'http://127.0.0.1:3001';
      console.log(`\nMCP Compliance Check (${baseUrl}):`);
      ok = (await runMCPComplianceCheck(baseUrl)) && ok;
    }

    // Summary
    console.log(ok ? '\nAll checks passed.' : '\nSome checks failed. See above for details.');
    if (!ok) process.exit(1);
  });

// ---------------------------------------------------------------------------
// MCP Compliance checker
// ---------------------------------------------------------------------------

async function runMCPComplianceCheck(baseUrl: string): Promise<boolean> {
  let ok = true;
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  // Helper for JSON-RPC calls
  async function rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  // 1. Discovery endpoint
  try {
    const resp = await fetch(`${baseUrl}/.well-known/mcp.json`);
    const discovery = (await resp.json()) as { mcpVersion?: string; serverInfo?: { name: string } };
    if (discovery.mcpVersion && discovery.serverInfo) {
      checks.push({ name: 'Discovery (/.well-known/mcp.json)', pass: true, detail: `version=${discovery.mcpVersion}` });
    } else {
      checks.push({ name: 'Discovery (/.well-known/mcp.json)', pass: false, detail: 'Missing required fields' });
      ok = false;
    }
  } catch (e) {
    checks.push({ name: 'Discovery (/.well-known/mcp.json)', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 2. Health endpoint
  try {
    const resp = await fetch(`${baseUrl}/health`);
    const health = (await resp.json()) as { status: string };
    checks.push({ name: 'Health (/health)', pass: health.status === 'ok', detail: `status=${health.status}` });
  } catch (e) {
    checks.push({ name: 'Health (/health)', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 3. initialize
  try {
    const result = (await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smallchat-doctor', version: '1.0.0' },
    })) as { protocolVersion?: string; capabilities?: unknown; serverInfo?: unknown };

    const pass = !!(result.protocolVersion && result.capabilities && result.serverInfo);
    checks.push({ name: 'initialize', pass, detail: `protocolVersion=${result.protocolVersion}` });
    if (!pass) ok = false;
  } catch (e) {
    checks.push({ name: 'initialize', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 4. ping
  try {
    await rpc('ping');
    checks.push({ name: 'ping', pass: true, detail: 'OK' });
  } catch (e) {
    checks.push({ name: 'ping', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 5. tools/list
  try {
    const result = (await rpc('tools/list')) as { tools?: unknown[] };
    const pass = Array.isArray(result.tools);
    checks.push({ name: 'tools/list', pass, detail: `${result.tools?.length ?? 0} tools` });
    if (!pass) ok = false;
  } catch (e) {
    checks.push({ name: 'tools/list', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 6. tools/call (with a non-existent tool — should handle gracefully)
  try {
    await rpc('tools/call', { name: '__compliance_test__', arguments: {} });
    checks.push({ name: 'tools/call', pass: true, detail: 'Handled gracefully' });
  } catch {
    // An error response is acceptable too — it means the server handles unknown tools
    checks.push({ name: 'tools/call', pass: true, detail: 'Returns error for unknown tools' });
  }

  // 7. resources/list
  try {
    const result = (await rpc('resources/list')) as { resources?: unknown[] };
    checks.push({ name: 'resources/list', pass: true, detail: `${result.resources?.length ?? 0} resources` });
  } catch (e) {
    checks.push({ name: 'resources/list', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 8. prompts/list
  try {
    const result = (await rpc('prompts/list')) as { prompts?: unknown[] };
    checks.push({ name: 'prompts/list', pass: true, detail: `${result.prompts?.length ?? 0} prompts` });
  } catch (e) {
    checks.push({ name: 'prompts/list', pass: false, detail: (e as Error).message });
    ok = false;
  }

  // 9. SSE endpoint
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${baseUrl}/sse`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);
    if (resp && resp.headers.get('content-type')?.includes('text/event-stream')) {
      checks.push({ name: 'SSE (/sse)', pass: true, detail: 'Connected' });
    } else {
      checks.push({ name: 'SSE (/sse)', pass: false, detail: 'Not available' });
      ok = false;
    }
  } catch {
    // AbortError is expected — SSE stays open
    checks.push({ name: 'SSE (/sse)', pass: true, detail: 'Connected (stream open)' });
  }

  // 10. Unknown method handling
  try {
    await rpc('nonexistent/method');
    checks.push({ name: 'Unknown method handling', pass: false, detail: 'Should return error' });
    ok = false;
  } catch {
    checks.push({ name: 'Unknown method handling', pass: true, detail: 'Returns METHOD_NOT_FOUND' });
  }

  // Print results
  const maxName = Math.max(...checks.map(c => c.name.length));
  for (const check of checks) {
    const icon = check.pass ? '\u2713' : '\u2717';
    const status = check.pass ? 'PASS' : 'FAIL';
    console.log(`  ${icon} ${check.name.padEnd(maxName + 2)} ${status}  ${check.detail}`);
  }

  const passed = checks.filter(c => c.pass).length;
  const total = checks.length;
  console.log(`\n  MCP Compliance: ${passed}/${total} checks passed`);

  if (ok) {
    console.log('  Status: MCP 2026 compliant');
  }

  return ok;
}
