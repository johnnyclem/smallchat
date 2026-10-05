/**
 * The TypeSafe client for the shortlist judge (@smallchat/core/jev, D5):
 * option validation, the API key, the wire contract with
 * @typesafe-ai/sdk 0.6.0 (spec/judge/vectors.json "wire", captured from the
 * SDK itself; the SDK is not a dependency), answer validation, error codes,
 * retries and the transport guards.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JevJudge, JEV_ABSTAIN, DEFAULT_JEV_MODEL, DEFAULT_JEV_BASE_URL } from './index.js';
import type { JevJudgeOptions } from './index.js';
import { acceptJudgeAnswer } from '../core/judge.js';
import type { JudgeAnswer, JudgeRequest } from '../core/judge.js';

const KEY = 'ts_live_SECRET_client_test_abcdefghijklmnop';

const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../spec/judge/vectors.json', import.meta.url)), 'utf8')) as {
  wire: {
    request: {
      input: { apiKey: string; intent: string; candidates: Array<{ toolId: string; description: string }> };
      expect: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };
    };
  };
};

const REQUEST: JudgeRequest = {
  intent: 'email the invoice',
  trigger: 'ambiguous',
  candidates: [
    { toolId: 'mail/send', description: 'Send an email' },
    { toolId: 'mail/draft', description: 'Save an email draft' },
  ],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const answer = (choice: string, p: number, extra: Record<string, unknown> = {}) => jsonResponse({
  model: 'jev-1.13.0',
  answers: { tool: { type: 'choice', choice, confidence: 0.8, probabilities: { [choice]: p }, ...extra } },
  usage: { input_tokens: 1, output_tokens: 1 },
}, 200, { 'x-typesafe-request-id': 'req_123' });

function judgeWith(fetch: (url: string, init?: RequestInit) => Promise<Response>, extra: Partial<JevJudgeOptions> = {}): JevJudge {
  return new JevJudge({ apiKey: KEY, fetch, ...extra });
}

const unavailable = (a: JudgeAnswer) => (a.status === 'unavailable' ? a.error : `answered:${a.choice}`);

describe('options are validated at construction', () => {
  const bad: Array<[string, Partial<JevJudgeOptions>]> = [
    ['acceptThreshold NaN', { acceptThreshold: Number.NaN }],
    ['acceptThreshold 0', { acceptThreshold: 0 }],
    ['acceptThreshold above 1', { acceptThreshold: 1.5 }],
    ['maxCandidates 0', { maxCandidates: 0 }],
    ['maxCandidates fractional', { maxCandidates: 1.5 }],
    ['maxCandidates above the API option limit', { maxCandidates: 255 }],
    ['timeoutMs 0', { timeoutMs: 0 }],
    ['timeoutMs NaN', { timeoutMs: Number.NaN }],
    ['timeoutMs Infinity', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['timeoutMs past the timer limit', { timeoutMs: 2 ** 31 }],
    ['margin 1', { margin: 1 }],
    ['margin negative', { margin: -0.01 }],
    ['maxRetries negative', { maxRetries: -1 }],
  ];
  for (const [name, options] of bad) {
    it(`throws on ${name}`, () => {
      expect(() => new JevJudge({ apiKey: KEY, ...options })).toThrow(TypeError);
    });
  }

  it('accepts the boundaries', () => {
    const judge = new JevJudge({ apiKey: KEY, acceptThreshold: 1, margin: 0, maxCandidates: 254, maxRetries: 0 });
    expect({ accept: judge.acceptThreshold, margin: judge.margin, max: judge.maxCandidates }).toEqual({ accept: 1, margin: 0, max: 254 });
  });

  it('defaults to a pinned model and the SDK base URL', () => {
    const judge = new JevJudge({ apiKey: KEY });
    expect(DEFAULT_JEV_MODEL).toBe('jev-1.13.0');
    expect({ name: judge.name, model: judge.model, baseURL: judge.baseURL, margin: judge.margin, accept: judge.acceptThreshold, max: judge.maxCandidates })
      .toEqual({ name: 'jev', model: 'jev-1.13.0', baseURL: DEFAULT_JEV_BASE_URL, margin: 0.05, accept: 0.7, max: 8 });
  });

  it('requires an API key, and rejects one with whitespace or control characters without echoing it', () => {
    expect(() => new JevJudge({ apiKey: '' })).toThrow(/apiKey/);
    for (const key of [`${KEY} x`, `${KEY}\n`, `${KEY}é`]) {
      let message = '';
      try { new JevJudge({ apiKey: key }); } catch (err) { message = (err as Error).message; }
      expect(message).toMatch(/apiKey/);
      expect(message).not.toContain(KEY);
    }
  });
});

describe('the API key stays private', () => {
  it('is not an own property, and inspect, JSON and spread do not show it', () => {
    const judge = new JevJudge({ apiKey: KEY });
    expect(Object.keys(judge).join(',')).not.toMatch(/key/i);
    expect(inspect(judge, { depth: 5, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(judge)).not.toContain(KEY);
    expect(JSON.stringify({ ...judge })).not.toContain(KEY);
    expect(JSON.stringify(judge)).toContain('jev-1.13.0');
  });

  it('never appears in an answer, whatever the error says', async () => {
    const leaky = judgeWith(async () => { throw new TypeError(`invalid header value "Bearer ${KEY}"`); });
    const a = await leaky.judge(REQUEST);
    expect(a).toMatchObject({ status: 'unavailable', error: 'NETWORK' });
    expect(JSON.stringify(a)).not.toContain(KEY);

    const echo = judgeWith(async () => jsonResponse({ detail: { message: `bad key ${KEY}` } }, 401));
    const b = await echo.judge(REQUEST);
    expect(b).toMatchObject({ status: 'unavailable', error: 'AUTH' });
    expect(JSON.stringify(b)).not.toContain(KEY);
    expect(JSON.stringify(b)).not.toContain('bad key');
  });
});

describe('the wire contract with @typesafe-ai/sdk 0.6.0', () => {
  it('sends what TypeSafeClient.systemOne({ questions: { tool: choice(...) } }) sends', async () => {
    const { input, expect: want } = spec.wire.request;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const judge = new JevJudge({
      apiKey: input.apiKey,
      fetch: async (url, init) => { seen.push({ url, init: init! }); return answer('mail/send', 0.9); },
    });
    await judge.judge({ intent: input.intent, trigger: 'ambiguous', candidates: input.candidates });
    expect(seen).toHaveLength(1);
    const headers = Object.fromEntries(Object.entries(seen[0].init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(seen[0].url).toBe(want.url);
    expect(seen[0].init.method).toBe(want.method);
    for (const [name, value] of Object.entries(want.headers)) expect(headers[name], name).toBe(value);
    const sent = JSON.parse(String(seen[0].init.body));
    expect(sent).toEqual(want.body);
    // toEqual ignores key order; the options are presented in this order (tool ids sorted, abstain last).
    const criteria = (body: Record<string, unknown>) => Object.keys((body as { questions: { tool: { criteria: object } } }).questions.tool.criteria);
    expect(criteria(sent)).toEqual(criteria(want.body));
    expect(seen[0].init.redirect).toBe('error');
  });

  it('reads the choice, its probability, the confidence, the model and the request id', async () => {
    const a = await judgeWith(async () => answer('mail/send', 0.84)).judge(REQUEST);
    expect(a).toEqual({ status: 'answered', choice: 'mail/send', probability: 0.84, confidence: 0.8, model: 'jev-1.13.0', requestId: 'req_123' });
  });

  it('reads abstain as no choice', async () => {
    const a = await judgeWith(async () => answer(JEV_ABSTAIN, 0.9)).judge(REQUEST);
    expect(a).toMatchObject({ status: 'answered', choice: null });
  });

  it('an off-list answer of any length is declined, and the verdict does not echo it', async () => {
    const long = `mail/${'x'.repeat(10_000)}`;
    const a = await judgeWith(async () => answer(long, 0.99)).judge(REQUEST);
    const verdict = acceptJudgeAnswer(a, REQUEST.candidates.map(c => c.toolId), 0.7, DEFAULT_JEV_MODEL);
    expect(verdict).toMatchObject({ verdict: 'declined', toolId: null, reason: 'outside-shortlist' });
    expect(JSON.stringify(verdict).length).toBeLessThan(400);
  });
});

describe('answers outside the contract are unavailable (MALFORMED)', () => {
  const cases: Array<[string, () => Response]> = [
    ['probability 7', () => answer('mail/send', 7)],
    ['probability -0.1', () => answer('mail/send', -0.1)],
    ['confidence 1e400', () => new Response('{"answers":{"tool":{"type":"choice","choice":"mail/send","confidence":1e400,"probabilities":{"mail/send":0.9}}}}', { status: 200 })],
    ['a string probability', () => answer('mail/send', 0.9, { probabilities: { 'mail/send': '0.9' } })],
    ['no answer', () => jsonResponse({ answers: {} })],
    ['a non-choice answer', () => jsonResponse({ answers: { tool: { type: 'noul', noul: 0.9 } } })],
    ['a body that is not JSON', () => new Response('<html>oops</html>', { status: 200 })],
    ['a body over 64 KiB', () => jsonResponse({ pad: 'x'.repeat(70 * 1024), answers: { tool: { type: 'choice', choice: 'mail/send', confidence: 0.9, probabilities: { 'mail/send': 0.9 } } } })],
  ];
  for (const [name, response] of cases) {
    it(name, async () => {
      expect(unavailable(await judgeWith(async () => response()).judge(REQUEST))).toBe('MALFORMED');
    });
  }
});

describe('failures map to codes', () => {
  it('HTTP statuses', async () => {
    const codes: Record<number, string> = { 401: 'AUTH', 403: 'AUTH', 404: 'HTTP_404', 400: 'HTTP_400', 422: 'HTTP_422', 429: 'RATE_LIMITED', 500: 'HTTP_500', 529: 'HTTP_529' };
    for (const [status, code] of Object.entries(codes)) {
      const a = await judgeWith(async () => jsonResponse({ detail: { message: 'no' } }, Number(status)), { maxRetries: 0 }).judge(REQUEST);
      expect(unavailable(a), status).toBe(code);
    }
  });

  it('network failure, timeout and the caller aborting', async () => {
    expect(unavailable(await judgeWith(async () => { throw new TypeError('fetch failed'); }).judge(REQUEST))).toBe('NETWORK');
    const hang = () => new Promise<Response>(() => {});
    expect(unavailable(await judgeWith(hang, { timeoutMs: 30 }).judge(REQUEST))).toBe('TIMEOUT');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(unavailable(await judgeWith(hang, { timeoutMs: 5000 }).judge({ ...REQUEST, signal: controller.signal }))).toBe('ABORTED');
  });

  it('a signal aborted before the call sends nothing', async () => {
    const fetch = vi.fn(async () => answer('mail/send', 0.9));
    const a = await judgeWith(fetch).judge({ ...REQUEST, signal: AbortSignal.abort() });
    expect(unavailable(a)).toBe('ABORTED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a fetch that ignores its signal still settles at the timeout', async () => {
    const started = Date.now();
    const a = await judgeWith(() => new Promise<Response>(() => {}), { timeoutMs: 40 }).judge(REQUEST);
    expect(unavailable(a)).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('retries', () => {
  function flaky(first: number, headers: Record<string, string> = {}) {
    const fetch = vi.fn(async () => (fetch.mock.calls.length === 1
      ? jsonResponse({ detail: { message: 'try again' } }, first, headers)
      : answer('mail/send', 0.9)));
    return fetch;
  }

  for (const status of [408, 429, 500, 503, 529]) {
    it(`retries ${status} within the timeout budget`, async () => {
      const fetch = flaky(status, { 'retry-after-ms': '5' });
      const a = await judgeWith(fetch).judge(REQUEST);
      expect(a.status).toBe('answered');
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  }

  it('does not retry a 400', async () => {
    const fetch = flaky(400);
    expect(unavailable(await judgeWith(fetch).judge(REQUEST))).toBe('HTTP_400');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After only when it fits the budget, and reports it', async () => {
    const fetch = flaky(429, { 'retry-after': '30' });
    const a = await judgeWith(fetch, { timeoutMs: 200 }).judge(REQUEST);
    expect(a).toMatchObject({ status: 'unavailable', error: 'RATE_LIMITED', retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries', async () => {
    const fetch = vi.fn(async () => jsonResponse({}, 503, { 'retry-after-ms': '1' }));
    expect(unavailable(await judgeWith(fetch, { maxRetries: 2 }).judge(REQUEST))).toBe('HTTP_503');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('transport', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete (globalThis as { window?: unknown }).window;
  });

  it('calls the global fetch as a plain function (browsers and Workers reject another receiver)', async () => {
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown) {
      receivers.push(this);
      if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError('Illegal invocation'));
      return Promise.resolve(answer('mail/send', 0.9));
    } as typeof fetch;
    const a = await new JevJudge({ apiKey: KEY }).judge(REQUEST);
    expect(a.status).toBe('answered');
    expect(receivers).toHaveLength(1);
  });

  it('also calls a custom fetch without a receiver', async () => {
    let receiver: unknown = 'unset';
    const judge = judgeWith(function (this: unknown) { receiver = this; return Promise.resolve(answer('mail/send', 0.9)); });
    await judge.judge(REQUEST);
    expect(receiver).toBeUndefined();
  });

  it('refuses to construct in a browser unless dangerouslyAllowBrowser is set', () => {
    (globalThis as { window?: unknown }).window = { document: {} };
    expect(() => new JevJudge({ apiKey: KEY })).toThrow(/browser/);
    expect(() => new JevJudge({ apiKey: KEY, dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it('requires https, except on a loopback host, and no credentials in the URL', () => {
    expect(() => new JevJudge({ apiKey: KEY, baseURL: 'http://api.typesafe.ai' })).toThrow(/https/);
    expect(() => new JevJudge({ apiKey: KEY, baseURL: 'https://user:pass@api.typesafe.ai' })).toThrow(/credentials/);
    expect(() => new JevJudge({ apiKey: KEY, baseURL: 'not a url' })).toThrow(/baseURL/);
    for (const host of ['http://localhost:8080', 'http://127.0.0.1:9', 'http://[::1]:9']) {
      expect(() => new JevJudge({ apiKey: KEY, baseURL: host }), host).not.toThrow();
    }
  });

  it('takes an SDK-style base URL and appends /v1/systemone', async () => {
    const urls: string[] = [];
    const judge = judgeWith(async url => { urls.push(url); return answer('mail/send', 0.9); }, { baseURL: 'https://proxy.example.com/typesafe//' });
    await judge.judge(REQUEST);
    expect(urls).toEqual(['https://proxy.example.com/typesafe/v1/systemone']);
  });

  it('fromEnv reads TYPESAFE_API_KEY and TYPESAFE_BASE_URL; the constructor reads no environment', () => {
    const judge = JevJudge.fromEnv({ fetch: async () => answer('mail/send', 0.9) }, { TYPESAFE_API_KEY: ` ${KEY} `, TYPESAFE_BASE_URL: 'http://localhost:4010' });
    expect(judge.baseURL).toBe('http://localhost:4010');
    expect(() => JevJudge.fromEnv({}, {})).toThrow(/TYPESAFE_API_KEY/);
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    try {
      expect(() => new JevJudge({} as JevJudgeOptions)).toThrow(/apiKey/);
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it('redactIntent runs before the intent leaves the process', async () => {
    let state = '';
    const judge = judgeWith(async (_url, init) => { state = JSON.parse(String(init!.body)).state; return answer('mail/send', 0.9); }, {
      redactIntent: intent => intent.replace(/\S+@\S+/g, '[email]'),
    });
    await judge.judge({ ...REQUEST, intent: 'email the invoice to bob@example.com' });
    expect(state).toBe('email the invoice to [email]');
  });

  it('presents candidates sorted by tool id with abstain last, whatever order it is given', async () => {
    let keys: string[] = [];
    const judge = judgeWith(async (_url, init) => { keys = Object.keys(JSON.parse(String(init!.body)).questions.tool.criteria); return answer('mail/send', 0.9); });
    await judge.judge({ ...REQUEST, candidates: [...REQUEST.candidates].reverse() });
    expect(keys).toEqual(['mail/draft', 'mail/send', JEV_ABSTAIN]);
  });
});
