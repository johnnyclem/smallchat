/**
 * flight-recorder.ts — Black box recorder for post-mortem debugging.
 *
 * Records the last N dispatch contexts in a ring buffer and flushes
 * them to a NDJSON file on demand (or on process exit / SIGTERM).
 *
 * Inspired by flight-data recorders: always-on, bounded memory,
 * written to disk only when needed for debugging.
 *
 * Usage:
 *   const fr = new FlightRecorder({ maxEntries: 200, filePath: 'smallchat-fr.ndjson' });
 *
 *   // Record a dispatch
 *   fr.record({
 *     intent: 'search code',
 *     resolvedTool: 'github.search_code',
 *     args: { query: 'foo' },
 *     candidateTools: [{ tool: 'github.search_code', confidence: 0.97 }],
 *     durationMs: 42,
 *     success: true,
 *   });
 *
 *   // On crash / request: persist to disk
 *   await fr.flush();
 *
 *   // Load for analysis
 *   const entries = FlightRecorder.load('smallchat-fr.ndjson');
 */

import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { rootLogger } from './logger.js';

const log = rootLogger.child({ component: 'flight-recorder' });

// ---------------------------------------------------------------------------
// Entry schema
// ---------------------------------------------------------------------------

export interface DispatchRecord {
  /** ISO timestamp */
  timestamp: string;
  /** The raw intent string passed to dispatch */
  intent: string;
  /** Canonical selector resolved from intent */
  selector?: string;
  /** Resolved tool name (providerId.toolName) */
  resolvedTool?: string;
  /** Arguments passed to the tool */
  args?: Record<string, unknown>;
  /** Top candidate tools with confidence scores */
  candidateTools?: Array<{ tool: string; confidence: number }>;
  /** Execution duration in milliseconds */
  durationMs?: number;
  /** Whether the dispatch succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the cache was hit for this dispatch */
  cacheHit?: boolean;
  /** Whether the fallback chain was used */
  usedFallback?: boolean;
  /** Fallback steps taken */
  fallbackSteps?: Array<{ strategy: string; tried: string; result: string }>;
  /** Arbitrary additional context */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Flight recorder
// ---------------------------------------------------------------------------

export interface FlightRecorderOptions {
  /** Maximum entries to keep in memory (ring buffer) */
  maxEntries?: number;
  /** File to flush entries to */
  filePath?: string;
  /** Whether to auto-flush on process exit */
  autoFlushOnExit?: boolean;
  /** Flush to disk after every N entries (0 = only on explicit flush) */
  flushInterval?: number;
}

export class FlightRecorder {
  private buffer: DispatchRecord[] = [];
  private readonly maxEntries: number;
  private readonly filePath: string;
  private flushCount = 0;
  private readonly flushInterval: number;

  constructor(options: FlightRecorderOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.filePath = options.filePath ?? 'smallchat-flight.ndjson';
    this.flushInterval = options.flushInterval ?? 0;

    if (options.autoFlushOnExit ?? true) {
      // Flush synchronously on exit to avoid losing data
      process.on('exit', () => this.flushSync());
      process.on('SIGTERM', () => { this.flushSync(); });
      process.on('SIGINT', () => { this.flushSync(); });
    }
  }

  /**
   * Record a dispatch event in the ring buffer.
   * If the buffer is full, the oldest entry is evicted.
   */
  record(entry: Omit<DispatchRecord, 'timestamp'>): void {
    const record: DispatchRecord = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.buffer.push(record);

    // Evict oldest entries when full
    if (this.buffer.length > this.maxEntries) {
      this.buffer = this.buffer.slice(-this.maxEntries);
    }

    // Periodic flush
    if (this.flushInterval > 0) {
      this.flushCount++;
      if (this.flushCount >= this.flushInterval) {
        this.flushCount = 0;
        void this.flush();
      }
    }
  }

