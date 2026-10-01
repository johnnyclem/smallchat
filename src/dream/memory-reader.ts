/**
 * MemoryReader — reads and parses Claude memory files for tool insights.
 *
 * Scans standard Claude memory locations (CLAUDE.md files) plus any
 * user-configured paths, extracting tool mentions with sentiment.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { DreamConfig, MemoryFileContent, MemoryToolMention } from './types.js';

// ---------------------------------------------------------------------------
// Standard memory file locations
// ---------------------------------------------------------------------------

function standardMemoryPaths(projectDir: string): string[] {
  const home = homedir();
  return [
    join(home, '.claude', 'CLAUDE.md'),
    join(projectDir, 'CLAUDE.md'),
    join(projectDir, '.claude', 'CLAUDE.md'),
  ];
}

// ---------------------------------------------------------------------------
// Read memory files
// ---------------------------------------------------------------------------

/**
 * Discover and read all memory files from standard locations and config.
 */
export function readMemoryFiles(
  config: DreamConfig,
  projectDir: string = process.cwd(),
): MemoryFileContent[] {
  const candidates = new Set<string>([
    ...standardMemoryPaths(projectDir),
    ...config.memoryPaths.map(p => resolve(p)),
  ]);

  const results: MemoryFileContent[] = [];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;

      const content = readFileSync(filePath, 'utf-8');
      if (content.trim().length === 0) continue;

      results.push({
        path: filePath,
        content,
        modifiedAt: stat.mtime,
      });
    } catch {
      // Skip unreadable files silently
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Sentiment keywords
// ---------------------------------------------------------------------------

const POSITIVE_PATTERNS = [
  /\bprefer\b/i,
  /\balways use\b/i,
  /\bworks well\b/i,
  /\buseful\b/i,
  /\brecommend\b/i,
  /\bgreat\b/i,
  /\bbest\b/i,
  /\breliable\b/i,
  /\beffective\b/i,
  /\bsafer\b/i,
];

const NEGATIVE_PATTERNS = [
  /\bavoid\b/i,
  /\bdon'?t use\b/i,
  /\bdo not use\b/i,
  /\bbroken\b/i,
  /\bfailed\b/i,
  /\bdoesn'?t work\b/i,
  /\bdoes not work\b/i,
  /\bunreliable\b/i,
  /\bbuggy\b/i,
  /\bdeprecated\b/i,
];

type Sentiment = 'positive' | 'negative' | 'neutral';

/**
 * Comparisons name two tools with opposite sentiment: "use X instead of Y"
 * is +X and −Y, "X was replaced by Y" is −X and +Y. 0.x scored any line
 * containing "instead of" as negative for every tool on it (SAT-22).
 */
const PREFERRED_FIRST = /\b(?:instead of|rather than)\b/i;
const PREFERRED_SECOND = /\b(?:replaced by|in favou?r of)\b/i;

function keywordSentiment(text: string): Sentiment {
  const hasPositive = POSITIVE_PATTERNS.some(p => p.test(text));
  const hasNegative = NEGATIVE_PATTERNS.some(p => p.test(text));

  if (hasNegative && !hasPositive) return 'negative';
  if (hasPositive && !hasNegative) return 'positive';
  return 'neutral'; // no keywords, or mixed signals
}

/** Sentiment of one clause towards the tool it names at `at`. */
function clauseSentiment(clause: string, at: number): Sentiment {
  for (const [pattern, before, after] of [
    [PREFERRED_FIRST, 'positive', 'negative'],
    [PREFERRED_SECOND, 'negative', 'positive'],
  ] as const) {
    const m = pattern.exec(clause);
    if (m) return at < m.index ? before : after;
  }
  return keywordSentiment(clause);
}

/**
 * Sentiment towards `tool` on one line, read only from the clauses
 * (split at `;`, `!`, `?` and sentence-ending periods) that name it:
 * "Avoid raw shell reads; read_file is safer." says nothing bad about
 * read_file. Neighbouring lines are context for the report, not evidence.
 */
function inferSentiment(line: string, pattern: RegExp): Sentiment {
  const verdicts: Sentiment[] = [];
  for (const clause of line.split(/[;!?]|\.(?=\s|$)/)) {
    const m = pattern.exec(clause);
    if (m) verdicts.push(clauseSentiment(clause, m.index));
  }
  const positive = verdicts.includes('positive');
  const negative = verdicts.includes('negative');
  if (positive && !negative) return 'positive';
  if (negative && !positive) return 'negative';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Extract tool mentions
// ---------------------------------------------------------------------------

/**
 * Scan memory file content for mentions of known tools and infer sentiment.
 *
 * For each known tool name, searches the content line-by-line. When a tool
 * name is found, the surrounding line is captured as context and sentiment
 * is inferred from keyword patterns.
 */
export function extractToolMentions(
  content: string,
  knownTools: string[],
  sourcePath: string,
): MemoryToolMention[] {
  const mentions: MemoryToolMention[] = [];
  const lines = content.split('\n');

  for (const tool of knownTools) {
    // Build a regex that matches the tool name as a word boundary
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!pattern.test(line)) continue;

      // Gather context: the matching line plus one line above and below
      const contextLines = [
        i > 0 ? lines[i - 1] : '',
        line,
        i < lines.length - 1 ? lines[i + 1] : '',
      ].filter(l => l.trim().length > 0);

      const context = contextLines.join(' ').trim();
      const sentiment = inferSentiment(line, pattern);

      mentions.push({
        toolName: tool,
        context,
        sentiment,
        source: sourcePath,
      });
    }
  }

  return mentions;
}
