import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react';
import type { ToolRuntime, ToolResult, DispatchEvent, AppIMP, DispatchEventUIAvailable } from 'smallchat';
import type { UIRuntime } from 'smallchat/app';

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

  const dispatch = useCallback(
    async (intent: string, args?: Record<string, unknown>): Promise<ToolResult> => {
      if (!runtime) {
        throw new Error(
          'useToolDispatch: no ToolRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatProvider>.',
        );
      }

      setLoading(true);
      setError(null);

      try {
        const res = await runtime.dispatch(intent, args);
        setResult(res);
        setData(res.content as T);
        setLoading(false);
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setLoading(false);
        throw e;
      }
    },
    [runtime],
  );

  const reset = useCallback(() => {
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
  const cancelRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const stream = useCallback(
    (intent: string, args?: Record<string, unknown>) => {
      if (!runtime) {
        throw new Error(
          'useToolStream: no ToolRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatProvider>.',
        );
      }

      cancelRef.current = false;
      setEvents([]);
      setChunks([]);
      setStreaming(true);
      setError(null);

      (async () => {
        try {
          for await (const event of runtime.dispatchStream(intent, args)) {
            if (cancelRef.current) break;

            setEvents((prev) => [...prev, event]);

            if (event.type === 'chunk') {
              setChunks((prev) => [...prev, event.content]);
            } else if (event.type === 'error') {
              setError(new Error(event.error));
            }
          }
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          setStreaming(false);
        }
      })();
    },
    [runtime],
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
  const cancelRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const infer = useCallback(
    (intent: string, args?: Record<string, unknown>) => {
      if (!runtime) {
        throw new Error(
          'useInferenceStream: no ToolRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatProvider>.',
        );
      }

      cancelRef.current = false;
      setText('');
      setInferring(true);
      setError(null);

      (async () => {
        try {
          for await (const token of runtime.inferenceStream(intent, args)) {
            if (cancelRef.current) break;
            setText((prev) => prev + token);
          }
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          setInferring(false);
        }
      })();
    },
    [runtime],
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

  const dispatch = useCallback(
    async (intent: string): Promise<AppIMP | null> => {
      if (!runtime) {
        throw new Error(
          'useAppDispatch: no UIRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatAppProvider>.',
        );
      }

      setLoading(true);
      setError(null);

      try {
        const imp = await runtime.ui_dispatch(intent);
        setAppImp(imp);
        setLoading(false);
        return imp;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setLoading(false);
        throw e;
      }
    },
    [runtime],
  );

  const reset = useCallback(() => {
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
  const cancelRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const stream = useCallback(
    (intent: string, toolResult: ToolResult) => {
      if (!runtime) {
        throw new Error(
          'useAppStream: no UIRuntime available. ' +
          'Either pass runtime in options or wrap with <SmallchatAppProvider>.',
        );
      }

      cancelRef.current = false;
      setEvents([]);
      setUIEvents([]);
      setStreaming(true);
      setError(null);

      (async () => {
        try {
          for await (const event of runtime.ui_dispatchStream(intent, toolResult)) {
            if (cancelRef.current) break;

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
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          setStreaming(false);
        }
      })();
    },
    [runtime],
  );

  return { stream, events, uiEvents, streaming, error, cancel };
}

// ---------------------------------------------------------------------------
// AppView — sandboxed iframe component for rendering MCP Apps views
//
// Manages the AppBridgeWrapper lifecycle via useEffect: mounts the bridge
// when componentUri changes, tears it down on unmount.
//
// Obj-C analogy: AppView ≈ NSView — it owns the visual representation of
// an AppIMP, just as NSView owns pixels on screen.
// ---------------------------------------------------------------------------

export interface AppViewProps {
  /** The ui:// resource URI to render */
  componentUri: string;
  /** Tool result to deliver to the view on mount */
  toolResult?: ToolResult;
  /** Callback fired when the view sends a tool call or message */
  onInteraction?: (event: string, sourceToolName: string, payload: unknown) => void;
  /** Preferred display mode */
  displayMode?: 'inline' | 'fullscreen' | 'pip';
  /** Whether to add a visible border (hint from McpUiResourceMeta.prefersBorder) */
  prefersBorder?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** iframe sandbox attribute value (default: "allow-scripts allow-same-origin") */
  sandbox?: string;
  /** iframe title for accessibility */
  title?: string;
}

/**
 * AppView — renders a MCP Apps view in a sandboxed iframe.
 *
 * Security: iframes are sandboxed with allow-scripts allow-same-origin by
 * default (matching the MCP Apps spec mandatory sandbox requirement).
 * Use the sandbox prop to tighten or widen permissions as needed.
 */
export function AppView({
  componentUri,
  toolResult,
  onInteraction,
  displayMode = 'inline',
  prefersBorder = false,
  className,
  style,
  sandbox = 'allow-scripts allow-same-origin',
  title = 'MCP App View',
}: AppViewProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [bridgeReady, setBridgeReady] = useState(false);

  useEffect(() => {
    if (!iframeRef.current || !componentUri) return;

    const iframe = iframeRef.current;
    let torn = false;

    // Minimal PostMessage bridge for SSR-safe environments.
    // In production this would use @modelcontextprotocol/ext-apps/app-bridge AppBridge.
    const handleMessage = (evt: MessageEvent) => {
      if (evt.source !== iframe.contentWindow) return;
      const data = evt.data as Record<string, unknown>;

      if (data?.type === 'mcp-ui/ready') {
        setBridgeReady(true);
        // Deliver initial tool result if provided
        if (toolResult) {
          iframe.contentWindow?.postMessage(
            { type: 'ui/notifications/tool-result', toolName: '', result: toolResult.content },
            '*',
          );
        }
      }

      if (data?.type === 'tools/call' && onInteraction) {
        onInteraction(
          'tool-call',
          (data.toolName as string) ?? '',
          data.arguments,
        );
      }

      if (data?.type === 'ui/message' && onInteraction) {
        onInteraction('message', '', data.content);
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      torn = true;
      window.removeEventListener('message', handleMessage);
      setBridgeReady(false);
      // Send teardown notification to the view before unmounting
      if (!torn && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'ui/resource-teardown' }, '*');
      }
    };
  }, [componentUri, toolResult, onInteraction]);

  // Deliver updated toolResult when it changes after mount
  useEffect(() => {
    if (!bridgeReady || !toolResult || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'ui/notifications/tool-result', toolName: '', result: toolResult.content },
      '*',
    );
  }, [toolResult, bridgeReady]);

  const borderStyle = prefersBorder
    ? { border: '1px solid var(--color-border-primary, #e0e0e0)', borderRadius: 4 }
    : {};

  return (
    <iframe
      ref={iframeRef}
      src={componentUri}
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
export type { UIRuntime } from 'smallchat/app';
