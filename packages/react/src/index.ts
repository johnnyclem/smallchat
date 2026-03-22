import { useState, useCallback, useRef, useEffect, createContext, useContext } from 'react';
import type { ToolRuntime, ToolResult, DispatchEvent } from 'smallchat';

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
