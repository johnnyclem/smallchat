#!/usr/bin/env node
/**
 * Compile every examples/*-manifest.json into one artifact with the default
 * embedder (ONNX all-MiniLM-L6-v2), then run `smallchat replay` on it with
 * the golden traces in examples/traces/. Exits with replay's code: 0 every
 * case passed, 1 a mismatch, 2 could not run. Extra arguments (e.g. --json)
 * are passed to replay.
 *
 * Needs a build (`npm run build`); CI runs it after "Build core".
 *
 *   npm run test:traces
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const { ToolCompiler } = await import(join(dist, 'compiler/compiler.js'));
const { MemoryVectorIndex } = await import(join(dist, 'embedding/memory-vector-index.js'));
const { buildArtifact } = await import(join(dist, 'artifact/format.js'));
const { writeArtifact } = await import(join(dist, 'artifact/io.js'));
const { createEmbedder, fingerprintOf } = await import(join(dist, 'artifact/embedder.js'));

const examples = join(root, 'examples');
const manifests = readdirSync(examples)
  .filter(name => name.endsWith('-manifest.json'))
  .sort()
  .map(name => JSON.parse(readFileSync(join(examples, name), 'utf-8')));

const dir = mkdtempSync(join(tmpdir(), 'smallchat-traces-'));
let status = 2;
try {
  const embedder = await createEmbedder();
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
  const artifact = join(dir, 'examples.toolkit.json');
  await writeArtifact(artifact, buildArtifact(result, manifests, fingerprintOf(embedder)));
  console.error(`Compiled ${manifests.length} example manifests (${result.toolCount} tools) → ${artifact}`);

  const replay = spawnSync(
    process.execPath,
    [join(dist, 'cli/index.js'), 'replay', artifact, join(examples, 'traces'), ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: root },
  );
  status = replay.status ?? 2;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
