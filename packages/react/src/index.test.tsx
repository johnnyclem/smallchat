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
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ToolRuntime } from '@smallchat/core';
import { AppView, useToolDispatch, useToolStream, useInferenceStream } from './index.js';

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
  type Posted = [unknown, string];

  function mount(element: JSX.Element) {
    const posted: Posted[] = [];
    const contentWindow = { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) };
    const target = new EventTarget();
    (globalThis as Record<string, unknown>).window = target;
    const send = (data: unknown) => {
      const event = new Event('message');
      Object.assign(event, { data, source: contentWindow });
      target.dispatchEvent(event);
    };
    act(() => {
      renderer = create(element, { createNodeMock: (node) => (node.type === 'iframe' ? { contentWindow } : null) });
    });
    return { posted, send };
  }

  const resultMessages = (posted: Posted[]) =>
    posted.filter(([m]) => (m as { type?: string }).type === 'ui/notifications/tool-result').map(([m]) => (m as { result: unknown }).result);

  it('delivers every new tool result after the view is ready, across re-renders with inline callbacks', async () => {
    const view = (content: string) => (
      <AppView componentUri="https://views.example.com/forecast" toolResult={{ content, isError: false }} onInteraction={() => {}} />
    );
    const { posted, send } = mount(view('first'));
    act(() => send({ type: 'mcp-ui/ready' }));
    act(() => renderer!.update(view('second')));
    act(() => renderer!.update(view('third')));
    expect(resultMessages(posted)).toEqual(['first', 'second', 'third']);
  });

  it('posts to the view origin, sends teardown on unmount and does not grant allow-same-origin by default', () => {
    const { posted, send } = mount(<AppView componentUri="https://views.example.com/forecast" toolResult={{ content: 'x', isError: false }} />);
    act(() => send({ type: 'mcp-ui/ready' }));
    expect(posted.every(([, origin]) => origin === 'https://views.example.com')).toBe(true);
    const iframe = renderer!.root.findByType('iframe');
    expect(iframe.props.sandbox).toBe('allow-scripts');
    act(() => renderer!.unmount());
    renderer = null;
    expect(posted.map(([m]) => (m as { type: string }).type)).toContain('ui/resource-teardown');
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
