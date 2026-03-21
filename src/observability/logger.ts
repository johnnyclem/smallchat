/**
 * logger.ts — Structured logger for smallchat.
 *
 * A pino-compatible structured logger with configurable log levels.
 * Writes JSON lines to stdout/stderr (or a custom sink), making
 * it trivially parseable by log aggregators (Datadog, Loki, etc.).
 *
 * Usage:
 *   const log = createLogger({ level: 'debug', name: 'dispatch' });
 *   log.info({ intent: 'search code', selector: 'search:code' }, 'Resolved selector');
 *   log.error({ err }, 'Dispatch failed');
 */

import { writeSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Log level definitions
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

// ---------------------------------------------------------------------------
// Logger configuration
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  /** Minimum level to emit (default: 'info') */
  level?: LogLevel;
  /** Logger name — included as 'name' field in every record */
  name?: string;
  /** Whether to pretty-print to the terminal (default: false, JSON lines) */
  prettyPrint?: boolean;
  /** Custom sink function; receives the serialized JSON string */
  sink?: (line: string) => void;
  /** Static bindings merged into every log record */
  bindings?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Log record shape
// ---------------------------------------------------------------------------

export interface LogRecord {
  level: LogLevel;
  levelValue: number;
  time: string;       // ISO-8601
  name?: string;
  msg: string;
  pid: number;
  hostname?: string;
  err?: SerializedError;
  [key: string]: unknown;
}

interface SerializedError {
  type: string;
  message: string;
  stack?: string;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { type: err.name, message: err.message, stack: err.stack };
  }
  return { type: 'UnknownError', message: String(err) };
}

// ---------------------------------------------------------------------------
// Pretty formatter (terminal)
// ---------------------------------------------------------------------------

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: '\x1b[37m',   // white
  debug: '\x1b[36m',   // cyan
  info:  '\x1b[32m',   // green
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
  silent: '',
};
const RESET = '\x1b[0m';

function prettyFormat(record: LogRecord): string {
  const color = LEVEL_COLORS[record.level] ?? '';
  const prefix = `${color}${record.level.toUpperCase().padEnd(5)}${RESET}`;
  const time = record.time.substring(11, 23); // HH:MM:SS.mmm
  const name = record.name ? `[${record.name}] ` : '';

  // Collect extra fields (not the standard ones)
  const standard = new Set(['level', 'levelValue', 'time', 'name', 'msg', 'pid', 'hostname']);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!standard.has(k)) extra[k] = v;
  }

  const extraStr = Object.keys(extra).length > 0
    ? ' ' + JSON.stringify(extra)
    : '';

  return `${time} ${prefix} ${name}${record.msg}${extraStr}`;
}

// ---------------------------------------------------------------------------
// Logger class
// ---------------------------------------------------------------------------

const PID = (typeof process !== 'undefined') ? process.pid : 0;
let HOSTNAME = 'unknown';
try {
  // Sync resolution - os.hostname() is synchronous
  const { hostname } = await import('node:os');
  HOSTNAME = hostname();
} catch {
  HOSTNAME = 'unknown';
}

export class Logger {
  private levelRank: number;
  private options: Required<Omit<LoggerOptions, 'bindings'>> & { bindings: Record<string, unknown> };

  constructor(options: LoggerOptions = {}) {
    const level = options.level ?? 'info';
    this.levelRank = LEVEL_RANK[level];
    this.options = {
      level,
      name: options.name ?? '',
      prettyPrint: options.prettyPrint ?? false,
      sink: options.sink ?? this.defaultSink.bind(this),
      bindings: options.bindings ?? {},
    };
  }

  private defaultSink(line: string): void {
    // Write to stdout for info/debug/trace, stderr for warn/error
    writeSync(1, line + '\n');
  }

  private emit(level: LogLevel, fields: Record<string, unknown>, msg: string): void {
    if (LEVEL_RANK[level] < this.levelRank) return;

    const record: LogRecord = {
      level,
      levelValue: LEVEL_RANK[level],
      time: new Date().toISOString(),
      pid: PID,
      hostname: HOSTNAME,
      ...this.options.bindings,
      ...(this.options.name ? { name: this.options.name } : {}),
      ...fields,
      msg,
    };

    // Serialize error fields
    if (record['err'] && !(record['err'] as SerializedError).type) {
      record['err'] = serializeError(record['err']);
    }

    const line = this.options.prettyPrint
      ? prettyFormat(record)
      : JSON.stringify(record);

    this.options.sink(line);
  }

  /** Emit at TRACE level */
  trace(fields: Record<string, unknown>, msg: string): void;
  trace(msg: string): void;
  trace(fieldsOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof fieldsOrMsg === 'string') {
      this.emit('trace', {}, fieldsOrMsg);
    } else {
      this.emit('trace', fieldsOrMsg, msg ?? '');
    }
  }

  /** Emit at DEBUG level */
  debug(fields: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(fieldsOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof fieldsOrMsg === 'string') {
      this.emit('debug', {}, fieldsOrMsg);
    } else {
      this.emit('debug', fieldsOrMsg, msg ?? '');
    }
  }

  /** Emit at INFO level */
  info(fields: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(fieldsOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof fieldsOrMsg === 'string') {
      this.emit('info', {}, fieldsOrMsg);
    } else {
      this.emit('info', fieldsOrMsg, msg ?? '');
    }
  }

  /** Emit at WARN level */
  warn(fields: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(fieldsOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof fieldsOrMsg === 'string') {
      this.emit('warn', {}, fieldsOrMsg);
    } else {
      this.emit('warn', fieldsOrMsg, msg ?? '');
    }
  }

  /** Emit at ERROR level */
  error(fields: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(fieldsOrMsg: Record<string, unknown> | string, msg?: string): void {
    if (typeof fieldsOrMsg === 'string') {
      this.emit('error', {}, fieldsOrMsg);
    } else {
      this.emit('error', fieldsOrMsg, msg ?? '');
    }
  }

  /**
   * Create a child logger that inherits this logger's settings
   * and merges additional static bindings.
   */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger({
      ...this.options,
      bindings: { ...this.options.bindings, ...bindings },
    });
  }

  /** Dynamically change the log level */
  setLevel(level: LogLevel): void {
    this.levelRank = LEVEL_RANK[level];
    (this.options as { level: LogLevel }).level = level;
  }

  get level(): LogLevel {
    return this.options.level;
  }
}

// ---------------------------------------------------------------------------
// Factory & singleton root logger
// ---------------------------------------------------------------------------

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}

/**
 * Root logger — used as the default across all modules.
 * Level can be overridden via SC_LOG_LEVEL environment variable.
 */
export const rootLogger = createLogger({
  level: (process.env['SC_LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
  name: 'smallchat',
  prettyPrint: process.env['SC_LOG_PRETTY'] === '1' || process.env['NODE_ENV'] === 'development',
});
