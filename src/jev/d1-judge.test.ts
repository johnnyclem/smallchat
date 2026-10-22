/**
 * The local d1 judge and the System One wire shared with JevJudge:
 * construction without a key, loopback-only by default, the request with
 * and without context, llama-server's answer shape (no `model` field), and
 * the model helpers (`smallchat judge download|serve|status`).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1Judge, DEFAULT_D1_BASE_URL, DEFAULT_D1_MODEL, SystemOneJudge, systemOneState } from './index.js';
import {
  D1_MODEL_VARIANTS,
  d1ModelPath,
  d1ModelPresent,
  d1ModelURL,
  d1ProbeRequest,
  d1ServerAnswers,
  d1Status,
  d1Variant,
  defaultModelsDir,
  downloadD1Model,
  findLlamaServer,
  llamaServerArgs,
} from './d1-model.js';
import { acceptJudgeAnswer, boundJudgeContext } from '../core/judge.js';
import type { JudgeContext, JudgeRequest } from '../core/judge.js';

const REQUEST: JudgeRequest = {
  intent: 'email the invoice',
  trigger: 'ambiguous',
  candidates: [
    { toolId: 'mail/send', description: 'Send an email' },
    { toolId: 'mail/draft', description: 'Save an email draft' },
  ],
};

/** What llama-server answers for a d1 GGUF: answers and usage, no model field. */
const llamaAnswer = (choice: string, p: number) => new Response(JSON.stringify({
  answers: { tool: { type: 'choice', choice, confidence: 0.77, probabilities: { [choice]: p, __none__: 1 - p } } },
  usage: { input_tokens: 40, output_tokens: 0 },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('D1Judge', () => {
  it('needs no key, defaults to the local server and the model name, and is named d1', () => {
    const judge = new D1Judge();
    expect({ name: judge.name, model: judge.model, baseURL: judge.baseURL, authenticated: judge.authenticated })
      .toEqual({ name: 'd1', model: DEFAULT_D1_MODEL, baseURL: DEFAULT_D1_BASE_URL, authenticated: false });
    expect(JSON.parse(JSON.stringify(judge))).toMatchObject({ name: 'd1', apiKey: null, context: 'state' });
  });

  it('refuses a non-loopback server unless allowRemote is set', () => {
    expect(() => new D1Judge({ baseURL: 'https://judge.example.com' })).toThrow(/loopback/);
    expect(() => new D1Judge({ baseURL: 'https://judge.example.com', allowRemote: true })).not.toThrow();
    expect(() => new D1Judge({ baseURL: 'http://judge.example.com', allowRemote: true })).toThrow(/https/);
  });

  it('fromEnv reads SMALLCHAT_D1_URL, SMALLCHAT_D1_MODEL and SMALLCHAT_D1_API_KEY', () => {
    const judge = D1Judge.fromEnv({}, { SMALLCHAT_D1_URL: 'http://localhost:9090/', SMALLCHAT_D1_MODEL: 'd1-3B', SMALLCHAT_D1_API_KEY: 'k1' });
    expect({ baseURL: judge.baseURL, model: judge.model, authenticated: judge.authenticated }).toEqual({ baseURL: 'http://localhost:9090', model: 'd1-3B', authenticated: true });
    expect(D1Judge.fromEnv({}, {}).baseURL).toBe(DEFAULT_D1_BASE_URL);
  });

  it('sends no Authorization header without a key, and one with', async () => {
    const seen: Array<Record<string, string>> = [];
    const capture = async (_url: string, init?: RequestInit) => { seen.push(init!.headers as Record<string, string>); return llamaAnswer('mail/send', 0.9); };
    await new D1Judge({ fetch: capture }).judge(REQUEST);
    await new D1Judge({ fetch: capture, apiKey: 'local-key' }).judge(REQUEST);
    expect(Object.keys(seen[0]).map(k => k.toLowerCase())).not.toContain('authorization');
    expect(seen[1].Authorization).toBe('Bearer local-key');
  });

  it("reads llama-server's answer (no model field: the configured model is recorded)", async () => {
    const judge = new D1Judge({ fetch: async () => llamaAnswer('mail/send', 0.9) });
    const answer = await judge.judge(REQUEST);
    expect(answer).toEqual({ status: 'answered', choice: 'mail/send', probability: 0.9, confidence: 0.77 });
    expect(acceptJudgeAnswer(answer, ['mail/draft', 'mail/send'], 0.7, judge.model)).toMatchObject({ verdict: 'approved', toolId: 'mail/send', model: DEFAULT_D1_MODEL });
  });

  it('a server that is down is unavailable (NETWORK), never an error', async () => {
    const judge = new D1Judge({ fetch: async () => { throw new TypeError('fetch failed'); }, maxRetries: 0 });
    expect(await judge.judge(REQUEST)).toEqual({ status: 'unavailable', error: 'NETWORK' });
  });
});

describe('the state with context', () => {
  const context: JudgeContext = {
    sessionId: 'sess-1',
    subject: 'invoices',
    truth: [
      { id: 'tb1', type: 'TB', status: 'active', text: 'The rate limit is 60, not 30', literals: [{ subject: 'RATE_LIMIT', dead: '30', current: '60' }], grade: 'verified' },
      { id: 'uv1', type: 'UV', status: 'open', text: 'mail/send may double-bill', grade: 'advisory' },
    ],
    transcript: [{ role: 'user', text: 'please send the invoice' }, { role: 'assistant', text: 'drafting it now' }],
  };

  it('is the intent string without context (the wire vector), and an object with it', () => {
    expect(systemOneState('email the invoice', null)).toBe('email the invoice');
    expect(systemOneState('email the invoice', context)).toEqual({ intent: 'email the invoice', session: 'sess-1', subject: 'invoices', truth: context.truth, transcript: context.transcript });
  });

  it('is sent as the state, and the instructions say what it is', async () => {
    let body: Record<string, any> = {};
    const judge = new D1Judge({ fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return llamaAnswer('mail/send', 0.9); } });
    await judge.judge({ ...REQUEST, context });
    expect(body.state.intent).toBe('email the invoice');
    expect(body.state.truth.map((t: { id: string }) => t.id)).toEqual(['tb1', 'uv1']);
    expect(body.state.transcript).toHaveLength(2);
    expect(body.questions.tool.instructions).toMatch(/"truth" lists ledger entries/);
    expect(body.questions.tool.instructions).toMatch(/untrusted/);
  });

  it("is left out with context: 'ignore'", async () => {
    let body: Record<string, any> = {};
    const judge = new D1Judge({ context: 'ignore', fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return llamaAnswer('mail/send', 0.9); } });
    await judge.judge({ ...REQUEST, context });
    expect(body.state).toBe('email the invoice');
    expect(body.questions.tool.instructions).not.toMatch(/truth/);
  });

  it('is bounded: texts folded and cut, truth kept best grade first, the newest transcript lines kept', () => {
    const wide: JudgeContext = {
      truth: [
        { id: 'uv', type: 'UV', status: 'open', text: 'open claim', grade: 'advisory' },
        { id: 'tb-a', type: 'TB', status: 'active', text: 'asserted\nfact', grade: 'asserted' },
        { id: 'tb-v', type: 'TB', status: 'active', text: 'x'.repeat(600), grade: 'verified' },
        { id: 'bad', type: 'XX' as 'TB', status: 'active', text: 'dropped' },
      ],
      transcript: [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'three' }, { role: 'bot' as 'user', text: 'dropped' }],
    };
    const bounded = boundJudgeContext(wide, { maxTruth: 2, maxTranscript: 2, maxTextChars: 10 })!;
    expect(bounded.truth!.map(t => t.id)).toEqual(['tb-v', 'tb-a']);
    expect(bounded.truth![0].text).toBe('x'.repeat(10));
    expect(bounded.truth![1].text).toBe('asserted f');
    expect(bounded.transcript!.map(l => l.text)).toEqual(['two', 'three']);
    expect(boundJudgeContext(null)).toBeNull();
    expect(boundJudgeContext({ truth: [], transcript: [] })).toBeNull();
  });

  it('a judge built with the base class and a profile of its own records that name', async () => {
    const judge = new SystemOneJudge({ baseURL: 'http://localhost:7070', fetch: async () => llamaAnswer('mail/send', 0.9) }, {
      name: 'in-house',
      defaultBaseURL: 'http://localhost:7070',
      defaultModel: 'ranker-1',
      requireApiKey: false,
    });
    expect({ name: judge.name, model: judge.model }).toEqual({ name: 'in-house', model: 'ranker-1' });
    expect((await judge.judge(REQUEST)).status).toBe('answered');
    expect(() => new SystemOneJudge({}, { name: 'Bad Name', defaultBaseURL: 'http://localhost:1', defaultModel: 'm', requireApiKey: false })).toThrow(/name/);
  });
});

