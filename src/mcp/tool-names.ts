/**
 * MCP tool names for `smallchat serve` — the exact, collision-free mapping
 * between the names a client sees in tools/list and canonical tool ids.
 *
 * Two modes:
 *   - Aggregate (default): every provider's tools, each named
 *     `<providerId>__<toolName>` (matches ^[A-Za-z0-9_-]{1,128}$).
 *   - Per provider (`serve --provider <id>`): one provider's tools under
 *     their upstream names, verbatim — so policies keyed by upstream server
 *     and tool name (e.g. OpenAPPA batteries, `mcp/<server>/<tool>`) apply
 *     unchanged.
 *
 * Collisions are impossible by construction: an aggregate name is accepted
 * only when the provider id has no "__" and does not end in "_", so the
 * first "__" in a name always ends the provider id and the name maps back
 * to exactly one (providerId, toolName). Upstream names within one
 * provider are unique (they key its tools). Tools whose names cannot be
 * represented are left out and reported — never renamed.
 */

import type { ArtifactTool, ArtifactV1 } from '../artifact/types.js';

/** Characters and length every aggregate tool name satisfies. */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Longest tool name the MCP specification recommends (and every aggregate
 * name satisfies). Longer names a caller sends get no "did you mean"
 * suggestions and are shortened in messages and audit entries.
 */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Separator between provider id and upstream tool name in aggregate mode. */
export const AGGREGATE_SEPARATOR = '__';

/** Name of the semantic-resolution meta-tool. */
export const RESOLVE_TOOL_NAME = 'smallchat_resolve';

/** One servable tool: its MCP name and the canonical tool id it runs. */
export interface ToolTableEntry {
  /** Name in tools/list and tools/call */
  name: string;
  /** Canonical tool id `<providerId>/<toolName>` */
  toolId: string;
  tool: ArtifactTool;
}

/** A tool the server cannot expose under the current mode, and why. */
export interface SkippedTool {
  toolId: string;
  reason: string;
}

export interface ToolTable {
  /** 'aggregate', or the provider id served verbatim */
  mode: 'aggregate' | { provider: string };
  entries: ToolTableEntry[];
  skipped: SkippedTool[];
  byName: Map<string, ToolTableEntry>;
  byToolId: Map<string, ToolTableEntry>;
}

/**
 * Whether a provider id can prefix aggregate names unambiguously: only
 * [A-Za-z0-9_-], no "__", no trailing "_".
 */
export function isAggregateProviderId(providerId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(providerId)
    && !providerId.includes(AGGREGATE_SEPARATOR)
    && !providerId.endsWith('_');
}

/** `<providerId>__<toolName>` */
export function aggregateToolName(providerId: string, toolName: string): string {
  return `${providerId}${AGGREGATE_SEPARATOR}${toolName}`;
}

/**
 * Build the name table for an artifact. With `provider`, only that
 * provider's tools, under their upstream names; otherwise aggregate names.
 * Throws if `provider` is not in the artifact.
 */
export function buildToolTable(artifact: ArtifactV1, options: { provider?: string } = {}): ToolTable {
  const entries: ToolTableEntry[] = [];
  const skipped: SkippedTool[] = [];
  const provider = options.provider;

  if (provider !== undefined && !artifact.providers[provider]) {
    const known = Object.keys(artifact.providers).sort().join(', ') || '(none)';
    throw new Error(`Provider "${provider}" is not in the artifact. Providers: ${known}`);
  }

  for (const tool of Object.values(artifact.tools)) {
    if (provider !== undefined) {
      if (tool.providerId === provider) entries.push({ name: tool.name, toolId: tool.id, tool });
      continue;
    }
    if (!isAggregateProviderId(tool.providerId)) {
      skipped.push({
        toolId: tool.id,
        reason: `provider id "${tool.providerId}" must match [A-Za-z0-9_-], contain no "__" and not end in "_" to prefix aggregate names; serve it with --provider ${tool.providerId}`,
      });
      continue;
    }
    const name = aggregateToolName(tool.providerId, tool.name);
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      skipped.push({
        toolId: tool.id,
        reason: `"${name}" is not a valid aggregate tool name (^[A-Za-z0-9_-]{1,128}$); serve it with --provider ${tool.providerId}`,
      });
      continue;
    }
    entries.push({ name, toolId: tool.id, tool });
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const byName = new Map<string, ToolTableEntry>();
  const byToolId = new Map<string, ToolTableEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      // Unreachable for a valid artifact (see module doc); refuse rather than shadow.
      throw new Error(`Tool name "${entry.name}" maps to both ${byName.get(entry.name)!.toolId} and ${entry.toolId}`);
    }
    byName.set(entry.name, entry);
    byToolId.set(entry.toolId, entry);
  }

  return { mode: provider === undefined ? 'aggregate' : { provider }, entries, skipped, byName, byToolId };
}

/**
 * A caller-supplied tool name, shortened to MAX_TOOL_NAME_LENGTH (plus a
 * note of how much was cut) for error messages and audit entries.
 */
export function displayToolName(name: string): string {
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH)}…(+${name.length - MAX_TOOL_NAME_LENGTH} chars)`;
}

/**
 * Names close to `name`, best first: same name in another provider,
 * substring matches, then small edit distances. For "did you mean"
 * messages only — nothing is ever executed from this list. A name longer
 * than MAX_TOOL_NAME_LENGTH gets no suggestions, and edit distances are
 * only computed where the lengths allow a match, so the work per call is
 * bounded whatever the caller sends.
 */
export function closeMatches(name: string, names: Iterable<string>, limit = 5): string[] {
  if (name.length > MAX_TOOL_NAME_LENGTH) return [];
  const needle = name.toLowerCase();
  const bare = needle.includes(AGGREGATE_SEPARATOR) ? needle.slice(needle.indexOf(AGGREGATE_SEPARATOR) + 2) : needle;
  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of names) {
    const lower = candidate.toLowerCase();
    const candidateBare = lower.includes(AGGREGATE_SEPARATOR) ? lower.slice(lower.indexOf(AGGREGATE_SEPARATOR) + 2) : lower;
    let score: number;
    if (candidateBare === bare || lower.endsWith(`${AGGREGATE_SEPARATOR}${needle}`)) score = 0;
    else if (lower.includes(needle) || needle.includes(lower)) score = 1;
    else {
      const max = Math.max(2, Math.floor(Math.min(needle.length, lower.length) / 3));
      // An edit distance is at least the difference in length.
      const distance = Math.abs(needle.length - lower.length) <= max ? editDistance(needle, lower) : Infinity;
      const bareDistance = Math.abs(bare.length - candidateBare.length) <= max ? editDistance(bare, candidateBare) : Infinity;
      const best = Math.min(distance, bareDistance);
      if (best > max) continue;
      score = 1 + best;
    }
    scored.push({ name: candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return scored.slice(0, limit).map(s => s.name);
}

/** Levenshtein distance (two-row DP). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
