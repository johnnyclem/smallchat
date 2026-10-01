/**
 * @smallchat/nextjs route handlers (SAT-25). The documented
 * `export const POST = createDispatchHandler();` made a public route that
 * resolved and executed any intent for anyone: no authorization hook, no
 * body limit, raw error messages in responses.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ToolRuntime } from '@smallchat/core';
import { createDispatchHandler, createStreamHandler, createToolListHandler } from './index.js';

function fakeRuntime(requireLLMForSubHighDispatch = true) {
  const dispatch = vi.fn(async (intent: string) => ({ content: `ran ${intent}`, isError: false }));
  async function* dispatchStream(intent: string) {
    yield { type: 'done', result: { content: `ran ${intent}` } };
  }
  const runtime = {
    context: { requireLLMForSubHighDispatch },
    dispatch,
    dispatchStream: vi.fn(dispatchStream),
    generateHeader: () => 'tools',
  } as unknown as ToolRuntime;
  return { runtime, dispatch };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const allowAdmin = (request: Request) => request.headers.get('authorization') === 'Bearer admin';

describe('createDispatchHandler', () => {
  it('refuses to build a handler with neither authorize nor unsafePublic', () => {
    const { runtime } = fakeRuntime();
    expect(() => createDispatchHandler({ runtime })).toThrow(/authorize/);
    expect(() => createDispatchHandler()).toThrow(/authorize/);
    expect(() => createStreamHandler({ runtime })).toThrow(/authorize/);
    expect(() => createToolListHandler({ runtime })).toThrow(/authorize/);
  });

  it('runs nothing for a request authorize rejects', async () => {
    const { runtime, dispatch } = fakeRuntime();
    const handler = createDispatchHandler({ runtime, authorize: allowAdmin });
    const res = await handler(post({ intent: 'delete the staging database' }));
    expect(res.status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches an authorized request, with the request signal, and hands authorize the call', async () => {
    const { runtime, dispatch } = fakeRuntime();
    const authorize = vi.fn(allowAdmin);
    const handler = createDispatchHandler({ runtime, authorize });
    const req = post({ intent: 'list files', args: { path: '/' } }, { authorization: 'Bearer admin' });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: 'ran list files', isError: false });
    expect(authorize).toHaveBeenCalledWith(req, { kind: 'dispatch', intent: 'list files', args: { path: '/' } });
    expect(dispatch).toHaveBeenCalledWith('list files', { path: '/' }, { signal: req.signal });
  });

  it('sends a Response that authorize returns as-is', async () => {
    const { runtime } = fakeRuntime();
    const handler = createDispatchHandler({ runtime, authorize: () => new Response('login first', { status: 401 }) });
    const res = await handler(post({ intent: 'x' }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('login first');
  });

  it('serves a public route only with an explicit unsafePublic: true', async () => {
    const { runtime, dispatch } = fakeRuntime();
    const res = await createDispatchHandler({ runtime, unsafePublic: true })(post({ intent: 'x' }));
    expect(res.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('refuses a runtime that auto-runs sub-HIGH matches unless explicitly allowed', async () => {
    const { runtime, dispatch } = fakeRuntime(false);
    const res = await createDispatchHandler({ runtime, unsafePublic: true })(post({ intent: 'x' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/requireLLMForSubHighDispatch/);
    expect(dispatch).not.toHaveBeenCalled();
    const allowed = await createDispatchHandler({ runtime, unsafePublic: true, allowSubHighDispatch: true })(post({ intent: 'x' }));
    expect(allowed.status).toBe(200);
  });

  it('caps the body size', async () => {
    const { runtime, dispatch } = fakeRuntime();
    const handler = createDispatchHandler({ runtime, unsafePublic: true, maxBodyBytes: 100 });
    const res = await handler(post({ intent: 'x'.repeat(200) }));
    expect(res.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not return raw error messages', async () => {
    const { runtime, dispatch } = fakeRuntime();
    dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    const onError = vi.fn();
    const res = await createDispatchHandler({ runtime, unsafePublic: true, onError })(post({ intent: 'x' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/hunter2|ECONNREFUSED/);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('createStreamHandler and createToolListHandler', () => {
  it('authorize gates the stream and the tool list', async () => {
    const { runtime } = fakeRuntime();
    const stream = createStreamHandler({ runtime, authorize: allowAdmin });
    expect((await stream(post({ intent: 'x' }))).status).toBe(403);
    const ok = await stream(post({ intent: 'x' }, { authorization: 'Bearer admin' }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('data: [DONE]');

    const list = createToolListHandler({ runtime, authorize: allowAdmin });
    expect((await list(new Request('http://localhost/api/tools'))).status).toBe(403);
    expect((await list(new Request('http://localhost/api/tools', { headers: { authorization: 'Bearer admin' } }))).status).toBe(200);
  });
});
