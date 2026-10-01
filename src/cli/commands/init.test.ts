/**
 * `smallchat init` (SC-SURF-31): --no-git / --no-install do what they say,
 * the basic template dispatches against its own manifest, and next steps
 * never suggest running the unscoped `smallchat` name through npx.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');
const HAS_GIT = spawnSync('git', ['--version']).status === 0;

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc6-init-'));
  dirs.push(dir);
  return dir;
}

function cli(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', ...args], { timeout: 60_000, ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stdout, stderr });
    });
  });
}

function init(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return cli(['init', ...args]);
}

describe('smallchat init', () => {
  it.skipIf(!HAS_GIT)('initializes a git repository unless --no-git', async () => {
    const project = join(tmp(), 'with-git');
    const { code, stdout } = await init([project, '--no-install']);
    expect(code, stdout).toBe(0);
    expect(existsSync(join(project, '.git'))).toBe(true);
  }, 60_000);

  it('skips git with --no-git and npm with --no-install', async () => {
    const project = join(tmp(), 'bare');
    const { code, stdout } = await init([project, '--no-git', '--no-install']);
    expect(code, stdout).toBe(0);
    expect(existsSync(join(project, '.git'))).toBe(false);
    expect(existsSync(join(project, 'node_modules'))).toBe(false);
    expect(existsSync(join(project, 'package.json'))).toBe(true);
    expect(stdout).toContain('npm install');
  }, 60_000);

  it('scaffolds a basic template that dispatches against its sample manifest', async () => {
    const project = join(tmp(), 'basic');
    const { code, stdout } = await init([project, '--no-git', '--no-install']);
    expect(code).toBe(0);
    const entry = readFileSync(join(project, 'src', 'index.ts'), 'utf-8');
    expect(entry).toContain("loadRuntime('./manifests')");
    expect(entry).toContain('registerLocalHandler');
    expect(entry).toContain('dispatchById');
    expect(entry).not.toMatch(/new ToolRuntime\(/);
    // Next steps run the locally installed CLI, never the unscoped npm name.
    expect(stdout).not.toMatch(/npx (-y )?smallchat\b/);
  }, 60_000);

  it('compiles the scaffold it wrote, with and without --source (each manifest once)', async () => {
    const project = join(tmp(), 'compiles');
    expect((await init([project, '--no-git', '--no-install'])).code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf-8'));
    expect(pkg.scripts.compile).toBe('smallchat compile --source ./manifests');
    // The scaffold depends on the 1.x line it was written for, with current config keys.
    expect(pkg.dependencies['@smallchat/core']).toMatch(/^\^1\./);
    const project_ = JSON.parse(readFileSync(join(project, 'smallchat.json'), 'utf-8'));
    expect(project_.compiler).toMatchObject({ duplicateThreshold: 0.95 });
    expect(project_.compiler.deduplicationThreshold).toBeUndefined();

    // What `npm run compile` runs (hash embedder: no model download in tests).
    const withSource = await cli(['compile', '--source', './manifests', '--embedder', 'hash'], project);
    expect(withSource.code, withSource.stdout + withSource.stderr).toBe(0);
    const artifact = JSON.parse(readFileSync(join(project, 'tools.toolkit.json'), 'utf-8'));
    expect(Object.keys(artifact.tools).sort()).toEqual(['compiles/echo', 'compiles/greet']);

    const autoDetected = await cli(['compile', '--embedder', 'hash'], project);
    expect(autoDetected.code, autoDetected.stdout + autoDetected.stderr).toBe(0);
  }, 120_000);
});
