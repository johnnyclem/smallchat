/**
 * @smallchat/react hooks and AppView (SAT-26, SAT-27).
 *
 * - SAT-27: re-invoking a stream hook reset a shared cancel flag, so the
 *   previous stream kept appending to the same state, nothing aborted the
 *   running tool, and a slower earlier useToolDispatch call could overwrite
 *   a later result.
 * - SAT-26: AppView set a ui:// URI as the iframe src (browsers cannot load
 *   it), re-ran its mount effect on every new toolResult or inline callback
 *   (resetting readiness, so later results were never delivered), never
 *   sent its teardown message, and defaulted to allow-same-origin.
 * - Review of SAT-26: AppView spoke a private protocol instead of the MCP
 *   Apps one (an ext-apps view's ui/initialize was never answered), posted
 *   to the view URL's origin although the default sandbox makes the frame's
 *   origin opaque, and posted its teardown after the frame was gone. These
 *   tests stub contentWindow; app-view.browser.test.ts runs a real ext-apps
 *   view in Chromium.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createRef, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ToolRuntime } from '@smallchat/core';
import { AppView, useToolDispatch, useToolStream, useInferenceStream, type AppViewHandle } from './index.js';

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** A runtime whose streams wait for release(intent) before their chunk. */
function gatedRuntime() {
  const signals: (AbortSignal | undefined)[] = [];
  const gates = new Map<string, () => void>();
  const gate = (intent: string) => new Promise<void>(resolve => gates.set(intent, resolve));
  const runtime = {
    async *dispatchStream(intent: string, _args?: unknown, options?: { signal?: AbortSignal }) {
      signals.push(options?.signal);
      yield { type: 'resolving', intent };
      await gate(intent);
      yield { type: 'chunk', content: intent, index: 0 };
      yield { type: 'done', result: { content: intent } };
    },
    async *inferenceStream(intent: string, _args?: unknown, options?: { signal?: AbortSignal }) {
      signals.push(options?.signal);
      await gate(intent);
      yield `${intent}-token`;
    },
    async dispatch(intent: string) {
      await gate(intent);
      return { content: intent, isError: false };
    },
  } as unknown as ToolRuntime;
  return { runtime, signals, release: (intent: string) => gates.get(intent)?.() };
}

function capture<T>(useHook: () => T): { current: () => T } {
  let latest: T;
  function Probe() {
    latest = useHook();
    return null;
  }
  act(() => { renderer = create(<Probe />); });
  return { current: () => latest };
}

