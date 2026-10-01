/**
 * `smallchat setup` (SC-SURF-02, SC-SURF-03): adds a smallchat entry next
 * to the user's servers instead of replacing them, keeps every backup,
 * launches the scoped package over stdio, and verifies what it writes.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSmallchatEntry, serversToCompile, smallchatServerEntry, verifyServeEntry } from './setup.js';
import { packageVersion } from '../package-info.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');
const FIXTURE = join(REPO, 'src', 'mcp', '__fixtures__', 'upstream-server.mjs');

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc6-setup-'));
  dirs.push(dir);
  return dir;
}

const fixtureServer = { command: process.execPath, args: [FIXTURE] };

function writeConfig(dir: string, config: unknown): string {
  const path = join(dir, '.mcp.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

/**
 * Run the CLI, answering prompts as they appear: "Enter choice" with
 * `choice`, each "(y/n)" with the next of `answers`.
 */
function runSetup(cwd: string, args: string[], prompts: { choice?: string; answers?: string[] } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const home = join(cwd, 'home');
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', 'setup', ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const answers = [...(prompts.answers ?? [])];
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      pending += text;
      if (pending.includes('Enter choice') && prompts.choice) {
        pending = '';
        child.stdin.write(`${prompts.choice}\n`);
      } else if (pending.includes('(y/n)')) {
        pending = '';
        child.stdin.write(`${answers.shift() ?? 'n'}\n`);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 110_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('smallchat setup (interactive)', () => {
  it('adds smallchat next to the existing servers instead of replacing them, with a scoped launcher', async () => {
    const dir = tmp();
    const original = { mcpServers: { alpha: fixtureServer, beta: fixtureServer }, otherSetting: true };
    const config = writeConfig(dir, original);

    // auto-detect → compile? y → add smallchat? y → disable originals? n
    const { code, stdout, stderr } = await runSetup(dir, [], { choice: '1', answers: ['y', 'y', 'n'] });
    expect(code, stdout + stderr).toBe(0);

    const written = JSON.parse(readFileSync(config, 'utf-8'));
    expect(Object.keys(written.mcpServers).sort()).toEqual(['alpha', 'beta', 'smallchat']);
    expect(written.mcpServers.alpha).toEqual(fixtureServer);
    expect(written.otherSetting).toBe(true);

    const entry = written.mcpServers.smallchat;
    expect(entry.args[0]).not.toBe('smallchat');
    expect(entry).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', `@smallchat/core@${packageVersion()}`, 'serve', '--source', join(dir, 'tools.toolkit.json')],
    });

    const backups = readdirSync(dir).filter(f => f.startsWith('.mcp.json.smallchat-backup-'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, backups[0]), 'utf-8'))).toEqual(original);
  }, 120_000);
});

describe('smallchat setup --no-interactive', () => {
  it('installs with --install, moves originals aside with --disable-originals, and never reintrospects itself', async () => {
    const dir = tmp();
    const config = writeConfig(dir, { mcpServers: { alpha: fixtureServer, beta: fixtureServer } });
    const args = ['--no-interactive', '--config', config, '--install', '--disable-originals', '--embedder', 'hash'];

    const first = await runSetup(dir, args);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    let written = JSON.parse(readFileSync(config, 'utf-8'));
    expect(Object.keys(written.mcpServers)).toEqual(['smallchat']);
    expect(Object.keys(written.smallchatDisabledMcpServers).sort()).toEqual(['alpha', 'beta']);

    // A second run compiles the disabled originals again (not smallchat itself)
    // and keeps the first backup.
    const second = await runSetup(dir, args);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).not.toMatch(/server: smallchat/);
    written = JSON.parse(readFileSync(config, 'utf-8'));
    expect(Object.keys(written.smallchatDisabledMcpServers).sort()).toEqual(['alpha', 'beta']);
    expect(readdirSync(dir).filter(f => f.startsWith('.mcp.json.smallchat-backup-'))).toHaveLength(2);
  }, 120_000);

  it('does not write the config without --install', async () => {
    const dir = tmp();
    const config = writeConfig(dir, { mcpServers: { alpha: fixtureServer } });
    const before = readFileSync(config, 'utf-8');
    const { code } = await runSetup(dir, ['--no-interactive', '--config', config, '--embedder', 'hash']);
    expect(code).toBe(0);
    expect(readFileSync(config, 'utf-8')).toBe(before);
    expect(existsSync(join(dir, 'tools.toolkit.json'))).toBe(true);
  }, 120_000);
});

