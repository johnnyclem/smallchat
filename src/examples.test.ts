/**
 * The runnable examples under examples/ work against this source tree
 * (review: they compiled tools but never registered them, so every intent
 * was unresolved). Each runs under vite-node with `@smallchat/core`
 * aliased to src/, using the default embedder.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');

const dir = mkdtempSync(join(tmpdir(), 'sc-examples-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CONFIG = join(dir, 'vite.config.mjs');
writeFileSync(CONFIG, `export default { resolve: { alias: { '@smallchat/core': ${JSON.stringify(join(REPO, 'src', 'index.ts'))} } } };\n`);

function runExample(name: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [VITE_NODE, '--root', REPO, '--config', CONFIG, join(REPO, 'examples', name, 'index.ts')], { timeout: 120_000 }, (err, stdout, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      resolvePromise({ code: err ? (typeof exit === 'number' ? exit : 1) : 0, stdout, stderr });
    });
  });
}

describe('examples run against the 1.0 API', () => {
  it('github-bot resolves, runs by id, and asks when unsure', async () => {
    const { code, stdout, stderr } = await runExample('github-bot');
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('ran github-bot/list_pull_requests (high)');
    expect(stdout).toContain('ran github-bot/search_code (high)');
    expect(stdout).toContain('picked github-bot/create_issue');
    expect(stdout).toContain('unresolved: No tool matched "show me open PRs"');
  }, 120_000);

  it('sql-assistant gets content for resolved intents and a DispatchError otherwise', async () => {
    const { code, stdout, stderr } = await runExample('sql-assistant');
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('Result: ["users"]');
    expect(stdout).toContain('ran sql-assistant/insert_row by id');
    expect(stdout).toMatch(/unresolved: No tool matched "describe the users table schema"/);
  }, 120_000);

  it('weather-agent streams resolved intents and reports the ones that ran nothing', async () => {
    const { code, stdout, stderr } = await runExample('weather-agent');
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('resolved to weather-agent/get_current_weather');
    expect(stdout).toContain('resolved to weather-agent/get_alerts');
    expect(stdout).toContain('needs-disambiguation: weather-agent/get_forecast');
  }, 120_000);
});