describe('stream hooks cancel the previous run (SAT-27)', () => {
  it('useToolStream: a second stream aborts the first, whose events are dropped', async () => {
    const { runtime, signals, release } = gatedRuntime();
    const hook = capture(() => useToolStream({ runtime }));

    await act(async () => { hook.current().stream('first'); await tick(); });
    await act(async () => { hook.current().stream('second'); await tick(); });
    await act(async () => { release('second'); release('first'); await tick(); await tick(); });

    expect(hook.current().chunks).toEqual(['second']);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('useToolStream: cancel() and unmount abort the running stream', async () => {
    const { runtime, signals, release } = gatedRuntime();
    const hook = capture(() => useToolStream({ runtime }));
    await act(async () => { hook.current().stream('first'); await tick(); });
    await act(async () => { hook.current().cancel(); release('first'); await tick(); });
    expect(signals[0]?.aborted).toBe(true);
    expect(hook.current().chunks).toEqual([]);
    expect(hook.current().streaming).toBe(false);

    await act(async () => { hook.current().stream('second'); await tick(); });
    act(() => renderer!.unmount());
    renderer = null;
    expect(signals[1]?.aborted).toBe(true);
  });

  it('useInferenceStream: a second inference aborts the first', async () => {
    const { runtime, signals, release } = gatedRuntime();
    const hook = capture(() => useInferenceStream({ runtime }));
    await act(async () => { hook.current().infer('first'); await tick(); });
    await act(async () => { hook.current().infer('second'); await tick(); });
    await act(async () => { release('second'); release('first'); await tick(); await tick(); });
    expect(hook.current().text).toBe('second-token');
    expect(signals[0]?.aborted).toBe(true);
  });

  it('useToolDispatch: a slower earlier dispatch does not overwrite a later result', async () => {
    const { runtime, release } = gatedRuntime();
    const hook = capture(() => useToolDispatch({ runtime }));
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    await act(async () => { first = hook.current().dispatch('first'); await tick(); });
    await act(async () => { second = hook.current().dispatch('second'); await tick(); });
    await act(async () => { release('second'); await second; release('first'); await first; await tick(); });
    expect(hook.current().data).toBe('second');
    expect(hook.current().loading).toBe(false);
  });
});

describe('AppView (SAT-26)', () => {
  type Posted = [Record<string, unknown>, string];

  function mount(element: ReactElement) {
    const posted: Posted[] = [];
    const contentWindow = { postMessage: (message: Record<string, unknown>, origin: string) => posted.push([message, origin]) };
    const target = new EventTarget();
    (globalThis as Record<string, unknown>).window = target;
    const send = (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
      const event = new Event('message');
      Object.assign(event, { data, source: from.source ?? contentWindow, origin: from.origin ?? 'null' });
      target.dispatchEvent(event);
    };
    act(() => {
      renderer = create(element, { createNodeMock: (node) => (node.type === 'iframe' ? { contentWindow } : null) });
    });
    return { posted, send };
  }

  const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

  /** The view's side of the ext-apps handshake (what App.connect sends). */
  async function initialize(send: (data: unknown, from?: { source?: unknown; origin?: string }) => void, origin?: string) {
    await act(async () => {
      send({
        jsonrpc: '2.0', id: 1, method: 'ui/initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, appInfo: { name: 'view', version: '1.0.0' }, appCapabilities: {} },
      }, { origin });
      await flush();
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, { origin });
      await flush();
    });
  }

  const notifications = (posted: Posted[], method: string) =>
    posted.filter(([m]) => m.method === method).map(([m]) => m.params);

  it('answers ui/initialize, then sends the tool input and every new tool result across re-renders with inline callbacks', async () => {
    const view = (content: string) => (
      <AppView componentUri="https://views.example.com/forecast" toolInput={{ city: 'Oslo' }} toolResult={{ content, isError: false }} onInteraction={() => {}} />
    );
    const { posted, send } = mount(view('first'));
    await initialize(send);
    const answer = posted.find(([m]) => m.id === 1)?.[0] as { result: { hostInfo: unknown; hostContext: unknown } };
    expect(answer.result.hostInfo).toEqual({ name: '@smallchat/react', version: '1.0.0' });
    expect(answer.result.hostContext).toMatchObject({ displayMode: 'inline' });
    expect(notifications(posted, 'ui/notifications/tool-input')).toEqual([{ arguments: { city: 'Oslo' } }]);

    await act(async () => { renderer!.update(view('second')); await flush(); });
    await act(async () => { renderer!.update(view('third')); await flush(); });
    expect(notifications(posted, 'ui/notifications/tool-result')).toEqual(
      ['first', 'second', 'third'].map((text) => ({ content: [{ type: 'text', text }] })),
    );
  });

  it('posts to "*" under the default sandbox, whose frame origin is opaque, and does not grant allow-same-origin', async () => {
    const { posted, send } = mount(<AppView componentUri="https://views.example.com/forecast" toolResult={{ content: 'x', isError: false }} />);
    await initialize(send);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every(([, origin]) => origin === '*')).toBe(true);
    expect(renderer!.root.findByType('iframe').props.sandbox).toBe('allow-scripts');
  });

  it('with allow-same-origin, posts to the view origin and accepts messages only from it', async () => {
    const { posted, send } = mount(
      <AppView componentUri="https://views.example.com/forecast" sandbox="allow-scripts allow-same-origin" toolResult={{ content: 'x', isError: false }} />,
    );
    await initialize(send, 'https://evil.example');
    expect(posted).toEqual([]);
    await initialize(send, 'https://views.example.com');
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every(([, origin]) => origin === 'https://views.example.com')).toBe(true);
  });

  it('ignores messages from any window but its frame', async () => {
    const { posted, send } = mount(<AppView componentUri="https://views.example.com/forecast" />);
    await act(async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }, { source: {} });
      await flush();
    });
    expect(posted).toEqual([]);
  });

  it('answers tools/call with onCallTool and reports it and ui/message through onInteraction', async () => {
    const interactions: unknown[] = [];
    const onCallTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ content: { name, args } }));
    const { posted, send } = mount(
      <AppView componentUri="ui://weather/forecast" html="<p>view</p>" onCallTool={onCallTool} onInteraction={(...a) => interactions.push(a)} />,
    );
    await initialize(send);
    await act(async () => {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'refresh', arguments: { city: 'Oslo' } } });
      send({ jsonrpc: '2.0', id: 3, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
      await flush();
    });
    expect(onCallTool).toHaveBeenCalledWith('refresh', { city: 'Oslo' });
    expect(posted.find(([m]) => m.id === 2)?.[0]).toMatchObject({
      result: { content: [{ type: 'text', text: '{"name":"refresh","args":{"city":"Oslo"}}' }], structuredContent: { name: 'refresh' } },
    });
    expect(posted.find(([m]) => m.id === 3)?.[0]).toMatchObject({ result: {} });
    expect(interactions).toEqual([
      ['tool-call', 'refresh', { city: 'Oslo' }],
      ['message', '', [{ type: 'text', text: 'hi' }]],
    ]);
  });

  it('teardown() sends ui/resource-teardown, resolves when the view answers, and ends delivery', async () => {
    const handle = createRef<AppViewHandle>();
    const view = (content: string) => <AppView ref={handle} componentUri="ui://weather/forecast" html="<p>view</p>" toolResult={{ content, isError: false }} />;
    const { posted, send } = mount(view('first'));
    await initialize(send);
    let done: Promise<boolean> = Promise.resolve(false);
    await act(async () => { done = handle.current!.teardown(); await flush(); });
    const request = posted.find(([m]) => m.method === 'ui/resource-teardown')?.[0] as { id: number };
    expect(request).toBeDefined();
    await act(async () => { send({ jsonrpc: '2.0', id: request.id, result: {} }); await flush(); });
    expect(await done).toBe(true);
    await act(async () => { renderer!.update(view('second')); await flush(); });
    expect(notifications(posted, 'ui/notifications/tool-result')).toHaveLength(1);
  });

  it('teardown() resolves false when no view has connected', async () => {
    const handle = createRef<AppViewHandle>();
    mount(<AppView ref={handle} componentUri="https://views.example.com/forecast" />);
    expect(await handle.current!.teardown()).toBe(false);
  });

  it('renders a ui:// resource from its HTML (srcdoc), never as an iframe src', async () => {
    const readResource = vi.fn(async () => '<p>forecast</p>');
    mount(<AppView componentUri="ui://weather/forecast" readResource={readResource} />);
    await act(async () => { await tick(); });
    const iframe = renderer!.root.findByType('iframe');
    expect(readResource).toHaveBeenCalledWith('ui://weather/forecast');
    expect(iframe.props.srcDoc).toBe('<p>forecast</p>');
    expect(iframe.props.src).toBeUndefined();
  });

  it('says what is missing for a ui:// resource without html or readResource', () => {
    mount(<AppView componentUri="ui://weather/forecast" />);
    expect(renderer!.root.findAllByType('iframe')).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toMatch(/readResource/);
  });
});
