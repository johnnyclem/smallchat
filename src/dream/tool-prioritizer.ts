/**
 * ToolPrioritizer — combines memory insights and log stats into priority hints.
 *
 * Produces a ToolPriorityHints object that tells the compiler which tools
 * to boost, demote, or exclude based on observed usage patterns.
 */

import type { MemoryToolMention, ToolUsageStats, ToolPriorityHints } from './types.js';

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const BASE_SCORE = 1.0;
const MIN_SCORE = 0.5;
const MAX_SCORE = 2.0;

/** Minimum calls before usage stats meaningfully affect the score. */
const MIN_CALLS_THRESHOLD = 3;

/** Success rate below this triggers a demotion. */
const LOW_SUCCESS_RATE = 0.5;

/** Success rate above this triggers a boost. */
const HIGH_SUCCESS_RATE = 0.85;

/** Switch-away rate above this triggers a demotion. */
const HIGH_SWITCH_AWAY_RATE = 0.3;

// ---------------------------------------------------------------------------
// Prioritization
// ---------------------------------------------------------------------------

/**
 * Combine memory mentions and usage stats to produce priority hints.
 */
export function prioritizeTools(
  memoryMentions: MemoryToolMention[],
  usageStats: ToolUsageStats[],
  knownTools: string[],
): ToolPriorityHints {
  const scores = new Map<string, number>();
  const reasoning = new Map<string, string>();
  const excluded = new Set<string>();

  // Initialize all known tools at base score
  for (const tool of knownTools) {
    scores.set(tool, BASE_SCORE);
  }

  // --- Apply usage stats modifiers ---
  const statsMap = new Map(usageStats.map(s => [s.toolName, s]));

  for (const stats of usageStats) {
    const reasons: string[] = [];
    let score = scores.get(stats.toolName) ?? BASE_SCORE;

    if (stats.totalCalls >= MIN_CALLS_THRESHOLD) {
      // Usage frequency bonus (log-scaled, capped)
      const frequencyBonus = Math.min(0.3, Math.log10(stats.totalCalls) * 0.15);
      score += frequencyBonus;
      if (frequencyBonus > 0.05) {
        reasons.push(`frequently used (${stats.totalCalls} calls, +${(frequencyBonus * 100).toFixed(0)}%)`);
      }

      // Success rate modifier
      if (stats.successRate < LOW_SUCCESS_RATE) {
        const penalty = (LOW_SUCCESS_RATE - stats.successRate) * 0.6;
        score -= penalty;
        reasons.push(`low success rate (${(stats.successRate * 100).toFixed(0)}%, -${(penalty * 100).toFixed(0)}%)`);
      } else if (stats.successRate > HIGH_SUCCESS_RATE) {
        const bonus = (stats.successRate - HIGH_SUCCESS_RATE) * 0.3;
        score += bonus;
        reasons.push(`high success rate (${(stats.successRate * 100).toFixed(0)}%, +${(bonus * 100).toFixed(0)}%)`);
      }

      // Switch-away penalty
      const switchAwayRate = stats.switchAwayCount / stats.totalCalls;
      if (switchAwayRate > HIGH_SWITCH_AWAY_RATE) {
        const penalty = switchAwayRate * 0.4;
        score -= penalty;
        reasons.push(`high switch-away rate (${(switchAwayRate * 100).toFixed(0)}%, -${(penalty * 100).toFixed(0)}%)`);
      }
    }

    if (reasons.length > 0) {
      scores.set(stats.toolName, score);
      reasoning.set(stats.toolName, `Usage: ${reasons.join('; ')}`);
    }
  }

  // --- Apply memory sentiment modifiers ---
  // Group mentions by tool
  const mentionsByTool = new Map<string, MemoryToolMention[]>();
  for (const mention of memoryMentions) {
    const existing = mentionsByTool.get(mention.toolName) ?? [];
    existing.push(mention);
    mentionsByTool.set(mention.toolName, existing);
  }

  for (const [toolName, mentions] of mentionsByTool) {
    let score = scores.get(toolName) ?? BASE_SCORE;
    const existingReason = reasoning.get(toolName) ?? '';
    const memoryReasons: string[] = [];

    const positiveCount = mentions.filter(m => m.sentiment === 'positive').length;
    const negativeCount = mentions.filter(m => m.sentiment === 'negative').length;

    if (positiveCount > 0) {
      const bonus = Math.min(0.3, positiveCount * 0.1);
      score += bonus;
      memoryReasons.push(`${positiveCount} positive mention(s) in memory`);
    }

    if (negativeCount > 0) {
      const penalty = Math.min(0.4, negativeCount * 0.15);
      score -= penalty;
      memoryReasons.push(`${negativeCount} negative mention(s) in memory`);

      // Check for explicit exclusion signals
      const hasExclusionSignal = mentions.some(m =>
        /\b(avoid|don'?t use|do not use|deprecated|replaced by)\b/i.test(m.context),
      );
      if (hasExclusionSignal && negativeCount >= 2) {
        excluded.add(toolName);
        memoryReasons.push('marked for exclusion (strong negative signal)');
      }
    }

    if (memoryReasons.length > 0) {
      scores.set(toolName, score);
      const combined = existingReason
        ? `${existingReason}. Memory: ${memoryReasons.join('; ')}`
        : `Memory: ${memoryReasons.join('; ')}`;
      reasoning.set(toolName, combined);
    }
  }

  // --- Normalize and partition into boosted/demoted ---
  const boosted = new Map<string, number>();
  const demoted = new Map<string, number>();

  for (const [toolName, rawScore] of scores) {
    if (excluded.has(toolName)) continue;

    const score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, rawScore));

    if (score > BASE_SCORE + 0.05) {
      boosted.set(toolName, score);
    } else if (score < BASE_SCORE - 0.05) {
      demoted.set(toolName, score);
    }
  }

  return { boosted, demoted, excluded, reasoning };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable report from the priority hints.
 */
