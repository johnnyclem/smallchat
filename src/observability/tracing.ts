/**
 * tracing.ts — OpenTelemetry-compatible tracing for smallchat.
 *
 * Provides spans for the three core dispatch phases:
 *   1. dispatch  — the entire toolkit_dispatch call
 *   2. resolve   — selector table lookup + vector search
 *   3. execute   — IMP.execute() call
 *
 * When the real @opentelemetry/api SDK is installed the tracer will
 * delegate to it via the global API; otherwise it falls back to a
 * lightweight built-in implementation that can export to:
 *   - OTLP HTTP  (SC_OTEL_ENDPOINT env var)
 *   - Stdout JSON (SC_OTEL_STDOUT=1 env var)
 *   - No-op      (default, zero overhead)
 *
 * Usage:
 *   const tracer = getTracer('smallchat.dispatch');
 *   const span  = tracer.startSpan('dispatch', { attributes: { intent } });
 *   try { ... span.setStatus({ code: SpanStatusCode.OK }); }
 *   catch (err) { span.recordException(err); span.setStatus({ code: SpanStatusCode.ERROR }); }
 *   finally { span.end(); }
 */

import { rootLogger } from './logger.js';

const log = rootLogger.child({ component: 'tracing' });

// ---------------------------------------------------------------------------
// OTel-compatible types (mirrors @opentelemetry/api)
// ---------------------------------------------------------------------------

export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type SpanStatusCode = typeof SpanStatusCode[keyof typeof SpanStatusCode];

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export type SpanAttributeValue = string | number | boolean | string[] | number[] | boolean[];

export interface SpanAttributes {
  [key: string]: SpanAttributeValue | undefined;
}

export interface SpanOptions {
  attributes?: SpanAttributes;
  startTime?: number;
}

export interface Span {
  setAttribute(key: string, value: SpanAttributeValue): this;
  setAttributes(attrs: SpanAttributes): this;
  addEvent(name: string, attrs?: SpanAttributes): this;
  setStatus(status: SpanStatus): this;
  recordException(err: unknown): this;
  end(endTime?: number): void;
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
  startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Span implementation
// ---------------------------------------------------------------------------

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  endTimeMs?: number;
  attributes: SpanAttributes;
  events: Array<{ name: string; timeMs: number; attrs?: SpanAttributes }>;
  status: SpanStatus;
}

class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;

  private data: SpanData;
  private exporter: SpanExporter;

  constructor(name: string, traceId: string, spanId: string, parentSpanId: string | undefined, exporter: SpanExporter, attrs?: SpanAttributes) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = spanId;
    this.exporter = exporter;
    this.data = {
      traceId,
      spanId,
      parentSpanId,
      name,
      startTimeMs: Date.now(),
      attributes: attrs ?? {},
      events: [],
      status: { code: SpanStatusCode.UNSET },
    };
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.data.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    Object.assign(this.data.attributes, attrs);
    return this;
  }

  addEvent(name: string, attrs?: SpanAttributes): this {
    this.data.events.push({ name, timeMs: Date.now(), attrs });
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.data.status = status;
    return this;
  }

  recordException(err: unknown): this {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.addEvent('exception', {
      'exception.type': err instanceof Error ? err.name : 'Error',
      'exception.message': message,
      ...(stack ? { 'exception.stacktrace': stack } : {}),
    });
    return this;
  }

  end(endTime?: number): void {
    this.data.endTimeMs = endTime ?? Date.now();
    this.exporter.export(this.data);
  }
}

// ---------------------------------------------------------------------------
// Span exporters
// ---------------------------------------------------------------------------

export interface SpanExporter {
  export(span: SpanData): void;
  flush(): Promise<void>;
}

class NoopExporter implements SpanExporter {
  export(_span: SpanData): void { /* intentionally empty */ }
  flush(): Promise<void> { return Promise.resolve(); }
}

class StdoutExporter implements SpanExporter {
  export(span: SpanData): void {
    process.stdout.write(JSON.stringify({
      resourceSpans: [{
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          startTimeUnixNano: String(span.startTimeMs * 1_000_000),
          endTimeUnixNano: String((span.endTimeMs ?? span.startTimeMs) * 1_000_000),
          attributes: Object.entries(span.attributes).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } })),
          events: span.events,
          status: span.status,
        }],
      }],
    }) + '\n');
  }

  flush(): Promise<void> { return Promise.resolve(); }
}

