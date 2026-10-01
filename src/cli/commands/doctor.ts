import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { diagnoseArtifact, formatDiagnosis } from '../../artifact/doctor.js';
import { runConformance, type ConformanceOptions, type ConformanceTarget } from '../../mcp/conformance.js';
import { DEFAULT_TOKEN_FILE } from '../../mcp/http-guard.js';

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
  .description('Check system health: model files, dependencies, index, compiled artifact, and MCP conformance')
  .option('--db-path <path>', 'Path to sqlite-vec database', 'smallchat.db')
  .option('--artifact <path>', 'Check a compiled artifact against its embedder and index, and report near-duplicate tools (default: ./tools.toolkit.json when present)')
  .option('--mcp [url]', 'Run the MCP conformance checks against a running `serve --http` (default http://127.0.0.1:3001/mcp)')
  .option('--token-file <path>', 'Bearer token for --mcp', DEFAULT_TOKEN_FILE)
  .option('--mcp-source <artifact>', 'Run the MCP conformance checks against `smallchat serve --source <artifact>` over stdio')
  .option('--mcp-call <tool>', 'With --mcp/--mcp-source: also call this tool end to end')
  .option('--mcp-args <json>', 'Arguments for --mcp-call', '{}')
  .option('--mcp-timeout <ms>', 'Per-check timeout', '10000')
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

    // 6. Artifact ↔ embedder ↔ index
    const artifactPath = options.artifact ?? (existsSync('tools.toolkit.json') ? 'tools.toolkit.json' : undefined);
    if (artifactPath) {
      const diagnosis = await diagnoseArtifact(resolve(artifactPath));
      console.log(`\n${formatDiagnosis(diagnosis)}`);
      ok = diagnosis.ok && ok;
    }

    // 7. MCP conformance check
    const target = mcpTarget(options);
    if (target) {
      console.log(`\nMCP conformance (${target.kind === 'http' ? target.url : `stdio: smallchat serve --source ${options.mcpSource}`}):`);
      let call: { name: string; arguments: Record<string, unknown> } | undefined;
      if (options.mcpCall) {
        try {
          call = { name: options.mcpCall, arguments: JSON.parse(options.mcpArgs) as Record<string, unknown> };
        } catch {
          console.log('  --mcp-args is not valid JSON');
          process.exit(1);
        }
      }
      ok = (await runMcpDoctor(target, { call, timeoutMs: parseInt(options.mcpTimeout, 10) })) && ok;
    }

    // Summary
    console.log(ok ? '\nAll checks passed.' : '\nSome checks failed. See above for details.');
    if (!ok) process.exit(1);
  });

// ---------------------------------------------------------------------------
// MCP conformance
// ---------------------------------------------------------------------------

/** The server `doctor --mcp` / `--mcp-source` should check, if any. */
function mcpTarget(options: { mcp?: string | boolean; mcpSource?: string; tokenFile: string }): ConformanceTarget | null {
  if (options.mcpSource) {
    // Spawn this same CLI as the MCP host would: `smallchat serve --source <artifact>` over stdio.
    return {
      kind: 'stdio',
      command: process.execPath,
      args: [...process.execArgv, process.argv[1], 'serve', '--source', resolve(options.mcpSource)],
    };
  }
  if (options.mcp === undefined) return null;
  const url = typeof options.mcp === 'string' ? options.mcp : 'http://127.0.0.1:3001/mcp';
  const tokenFile = resolve(options.tokenFile);
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf-8').trim() : undefined;
  return { kind: 'http', url, ...(token ? { token } : {}) };
}

/**
 * Run the shared conformance checks (src/mcp/conformance.ts — the same ones
 * the test suite runs) and print them. Returns whether every check passed.
 */
export async function runMcpDoctor(
  target: ConformanceTarget,
  options: ConformanceOptions = {},
  print: (line: string) => void = line => console.log(line),
): Promise<boolean> {
  const checks = await runConformance(target, options);
  const width = Math.max(...checks.map(c => c.name.length));
  for (const check of checks) {
    print(`  ${check.pass ? '\u2713' : '\u2717'} ${check.name.padEnd(width + 2)} ${check.pass ? 'PASS' : 'FAIL'}  ${check.detail}`);
  }
  const passed = checks.filter(c => c.pass).length;
  print(`\n  MCP conformance: ${passed}/${checks.length} checks passed`);
  return passed === checks.length;
}