describe('installSmallchatEntry', () => {
  const now = new Date('2026-10-01T12:34:56.789Z');

  it('never overwrites a backup', () => {
    const dir = tmp();
    const config = writeConfig(dir, { mcpServers: { a: fixtureServer } });
    const first = installSmallchatEntry(config, join(dir, 'tools.toolkit.json'), { now });
    const second = installSmallchatEntry(config, join(dir, 'tools.toolkit.json'), { now });
    expect(first.backupPath).not.toBe(second.backupPath);
    expect(JSON.parse(readFileSync(first.backupPath, 'utf-8'))).toEqual({ mcpServers: { a: fixtureServer } });
  });

  it.skipIf(process.platform === 'win32')('gives the backup the config\'s own permissions (it may hold tokens)', () => {
    const dir = tmp();
    const config = writeConfig(dir, { mcpServers: { a: { command: 'x', env: { TOKEN: 'secret' } } } });
    chmodSync(config, 0o600);
    const { backupPath } = installSmallchatEntry(config, join(dir, 't.json'), { now });
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it('refuses a config it cannot parse and leaves it untouched', () => {
    const dir = tmp();
    const config = join(dir, '.mcp.json');
    writeFileSync(config, '{ "mcpServers": { "a": {} }, }');
    expect(() => installSmallchatEntry(config, join(dir, 't.json'), { now })).toThrow(/JSON/);
    expect(readFileSync(config, 'utf-8')).toBe('{ "mcpServers": { "a": {} }, }');
  });

  it('works on nested mcpServers and keeps every other key', () => {
    const dir = tmp();
    const config = writeConfig(dir, { editor: { fontSize: 12, mcpServers: { a: fixtureServer } }, theme: 'dark' });
    const result = installSmallchatEntry(config, join(dir, 't.json'), { now, disableOriginals: true });
    const written = JSON.parse(readFileSync(config, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.editor.fontSize).toBe(12);
    expect(Object.keys(written.editor.mcpServers)).toEqual(['smallchat']);
    expect(written.editor.smallchatDisabledMcpServers).toEqual({ a: fixtureServer });
    expect(result.disabled).toEqual(['a']);
  });

  it('can launch through an absolute node path instead of npx', () => {
    const entry = smallchatServerEntry('/abs/tools.toolkit.json', { launcher: 'node', cliPath: '/opt/smallchat/dist/cli/index.js' });
    expect(entry).toEqual({ type: 'stdio', command: process.execPath, args: ['/opt/smallchat/dist/cli/index.js', 'serve', '--source', '/abs/tools.toolkit.json'] });
  });
});

describe('serversToCompile', () => {
  it('leaves out smallchat itself and brings back servers it disabled', () => {
    const servers = serversToCompile({
      mcpServers: { smallchat: { command: 'npx' }, live: fixtureServer },
      smallchatDisabledMcpServers: { old: fixtureServer },
    });
    expect(Object.keys(servers).sort()).toEqual(['live', 'old']);
  });
});

describe('verifyServeEntry', () => {
  it('completes initialize and lists tools over stdio', async () => {
    const tools = await verifyServeEntry({ command: process.execPath, args: [FIXTURE] }, { timeoutMs: 15_000 });
    expect(tools).toContain('echo');
  }, 30_000);

  it('fails for an entry that does not speak MCP on stdout', async () => {
    await expect(verifyServeEntry({ command: process.execPath, args: ['-e', 'console.log("Loading toolkit..."); setTimeout(() => {}, 5000)'] }, { timeoutMs: 1_500 }))
      .rejects.toThrow();
  }, 30_000);
});
