/**
 * @shorthand/core — Shared Types
 *
 * Canonical ConversationMessage that unifies the compaction and importance
 * module representations into a single superset type.
 */

/** A single message in a conversation. */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** ISO 8601 string for serialization; epoch number for computation. */
  timestamp: string | number;
  /** Pre-computed embedding vector (optional — populated by embedding layer). */
  embedding?: Float32Array;
  /** Tool call metadata. */
  toolCall?: {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
  };
  /** If this message corrects/supersedes a prior message. */
  supersedes?: string;
}

/**
 * Normalize a timestamp to epoch milliseconds.
 * Accepts both ISO 8601 strings and numeric epoch values.
 */
export function normalizeTimestamp(ts: string | number): number {
  return typeof ts === 'string' ? new Date(ts).getTime() : ts;
}
