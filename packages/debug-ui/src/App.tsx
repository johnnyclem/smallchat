/**
 * App.tsx — smallchat Debug UI
 *
 * Tabs:
 *   Overview     — Health status, key metrics, live SSE feed
 *   Traces       — Paginated flight recorder log
 *   Trace Viz    — Semantic distance visualization for recent dispatches
 *   Metrics      — Live Prometheus metrics as charts
 *   Flight Log   — Raw NDJSON flight recorder viewer
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TraceView } from './TraceView';
import type { DispatchRecord, HealthData, MetricsData, TabId } from './types';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  app: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  header: {
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    padding: '12px 20px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  logo: { fontSize: 18, fontWeight: 700, color: '#79c0ff' },
  version: { fontSize: 12, color: '#8b949e' },
  statusDot: (ok: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: ok ? '#56d364' : '#da3633',
    marginLeft: 'auto',
  }),
  nav: {
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    display: 'flex',
    gap: 0,
    padding: '0 20px',
  },
  tab: (active: boolean): React.CSSProperties => ({
    padding: '10px 16px',
    cursor: 'pointer',
    fontSize: 13,
    color: active ? '#79c0ff' : '#8b949e',
    borderBottom: active ? '2px solid #79c0ff' : '2px solid transparent',
    background: 'none',
    border: 'none',
    borderBottomColor: active ? '#79c0ff' : 'transparent',
    borderBottomWidth: 2,
    borderBottomStyle: 'solid',
    fontFamily: 'inherit',
  }),
  content: {
    flex: 1,
    padding: 20,
    maxWidth: 1100,
    margin: '0 auto',
    width: '100%',
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
    marginBottom: 16,
  } as React.CSSProperties,
  card: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 8,
    padding: 16,
  } as React.CSSProperties,
  cardTitle: { fontSize: 12, color: '#8b949e', marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  stat: { fontSize: 28, fontWeight: 700, color: '#79c0ff' },
  statLabel: { fontSize: 12, color: '#8b949e', marginTop: 2 },
  error: { color: '#da3633', fontSize: 12, padding: 8 },
  refresh: {
    padding: '6px 12px',
    background: '#21262d',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#c9d1d9',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  input: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: 6,
    color: '#c9d1d9',
    padding: '6px 10px',
    fontSize: 12,
    fontFamily: 'inherit',
    width: '100%',
  },
  metricRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    borderBottom: '1px solid #21262d',
    fontSize: 13,
  } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const API_BASE = '/api';

async function fetchHealth(): Promise<HealthData> {
  const res = await fetch(`${API_BASE}/health`);
  return res.json();
}

async function fetchMetrics(): Promise<MetricsData> {
  // Fetch JSON metrics from the server
  const res = await fetch(`${API_BASE}/metrics`);
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  // Parse Prometheus text format into simple key counts
  const text = await res.text();
  const result: MetricsData = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const match = line.match(/^(\w+)(?:\{[^}]*\})?\s+([\d.e+\-]+)/);
    if (match) {
      const key = match[1] as keyof MetricsData;
      if (!result[key]) result[key] = {};
      (result[key] as Record<string, number>)['total'] = parseFloat(match[2]);
    }
  }
  return result;
}

// Flight recorder data is read from server flight endpoint or local file
async function fetchFlight(): Promise<DispatchRecord[]> {
  try {
    const res = await fetch(`${API_BASE}/debug/flight`);
    if (res.ok) return res.json();
  } catch { /* fallback */ }
  return [];
}

// ---------------------------------------------------------------------------
// Overview Tab
// ---------------------------------------------------------------------------

