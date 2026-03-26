/**
 * LogAnalyzer — parses Claude JSONL session logs to extract tool usage data.
 *
 * Claude Code stores session logs as newline-delimited JSON in:
 *   ~/.claude/projects/<project-hash>/<session-id>.jsonl
 *
 * Each line has a `type` field. Tool calls appear as assistant messages with
 * content[].type === "tool_use", and results as user messages with
 * content[].type === "tool_result".
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolUsageRecord, ToolUsageStats } from './types.js';

// ---------------------------------------------------------------------------
// Log file discovery
// ---------------------------------------------------------------------------

/**
 * Find all JSONL session log files under the Claude projects directory.
 * If logDir is empty, auto-detects from ~/.claude/projects/.
 */
export function discoverLogFiles(logDir: string): string[] {
  const searchDir = logDir || join(homedir(), '.claude', 'projects');

  if (!existsSync(searchDir)) return [];

  const files: string[] = [];
  walkDirectory(searchDir, files);
  return files;
}

function walkDirectory(dir: string, results: string[]): void {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && entry.endsWith('.jsonl')) {
          results.push(fullPath);
        } else if (stat.isDirectory()) {
          walkDirectory(fullPath, results);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Skip inaccessible directories
  }
}

// ---------------------------------------------------------------------------
// JSONL log parsing
// ---------------------------------------------------------------------------

interface LogEntry {
  type: string;
  message?: {
    role: string;
    content: unknown;
  };
  sessionId?: string;
  timestamp?: string;
}

interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

function isToolUse(item: unknown): item is ToolUseContent {
  return typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'tool_use';
}

function isToolResult(item: unknown): item is ToolResultContent {
  return typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'tool_result';
}

/**
 * Parse a single JSONL session log and extract tool usage records.
 */
export function analyzeSessionLog(logPath: string): ToolUsageRecord[] {
  let content: string;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const records: ToolUsageRecord[] = [];

  // Track pending tool calls (tool_use_id → metadata)
  const pendingCalls = new Map<string, { toolName: string; timestamp: string; sessionId: string }>();

  // Track the sequence of tool calls to detect switch-away patterns
  const toolCallSequence: { toolName: string; success: boolean; index: number }[] = [];

  let sessionId = '';

  for (const line of lines) {
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      continue;
    }

    if (entry.sessionId && !sessionId) {
      sessionId = entry.sessionId;
    }

    if (!entry.message?.content || !Array.isArray(entry.message.content)) continue;

    const contentItems = entry.message.content as unknown[];

    // Process tool_use entries (assistant messages)
    if (entry.message.role === 'assistant') {
      for (const item of contentItems) {
        if (isToolUse(item)) {
          pendingCalls.set(item.id, {
            toolName: item.name,
            timestamp: entry.timestamp ?? new Date().toISOString(),
            sessionId: entry.sessionId ?? sessionId,
          });
        }
      }
    }

    // Process tool_result entries (user messages)
    if (entry.message.role === 'user') {
      for (const item of contentItems) {
        if (isToolResult(item) && pendingCalls.has(item.tool_use_id)) {
          const pending = pendingCalls.get(item.tool_use_id)!;
          pendingCalls.delete(item.tool_use_id);

          const success = !item.is_error && !isErrorContent(item.content);

          toolCallSequence.push({
            toolName: pending.toolName,
            success,
            index: toolCallSequence.length,
          });

          records.push({
            toolName: pending.toolName,
            timestamp: pending.timestamp,
            success,
            userSwitchedAway: false, // computed in post-processing
            sessionId: pending.sessionId,
          });
        }
      }
    }
  }

  // Post-process: detect switch-away patterns
  // A switch-away occurs when a tool fails (or returns an error) and the
  // very next tool call in the sequence is a different tool.
  for (let i = 0; i < toolCallSequence.length - 1; i++) {
    const current = toolCallSequence[i];
    const next = toolCallSequence[i + 1];

    if (!current.success && current.toolName !== next.toolName) {
      // Find the corresponding record and mark it
      const recordIndex = records.findIndex(
        (r, idx) => idx >= i && r.toolName === current.toolName && !r.success,
      );
      if (recordIndex >= 0) {
        records[recordIndex].userSwitchedAway = true;
      }
    }
  }

  return records;
}

/**
 * Heuristic: check if tool result content looks like an error.
 */
function isErrorContent(content: string | undefined): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('exception') ||
    lower.includes('permission denied') ||
    lower.includes('not found')
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate individual tool usage records into per-tool statistics.
 */
export function aggregateUsageStats(records: ToolUsageRecord[]): ToolUsageStats[] {
  const byTool = new Map<string, ToolUsageRecord[]>();

  for (const record of records) {
    const key = record.providerId
      ? `${record.providerId}.${record.toolName}`
      : record.toolName;
    const existing = byTool.get(key) ?? [];
    existing.push(record);
    byTool.set(key, existing);
  }

  const stats: ToolUsageStats[] = [];

  for (const [, toolRecords] of byTool) {
    const first = toolRecords[0];
    const totalCalls = toolRecords.length;
    const successCount = toolRecords.filter(r => r.success).length;
    const failureCount = totalCalls - successCount;
    const switchAwayCount = toolRecords.filter(r => r.userSwitchedAway).length;

    const durations = toolRecords
      .map(r => r.durationMs)
      .filter((d): d is number => d !== undefined);

    stats.push({
      toolName: first.toolName,
      providerId: first.providerId,
      totalCalls,
      successCount,
      failureCount,
      switchAwayCount,
      successRate: totalCalls > 0 ? successCount / totalCalls : 0,
      avgDurationMs: durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : undefined,
    });
  }

  // Sort by total calls descending
  stats.sort((a, b) => b.totalCalls - a.totalCalls);

  return stats;
}
