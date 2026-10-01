/**
 * AuditLog — what `smallchat serve` did with each request, including the
 * ones it refused.
 *
 * Every JSON-RPC request is recorded once, after its response is sent,
 * with its real outcome: 'ok', 'error' (JSON-RPC error, or a tool result
 * with isError) or 'rejected' (refused before reaching the MCP layer:
 * Host/Origin, bearer token, rate limit, content type, body size,
 * malformed JSON, unknown session). tools/call entries name the tool id
 * that ran and its canonical call digest — never the arguments.
 *
 * Entries stay in an in-memory ring (recent()) and, with `file`, are
 * appended as JSON lines (mode 0600). The file is append-only by
 * convention; it is not hash-chained (see MIGRATION.md).
 */

import { appendFileSync } from 'node:fs';

export interface AuditEntry {
  timestamp: string;
  /** Transport the request arrived on */
  transport: 'stdio' | 'http';
  /** JSON-RPC method, or 'http' for a request refused before parsing */
  method: string;
  /** JSON-RPC request id, when there was one */
  requestId?: string | number;
  sessionId?: string;
  /** Peer address (HTTP) */
  remoteAddress?: string;
  outcome: 'ok' | 'error' | 'rejected';
  /** HTTP status of a rejection */
  httpStatus?: number;
  /** JSON-RPC error code */
  errorCode?: number;
  /** Error message or rejection reason */
  error?: string;
  /** tools/call: the name the client called */
  toolName?: string;
  /** tools/call: canonical tool id that ran (absent when nothing ran) */
  toolId?: string;
  /** tools/call: canonical call digest of what ran */
  callDigest?: string;
  durationMs: number;
}

export interface AuditLogOptions {
  /** In-memory entries kept for recent() (default 10,000) */
  maxEntries?: number;
  /** Append every entry to this file as one JSON line */
  file?: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly maxEntries: number;
  private readonly file?: string;

  constructor(options: AuditLogOptions | number = {}) {
    const opts = typeof options === 'number' ? { maxEntries: options } : options;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.file = opts.file;
  }

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    if (this.file) {
      try {
        appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      } catch (err) {
        process.stderr.write(`audit log: could not append to ${this.file}: ${(err as Error).message}\n`);
      }
    }
  }

  recent(count = 100): AuditEntry[] {
    return this.entries.slice(-count);
  }
}
