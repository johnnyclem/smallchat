/**
 * The playground resolves through the 1.0 runtime (SAT-15). It interned the
 * typed intent into the selector table and reported the intent's own
 * canonical as the "resolved selector" (100%, provider unknown), ranked raw
 * vector hits with no tiers or policy, and listened on every interface.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createPlaygroundServer } from './index.js';

const ARTIFACT = fileURLToPath(new URL('../../../spec/artifact/fixtures/minimal.v1.json', import.meta.url));

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

async function start() {
  const playground = await createPlaygroundServer(ARTIFACT);
  close = playground.close;
  await new Promise<void>(resolve => playground.server.listen(0, '127.0.0.1', resolve));
  const { port } = playground.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('playground', () => {
  it('reports the runtime resolution: outcome, tier, chosen tool id and candidates', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/resolve`, { method: 'POST', body: JSON.stringify({ intent: 'Create a new note with a title and body' }) });
    const data = await res.json() as Record<string, unknown>;
    expect(data.outcome).toBe('resolved');
    expect(data.chosen).toBe('notes/create_note');
    expect(data.tier).toMatch(/^(exact|high)$/);
    expect((data.candidates as Array<{ toolId: string }>).map(c => c.toolId)).toContain('notes/create_note');
    expect(data.proofDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(data).not.toHaveProperty('resolvedSelector');
  });

  it('lists every candidate as a real tool, never the intent itself', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/resolve`, { method: 'POST', body: JSON.stringify({ intent: 'send a note to the team slack' }) });
    const data = await res.json() as { candidates: Array<{ toolId: string }> };
    for (const c of data.candidates) expect(['notes/create_note', 'notes/delete_note']).toContain(c.toolId);
  });

  it('lists the artifact tools with their canonical ids', async () => {
    const base = await start();
    const data = await (await fetch(`${base}/api/tools`)).json() as { tools: Array<{ toolId: string }>; stats: { toolCount: number } };
    expect(data.tools.map(t => t.toolId).sort()).toEqual(['notes/create_note', 'notes/delete_note']);
    expect(data.stats.toolCount).toBe(2);
  });
});
