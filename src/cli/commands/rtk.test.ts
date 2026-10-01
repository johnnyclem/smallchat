/**
 * `smallchat rtk setup --hook-only` (SC-SURF-16): never clobbers
 * .claude/settings.json, works in a fresh project, and installs a hook
 * that actually runs and speaks Claude Code's PreToolUse contract.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc6-rtk-'));
  dirs.push(dir);
  return dir;
}

function rtkSetup(cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', 'rtk', 'setup', '--hook-only'], { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stdout, stderr });
    });
  });
}

function settingsOf(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
}

/** Run the installed hook command the way Claude Code does (shell form, CLAUDE_PROJECT_DIR set). */
function runHook(dir: string, input: unknown): { status: number | null; stdout: string; stderr: string } {
  const command = settingsOf(dir).hooks.PreToolUse
    .flatMap((entry: { hooks: Array<{ command: string }> }) => entry.hooks)
    .map((h: { command: string }) => h.command)
    .find((c: string) => c.includes('smallchat-rtk'));
  expect(command).toBeDefined();
  const result = spawnSync('sh', ['-c', command], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf-8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('smallchat rtk setup --hook-only', () => {
  it('refuses to touch a settings.json it cannot parse, and keeps its deny rules', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    const original = '{\n  "permissions": { "deny": ["Bash(rm:*)"] },\n  "env": { "FOO": "1" },\n}\n';
    writeFileSync(join(dir, '.claude', 'settings.json'), original);

    const { code, stderr } = await rtkSetup(dir);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/settings\.json/);
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8')).toBe(original);
  }, 60_000);

  it('creates .claude/ in a fresh project', async () => {
    const dir = project();
    const { code } = await rtkSetup(dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(settingsOf(dir).hooks.PreToolUse).toHaveLength(1);
  }, 60_000);

  it('preserves every existing setting and installs the hook once', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { deny: ['Bash(rm:*)'], allow: ['Bash(git status:*)'] },
      env: { FOO: '1' },
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo other' }] }] },
    }));

    expect((await rtkSetup(dir)).code).toBe(0);
    expect((await rtkSetup(dir)).code).toBe(0);

    const settings = settingsOf(dir);
    expect(settings.permissions).toEqual({ deny: ['Bash(rm:*)'], allow: ['Bash(git status:*)'] });
    expect(settings.env).toEqual({ FOO: '1' });
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('echo other');
  }, 60_000);

  it.skipIf(process.platform === 'win32')('installs a hook that rewrites eligible Bash commands via updatedInput', async () => {
    const dir = project();
    expect((await rtkSetup(dir)).code).toBe(0);

    const rewritten = runHook(dir, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status', description: 'Show status' },
    });
    expect(rewritten.status).toBe(0);
    expect(JSON.parse(rewritten.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { command: 'rtk git status', description: 'Show status' },
      },
    });

    // Not eligible, already wrapped, or not Bash: no output, the call proceeds unchanged.
    for (const input of [
      { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      { tool_name: 'Bash', tool_input: { command: 'rtk git status' } },
      { tool_name: 'Write', tool_input: { file_path: 'x', content: 'git status' } },
    ]) {
      const result = runHook(dir, input);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }

    // Garbage input never fails the tool call.
    const garbage = spawnSync('sh', ['-c', settingsOf(dir).hooks.PreToolUse[0].hooks[0].command], {
      input: 'not json', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf-8',
    });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  }, 60_000);

  it('replaces the broken inline hook older versions installed', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    const legacy = `node -e "const i=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const c=(i.tool_input&&i.tool_input.command)||'';"`;
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: legacy }] }] },
    }));
    expect((await rtkSetup(dir)).code).toBe(0);
    const commands = JSON.stringify(settingsOf(dir).hooks.PreToolUse);
    expect(commands).not.toContain('/dev/stdin');
    expect(commands).toContain('smallchat-rtk');
  }, 60_000);
});