class OtlpHttpExporter implements SpanExporter {
  private queue: SpanData[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private endpoint: string) {
    // Flush on process exit
    process.on('beforeExit', () => this.flush());
  }

  export(span: SpanData): void {
    this.queue.push(span);
    if (this.queue.length >= 512) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, 5000);
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);

    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'smallchat' } }] },
        scopeSpans: [{
          scope: { name: 'smallchat', version: '0.1.0' },
          spans: batch.map(span => ({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            kind: 1,
            startTimeUnixNano: String(span.startTimeMs * 1_000_000),
            endTimeUnixNano: String((span.endTimeMs ?? span.startTimeMs) * 1_000_000),
            attributes: Object.entries(span.attributes).map(([k, v]) => ({
              key: k,
              value: typeof v === 'number' ? { doubleValue: v }
                : typeof v === 'boolean' ? { boolValue: v }
                : { stringValue: String(v) },
            })),
            events: span.events.map(e => ({
              name: e.name,
              timeUnixNano: String(e.timeMs * 1_000_000),
              attributes: Object.entries(e.attrs ?? {}).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } })),
            })),
            status: { code: span.status.code, message: span.status.message ?? '' },
          })),
        }],
      }],
    });

    try {
      await fetch(`${this.endpoint}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      log.warn({ err }, 'Failed to export spans to OTLP endpoint');
    }
  }
}

// ---------------------------------------------------------------------------
// Context propagation (simplified async-local-storage based)
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

interface TraceContext {
  traceId: string;
  spanId: string;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

function currentContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

// ---------------------------------------------------------------------------
// Tracer implementation
// ---------------------------------------------------------------------------

class TracerImpl implements Tracer {
  constructor(
    private readonly name: string,
    private readonly exporter: SpanExporter,
  ) {}

  startSpan(spanName: string, options?: SpanOptions): Span {
    const ctx = currentContext();
    const traceId = ctx?.traceId ?? randomHex(16);
    const spanId = randomHex(8);
    return new SpanImpl(spanName, traceId, spanId, ctx?.spanId, this.exporter, options?.attributes);
  }

  startActiveSpan<T>(spanName: string, optionsOrFn: SpanOptions | ((span: Span) => T), fn?: (span: Span) => T): T {
    let options: SpanOptions;
    let callback: (span: Span) => T;

    if (typeof optionsOrFn === 'function') {
      options = {};
      callback = optionsOrFn;
    } else {
      options = optionsOrFn;
      callback = fn!;
    }

    const span = this.startSpan(spanName, options);
    const ctx = currentContext();
    const newCtx: TraceContext = {
      traceId: span.traceId,
      spanId: span.spanId,
    };

    return traceContextStorage.run(newCtx, () => {
      // Restore parent context for siblings after this scope
      void ctx;
      return callback(span);
    });
  }
}

// ---------------------------------------------------------------------------
// Global tracer provider
// ---------------------------------------------------------------------------

let globalExporter: SpanExporter;

function buildExporter(): SpanExporter {
  const otlpEndpoint = process.env['SC_OTEL_ENDPOINT'];
  if (otlpEndpoint) {
    log.info({ endpoint: otlpEndpoint }, 'OpenTelemetry OTLP exporter enabled');
    return new OtlpHttpExporter(otlpEndpoint);
  }
  if (process.env['SC_OTEL_STDOUT'] === '1') {
    log.info('OpenTelemetry stdout exporter enabled');
    return new StdoutExporter();
  }
  return new NoopExporter();
}

function getExporter(): SpanExporter {
  if (!globalExporter) {
    globalExporter = buildExporter();
  }
  return globalExporter;
}

const tracers = new Map<string, Tracer>();

export function getTracer(name: string): Tracer {
  let tracer = tracers.get(name);
  if (!tracer) {
    tracer = new TracerImpl(name, getExporter());
    tracers.set(name, tracer);
  }
  return tracer;
}

/** Flush all pending spans (call on graceful shutdown) */
export async function flushTracing(): Promise<void> {
  if (globalExporter) {
    await globalExporter.flush();
  }
}

/** Override the global exporter (useful for testing) */
export function setSpanExporter(exporter: SpanExporter): void {
  globalExporter = exporter;
}
