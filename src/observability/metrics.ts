/**
 * metrics.ts — Metrics registry for smallchat.
 *
 * Implements a lightweight in-process metrics registry exposing:
 *   - Counter    — monotonically increasing count (dispatch_count, cache_hit_rate)
 *   - Histogram  — latency distribution (tool_latency)
 *   - Gauge      — current point-in-time value (active_connections, queue_depth)
 *
 * Metrics can be scraped via:
 *   - GET /metrics → Prometheus text format (when server is running)
 *   - metricsRegistry.toJSON() → programmatic access
 *
 * Standard smallchat metrics automatically registered:
 *   - sc_dispatch_total         counter
 *   - sc_dispatch_errors_total  counter
 *   - sc_tool_latency_ms        histogram
 *   - sc_cache_hits_total       counter
 *   - sc_cache_misses_total     counter
 *   - sc_active_executions      gauge
 *   - sc_queue_depth            gauge
 */

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

export type MetricLabels = Record<string, string>;

export interface MetricOptions {
  help: string;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

export class Counter {
  readonly name: string;
  readonly help: string;
  private values: Map<string, number> = new Map();

  constructor(name: string, options: MetricOptions) {
    this.name = name;
    this.help = options.help;
  }

  inc(labels?: MetricLabels, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(labelsKey(labels)) ?? 0;
  }

  /** Reset all counters (used in tests) */
  reset(): void {
    this.values.clear();
  }

  toPrometheus(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key} ${value}`);
    }
    return lines.join('\n');
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}

// ---------------------------------------------------------------------------
// Histogram (fixed buckets, P50/P90/P99 computed on-the-fly)
// ---------------------------------------------------------------------------

const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class Histogram {
  readonly name: string;
  readonly help: string;
  private readonly buckets: number[];

  // Per-label-set data
  private data: Map<string, {
    counts: number[];  // aligned with this.buckets
    inf: number;       // > max bucket
    sum: number;
    count: number;
    values: number[];  // raw values for percentile calculation (capped at 10k)
  }> = new Map();

  constructor(name: string, options: MetricOptions & { buckets?: number[] }) {
    this.name = name;
    this.help = options.help;
    this.buckets = (options.buckets ?? DEFAULT_BUCKETS).sort((a, b) => a - b);
  }

  observe(value: number, labels?: MetricLabels): void {
    const key = labelsKey(labels);
    let d = this.data.get(key);
    if (!d) {
      d = { counts: new Array(this.buckets.length).fill(0), inf: 0, sum: 0, count: 0, values: [] };
      this.data.set(key, d);
    }

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        d.counts[i]++;
      }
    }
    if (value > (this.buckets[this.buckets.length - 1] ?? Infinity)) {
      d.inf++;
    }

    d.sum += value;
    d.count++;
    if (d.values.length < 10000) {
      d.values.push(value);
    }
  }

  percentile(p: number, labels?: MetricLabels): number {
    const d = this.data.get(labelsKey(labels));
    if (!d || d.values.length === 0) return 0;
    const sorted = [...d.values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  }

  mean(labels?: MetricLabels): number {
    const d = this.data.get(labelsKey(labels));
    if (!d || d.count === 0) return 0;
    return d.sum / d.count;
  }

  toPrometheus(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const [key, d] of this.data) {
      // Cumulative bucket counts
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += d.counts[i];
        const le = this.buckets[i];
        lines.push(`${this.name}_bucket${mergeLabels(key, `le="${le}"`)} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${mergeLabels(key, 'le="+Inf"')} ${d.count}`);
      lines.push(`${this.name}_sum${key} ${d.sum}`);
      lines.push(`${this.name}_count${key} ${d.count}`);
    }

    return lines.join('\n');
  }

  toJSON(): Record<string, { p50: number; p90: number; p99: number; mean: number; count: number }> {
    const result: Record<string, { p50: number; p90: number; p99: number; mean: number; count: number }> = {};
    for (const [key, d] of this.data) {
      const sorted = [...d.values].sort((a, b) => a - b);
      result[key || 'default'] = {
        p50: sorted[Math.ceil(0.50 * sorted.length) - 1] ?? 0,
        p90: sorted[Math.ceil(0.90 * sorted.length) - 1] ?? 0,
        p99: sorted[Math.ceil(0.99 * sorted.length) - 1] ?? 0,
        mean: d.count > 0 ? d.sum / d.count : 0,
        count: d.count,
      };
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

export class Gauge {
  readonly name: string;
  readonly help: string;
  private values: Map<string, number> = new Map();

  constructor(name: string, options: MetricOptions) {
    this.name = name;
    this.help = options.help;
  }

  set(value: number, labels?: MetricLabels): void {
    this.values.set(labelsKey(labels), value);
  }

  inc(labels?: MetricLabels, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  dec(labels?: MetricLabels, amount = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, Math.max(0, (this.values.get(key) ?? 0) - amount));
  }

  get(labels?: MetricLabels): number {
    return this.values.get(labelsKey(labels)) ?? 0;
  }

  toPrometheus(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key} ${value}`);
    }
    return lines.join('\n');
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}

