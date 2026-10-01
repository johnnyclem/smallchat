/**
 * Shared utilities for @shorthand/core.
 */

import { createHash } from 'node:crypto';

/**
 * Estimate token count from a string.
 * Uses the ~4 chars per token heuristic (conservative for English).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate a unique ID (simple, no external deps).
 *
 * Not cryptographically secure and not collision-proof — callers that key
 * a Map/Set by this ID (e.g. ActiveEngramStore) can silently overwrite an
 * existing entry on collision. Fine for the current use (message/engram/
 * summary identifiers, not auth tokens or anything security-sensitive);
 * swap for a stronger generator if collision resistance ever matters.
 */
export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** sha256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * How much of one message the heuristic extractors (RegexCompactor,
 * importance state delta) read. Text past this point is still stored and
 * rendered verbatim; it just isn't mined for decisions, corrections,
 * entities or constraints.
 */
export const MAX_EXTRACTION_CHARS = 16 * 1024;

/** Longest sentence window the extractors run their patterns over. */
export const MAX_SENTENCE_CHARS = 400;

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Split text into sentences in one linear pass. A sentence ends at a run of
 * `.`, `!` or `?` followed by whitespace (or the end of the text), or at a
 * newline. Sentences longer than `maxChars` are cut at their last
 * whitespace before the limit (hard cut when there is none).
 *
 * The slices are contiguous and cover the whole input — joining them with
 * `''` reproduces it exactly, including trailing text with no terminator.
 */
export function splitSentences(text: string, maxChars = Infinity): string[] {
  const out: string[] = [];
  const n = text.length;
  let start = 0;
  let lastSpace = -1;

  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const terminal =
      ch === '\n' ||
      ((ch === '.' || ch === '!' || ch === '?') && (i + 1 === n || isSpace(text[i + 1])));
    if (terminal) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
      lastSpace = -1;
      continue;
    }
    if (isSpace(ch)) lastSpace = i;
    if (i + 1 - start >= maxChars) {
      const cut = lastSpace > start ? lastSpace + 1 : i + 1;
      out.push(text.slice(start, cut));
      start = cut;
      lastSpace = -1;
      // Re-scan whitespace between the cut and i for the next window
      for (let j = cut; j <= i; j++) if (isSpace(text[j])) lastSpace = j;
    }
  }
  if (start < n) out.push(text.slice(start));
  return out;
}
