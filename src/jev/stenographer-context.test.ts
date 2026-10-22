/**
 * StenographerJudgeContext: what it reads from stenographer's REST API,
 * how it grades entries (verified > asserted > migration; an open UV is
 * advisory; dead entries left out), the transcript order, the token, and
 * that a stenographer that is down or slow yields no context.
 */

import { describe, it, expect } from 'vitest';
import { StenographerJudgeContext, gradeLedgerEntry, transcriptLine } from './index.js';

const tb = (id: string, extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({
  id, type: 'TB', author: 'kim', body: { claim: `claim ${id}`, status: 'active', evidence: [{ kind: 'commit', ref: 'abc' }], ...body }, ...extra,
});

function server(routes: Record<string, unknown | ((url: URL) => unknown)>, seen: Array<{ path: string; auth: string | null }> = []) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = init?.headers as Record<string, string>;
    seen.push({ path: url.pathname, auth: headers?.Authorization ?? null });
    const route = routes[url.pathname];
    if (route === undefined) return new Response('not found', { status: 404 });
    const body = typeof route === 'function' ? (route as (u: URL) => unknown)(url) : route;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('grading ledger entries', () => {
  it('a TB with a reproducible check is verified, one on judgment asserted, a backfilled one migration', () => {
    expect(gradeLedgerEntry(tb('a', {}, { evidence: [{ kind: 'test', ref: 't' }] }))!.grade).toBe('verified');
    expect(gradeLedgerEntry(tb('b'))!.grade).toBe('asserted');
    expect(gradeLedgerEntry(tb('c', { author: 'migration' }, { evidence: [] }))!.grade).toBe('migration');
    expect(gradeLedgerEntry(tb('d', {}, { status: 'contested', literals: [{ subject: 'X', dead: '30', current: '60' }] }))).toMatchObject({ status: 'contested', literals: [{ subject: 'X', dead: '30', current: '60' }] });
  });

  it('an open UV is advisory; an overridden TB, a refuted UV or a malformed entry is left out', () => {
    expect(gradeLedgerEntry({ id: 'u', type: 'UV', body: { assertion: 'maybe', status: 'open' } })).toEqual({ id: 'u', type: 'UV', status: 'open', text: 'maybe', grade: 'advisory' });
    expect(gradeLedgerEntry({ id: 'u2', type: 'UV', body: { assertion: 'no', status: 'refuted' } })).toBeNull();
    expect(gradeLedgerEntry(tb('e', {}, { status: 'overridden' }))).toBeNull();
    expect(gradeLedgerEntry({ id: 1 })).toBeNull();
  });

  it('transcript lines keep the roles a judge may see', () => {
    expect(transcriptLine({ id: 'm1', role: 'assistant', content: 'hi' })).toEqual({ role: 'assistant', text: 'hi', id: 'm1' });
    expect(transcriptLine({ role: 'assistant', content: '   ' })).toBeNull();
    expect(transcriptLine({ role: 'narrator', content: 'x' })).toBeNull();
  });
});

describe('StenographerJudgeContext', () => {
  it('is loopback-only unless allowed, and validates its options', () => {
    expect(() => new StenographerJudgeContext({ baseURL: 'http://steno.example.com:8787' })).toThrow(/loopback/);
    expect(() => new StenographerJudgeContext({ baseURL: 'https://steno.example.com', allowRemote: true })).not.toThrow();
    expect(() => new StenographerJudgeContext({ baseURL: 'nope' })).toThrow(/baseURL/);
    expect(() => new StenographerJudgeContext({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(new StenographerJudgeContext().baseURL).toBe('http://127.0.0.1:8787');
    expect(JSON.stringify(new StenographerJudgeContext({ token: 'secret-token' }))).not.toContain('secret-token');
  });

  it('reads relevant truth and the newest messages, oldest first, with the bearer token', async () => {
    const seen: Array<{ path: string; auth: string | null }> = [];
    const provider = new StenographerJudgeContext({
      token: 'tok',
      subject: 'billing',
      maxTranscript: 3,
      fetch: server({
        '/truth/search': [tb('t1', {}, { evidence: [{ kind: 'command', ref: 'npm test' }] }), { id: 'u1', type: 'UV', body: { assertion: 'hmm', status: 'open' } }],
        '/messages': [{ id: 'm3', role: 'assistant', content: 'newest' }, { id: 'm2', role: 'user', content: 'middle' }, { id: 'm1', role: 'user', content: 'oldest' }],
      }, seen),
    });
    const context = await provider.context({ intent: 'refund the charge' });
    expect(context).toEqual({
      subject: 'billing',
      truth: [
        { id: 't1', type: 'TB', status: 'active', text: 'claim t1', grade: 'verified' },
        { id: 'u1', type: 'UV', status: 'open', text: 'hmm', grade: 'advisory' },
      ],
      transcript: [{ role: 'user', text: 'oldest', id: 'm1' }, { role: 'user', text: 'middle', id: 'm2' }, { role: 'assistant', text: 'newest', id: 'm3' }],
    });
    expect(seen.map(s => s.path).sort()).toEqual(['/messages', '/truth/search']);
    expect(seen.every(s => s.auth === 'Bearer tok')).toBe(true);
  });

  it('falls back to the current ledger when the search route is missing', async () => {
    const provider = new StenographerJudgeContext({ fetch: server({ '/truth': [tb('t2')], '/messages': [] }) });
    const context = await provider.context({ intent: 'x' });
    expect(context!.truth!.map(t => t.id)).toEqual(['t2']);
    expect(context!.transcript).toBeUndefined();
  });

  it('yields nothing when stenographer is down, refuses, or is too slow', async () => {
    const down = new StenographerJudgeContext({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await down.context({ intent: 'x' })).toBeNull();
    const refusing = new StenographerJudgeContext({ fetch: async () => new Response('no', { status: 401 }) });
    expect(await refusing.context({ intent: 'x' })).toBeNull();
    const slow = new StenographerJudgeContext({
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        if (init!.signal!.aborted) return reject(new Error('aborted'));
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    expect(await slow.context({ intent: 'x' })).toBeNull();
  });
});
