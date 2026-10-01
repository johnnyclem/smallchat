/**
 * `smallchat memex compile` / `memex query` (SAT-16): the command built a
 * vector index with CommonJS require() inside an ES module, so both crashed
 * ("require is not defined" from dist/, MODULE_NOT_FOUND from source).
 *
 * Review of SAT-16: the knowledge base did not record its embedder, `query`
 * embedded with its own -e default (onnx) whatever the KB was compiled
 * with, so a KB compiled with -e local answered every question with "Tier:
 * NONE" and no warning; and any -e value other than "local" (including
 * "hash", the 1.0 name) silently meant ONNX.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', ...args], { timeout: 60_000, cwd }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stdout, stderr });
    });
  });
}

describe('smallchat memex and dream', () => {
  it('compiles a knowledge base and answers a query from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc7-memex-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'gondor.md'), '# Gondor\n\nGondor was a great kingdom of Men in Middle-earth.\nThe capital of Gondor was Minas Tirith.\n');
    writeFileSync(join(dir, 'memex.schema.json'), JSON.stringify({ name: 'kb', domain: 'lore', entityTypes: ['place'], sources: ['./docs'], compiler: { minConfidence: 0.3 } }));

    const compiled = await cli(['memex', 'compile', '-e', 'local'], dir);
    expect(compiled.stderr).not.toMatch(/require is not defined|MODULE_NOT_FOUND/);
    expect(compiled.code, compiled.stderr).toBe(0);
    expect(existsSync(join(dir, 'knowledge.memex.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'knowledge.memex.json'), 'utf-8')).stats.claimCount).toBeGreaterThan(0);

    const queried = await cli(['memex', 'query', 'What was the capital of Gondor?', '-e', 'local'], dir);
    expect(queried.code, queried.stderr).toBe(0);
    expect(queried.stdout).toMatch(/Tier: {2}(EXACT|HIGH|MEDIUM|LOW|NONE)/);
  }, 120_000);

  function gondor(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sc7-memex-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'gondor.md'), '# Gondor\n\nGondor was a great kingdom of Men in Middle-earth.\nThe capital of Gondor was Minas Tirith.\n');
    writeFileSync(join(dir, 'memex.schema.json'), JSON.stringify({ name: 'kb', domain: 'lore', entityTypes: ['place'], sources: ['./docs'], compiler: { minConfidence: 0.3 } }));
    return dir;
  }

  it('records the embedder in the knowledge base, and query uses it or refuses another', async () => {
    const dir = gondor();
    const compiled = await cli(['memex', 'compile', '-e', 'hash'], dir);
    expect(compiled.code, compiled.stderr).toBe(0);
    const kb = JSON.parse(readFileSync(join(dir, 'knowledge.memex.json'), 'utf-8'));
    expect(kb.embedder).toMatchObject({ kind: 'hash' });

    // No -e: the KB's own embedder answers.
    const queried = await cli(['memex', 'query', 'What was the capital of Gondor?'], dir);
    expect(queried.code, queried.stderr).toBe(0);
    expect(queried.stdout).toContain('Matched Claims:');
    expect(queried.stdout).toContain('Minas Tirith');

    // A different embedder is refused instead of answering from incomparable vectors.
    const mismatched = await cli(['memex', 'query', 'What was the capital of Gondor?', '-e', 'onnx'], dir);
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toMatch(/compiled with the hash embedder/);
  }, 120_000);

  it('accepts hash (and local as its alias) and refuses unknown embedder names', async () => {
    const dir = gondor();
    const unknown = await cli(['memex', 'compile', '-e', 'bogus'], dir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown embedder "bogus"/);
    expect((await cli(['memex', 'compile', '-e', 'local'], dir)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'knowledge.memex.json'), 'utf-8')).embedder).toMatchObject({ kind: 'hash' });
  }, 120_000);

  it('says it is experimental and documents only commands that exist', async () => {
    const help = await cli(['memex', '--help'], REPO);
    expect(help.stdout).toMatch(/experimental/i);
    expect(help.stdout).not.toMatch(/\bingest\b/);
    expect(readFileSync(join(REPO, 'src', 'cli', 'commands', 'memex.ts'), 'utf-8')).not.toMatch(/smallchat memex ingest/);
  }, 60_000);

  it('marks dream experimental too, with exclusions opt-in', async () => {
    const help = await cli(['dream', '--help'], REPO);
    expect(help.stdout).toMatch(/experimental/i);
    expect(help.stdout).toMatch(/--apply-proposed-exclusions/);
  }, 60_000);
});