  /** Return all entries currently in the ring buffer */
  entries(): ReadonlyArray<DispatchRecord> {
    return this.buffer;
  }

  /** Return the most recent N entries */
  recent(n: number): DispatchRecord[] {
    return this.buffer.slice(-n);
  }

  /** Clear the in-memory buffer */
  clear(): void {
    this.buffer = [];
  }

  /** Flush the current buffer to disk (async, appends to file) */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    const snapshot = this.buffer.splice(0); // drain

    try {
      appendFileSync(this.filePath, lines, 'utf-8');
      log.debug({ file: this.filePath, entries: snapshot.length }, 'Flight recorder flushed');
    } catch (err) {
      // Put entries back if write failed
      this.buffer.unshift(...snapshot);
      log.error({ err, file: this.filePath }, 'Failed to flush flight recorder');
    }
  }

  /** Flush synchronously (for process exit handlers) */
  flushSync(): void {
    if (this.buffer.length === 0) return;

    const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
    this.buffer = [];

    try {
      appendFileSync(this.filePath, lines, 'utf-8');
    } catch {
      // Ignore errors during exit
    }
  }

  /**
   * Write a clean snapshot (overwrite file) for post-mortem analysis.
   * Includes all entries in the current in-memory buffer.
   */
  async snapshot(outputPath?: string): Promise<string> {
    const path = outputPath ?? this.filePath;
    const lines = this.buffer.map(e => JSON.stringify(e)).join('\n');

    writeFileSync(path, lines + (lines ? '\n' : ''), 'utf-8');
    log.info({ file: path, entries: this.buffer.length }, 'Flight recorder snapshot written');
    return path;
  }

  /**
   * Load a previously written flight recorder file for analysis.
   */
  static load(filePath: string): DispatchRecord[] {
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf-8');
    const records: DispatchRecord[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }

    return records;
  }

  /**
   * Analyze a loaded set of records and return summary statistics.
   */
  static analyze(records: DispatchRecord[]): FlightAnalysis {
    if (records.length === 0) {
      return { total: 0, successes: 0, failures: 0, fallbacks: 0, cacheHits: 0, topIntents: [], topErrors: [], avgDurationMs: 0 };
    }

    const successes = records.filter(r => r.success).length;
    const failures = records.length - successes;
    const fallbacks = records.filter(r => r.usedFallback).length;
    const cacheHits = records.filter(r => r.cacheHit).length;

    const intentCounts = new Map<string, number>();
    const errorCounts = new Map<string, number>();
    let totalDuration = 0;
    let durationCount = 0;

    for (const r of records) {
      intentCounts.set(r.intent, (intentCounts.get(r.intent) ?? 0) + 1);
      if (r.error) errorCounts.set(r.error, (errorCounts.get(r.error) ?? 0) + 1);
      if (r.durationMs != null) { totalDuration += r.durationMs; durationCount++; }
    }

    const topIntents = [...intentCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([intent, count]) => ({ intent, count }));

    const topErrors = [...errorCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([error, count]) => ({ error, count }));

    return {
      total: records.length,
      successes,
      failures,
      fallbacks,
      cacheHits,
      topIntents,
      topErrors,
      avgDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
    };
  }
}

export interface FlightAnalysis {
  total: number;
  successes: number;
  failures: number;
  fallbacks: number;
  cacheHits: number;
  topIntents: Array<{ intent: string; count: number }>;
  topErrors: Array<{ error: string; count: number }>;
  avgDurationMs: number;
}

// ---------------------------------------------------------------------------
// Singleton flight recorder
// ---------------------------------------------------------------------------

export const flightRecorder = new FlightRecorder({
  maxEntries: parseInt(process.env['SC_FR_MAX_ENTRIES'] ?? '500', 10),
  filePath: process.env['SC_FR_FILE'] ?? 'smallchat-flight.ndjson',
  autoFlushOnExit: true,
  flushInterval: 0,
});
