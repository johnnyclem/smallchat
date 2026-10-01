import {
  useState, useCallback, useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, createContext, useContext,
  type CSSProperties,
} from 'react';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ToolRuntime, ToolResult, DispatchEvent, AppIMP, DispatchEventUIAvailable } from '@smallchat/core';
import type { UIRuntime } from '@smallchat/core/app';

// ---------------------------------------------------------------------------
// Context — provide a ToolRuntime to the tree
// ---------------------------------------------------------------------------

const SmallchatContext = createContext<ToolRuntime | null>(null);

export const SmallchatProvider = SmallchatContext.Provider;

export function useSmallchatRuntime(): ToolRuntime {
  const runtime = useContext(SmallchatContext);
  if (!runtime) {
    throw new Error(
      'useSmallchatRuntime: no ToolRuntime found. ' +
      'Wrap your component tree with <SmallchatProvider value={runtime}>.',
    );
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// One run at a time
//
// Starting a run (or cancel(), or unmounting) aborts the previous one, and
// only the current run writes state. A shared boolean cancel flag, reset on
// every call, let a previous stream keep appending to the same state
// (SAT-27).
// ---------------------------------------------------------------------------

function useLatestRun(): {
  start: () => { signal: AbortSignal; isCurrent: () => boolean };
  cancel: () => void;
} {
  const current = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    current.current?.abort();
    current.current = null;
  }, []);

  const start = useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return { signal: controller.signal, isCurrent: () => current.current === controller };
  }, []);

  useEffect(() => cancel, [cancel]);

  return { start, cancel };
}

// ---------------------------------------------------------------------------
// useToolDispatch — fire-and-forget dispatch with state tracking
// ---------------------------------------------------------------------------

export interface UseToolDispatchOptions {
  /** Custom runtime (overrides context) */
  runtime?: ToolRuntime;
}

