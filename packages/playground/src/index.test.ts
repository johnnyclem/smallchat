/**
 * The playground resolves through the 1.0 runtime (SAT-15). It interned the
 * typed intent into the selector table and reported the intent's own
 * canonical as the "resolved selector" (100%, provider unknown), ranked raw
 * vector hits with no tiers or policy, and listened on every interface.
 *
 * Review of SAT-15: bound to 127.0.0.1 it still answered any Host and
 * Origin and parsed any content type as JSON, so a DNS-rebinding page could
 * read /api/tools and drive /api/resolve, and a cross-site text/plain POST
 * reached resolve. `serve --http` refuses all three (SC-SURF-09).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
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

const json = { 'content-type': 'application/json' };

/** A raw HTTP request (fetch cannot set Host). */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('playground', () => {
  it('reports the runtime resolution: outcome, tier, chosen tool id and candidates', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/resolve`, { method: 'POST', headers: json, body: JSON.stringify({ intent: 'Create a new note with a title and body' }) });
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
    const res = await fetch(`${base}/api/resolve`, { method: 'POST', headers: json, body: JSON.stringify({ intent: 'send a note to the team slack' }) });
    const data = await res.json() as { candidates: Array<{ toolId: string }> };
    for (const c of data.candidates) expect(['notes/create_note', 'notes/delete_note']).toContain(c.toolId);
  });

  it('lists the artifact tools with their canonical ids', async () => {
    const base = await start();
    const data = await (await fetch(`${base}/api/tools`)).json() as { tools: Array<{ toolId: string }>; stats: { toolCount: number } };
    expect(data.tools.map(t => t.toolId).sort()).toEqual(['notes/create_note', 'notes/delete_note']);
    expect(data.stats.toolCount).toBe(2);
  });

  it('refuses a foreign Host (DNS rebinding) on every route', async () => {
    const base = await start();
    const port = new URL(base).port;
    for (const [method, path] of [['GET', '/'], ['GET', '/api/tools'], ['POST', '/api/resolve']]) {
      const res = await raw(base, method, path, { host: `attacker.example:${port}`, ...json }, method === 'POST' ? JSON.stringify({ intent: 'delete a note' }) : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).not.toContain('notes/');
    }
    // Its own loopback names are fine.
    expect((await raw(base, 'GET', '/api/tools', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('refuses a cross-site Origin and a non-JSON body', async () => {
    const base = await start();
    const body = JSON.stringify({ intent: 'delete a note' });
    const crossSite = await raw(base, 'POST', '/api/resolve', { host: new URL(base).host, origin: 'http://attacker.example', ...json }, body);
    expect(crossSite.status).toBe(403);
    const textPlain = await raw(base, 'POST', '/api/resolve', { host: new URL(base).host, 'content-type': 'text/plain' }, body);
    expect(textPlain.status).toBe(415);
    // The playground's own page (same origin) still works.
    const own = await raw(base, 'POST', '/api/resolve', { host: new URL(base).host, origin: base, ...json }, body);
    expect(own.status).toBe(200);
  });
});
