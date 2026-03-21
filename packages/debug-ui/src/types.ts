// Types shared between Debug UI components

export interface DispatchRecord {
  timestamp: string;
  intent: string;
  selector?: string;
  resolvedTool?: string;
  args?: Record<string, unknown>;
  candidateTools?: Array<{ tool: string; confidence: number }>;
  durationMs?: number;
  success: boolean;
  error?: string;
  cacheHit?: boolean;
  usedFallback?: boolean;
  fallbackSteps?: Array<{ strategy: string; tried: string; result: string }>;
  meta?: Record<string, unknown>;
}

export interface HealthData {
  status: string;
  version: string;
  protocolVersion: string;
  tools: number;
  providers: number;
  sessions: number;
  sseClients: number;
  activeExecutions: number;
  queueDepth: number;
  cacheHitRate: number;
  shuttingDown: boolean;
}

export interface MetricsData {
  sc_dispatch_total?: Record<string, number>;
  sc_dispatch_errors_total?: Record<string, number>;
  sc_tool_latency_ms?: Record<string, { p50: number; p90: number; p99: number; mean: number; count: number }>;
  sc_cache_hits_total?: Record<string, number>;
  sc_cache_misses_total?: Record<string, number>;
  sc_active_executions?: Record<string, number>;
  sc_queue_depth?: Record<string, number>;
  [key: string]: unknown;
}

export interface TraceCandidate {
  tool: string;
  confidence: number;
  semanticDistance: number;
}

export type TabId = 'overview' | 'traces' | 'trace-viz' | 'metrics' | 'flight';
