import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react';
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
// AppView — sandboxed iframe component for rendering MCP Apps views
//
// A ui:// view is an MCP resource, not a URL a browser can load: AppView
// renders its HTML (given as `html`, or read with `readResource`) through
// srcdoc. An http(s) view URI is loaded as the iframe src and messaged at
// its own origin. The bridge lives as long as the frame's content; new tool
// results are delivered to it without re-mounting (SAT-26).
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
  /** Tool result delivered to the view once it is ready, and again whenever it changes */
  toolResult?: ToolResult;
  /** Callback fired when the view sends a tool call or message */
  onInteraction?: (event: string, sourceToolName: string, payload: unknown) => void;
  /** Called when a ui:// resource cannot be read */
  onError?: (error: Error) => void;
  /** Preferred display mode */
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  /** Whether to add a visible border (hint from McpUiResourceMeta.prefersBorder) */
  prefersBorder?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /**
   * iframe sandbox attribute value (default: "allow-scripts"). Adding
   * allow-same-origin to allow-scripts lets a view served from your own
   * origin remove its sandbox; grant it only to views you trust.
   */
  sandbox?: string;
  /** iframe title for accessibility */
  title?: string;
}

const isResourceUri = (uri: string) => uri.startsWith('ui://');

/** Origin to post to: the view URL's own origin; '*' for srcdoc frames, whose sandboxed origin is opaque. */
function messageOrigin(uri: string): string {
  if (isResourceUri(uri)) return '*';
  try {
    return new URL(uri).origin;
  } catch {
    return '*';
  }
}

/**
 * AppView — renders a MCP Apps view in a sandboxed iframe.
 *
 * Security: the iframe is sandboxed with allow-scripts only by default; use
 * the sandbox prop to change it. Messages go only to the frame's own
 * window, addressed to the view URL's origin when it has one.
 */
export function AppView({
  componentUri,
  html,
  readResource,
  toolResult,
  onInteraction,
  onError,
  displayMode = 'inline',
  prefersBorder = false,
  className,
  style,
  sandbox = 'allow-scripts',
  title = 'MCP App View',
}: AppViewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState<{ uri: string; html?: string; error?: Error } | null>(null);

  // Latest props, read by the long-lived bridge without re-mounting it.
  const toolResultRef = useRef(toolResult);
  const onInteractionRef = useRef(onInteraction);
  const onErrorRef = useRef(onError);
  const readyRef = useRef(false);
  const deliverRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    onInteractionRef.current = onInteraction;
    onErrorRef.current = onError;
  });

  const resource = isResourceUri(componentUri);
  const resourceHtml = resource ? (html ?? (loaded?.uri === componentUri ? loaded.html : undefined)) : undefined;
  const loadError = resource && html === undefined && loaded?.uri === componentUri ? loaded.error : undefined;
  const targetOrigin = messageOrigin(componentUri);
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
        onErrorRef.current?.(error);
      },
    );
    return () => { stale = true; };
  }, [componentUri, html, readResource, resource]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || frameSource === undefined) return;

    readyRef.current = false;
    const post = (message: unknown) => iframe.contentWindow?.postMessage(message, targetOrigin);
    const deliver = () => {
      const result = toolResultRef.current;
      if (result) post({ type: 'ui/notifications/tool-result', toolName: '', result: result.content });
    };

    const handleMessage = (evt: MessageEvent) => {
      if (evt.source !== iframe.contentWindow) return;
      const data = evt.data as Record<string, unknown>;

      if (data?.type === 'mcp-ui/ready') {
        readyRef.current = true;
        deliver();
      }

      if (data?.type === 'tools/call') {
        onInteractionRef.current?.('tool-call', (data.toolName as string) ?? '', data.arguments);
      }

      if (data?.type === 'ui/message') {
        onInteractionRef.current?.('message', '', data.content);
      }
    };

    window.addEventListener('message', handleMessage);
    deliverRef.current = deliver;

    return () => {
      // Tell the view first, while it can still receive the message.
      if (readyRef.current) post({ type: 'ui/resource-teardown' });
      readyRef.current = false;
      deliverRef.current = null;
      window.removeEventListener('message', handleMessage);
    };
  }, [frameSource, targetOrigin]);

  // Deliver each new tool result to a ready view.
  useEffect(() => {
    toolResultRef.current = toolResult;
    if (readyRef.current) deliverRef.current?.();
  }, [toolResult]);

  if (resource && resourceHtml === undefined && (loadError || !readResource)) {
    const message = loadError
      ? `AppView: could not read ${componentUri}: ${loadError.message}`
      : `AppView: ${componentUri} is an MCP resource; pass its html, or readResource to read it.`;
    return (<div role="alert" className={className} style={style}>{message}</div>) as unknown as JSX.Element;
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
  ) as unknown as JSX.Element;
}

// Re-export UIRuntime type for consumers who want to type their context value
export type { UIRuntime } from '@smallchat/core/app';