export function generateReport(
  hints: ToolPriorityHints,
  usageStats: ToolUsageStats[],
  memoryMentions: MemoryToolMention[],
): string {
  const lines: string[] = [];

  lines.push('=== Dream Analysis Report ===');
  lines.push('');

  // Usage summary
  lines.push(`Tool usage records analyzed: ${usageStats.reduce((s, t) => s + t.totalCalls, 0)} calls across ${usageStats.length} tools`);
  lines.push(`Memory mentions found: ${memoryMentions.length}`);
  lines.push('');

  // Boosted tools
  if (hints.boosted.size > 0) {
    lines.push('Boosted tools (higher priority):');
    for (const [tool, score] of sortedEntries(hints.boosted, 'desc')) {
      const reason = hints.reasoning.get(tool) ?? '';
      lines.push(`  + ${tool} (score: ${score.toFixed(2)}) — ${reason}`);
    }
    lines.push('');
  }

  // Demoted tools
  if (hints.demoted.size > 0) {
    lines.push('Demoted tools (lower priority):');
    for (const [tool, score] of sortedEntries(hints.demoted, 'asc')) {
      const reason = hints.reasoning.get(tool) ?? '';
      lines.push(`  - ${tool} (score: ${score.toFixed(2)}) — ${reason}`);
    }
    lines.push('');
  }

  // Excluded tools
  if (hints.excluded.size > 0) {
    lines.push('Excluded tools (removed from compilation):');
    for (const tool of hints.excluded) {
      const reason = hints.reasoning.get(tool) ?? '';
      lines.push(`  x ${tool} — ${reason}`);
    }
    lines.push('');
  }

  // Top used tools
  if (usageStats.length > 0) {
    lines.push('Top tools by usage:');
    const top = usageStats.slice(0, 10);
    for (const stat of top) {
      lines.push(`  ${stat.toolName}: ${stat.totalCalls} calls, ${(stat.successRate * 100).toFixed(0)}% success`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function sortedEntries(map: Map<string, number>, order: 'asc' | 'desc'): [string, number][] {
  const entries = Array.from(map.entries());
  return entries.sort((a, b) => order === 'desc' ? b[1] - a[1] : a[1] - b[1]);
}
