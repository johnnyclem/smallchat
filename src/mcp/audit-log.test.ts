/**
 * Feature: Audit Log
 *
 * In-memory ring buffer of recent MCP request audit entries,
 * capped at maxEntries to bound memory usage.
 */

import { describe, it, expect } from 'vitest';
import { AuditLog, type AuditEntry } from './audit-log.js';

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    method: 'tools/call',
    sessionId: 'sess-1',
    clientId: 'client-1',
    success: true,
    durationMs: 42,
    ...overrides,
  };
}

describe('Feature: Audit Log Ring Buffer', () => {
  describe('Scenario: Log entries are stored', () => {
    it('Given an audit log, When an entry is logged, Then it can be retrieved via recent()', () => {
      const log = new AuditLog();

      log.log(makeEntry({ method: 'ping' }));

      const entries = log.recent();
      expect(entries).toHaveLength(1);
      expect(entries[0].method).toBe('ping');
    });
  });

  describe('Scenario: Recent returns the last N entries', () => {
    it('Given 5 logged entries, When recent(3) is called, Then the last 3 entries are returned', () => {
      const log = new AuditLog();

      for (let i = 0; i < 5; i++) {
        log.log(makeEntry({ method: `method-${i}` }));
      }

      const entries = log.recent(3);
      expect(entries).toHaveLength(3);
      expect(entries[0].method).toBe('method-2');
      expect(entries[1].method).toBe('method-3');
      expect(entries[2].method).toBe('method-4');
    });
  });

  describe('Scenario: Default recent count is 100', () => {
    it('Given 150 entries, When recent() is called without arguments, Then 100 entries are returned', () => {
      const log = new AuditLog();

      for (let i = 0; i < 150; i++) {
        log.log(makeEntry());
      }

      expect(log.recent()).toHaveLength(100);
    });
  });

  describe('Scenario: Ring buffer caps at maxEntries', () => {
    it('Given a maxEntries of 5, When 10 entries are logged, Then only the last 5 remain', () => {
      const log = new AuditLog(5);

      for (let i = 0; i < 10; i++) {
        log.log(makeEntry({ method: `m-${i}` }));
      }

      const entries = log.recent(10);
      expect(entries).toHaveLength(5);
      expect(entries[0].method).toBe('m-5');
      expect(entries[4].method).toBe('m-9');
    });
  });

  describe('Scenario: Error entries are recorded', () => {
    it('Given a failed request, When logging with success=false and error, Then the error is stored', () => {
      const log = new AuditLog();

      log.log(makeEntry({
        success: false,
        error: 'Something went wrong',
      }));

      const entries = log.recent();
      expect(entries[0].success).toBe(false);
      expect(entries[0].error).toBe('Something went wrong');
    });
  });

  describe('Scenario: Empty log returns empty array', () => {
    it('Given a new audit log, When recent is called, Then an empty array is returned', () => {
      const log = new AuditLog();
      expect(log.recent()).toEqual([]);
    });
  });

  describe('Scenario: All entry fields are preserved', () => {
    it('Given a fully populated entry, When logged and retrieved, Then all fields are intact', () => {
      const log = new AuditLog();
      const entry = makeEntry({
        timestamp: '2025-01-01T00:00:00Z',
        method: 'resources/read',
        sessionId: 'sess-abc',
        clientId: 'client-xyz',
        success: true,
        durationMs: 123,
      });

      log.log(entry);

      const [retrieved] = log.recent(1);
      expect(retrieved).toEqual(entry);
    });
  });
});
