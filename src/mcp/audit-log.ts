/**
 * AuditLog — in-memory ring buffer of recent MCP request audit entries.
 *
 * Capped at maxEntries (default 10,000) to bound memory usage.
 */

export interface AuditEntry {
  timestamp: string;
  method: string;
  sessionId?: string;
  clientId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  recent(count = 100): AuditEntry[] {
    return this.entries.slice(-count);
  }
}
