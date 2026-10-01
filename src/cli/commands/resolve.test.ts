/**
 * Feature: `smallchat resolve` uses the runtime's resolution, and
 * `--execute` runs only a HIGH/EXACT match unless --force (SC-SURF-23).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionGate } from './resolve.js';
import { introspectMcpConfigFile } from '../../mcp/client.js';
import { ToolCompiler } from '../../compiler/compiler.js';
import { HashEmbedder } from '../../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';
import { buildArtifact } from '../../artifact/format.js';
import { writeArtifact } from '../../artifact/io.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');
const FIXTURE = join(REPO, 'src', 'mcp', '__fixtures__', 'upstream-server.mjs');

const candidate = (toolId: string) => ({ toolId, selector: toolId, score: 0.7, similarity: 0.7, tier: 'medium' as const, source: 'vector' as const });

describe('executionGate', () => {
  it('runs a resolved EXACT or HIGH match', () => {
    expect(executionGate({ outcome: 'resolved', tier: 'exact', chosen: 'a/b', candidates: [] })).toEqual({ run: true, toolId: 'a/b', forced: false });
    expect(executionGate({ outcome: 'resolved', tier: 'high', chosen: 'a/b', candidates: [] })).toMatchObject({ run: true });
  });

  it('refuses anything else without --force', () => {
    const medium = executionGate({ outcome: 'resolved', tier: 'medium', chosen: 'a/b', candidates: [] });
    expect(medium).toMatchObject({ run: false });
    expect((medium as { reason: string }).reason).toContain('MEDIUM tier');
    expect(executionGate({ outcome: 'needs-disambiguation', tier: 'medium', candidates: [candidate('a/b')] })).toMatchObject({ run: false });
    expect(executionGate({ outcome: 'unresolved', tier: 'none', candidates: [] })).toMatchObject({ run: false });
  });

  it('with --force runs the chosen tool or the top candidate', () => {
    expect(executionGate({ outcome: 'resolved', tier: 'low', chosen: 'a/b', candidates: [] }, { force: true })).toEqual({ run: true, toolId: 'a/b', forced: true });
    expect(executionGate({ outcome: 'needs-disambiguation', tier: 'medium', candidates: [candidate('c/d'), candidate('e/f')] }, { force: true }))
      .toEqual({ run: true, toolId: 'c/d', forced: true });
    expect(executionGate({ outcome: 'unresolved', tier: 'none', candidates: [] }, { force: true })).toMatchObject({ run: false });
  });
});

describe('smallchat resolve --execute (CLI)', () => {
  let dir: string;
  let artifact: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sc4-resolve-'));
    const cfg = join(dir, '.mcp.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } } }));
    const manifests = await introspectMcpConfigFile(cfg);
    const embedder = new HashEmbedder(64);
    const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
    artifact = join(dir, 'tools.toolkit.json');
    await writeArtifact(artifact, buildArtifact(result, manifests, embedder.fingerprint));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolvePromise => {
      execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', ...args], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => {
        resolvePromise({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr });
      });
    });
  }

  it('runs an EXACT match on the upstream server', async () => {
    const run = await cli('resolve', artifact, 'echo: Echo the given text back unchanged', '--execute', '--args', '{"text":"ran"}', '--json');
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.resolution).toMatchObject({ outcome: 'resolved', tier: 'exact', chosen: 'fixture/echo' });
    expect(out.result.content).toEqual([{ type: 'text', text: 'ran' }]);
  }, 60_000);

  it('refuses a weak match and runs nothing', async () => {
    const run = await cli('resolve', artifact, 'book a flight to Lisbon', '--execute', '--args', '{"text":"x"}');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Nothing was executed');
    expect(run.stdout).not.toContain('Executing');
  }, 60_000);
});
