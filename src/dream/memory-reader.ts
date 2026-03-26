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
  /\binstead of\b/i,
  /\breplaced by\b/i,
];

function inferSentiment(context: string): 'positive' | 'negative' | 'neutral' {
  const hasPositive = POSITIVE_PATTERNS.some(p => p.test(context));
  const hasNegative = NEGATIVE_PATTERNS.some(p => p.test(context));

  if (hasNegative && !hasPositive) return 'negative';
  if (hasPositive && !hasNegative) return 'positive';
  if (hasPositive && hasNegative) return 'neutral'; // mixed signals
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
      const sentiment = inferSentiment(context);

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