export interface UseToolDispatchResult<T = unknown> {
  /** Execute the dispatch */
  dispatch: (intent: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  /** Latest result */
  data: T | null;
  /** Full ToolResult */
  result: ToolResult | null;
  /** Loading state */
  loading: boolean;
  /** Error if the dispatch failed */
  error: Error | null;
  /** Reset state */
  reset: () => void;
}

export function useToolDispatch<T = unknown>(
  options?: UseToolDispatchOptions,
): UseToolDispatchResult<T> {
  const contextRuntime = useContext(SmallchatContext);
  const runtime = options?.runtime ?? contextRuntime;

  const [data, setData] = useState<T | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Every call runs to completion (a dispatch may have side effects), but
  // only the latest call's outcome becomes the hook's state.
  const latest = useRef(0);

  const dispatch = useCallback(
    async (intent: string, args?: Record<string, unknown>): Promise<ToolResult> => {
      if (!runtime) {
        throw new Error(
          'useToolDispatch: no ToolRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatProvider>.',
        );
      }

      const call = ++latest.current;
      setLoading(true);
      setError(null);

      try {
        const res = await runtime.dispatch(intent, args ?? {});
        if (call === latest.current) {
          setResult(res);
          setData(res.content as T);
          setLoading(false);
        }
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (call === latest.current) {
          setError(e);
          setLoading(false);
        }
        throw e;
      }
    },
    [runtime],
  );

  const reset = useCallback(() => {
    latest.current++;
    setData(null);
    setResult(null);
    setLoading(false);
    setError(null);
  }, []);

  return { dispatch, data, result, loading, error, reset };
}

// ---------------------------------------------------------------------------
// useToolStream — streaming dispatch with progressive updates
// ---------------------------------------------------------------------------

export interface UseToolStreamOptions {
  runtime?: ToolRuntime;
}

export interface UseToolStreamResult {
  /** Start streaming a dispatch */
  stream: (intent: string, args?: Record<string, unknown>) => void;
  /** All events received so far */
  events: DispatchEvent[];
  /** Accumulated content chunks */
  chunks: unknown[];
  /** Whether the stream is active */
  streaming: boolean;
  /** Error if the stream failed */
  error: Error | null;
  /** Cancel the active stream */
  cancel: () => void;
}

export function useToolStream(options?: UseToolStreamOptions): UseToolStreamResult {
  const contextRuntime = useContext(SmallchatContext);
  const runtime = options?.runtime ?? contextRuntime;

  const [events, setEvents] = useState<DispatchEvent[]>([]);
  const [chunks, setChunks] = useState<unknown[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useLatestRun();

  const cancel = useCallback(() => {
    run.cancel();
    setStreaming(false);
  }, [run.cancel]);

  const stream = useCallback(
    (intent: string, args?: Record<string, unknown>) => {
      if (!runtime) {
        throw new Error(
          'useToolStream: no ToolRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatProvider>.',
        );
      }

      // Aborts the previous stream (and the tool it is running).
      const { signal, isCurrent } = run.start();
      setEvents([]);
      setChunks([]);
      setStreaming(true);
      setError(null);

      (async () => {
        try {
          for await (const event of runtime.dispatchStream(intent, args, { signal })) {
            if (!isCurrent()) break;

            setEvents((prev) => [...prev, event]);

            if (event.type === 'chunk') {
              setChunks((prev) => [...prev, event.content]);
            } else if (event.type === 'error') {
              setError(new Error(event.error));
            }
          }
        } catch (err) {
          if (isCurrent()) setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (isCurrent()) setStreaming(false);
        }
      })();
    },
    [runtime, run.start],
  );

  return { stream, events, chunks, streaming, error, cancel };
}

// ---------------------------------------------------------------------------
// useInferenceStream — token-level streaming for progressive text display
// ---------------------------------------------------------------------------

export interface UseInferenceStreamResult {
  /** Start inference streaming */
  infer: (intent: string, args?: Record<string, unknown>) => void;
  /** Accumulated text so far */
  text: string;
  /** Whether inference is active */
  inferring: boolean;
  /** Error if inference failed */
  error: Error | null;
  /** Cancel the active inference */
  cancel: () => void;
}

export function useInferenceStream(options?: UseToolStreamOptions): UseInferenceStreamResult {
  const contextRuntime = useContext(SmallchatContext);
  const runtime = options?.runtime ?? contextRuntime;

  const [text, setText] = useState('');
  const [inferring, setInferring] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useLatestRun();

  const cancel = useCallback(() => {
    run.cancel();
    setInferring(false);
  }, [run.cancel]);

  const infer = useCallback(
    (intent: string, args?: Record<string, unknown>) => {
      if (!runtime) {
        throw new Error(
          'useInferenceStream: no ToolRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatProvider>.',
        );
      }

      const { signal, isCurrent } = run.start();
      setText('');
      setInferring(true);
      setError(null);

      (async () => {
        try {
          for await (const token of runtime.inferenceStream(intent, args, { signal })) {
            if (!isCurrent()) break;
            setText((prev) => prev + token);
          }
        } catch (err) {
          if (isCurrent()) setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (isCurrent()) setInferring(false);
        }
      })();
    },
    [runtime, run.start],
  );

  return { infer, text, inferring, error, cancel };
}

// ---------------------------------------------------------------------------
// MCP Apps Extension — UI component dispatch hooks and components
//
// Extends the existing hook pattern to cover the component dispatch space.
// The analogy holds exactly: useAppDispatch ≈ useToolDispatch, but resolves
// to an AppIMP (a ui:// view) instead of a ToolIMP (an executable tool).
// ---------------------------------------------------------------------------

const SmallchatAppContext = createContext<UIRuntime | null>(null);
export const SmallchatAppProvider = SmallchatAppContext.Provider;

export function useUIRuntime(): UIRuntime {
  const runtime = useContext(SmallchatAppContext);
  if (!runtime) {
    throw new Error(
      'useUIRuntime: no UIRuntime found. ' +
      'Wrap your component tree with <SmallchatAppProvider value={uiRuntime}>.',
    );
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// useAppDispatch — fire-and-forget UI component dispatch
// ---------------------------------------------------------------------------

export interface UseAppDispatchOptions {
  runtime?: UIRuntime;
}

export interface UseAppDispatchResult {
  /** Resolve a UI intent to a mounted AppIMP */
  dispatch: (intent: string) => Promise<AppIMP | null>;
  /** The resolved AppIMP (null if not yet dispatched or no view found) */
  appImp: AppIMP | null;
  /** Whether dispatch is in progress */
  loading: boolean;
  /** Error if dispatch failed */
  error: Error | null;
  /** Reset state */
  reset: () => void;
}

export function useAppDispatch(options?: UseAppDispatchOptions): UseAppDispatchResult {
  const contextRuntime = useContext(SmallchatAppContext);
  const runtime = options?.runtime ?? contextRuntime;

  const [appImp, setAppImp] = useState<AppIMP | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const latest = useRef(0);

  const dispatch = useCallback(
    async (intent: string): Promise<AppIMP | null> => {
      if (!runtime) {
        throw new Error(
          'useAppDispatch: no UIRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatAppProvider>.',
        );
      }

      const call = ++latest.current;
      setLoading(true);
      setError(null);

      try {
        const imp = await runtime.ui_dispatch(intent);
        if (call === latest.current) {
          setAppImp(imp);
          setLoading(false);
        }
        return imp;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (call === latest.current) {
          setError(e);
          setLoading(false);
        }
        throw e;
      }
    },
    [runtime],
  );

  const reset = useCallback(() => {
    latest.current++;
    setAppImp(null);
    setLoading(false);
    setError(null);
  }, []);

  return { dispatch, appImp, loading, error, reset };
}

// ---------------------------------------------------------------------------
// useAppStream — streaming dispatch that surfaces UI lifecycle events
// ---------------------------------------------------------------------------

export interface UseAppStreamOptions {
  runtime?: UIRuntime;
}

export interface UseAppStreamResult {
  /** Start a streaming UI dispatch */
  stream: (intent: string, toolResult: ToolResult) => void;
  /** All dispatch events received (tool + UI combined) */
  events: DispatchEvent[];
  /** Only the UI-specific events */
  uiEvents: DispatchEvent[];
  /** Whether the stream is active */
  streaming: boolean;
  /** Error if the stream failed */
  error: Error | null;
  /** Cancel the active stream */
  cancel: () => void;
}

export function useAppStream(options?: UseAppStreamOptions): UseAppStreamResult {
  const contextRuntime = useContext(SmallchatAppContext);
  const runtime = options?.runtime ?? contextRuntime;

  const [events, setEvents] = useState<DispatchEvent[]>([]);
  const [uiEvents, setUIEvents] = useState<DispatchEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useLatestRun();

  const cancel = useCallback(() => {
    run.cancel();
    setStreaming(false);
  }, [run.cancel]);

  const stream = useCallback(
    (intent: string, toolResult: ToolResult) => {
      if (!runtime) {
        throw new Error(
          'useAppStream: no UIRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatAppProvider>.',
        );
      }

      const { isCurrent } = run.start();
      setEvents([]);
      setUIEvents([]);
      setStreaming(true);
      setError(null);

      (async () => {
        try {
          for await (const event of runtime.ui_dispatchStream(intent, toolResult)) {
            if (!isCurrent()) break;

            setEvents(prev => [...prev, event]);

            if (
              event.type === 'ui-available' ||
              event.type === 'ui-ready' ||
              event.type === 'ui-update' ||
              event.type === 'ui-interaction'
            ) {
              setUIEvents(prev => [...prev, event]);
            }

            if (event.type === 'error') {
              setError(new Error((event as { error: string }).error));
            }
          }
        } catch (err) {
          if (isCurrent()) setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (isCurrent()) setStreaming(false);
        }
      })();
    },
    [runtime, run.start],
  );

  return { stream, events, uiEvents, streaming, error, cancel };
}

// ---------------------------------------------------------------------------
// AppView — sandboxed iframe host for an MCP Apps view
//
// A ui:// view is an MCP resource, not a URL a browser can load: AppView
// renders its HTML (given as `html`, or read with `readResource`) through
// srcdoc. An http(s) view URI is loaded as the iframe src.
//
// AppView is the host side of the MCP Apps protocol (@modelcontextprotocol/
// ext-apps): an AppBridge answers the view's ui/initialize, then sends
// ui/notifications/tool-input and a ui/notifications/tool-result for the
// current toolResult and for every later one, and answers the view's
// tools/call and ui/message requests. The bridge lives as long as the
// frame's content; new tool results reach it without re-mounting (SAT-26).
//
// Obj-C analogy: AppView ≈ NSView — it owns the visual representation of
// an AppIMP, just as NSView owns pixels on screen.
// ---------------------------------------------------------------------------

export interface AppViewProps {
  /** The view's URI: a ui:// resource (see html / readResource) or an http(s) URL */
  componentUri: string;
  /** HTML of a ui:// resource (the MCP resources/read result's text) */
  html?: string;
  /** Reads a ui:// resource's HTML, e.g. through your MCP client's resources/read; used when html is not given */
  readResource?: (uri: string) => Promise<string>;
  /** Arguments of the tool call the view belongs to, sent once as ui/notifications/tool-input (default {}) */
  toolInput?: Record<string, unknown>;
  /** Tool result sent as ui/notifications/tool-result once the view has initialized, and again whenever it changes */
  toolResult?: ToolResult;
  /**
   * Runs a tools/call the view sends, e.g. with runtime.dispatchById; its
   * result is the view's answer. Without it the view's tool calls fail.
   */
  onCallTool?: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** Fired when the view sends a tool call ('tool-call') or a ui/message ('message') */
  onInteraction?: (event: string, sourceToolName: string, payload: unknown) => void;
  /** Called when a ui:// resource cannot be read */
  onError?: (error: Error) => void;
  /** Display mode, sent to the view in its host context */
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  /** Whether to add a visible border (hint from McpUiResourceMeta.prefersBorder) */
  prefersBorder?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * iframe sandbox attribute value (default: "allow-scripts"). Adding
   * allow-same-origin to allow-scripts lets a view served from your own
   * origin remove its sandbox; grant it only to views you trust.
   */
  sandbox?: string;
  /** iframe title for accessibility */
  title?: string;
}

/** Imperative handle of an AppView (`ref`). */
export interface AppViewHandle {
  /**
   * Sends ui/resource-teardown and resolves true once the view has answered
   * (false when no view is connected or it did not answer within timeoutMs,
   * default 5000). Await it before you unmount the AppView or change its
   * componentUri: a frame that has been removed from the page receives no
   * messages, so unmounting alone never reaches the view. After teardown the
   * view gets no further messages.
   */
  teardown(options?: { timeoutMs?: number }): Promise<boolean>;
}

type CallToolResult = Parameters<AppBridge['sendToolResult']>[0];
type BridgeTransport = Parameters<AppBridge['connect']>[0];
type JSONRPCMessage = Parameters<BridgeTransport['send']>[0];

const HOST_INFO = { name: '@smallchat/react', version: '1.0.0' };
const CONTENT_BLOCK_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);

const isResourceUri = (uri: string) => uri.startsWith('ui://');

/** A smallchat ToolResult as the MCP CallToolResult the protocol carries. */
function toCallToolResult(result: ToolResult): CallToolResult {
  const { content } = result;
  const isError = result.isError ? { isError: true } : {};
  if (
    Array.isArray(content) && content.length > 0 &&
    content.every((b) => typeof b === 'object' && b !== null && CONTENT_BLOCK_TYPES.has((b as { type?: unknown }).type as string))
  ) {
    return { content: content as CallToolResult['content'], ...isError };
  }
  if (content === undefined || content === null) return { content: [], ...isError };
  if (typeof content === 'string') return { content: [{ type: 'text', text: content }], ...isError };
  const structured = typeof content === 'object' && !Array.isArray(content)
    ? { structuredContent: content as Record<string, unknown> }
    : {};
  return { content: [{ type: 'text', text: JSON.stringify(content) }], ...structured, ...isError };
}

/**
 * The origin AppView posts to and accepts messages from. A sandbox without
 * allow-same-origin gives the frame an opaque origin ('null'), which only
 * '*' reaches; messages are then matched by their source window alone.
 * With allow-same-origin the frame keeps its real origin: the view URL's,
 * or the host page's for a srcdoc (ui://) view.
 */
function frameOrigin(uri: string, sandbox: string): string {
  if (!sandbox.split(/\s+/).includes('allow-same-origin')) return '*';
  let origin: string | undefined;
  if (isResourceUri(uri)) {
    origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  } else {
    try { origin = new URL(uri).origin; } catch { origin = undefined; }
  }
  return origin && origin !== 'null' ? origin : '*';
}

/**
 * JSON-RPC over postMessage to one frame: sends to `origin`, accepts only
 * messages whose source is that frame's window (and, unless origin is '*',
 * whose origin matches).
 */
class FrameTransport implements BridgeTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly frame: Window, private readonly origin: string) {}

  private readonly listener = (evt: MessageEvent) => {
    if (evt.source !== this.frame) return;
    if (this.origin !== '*' && evt.origin !== this.origin) return;
    const data = evt.data as { jsonrpc?: unknown } | null;
    if (typeof data !== 'object' || data === null || data.jsonrpc !== '2.0') return;
    this.onmessage?.(data as JSONRPCMessage);
  };

  async start(): Promise<void> {
    window.addEventListener('message', this.listener);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.frame.postMessage(message, this.origin);
  }

  async close(): Promise<void> {
    window.removeEventListener('message', this.listener);
    this.onclose?.();
  }
}

interface ConnectedView {
  bridge: AppBridge;
  transport: FrameTransport;
  initialized: boolean;
  closed: boolean;
  deliver: () => void;
  close: () => void;
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * AppView — renders an MCP Apps view in a sandboxed iframe and hosts it.
 *
 * Security: the iframe is sandboxed with allow-scripts only by default; use
 * the sandbox prop to change it. Messages go only to the frame's own window
 * and are accepted only from it; with allow-same-origin they are also bound
 * to the frame's origin.
 */
export const AppView = forwardRef<AppViewHandle, AppViewProps>(function AppView({
  componentUri,
  html,
  readResource,
  toolInput,
  toolResult,
  onCallTool,
  onInteraction,
  onError,
  displayMode = 'inline',
  prefersBorder = false,
  className,
  style,
  sandbox = 'allow-scripts',
  title = 'MCP App View',
}, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState<{ uri: string; html?: string; error?: Error } | null>(null);

  // Latest props, read by the long-lived bridge without re-mounting it.
  const latest = useRef({ toolInput, toolResult, onCallTool, onInteraction, onError, displayMode });
  useIsomorphicLayoutEffect(() => {
    latest.current = { toolInput, toolResult, onCallTool, onInteraction, onError, displayMode };
  });
  const viewRef = useRef<ConnectedView | null>(null);

  const resource = isResourceUri(componentUri);
  const resourceHtml = resource ? (html ?? (loaded?.uri === componentUri ? loaded.html : undefined)) : undefined;
  const loadError = resource && html === undefined && loaded?.uri === componentUri ? loaded.error : undefined;
  const origin = frameOrigin(componentUri, sandbox);
  // The frame's content; the bridge is rebuilt only when it changes.
  const frameSource = resource ? resourceHtml : componentUri;

  // Read a ui:// resource that was not given as html.
  useEffect(() => {
    if (!resource || html !== undefined || !readResource) return;
    let stale = false;
    readResource(componentUri).then(
      (text) => { if (!stale) setLoaded({ uri: componentUri, html: text }); },
      (err: unknown) => {
        if (stale) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setLoaded({ uri: componentUri, error });
        latest.current.onError?.(error);
      },
    );
    return () => { stale = true; };
  }, [componentUri, html, readResource, resource]);

  // Connect a bridge to the frame as soon as it is in the page, before its
  // content can send ui/initialize.
  useIsomorphicLayoutEffect(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || frameSource === undefined) return;

    const props = latest.current;
    const bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        ...(props.onCallTool ? { serverTools: {} } : {}),
        ...(props.onInteraction ? { message: { text: {} } } : {}),
      },
      { hostContext: { displayMode: props.displayMode } },
    );
    const transport = new FrameTransport(frame, origin);
    const view: ConnectedView = {
      bridge,
      transport,
      initialized: false,
      closed: false,
      deliver: () => {
        const result = latest.current.toolResult;
        if (!view.initialized || view.closed || !result) return;
        bridge.sendToolResult(toCallToolResult(result)).catch(() => {});
      },
      close: () => {
        if (view.closed) return;
        view.closed = true;
        // Closing the transport closes the bridge (rejecting pending requests).
        transport.close().catch(() => {});
      },
    };

