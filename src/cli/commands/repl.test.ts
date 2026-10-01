/**
 * `smallchat repl` shows what the runtime decides (review of SAT-15).
 *
 * The REPL printed raw selector similarities above its own 0.5 threshold
 * (below the LOW tier), with no outcome, tier or chosen tool, so an intent
 * that `smallchat resolve` reports as needs-disambiguation looked like a
 * 78.6% match. It now prints runtime.resolve()'s outcome, tier, chosen tool
 * and candidates, the same resolution `resolve` prints.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const manifest = {
  id: 'demo',
  name: 'demo',
  transportType: 'local',
  tools: [
    {
      name: 'greet',
      description: 'Greet a user by name with an optional custom greeting',
      providerId: 'demo',
      transportType: 'local',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, greeting: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'echo',
      description: 'Echo back the provided message',
      providerId: 'demo',
      transportType: 'local',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    },
  ],
};

describe('smallchat repl', () => {
  let dir: string;
  let artifact: string;

  function cli(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      if (input === undefined) {
        execFile(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', ...args], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => {
          resolvePromise({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr });
        });
        return;
      }
      const child = spawn(process.execPath, [VITE_NODE, '--root', REPO, CLI, '--', ...args], { cwd: dir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sc7-repl-'));
    mkdirSync(join(dir, 'manifests'));
    writeFileSync(join(dir, 'manifests', 'demo-manifest.json'), JSON.stringify(manifest));
    artifact = join(dir, 'tools.toolkit.json');
    const compiled = await cli(['compile', '--source', './manifests', '--output', artifact]);
    expect(compiled.code, compiled.stdout + compiled.stderr).toBe(0);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('prints the outcome, tier and chosen tool that `resolve` reports for the same intent', async () => {
    const intents = ['greet a user', 'echo back the provided message', 'book a flight to Lisbon'];
    const repl = await cli(['repl', artifact], intents.join('\n') + '\n');
    expect(repl.code, repl.stderr).toBe(0);
    expect(repl.stdout).not.toMatch(/Matches:/);

    for (const intent of intents) {
      const run = await cli(['resolve', artifact, intent, '--json']);
      expect(run.code, run.stderr).toBe(0);
      const { resolution } = JSON.parse(run.stdout) as { resolution: { outcome: string; tier: string; chosen?: string } };
      const block = repl.stdout.slice(repl.stdout.indexOf(`Intent:  "${intent}"`));
      expect(block, intent).toContain(`Outcome: ${resolution.outcome} (tier ${resolution.tier.toUpperCase()}`);
      if (resolution.chosen) expect(block).toContain(`Chosen:  ${resolution.chosen}`);
    }
    // The vague intent is not presented as a match.
    expect(repl.stdout).toMatch(/Intent: {2}"greet a user"\n {2}Outcome: needs-disambiguation/);
  }, 120_000);
});
