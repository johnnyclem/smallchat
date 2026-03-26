import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeSessionLog, aggregateUsageStats, discoverLogFiles } from './log-analyzer.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `dream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeLogLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

describe('analyzeSessionLog', () => {
  it('extracts tool usage from tool_use and tool_result pairs', () => {
    const dir = createTempDir();
    const logPath = join(dir, 'session.jsonl');

    const lines = [
      makeLogLine({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-03-25T10:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'search_code', input: {} }],
        },
      }),
      makeLogLine({
        type: 'user',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Found 3 results' }],
        },
      }),
    ];

    writeFileSync(logPath, lines.join('\n'));
    const records = analyzeSessionLog(logPath);

    expect(records.length).toBe(1);
    expect(records[0].toolName).toBe('search_code');
    expect(records[0].success).toBe(true);
    expect(records[0].userSwitchedAway).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it('detects failed tool calls', () => {
    const dir = createTempDir();
    const logPath = join(dir, 'session.jsonl');

    const lines = [
      makeLogLine({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-03-25T10:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'create_issue', input: {} }],
        },
      }),
      makeLogLine({
        type: 'user',
        sessionId: 'sess-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'Permission denied' }],
        },
      }),
    ];

    writeFileSync(logPath, lines.join('\n'));
    const records = analyzeSessionLog(logPath);

    expect(records[0].success).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it('detects switch-away patterns', () => {
    const dir = createTempDir();
    const logPath = join(dir, 'session.jsonl');

    const lines = [
      // Tool A fails
      makeLogLine({
        type: 'assistant', sessionId: 'sess-1', timestamp: '2026-03-25T10:00:00Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'tool_a', input: {} }] },
      }),
      makeLogLine({
        type: 'user', sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'Error occurred' }] },
      }),
      // Immediately switches to Tool B
      makeLogLine({
        type: 'assistant', sessionId: 'sess-1', timestamp: '2026-03-25T10:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'tool_b', input: {} }] },
      }),
      makeLogLine({
        type: 'user', sessionId: 'sess-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'Success' }] },
      }),
    ];

    writeFileSync(logPath, lines.join('\n'));
    const records = analyzeSessionLog(logPath);

    expect(records.length).toBe(2);
    expect(records[0].toolName).toBe('tool_a');
    expect(records[0].userSwitchedAway).toBe(true);
    expect(records[1].toolName).toBe('tool_b');
    expect(records[1].userSwitchedAway).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it('handles empty or malformed log files', () => {
    const dir = createTempDir();
    const logPath = join(dir, 'bad.jsonl');
    writeFileSync(logPath, 'not valid json\n{also bad\n');

    const records = analyzeSessionLog(logPath);
    expect(records).toEqual([]);

    rmSync(dir, { recursive: true });
  });
});

describe('aggregateUsageStats', () => {
  it('aggregates records by tool name', () => {
    const records = [
      { toolName: 'search', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
      { toolName: 'search', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
      { toolName: 'search', timestamp: '', success: false, userSwitchedAway: true, sessionId: 's1' },
      { toolName: 'create', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
    ];

    const stats = aggregateUsageStats(records);

    const searchStats = stats.find(s => s.toolName === 'search')!;
    expect(searchStats.totalCalls).toBe(3);
    expect(searchStats.successCount).toBe(2);
    expect(searchStats.failureCount).toBe(1);
    expect(searchStats.switchAwayCount).toBe(1);
    expect(searchStats.successRate).toBeCloseTo(2 / 3);

    const createStats = stats.find(s => s.toolName === 'create')!;
    expect(createStats.totalCalls).toBe(1);
    expect(createStats.successRate).toBe(1);
  });

  it('sorts by total calls descending', () => {
    const records = [
      { toolName: 'rare', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
      { toolName: 'common', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
      { toolName: 'common', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
      { toolName: 'common', timestamp: '', success: true, userSwitchedAway: false, sessionId: 's1' },
    ];

    const stats = aggregateUsageStats(records);
    expect(stats[0].toolName).toBe('common');
    expect(stats[1].toolName).toBe('rare');
  });
});

describe('discoverLogFiles', () => {
  it('finds jsonl files recursively', () => {
    const dir = createTempDir();
    const subDir = join(dir, 'project-hash');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'session1.jsonl'), '{}');
    writeFileSync(join(subDir, 'session2.jsonl'), '{}');
    writeFileSync(join(subDir, 'other.txt'), 'ignored');

    const files = discoverLogFiles(dir);
    expect(files.length).toBe(2);
    expect(files.every(f => f.endsWith('.jsonl'))).toBe(true);

    rmSync(dir, { recursive: true });
  });

  it('returns empty for non-existent directory', () => {
    const files = discoverLogFiles('/nonexistent/path');
    expect(files).toEqual([]);
  });
});
