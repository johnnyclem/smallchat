import { describe, it, expect } from 'vitest';
import { prioritizeTools, generateReport } from './tool-prioritizer.js';
import type { MemoryToolMention, ToolUsageStats } from './types.js';

describe('prioritizeTools', () => {
  const knownTools = ['search_code', 'create_issue', 'send_message', 'read_file', 'broken_tool'];

  it('boosts frequently used tools with high success rates', () => {
    const stats: ToolUsageStats[] = [
      { toolName: 'search_code', totalCalls: 50, successCount: 48, failureCount: 2, switchAwayCount: 0, successRate: 0.96 },
    ];

    const hints = prioritizeTools([], stats, knownTools);
    expect(hints.boosted.has('search_code')).toBe(true);
    expect(hints.boosted.get('search_code')!).toBeGreaterThan(1.0);
  });

  it('demotes tools with low success rates', () => {
    const stats: ToolUsageStats[] = [
      { toolName: 'broken_tool', totalCalls: 10, successCount: 3, failureCount: 7, switchAwayCount: 5, successRate: 0.3 },
    ];

    const hints = prioritizeTools([], stats, knownTools);
    expect(hints.demoted.has('broken_tool')).toBe(true);
    expect(hints.demoted.get('broken_tool')!).toBeLessThan(1.0);
  });

  it('demotes tools with high switch-away rates', () => {
    const stats: ToolUsageStats[] = [
      { toolName: 'send_message', totalCalls: 10, successCount: 4, failureCount: 6, switchAwayCount: 5, successRate: 0.4 },
    ];

    const hints = prioritizeTools([], stats, knownTools);
    expect(hints.demoted.has('send_message')).toBe(true);
  });

  it('boosts tools with positive memory mentions', () => {
    const mentions: MemoryToolMention[] = [
      { toolName: 'read_file', context: 'Always use read_file — works well', sentiment: 'positive', source: 'test.md' },
    ];

    const hints = prioritizeTools(mentions, [], knownTools);
    expect(hints.boosted.has('read_file')).toBe(true);
  });

  it('demotes tools with negative memory mentions', () => {
    const mentions: MemoryToolMention[] = [
      { toolName: 'broken_tool', context: 'broken_tool is buggy and unreliable', sentiment: 'negative', source: 'test.md' },
    ];

    const hints = prioritizeTools(mentions, [], knownTools);
    expect(hints.demoted.has('broken_tool')).toBe(true);
  });

  it('excludes tools with strong negative signals in memory', () => {
    const mentions: MemoryToolMention[] = [
      { toolName: 'broken_tool', context: "avoid broken_tool — it's deprecated", sentiment: 'negative', source: 'a.md' },
      { toolName: 'broken_tool', context: "don't use broken_tool anymore", sentiment: 'negative', source: 'b.md' },
    ];

    const hints = prioritizeTools(mentions, [], knownTools);
    expect(hints.excluded.has('broken_tool')).toBe(true);
  });

  it('combines usage stats and memory insights', () => {
    const stats: ToolUsageStats[] = [
      { toolName: 'search_code', totalCalls: 20, successCount: 19, failureCount: 1, switchAwayCount: 0, successRate: 0.95 },
    ];
    const mentions: MemoryToolMention[] = [
      { toolName: 'search_code', context: 'prefer search_code for all code searches', sentiment: 'positive', source: 'test.md' },
    ];

    const hints = prioritizeTools(mentions, stats, knownTools);
    expect(hints.boosted.has('search_code')).toBe(true);
    const reason = hints.reasoning.get('search_code') ?? '';
    expect(reason).toContain('Usage');
    expect(reason).toContain('Memory');
  });

  it('does not affect tools with insufficient data', () => {
    const stats: ToolUsageStats[] = [
      { toolName: 'read_file', totalCalls: 1, successCount: 1, failureCount: 0, switchAwayCount: 0, successRate: 1.0 },
    ];

    const hints = prioritizeTools([], stats, knownTools);
    // With only 1 call (below threshold), no boost/demote
    expect(hints.boosted.has('read_file')).toBe(false);
    expect(hints.demoted.has('read_file')).toBe(false);
  });
});

describe('generateReport', () => {
  it('produces a human-readable report', () => {
    const hints = prioritizeTools([], [], ['tool_a']);
    const report = generateReport(hints, [], []);
    expect(report).toContain('Dream Analysis Report');
  });

  it('includes boosted tools in report', () => {
    const stats: ToolUsageStats[] = [
      { toolName: 'good_tool', totalCalls: 100, successCount: 98, failureCount: 2, switchAwayCount: 0, successRate: 0.98 },
    ];
    const hints = prioritizeTools([], stats, ['good_tool']);
    const report = generateReport(hints, stats, []);
    expect(report).toContain('good_tool');
    expect(report).toContain('Boosted');
  });
});