    bridge.oninitialized = () => {
      view.initialized = true;
      bridge.sendToolInput({ arguments: latest.current.toolInput ?? {} })
        .then(view.deliver, () => {});
    };
    bridge.oncalltool = async (params) => {
      const args = params.arguments ?? {};
      latest.current.onInteraction?.('tool-call', params.name, args);
      const run = latest.current.onCallTool;
      if (!run) {
        return { content: [{ type: 'text', text: `This host does not run tools for views (${params.name})` }], isError: true };
      }
      try {
        return toCallToolResult(await run(params.name, args));
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    };
    bridge.onmessage = async (params) => {
      const notify = latest.current.onInteraction;
      if (!notify) return { isError: true };
      notify('message', '', params.content);
      return {};
    };

    viewRef.current = view;
    bridge.connect(transport).catch((err: unknown) => {
      latest.current.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      // The frame is about to be removed or to load new content: nothing
      // posted now would reach the view (see AppViewHandle.teardown).
      view.close();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [frameSource, origin]);

  // Deliver each new tool result to an initialized view.
  useEffect(() => {
    viewRef.current?.deliver();
  }, [toolResult]);

  useImperativeHandle(ref, () => ({
    async teardown({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<boolean> {
      const view = viewRef.current;
      if (!view || view.closed || !view.initialized) return false;
      try {
        await view.bridge.teardownResource({}, { timeout: timeoutMs });
        return true;
      } catch {
        return false;
      } finally {
        view.close();
      }
    },
  }), []);

  if (resource && resourceHtml === undefined && (loadError || !readResource)) {
    const message = loadError
      ? `AppView: could not read ${componentUri}: ${loadError.message}`
      : `AppView: ${componentUri} is an MCP resource; pass its html, or readResource to read it.`;
    return <div role="alert" className={className} style={style}>{message}</div>;
  }

  const borderStyle = prefersBorder
    ? { border: '1px solid var(--color-border-primary, #e0e0e0)', borderRadius: 4 }
    : {};

  return (
    <iframe
      ref={iframeRef}
      {...(resource ? { srcDoc: resourceHtml ?? '' } : { src: componentUri })}
      sandbox={sandbox}
      title={title}
      className={className}
      style={{
        width: displayMode === 'fullscreen' ? '100vw' : '100%',
        height: displayMode === 'fullscreen' ? '100vh' : 'auto',
        minHeight: 200,
        border: 'none',
        ...borderStyle,
        ...style,
      }}
    />
  );
});

// Re-export UIRuntime type for consumers who want to type their context value
export type { UIRuntime } from '@smallchat/core/app';
