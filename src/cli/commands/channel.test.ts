/**
 * `smallchat channel` bridge credentials: never from argv, never
 * unauthenticated (SC-SURF-10, SC-SURF-31).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBridgeCredentials, CHANNEL_SECRET_ENV } from './channel.js';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc6-channel-'));
  dirs.push(dir);
  return dir;
}

function writePrivate(path: string, content: string, mode = 0o600): string {
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe('resolveBridgeCredentials', () => {
  it('refuses a secret on the command line', () => {
    expect(() => resolveBridgeCredentials({ httpBridge: true, httpBridgeSecret: 'change-me-in-production' }, {}))
      .toThrow(/no longer accepted.*SMALLCHAT_CHANNEL_SECRET/s);
  });

  it('refuses to run the bridge without any credential', () => {
    expect(() => resolveBridgeCredentials({ httpBridge: true }, {})).toThrow(/needs a secret/);
  });

  it('reads the shared secret from the environment', () => {
    expect(resolveBridgeCredentials({ httpBridge: true }, { [CHANNEL_SECRET_ENV]: 'env-secret-0123456789' }))
      .toEqual({ secret: 'env-secret-0123456789' });
  });

  it('reads the shared secret from a private file, and refuses a readable one', () => {
    const dir = tmp();
    const good = writePrivate(join(dir, 'secret'), 'file-secret-0123456789\n');
    expect(resolveBridgeCredentials({ httpBridge: true, httpBridgeSecretFile: good }, {})).toEqual({ secret: 'file-secret-0123456789' });
    if (process.platform !== 'win32') {
      const open = writePrivate(join(dir, 'open-secret'), 'file-secret-0123456789\n', 0o644);
      expect(() => resolveBridgeCredentials({ httpBridge: true, httpBridgeSecretFile: open }, {})).toThrow(/readable by other users/);
    }
  });

  it('refuses short secrets', () => {
    expect(() => resolveBridgeCredentials({ httpBridge: true }, { [CHANNEL_SECRET_ENV]: 'short' })).toThrow(/at least 16/);
  });

  it('reads per-sender tokens from a JSON file', () => {
    const path = writePrivate(join(tmp(), 'tokens.json'), JSON.stringify({ 'alice@corp.example': 'alice-token-0123456789' }));
    expect(resolveBridgeCredentials({ httpBridge: true, httpBridgeTokensFile: path }, {}))
      .toEqual({ tokens: { 'alice@corp.example': 'alice-token-0123456789' } });
  });
});

describe('smallchat channel --http-bridge', () => {
  function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', ...args], {
        timeout: 60_000,
        env: { ...process.env, [CHANNEL_SECRET_ENV]: '', ...env },
      }, (err, _stdout, stderr) => {
        const exit = (err as { code?: unknown } | null)?.code;
        resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stderr });
      });
      child.stdin?.end();
    });
  }

  it('exits with an error instead of serving an unauthenticated bridge', async () => {
    const { code, stderr } = await run(['channel', '--name', 'webhook', '--http-bridge', '--http-bridge-port', '0']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/needs a secret/);
  }, 60_000);

  it('rejects --http-bridge-secret on argv', async () => {
    const { code, stderr } = await run(['channel', '--name', 'webhook', '--http-bridge', '--http-bridge-secret', 'change-me-in-production']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/no longer accepted/);
  }, 60_000);
});
