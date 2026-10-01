/**
 * `smallchat init` (SC-SURF-31): --no-git / --no-install do what they say,
 * the basic template dispatches against its own manifest, and next steps
 * never suggest running the unscoped `smallchat` name through npx.
 *
 * Review of SC-SURF-31: the mcp-server template served manifest tools that
 * no handler ran (every tools/call returned "No local handler registered
 * for greet"), and wrote sample tools outside tsconfig's rootDir that no
 * manifest declared; the agent template dispatched against an empty
 * runtime, so every intent printed only "Resolving... Done."; and every
 * template wrote a smallchat.config.json nothing reads. Each template's
 * entry now runs against this tree and makes a successful call
 * (scripts/pack-smoke.mjs builds them against the packed package).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');
// Maps @smallchat/core to this tree's src/index.ts for a scaffold's entry.
const VITEST_CONFIG = join(REPO, 'vitest.config.ts');
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

/** Run a scaffold's TypeScript entry (what `npm start` runs once built) against this tree. */
function runEntry(project: string, entry: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [VITE_NODE, '--root', REPO, '--config', VITEST_CONFIG, entry], { timeout: 60_000, cwd: project }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stdout, stderr });
    });
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]);
}

describe('smallchat init templates make a successful call', () => {
  for (const template of ['basic', 'mcp-server', 'agent']) {
    it(`${template}: every source file is under src/ and no unread config is written`, async () => {
      const project = join(tmp(), template.replace('-', ''));
      expect((await init([project, '--template', template, '--no-git', '--no-install'])).code).toBe(0);
      expect(existsSync(join(project, 'smallchat.config.json'))).toBe(false);
      const sources = filesUnder(project).filter((f) => f.endsWith('.ts')).map((f) => relative(project, f));
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.filter((f) => !f.startsWith('src/'))).toEqual([]);
    }, 60_000);
  }

  it('basic: resolves an intent and runs the tool', async () => {
    const project = join(tmp(), 'basicrun');
    expect((await init([project, '--no-git', '--no-install'])).code).toBe(0);
    const run = await runEntry(project, 'src/index.ts');
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('Result: Hello, World! Welcome to smallchat.');
  }, 120_000);

  it('mcp-server: an MCP client calls a scaffolded tool over stdio', async () => {
    const project = join(tmp(), 'mcpserver');
    expect((await init([project, '--template', 'mcp-server', '--no-git', '--no-install'])).code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf-8'));
    expect(pkg.scripts.start).toBe('node dist/server.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [VITE_NODE, '--root', REPO, '--config', VITEST_CONFIG, 'src/server.ts'],
      cwd: project,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'init-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['mcpserver__greet', 'mcpserver__echo']));
      const result = await client.callTool({ name: 'mcpserver__greet', arguments: { name: 'Ada' } });
      expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada! Welcome to smallchat.' }]);
    } finally {
      await client.close();
    }
  }, 120_000);

  it('agent: streams each sample request to a tool result, and refuses a request no tool matches', async () => {
    const project = join(tmp(), 'agentrun');
    expect((await init([project, '--template', 'agent', '--no-git', '--no-install'])).code).toBe(0);
    const run = await runEntry(project, 'src/agent.ts');
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('Tool: agentrun/greet');
    expect(run.stdout).toContain('Hi, Ada! Welcome to smallchat.');
    expect(run.stdout).toContain('Tool: agentrun/echo');
    expect(run.stdout).toContain('ping');
    expect(run.stdout).toMatch(/book a flight[\s\S]*(needs-disambiguation|unresolved|No tool)/);
  }, 120_000);
});