function OverviewTab({ health, metrics }: { health: HealthData | null; metrics: MetricsData | null }) {
  if (!health) return <div style={s.error}>Failed to load health data. Is the server running?</div>;

  const dispatchTotal = Object.values(metrics?.sc_dispatch_total ?? {}).reduce((a: number, b) => a + (b as number), 0);
  const errorTotal = Object.values(metrics?.sc_dispatch_errors_total ?? {}).reduce((a: number, b) => a + (b as number), 0);

  return (
    <div>
      <div style={s.grid2}>
        <div style={s.card}>
          <div style={s.cardTitle}>Status</div>
          <div style={{ ...s.stat, color: health.status === 'ok' ? '#56d364' : '#da3633' }}>
            {health.status.toUpperCase()}
          </div>
          <div style={s.statLabel}>v{health.version} · MCP {health.protocolVersion}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>Tools</div>
          <div style={s.stat}>{health.tools}</div>
          <div style={s.statLabel}>{health.providers} providers</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>Cache Hit Rate</div>
          <div style={{ ...s.stat, color: health.cacheHitRate > 0.8 ? '#56d364' : '#9e6a03' }}>
            {(health.cacheHitRate * 100).toFixed(1)}%
          </div>
          <div style={s.statLabel}>Resolution cache</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>Active</div>
          <div style={s.stat}>{health.activeExecutions}</div>
          <div style={s.statLabel}>{health.queueDepth} queued · {health.sessions} sessions · {health.sseClients} SSE</div>
        </div>
      </div>

      <div style={s.card}>
        <div style={s.cardTitle}>Dispatch Metrics</div>
        <div style={s.metricRow}>
          <span>Total dispatches</span>
          <span style={{ color: '#79c0ff' }}>{dispatchTotal}</span>
        </div>
        <div style={s.metricRow}>
          <span>Errors</span>
          <span style={{ color: errorTotal > 0 ? '#da3633' : '#8b949e' }}>{errorTotal}</span>
        </div>
        <div style={s.metricRow}>
          <span>Success rate</span>
          <span style={{ color: '#56d364' }}>
            {dispatchTotal > 0 ? ((1 - errorTotal / dispatchTotal) * 100).toFixed(1) : '—'}%
          </span>
        </div>
        {metrics?.sc_tool_latency_ms && Object.entries(metrics.sc_tool_latency_ms as Record<string, { p50: number; p90: number; p99: number; mean: number; count: number }>).map(([key, lat]) => (
          <div key={key} style={s.metricRow}>
            <span>Latency ({key})</span>
            <span style={{ color: '#8b949e' }}>p50: {lat.p50}ms · p99: {lat.p99}ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trace Visualization Tab (Feature 9)
// ---------------------------------------------------------------------------

function TraceVizTab({ records }: { records: DispatchRecord[] }) {
  const [filter, setFilter] = useState('');

  const filtered = records.filter(r =>
    !filter || r.intent.toLowerCase().includes(filter.toLowerCase()) ||
    r.resolvedTool?.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <input
          style={s.input}
          placeholder="Filter by intent or tool name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#8b949e', alignSelf: 'center' }}>
          {filtered.length} of {records.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ color: '#8b949e', fontSize: 13, textAlign: 'center', padding: 40 }}>
          {records.length === 0
            ? 'No dispatch records yet. Make some tool calls to see traces.'
            : 'No records match your filter.'}
        </div>
      ) : (
        filtered.slice(-50).reverse().map((record, i) => (
          <TraceView key={`${record.timestamp}-${i}`} record={record} />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics Tab
// ---------------------------------------------------------------------------

function MetricsTab({ metrics }: { metrics: MetricsData | null }) {
  if (!metrics) return <div style={s.error}>No metrics available. Enable with --metrics flag.</div>;

  const entries = Object.entries(metrics).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div>
      {entries.map(([name, value]) => (
        <div key={name} style={{ ...s.card, marginBottom: 12 }}>
          <div style={s.cardTitle}>{name}</div>
          {typeof value === 'object' && value !== null ? (
            Object.entries(value as Record<string, unknown>).map(([k, v]) => (
              <div key={k} style={s.metricRow}>
                <span style={{ color: '#8b949e' }}>{k || 'total'}</span>
                <span>{typeof v === 'number' ? v.toFixed(v % 1 === 0 ? 0 : 3) : JSON.stringify(v)}</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 20, fontWeight: 700, color: '#79c0ff' }}>{String(value)}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flight Log Tab
// ---------------------------------------------------------------------------

function FlightTab({ records }: { records: DispatchRecord[] }) {
  return (
    <div>
      <div style={{ ...s.card, marginBottom: 16, fontFamily: 'monospace', fontSize: 11 }}>
        <div style={s.cardTitle}>Flight Recorder ({records.length} entries)</div>
        <div style={{ maxHeight: 600, overflowY: 'auto' }}>
          {records.length === 0 ? (
            <span style={{ color: '#8b949e' }}>No flight records loaded.</span>
          ) : (
            records.slice(-100).reverse().map((r, i) => (
              <div key={i} style={{
                padding: '4px 0',
                borderBottom: '1px solid #21262d',
                color: r.success ? '#c9d1d9' : '#da3633',
              }}>
                {r.timestamp.slice(11, 23)} {r.success ? '✓' : '✗'} {r.intent}
                {r.resolvedTool && <span style={{ color: '#8b949e' }}> → {r.resolvedTool}</span>}
                {r.durationMs != null && <span style={{ color: '#8b949e' }}> ({r.durationMs}ms)</span>}
                {r.cacheHit && <span style={{ color: '#56d364' }}> ⚡</span>}
                {r.usedFallback && <span style={{ color: '#9e6a03' }}> ↩</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  const [tab, setTab] = useState<TabId>('overview');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [records, setRecords] = useState<DispatchRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const sseRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, m, f] = await Promise.allSettled([fetchHealth(), fetchMetrics(), fetchFlight()]);
      if (h.status === 'fulfilled') setHealth(h.value);
      if (m.status === 'fulfilled') setMetrics(m.value);
      if (f.status === 'fulfilled') setRecords(f.value);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    setLastRefresh(Date.now());
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);

    // Live SSE feed for real-time updates
    try {
      const sse = new EventSource('/api/sse');
      sseRef.current = sse;
      sse.addEventListener('message', () => void refresh());
    } catch { /* SSE not available */ }

    return () => {
      clearInterval(interval);
      sseRef.current?.close();
    };
  }, [refresh]);

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'trace-viz', label: 'Trace Viz' },
    { id: 'flight', label: 'Flight Log' },
    { id: 'metrics', label: 'Metrics' },
  ];

  return (
    <div style={s.app}>
      <header style={s.header}>
        <span style={s.logo}>smallchat</span>
        <span style={s.version}>debug ui</span>
        {error && <span style={{ fontSize: 12, color: '#da3633' }}>{error}</span>}
        <button style={{ ...s.refresh, marginLeft: 'auto' }} onClick={() => void refresh()}>↻ Refresh</button>
        <div style={s.statusDot(health?.status === 'ok')} title={health?.status ?? 'unknown'} />
        <span style={{ fontSize: 11, color: '#8b949e' }}>
          {new Date(lastRefresh).toLocaleTimeString()}
        </span>
      </header>

      <nav style={s.nav}>
        {tabs.map(({ id, label }) => (
          <button key={id} style={s.tab(tab === id)} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      <main style={s.content}>
        {tab === 'overview' && <OverviewTab health={health} metrics={metrics} />}
        {tab === 'trace-viz' && <TraceVizTab records={records} />}
        {tab === 'flight' && <FlightTab records={records} />}
        {tab === 'metrics' && <MetricsTab metrics={metrics} />}
      </main>
    </div>
  );
}
