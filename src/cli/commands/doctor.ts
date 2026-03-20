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
  .description('Check system health: model files, dependencies, and index')
  .option('--db-path <path>', 'Path to sqlite-vec database', 'smallchat.db')
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

    // Summary
    console.log(ok ? '\nAll checks passed.' : '\nSome checks failed. See above for details.');
    if (!ok) process.exit(1);
  });
