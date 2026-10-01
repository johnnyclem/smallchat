/**
 * HttpTransport against a real local server: retries never duplicate
 * non-idempotent calls (SC-SURF-18), the breaker sees 5xx, auth runs inside
 * the timeout, and streamed uploads arrive whole (SC-SURF-26).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTransport } from './http-transport.js';
import { OAuth2ClientCredentialsAuth } from './auth.js';
import { buildMultipartBody } from './file-upload.js';
import type { AuthStrategy } from './types.js';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const slow = (ms: number) => (_req: IncomingMessage, res: ServerResponse) => {
  setTimeout(() => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  }, ms);
};

const retry = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 20 };

describe('HttpTransport retries (SC-SURF-18)', () => {
  it('does not retry a timed-out POST: the side effect happens once', async () => {
    const { url, seen } = await serve(slow(800));
    const transport = new HttpTransport({ baseUrl: url, timeoutMs: 300, retry });
    const result = await transport.execute({ toolName: 'create_payment', args: { amount: 5 } });
    expect(result.isError).toBe(true);
    expect(result.metadata?.code).toBe('TRANSPORT_TIMEOUT');
    await new Promise(r => setTimeout(r, 1_000));
    expect(seen.filter(s => s.method === 'POST')).toHaveLength(1);
  });

  it('still retries idempotent methods', async () => {
    const { url, seen } = await serve(slow(800));
    const transport = new HttpTransport({ baseUrl: url, timeoutMs: 200, retry });
    await transport.execute({ toolName: 'get_payment', args: {}, method: 'GET' });
    await new Promise(r => setTimeout(r, 1_000));
    expect(seen.filter(s => s.method === 'GET')).toHaveLength(4);
  });

  it('retries a POST only when opted in, with one Idempotency-Key for every attempt', async () => {
    let calls = 0;
    const { url, seen } = await serve((_req, res) => {
      calls++;
      if (calls < 3) res.writeHead(503).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const transport = new HttpTransport({ baseUrl: url, retry: { ...retry, retryNonIdempotent: true } });
    const result = await transport.execute({ toolName: 'create_payment', args: { amount: 5 } });
    expect(result.isError).toBe(false);
    expect(seen).toHaveLength(3);
    const keys = seen.map(s => s.headers['idempotency-key']);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(keys).size).toBe(1);

    // A second logical call gets a new key.
    calls = 10;
    await transport.execute({ toolName: 'create_payment', args: { amount: 6 } });
    expect(seen[3].headers['idempotency-key']).not.toBe(keys[0]);
  });

  it('retries a POST that carries its own Idempotency-Key, keeping the key', async () => {
    let calls = 0;
    const { url, seen } = await serve((_req, res) => {
      calls++;
      res.writeHead(calls < 2 ? 502 : 200, { 'content-type': 'application/json' }).end('{}');
    });
    const transport = new HttpTransport({ baseUrl: url, retry });
    await transport.execute({ toolName: 'create_payment', args: {}, headers: { 'Idempotency-Key': 'caller-key-1' } });
    expect(seen.map(s => s.headers['idempotency-key'])).toEqual(['caller-key-1', 'caller-key-1']);
  });

  it('counts 5xx responses as circuit breaker failures without a retry config', async () => {
    const { url, seen } = await serve((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"down"}'); });
    const transport = new HttpTransport({ baseUrl: url, circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000 } });
    const first = await transport.execute({ toolName: 'x', args: {} });
    expect(first.isError).toBe(true);
    expect(first.metadata?.statusCode).toBe(500);
    expect(first.content).toEqual({ error: 'down' });
    await transport.execute({ toolName: 'x', args: {} });
    const third = await transport.execute({ toolName: 'x', args: {} });
    expect(third.metadata?.code).toBe('CIRCUIT_OPEN');
    expect(seen).toHaveLength(2);
  });

  it('keeps token acquisition inside the timeout', async () => {
    const { url } = await serve(slow(0));
    const hangingAuth: AuthStrategy = { apply: () => new Promise(() => {}) };
    const transport = new HttpTransport({ baseUrl: url, timeoutMs: 200, auth: hangingAuth });
    const started = Date.now();
    const result = await Promise.race([
      transport.execute({ toolName: 'x', args: {} }),
      new Promise<'hung'>(r => setTimeout(() => r('hung'), 3_000)),
    ]);
    expect(result).not.toBe('hung');
    expect((result as { metadata?: { code?: string } }).metadata?.code).toBe('TRANSPORT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('OAuth2ClientCredentialsAuth', () => {
  it('fetches one token for concurrent requests (single flight)', async () => {
    const { url, seen } = await serve((_req, res) => {
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: 'tok', expires_in: 3600 })), 50);
    });
    const auth = new OAuth2ClientCredentialsAuth({ clientId: 'c', clientSecret: 's', tokenUrl: `${url}/token` });
    const headers = await Promise.all(Array.from({ length: 5 }, async () => {
      const h: Record<string, string> = {};
      await auth.apply(h);
      return h;
    }));
    expect(headers.every(h => h.Authorization === 'Bearer tok')).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe('multipart uploads from a ReadableStream (SC-SURF-26)', () => {
  function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
  }

  it('sends the whole stream, not an empty file', async () => {
    const { url, seen } = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
    const transport = new HttpTransport({ baseUrl: url });
    const result = await transport.execute({
      toolName: 'upload',
      args: { note: 'log' },
      files: [{ fieldName: 'file', filename: 'app.log', contentType: 'text/plain', content: streamOf('line one\n', 'line two\n') }],
    });
    expect(result.isError).toBe(false);
    const body = seen[0].body.toString('utf-8');
    expect(body).toContain('filename="app.log"');
    expect(body).toContain('line one\nline two\n');
  });

  it('refuses a stream larger than maxUploadBytes instead of truncating it', async () => {
    const { url, seen } = await serve((_req, res) => { res.writeHead(200).end(); });
    const transport = new HttpTransport({ baseUrl: url, maxUploadBytes: 8 });
    const result = await transport.execute({
      toolName: 'upload',
      args: {},
      files: [{ fieldName: 'file', filename: 'big.bin', contentType: 'application/octet-stream', content: streamOf('0123456789') }],
    });
    expect(result.isError).toBe(true);
    expect(String(result.metadata?.error)).toMatch(/8 bytes/);
    expect(seen).toHaveLength(0);
  });

  it('buildMultipartBody refuses an unbuffered stream rather than sending 0 bytes', () => {
    expect(() => buildMultipartBody([
      { fieldName: 'f', filename: 'x', contentType: 'text/plain', content: streamOf('data') },
    ])).toThrow(/bufferFileUploads|ReadableStream/);
  });
});
