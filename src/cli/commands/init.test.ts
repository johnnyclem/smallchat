/**
 * `smallchat init` (SC-SURF-31): --no-git / --no-install do what they say,
 * the basic template dispatches against its own manifest, and next steps
 * never suggest the unscoped `npx smallchat`.
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

function init(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', 'init', ...args], { timeout: 60_000 }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stdout, stderr });
    });
  });
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
    expect(stdout).not.toMatch(/npx smallchat/);
  }, 60_000);
});