describe('the model helpers', () => {
  it('know the variants, their URLs and paths', () => {
    expect(d1Variant(undefined).name).toBe('q8');
    expect(() => d1Variant('q2')).toThrow(/q8, f16, bf16/);
    expect(d1ModelURL(D1_MODEL_VARIANTS.q8)).toBe('https://huggingface.co/LiquidAI/d1-omni-600M-GGUF/resolve/main/d1-omni-600M-Q8_0.gguf');
    expect(d1ModelPath('/m', D1_MODEL_VARIANTS.f16)).toBe(join('/m', 'd1-omni-600M-F16.gguf'));
    expect(defaultModelsDir({ SMALLCHAT_MODELS_DIR: '/x/models' })).toBe('/x/models');
    expect(defaultModelsDir({})).toMatch(/\.smallchat[\\/]models$/);
  });

  it('start llama-server with the batch sizes the model card asks for', () => {
    expect(llamaServerArgs({ modelPath: '/m/d1.gguf' })).toEqual(['-m', '/m/d1.gguf', '--host', '127.0.0.1', '--port', '8080', '-b', '4096', '-ub', '4096']);
    expect(llamaServerArgs({ modelPath: '/m/d1.gguf', port: 9000, threads: 4, extraArgs: ['--verbose'] })).toContain('--verbose');
    expect(() => llamaServerArgs({ modelPath: '/m', batch: 10 })).toThrow(/batch/);
    expect(() => llamaServerArgs({ modelPath: '/m', port: 70000 })).toThrow(/port/);
    expect(findLlamaServer({ PATH: '/nonexistent' })).toBeNull();
  });

  it('download writes a .part file and keeps it only at the catalog size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-'));
    try {
      const variant = { ...D1_MODEL_VARIANTS.q8, bytes: 5 };
      const good = await downloadD1Model({ dir, fetch: async () => new Response('hello', { status: 200 }), variant: 'q8', ...({} as object) }).catch(e => e);
      // The real catalog size is 407 MB, so a 5-byte body is short: refused and removed
      expect(good).toBeInstanceOf(Error);
      expect(String(good)).toMatch(/expected 407207584/);
      expect(d1ModelPresent(dir, D1_MODEL_VARIANTS.q8)).toBe(false);
      // A file of the right size is accepted, and present
      writeFileSync(d1ModelPath(dir, variant), 'hello');
      expect(d1ModelPresent(dir, variant)).toBe(true);
      expect(readFileSync(d1ModelPath(dir, variant), 'utf8')).toBe('hello');
      const http = await downloadD1Model({ dir, fetch: async () => new Response('nope', { status: 404 }), force: true }).catch(e => e);
      expect(String(http)).toMatch(/HTTP 404/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status probes the server with one tool and reports what is installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd1-'));
    try {
      let probe: Record<string, any> = {};
      const fetchFn = async (_url: string, init?: RequestInit) => { probe = JSON.parse(String(init!.body)); return llamaAnswer('probe/ok', 0.9); };
      const status = await d1Status({ dir, fetch: fetchFn, env: { PATH: '/nonexistent' } });
      expect(status.serving).toBe(true);
      expect(probe).toEqual(d1ProbeRequest());
      expect(status.variants.map(v => v.present)).toEqual([false, false, false]);
      expect(status.llamaServer).toBeNull();
      expect(await d1ServerAnswers('http://127.0.0.1:1', async () => new Response('x', { status: 500 }))).toBe(false);
      expect(await d1ServerAnswers('http://127.0.0.1:1', async () => { throw new Error('down'); })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