// ---------------------------------------------------------------------------
// Metrics registry
// ---------------------------------------------------------------------------

export class MetricsRegistry {
  private counters: Map<string, Counter> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private gauges: Map<string, Gauge> = new Map();

  counter(name: string, options: MetricOptions): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, options);
      this.counters.set(name, c);
    }
    return c;
  }

  histogram(name: string, options: MetricOptions & { buckets?: number[] }): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, options);
      this.histograms.set(name, h);
    }
    return h;
  }

  gauge(name: string, options: MetricOptions): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, options);
      this.gauges.set(name, g);
    }
    return g;
  }

  /** Render all metrics in Prometheus text format */
  toPrometheus(): string {
    const sections: string[] = [];
    for (const c of this.counters.values()) sections.push(c.toPrometheus());
    for (const h of this.histograms.values()) sections.push(h.toPrometheus());
    for (const g of this.gauges.values()) sections.push(g.toPrometheus());
    return sections.join('\n\n') + '\n';
  }

  /** Render all metrics as a plain JSON object */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, c] of this.counters) out[name] = c.toJSON();
    for (const [name, h] of this.histograms) out[name] = h.toJSON();
    for (const [name, g] of this.gauges) out[name] = g.toJSON();
    return out;
  }

  /** Reset all metrics (used in tests) */
  reset(): void {
    for (const c of this.counters.values()) c.reset();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelsKey(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return `{${pairs}}`;
}

function mergeLabels(existing: string, extra: string): string {
  if (!existing) return `{${extra}}`;
  // existing is like {foo="bar"}, strip trailing brace and append
  return existing.slice(0, -1) + ',' + extra + '}';
}

// ---------------------------------------------------------------------------
// Standard smallchat metrics (singleton registry)
// ---------------------------------------------------------------------------

export const metricsRegistry = new MetricsRegistry();

export const metrics = {
  /** Total tool dispatches */
  dispatchTotal: metricsRegistry.counter('sc_dispatch_total', {
    help: 'Total number of tool dispatches',
    labels: ['provider', 'tool', 'status'],
  }),

  /** Total dispatch errors */
  dispatchErrors: metricsRegistry.counter('sc_dispatch_errors_total', {
    help: 'Total number of dispatch errors',
    labels: ['provider', 'tool', 'error_type'],
  }),

  /** Tool execution latency in milliseconds */
  toolLatency: metricsRegistry.histogram('sc_tool_latency_ms', {
    help: 'Tool execution latency in milliseconds',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    labels: ['provider', 'tool'],
  }),

  /** Total cache hits */
  cacheHits: metricsRegistry.counter('sc_cache_hits_total', {
    help: 'Total resolution cache hits',
  }),

  /** Total cache misses */
  cacheMisses: metricsRegistry.counter('sc_cache_misses_total', {
    help: 'Total resolution cache misses',
  }),

  /** Currently active (in-flight) tool executions */
  activeExecutions: metricsRegistry.gauge('sc_active_executions', {
    help: 'Number of currently active tool executions',
  }),

  /** Current dispatch queue depth */
  queueDepth: metricsRegistry.gauge('sc_queue_depth', {
    help: 'Current number of requests waiting in the dispatch queue',
  }),

  /** Total fallback chain invocations */
  fallbackTotal: metricsRegistry.counter('sc_fallback_total', {
    help: 'Total fallbacks through the forwarding chain',
    labels: ['strategy'],
  }),

  /** Embedding generation latency */
  embeddingLatency: metricsRegistry.histogram('sc_embedding_latency_ms', {
    help: 'Embedding generation latency in milliseconds',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  }),

  /** HTTP request latency */
  httpLatency: metricsRegistry.histogram('sc_http_latency_ms', {
    help: 'HTTP handler latency in milliseconds',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    labels: ['method', 'path', 'status'],
  }),

  /** Active SSE connections */
  sseConnections: metricsRegistry.gauge('sc_sse_connections', {
    help: 'Number of active SSE connections',
  }),

  /** Rate limit rejections */
  rateLimitRejections: metricsRegistry.counter('sc_rate_limit_rejections_total', {
    help: 'Total requests rejected by rate limiter',
    labels: ['client'],
  }),
};

/** Computed cache hit rate (0..1) */
export function cacheHitRate(): number {
  const hits = metrics.cacheHits.get();
  const misses = metrics.cacheMisses.get();
  const total = hits + misses;
  return total > 0 ? hits / total : 0;
}
