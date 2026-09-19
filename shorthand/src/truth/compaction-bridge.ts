/**
 * Truth Ledger Interop — compaction bridge
 *
 * Wires the truth ledger into short-hand's compaction levels at the JSONL
 * seam (Option B): at compaction time the current-truth selection is
 * ingested as high-priority input that survives every level, and
 * compaction may emit its candidate invariants back as PROPOSAL lines.
 *
 * The contract this bridge enforces (§7):
 *   - Active TB      → ground truth: compacted, citable.
 *   - Contested TB   → carried WITH its contesting UVs; the dispute is
 *                      never resolved silently in either direction.
 *   - Open UV        → flagged `UNVERIFIED`; compaction never promotes a
 *                      UV into something that reads as proven.
 *   - History        → excluded; a stale cached copy is displaced on the
 *                      next sync because the section is always rebuilt.
 *
 * Write direction: proposals only. There is no anonymous write path —
 * generic identities are rejected before a line is ever emitted, and the
 * compactor cannot sign its own output.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type {
  CompactedState,
  CompactionLevel,
  Compactor,
  ConversationHistory,
} from '../compaction/types.js';
import { estimateTokens } from '../compaction/compactor.js';
import type {
  CompactedTruth,
  InvariantProposalLine,
  TruthConfidence,
  TruthSelection,
  TruthTbEntry,
  TruthUvEntry,
} from './types.js';
import { assertAccountableAuthor, ulid } from './types.js';

// ---------------------------------------------------------------------------
// Rendering — the truth section that rides the compacted summary
// ---------------------------------------------------------------------------

function renderTb(tb: TruthTbEntry): string {
  const signer = tb.signedBy ?? tb.author;
  return `- [TB] ${tb.claim} (signed: ${signer}, evidence: ${tb.evidence.length})`;
}

function renderUv(uv: TruthUvEntry): string {
  return `- [UV — UNVERIFIED] ${uv.assertion} (basis: ${uv.basis}; verify by ${uv.verifyBy.kind}: ${uv.verifyBy.value})`;
}

/**
 * Render a truth selection as the markdown section appended to compacted
 * summaries. Markers are load-bearing: `[TB]` may be relied on, `[TB ⚠
 * CONTESTED]` carries its dispute, `[UV — UNVERIFIED]` is the dragon
 * marker and must never be dropped by deeper compaction.
 */
export function renderTruthSection(selection: TruthSelection): string {
  const lines: string[] = ['## Asserted Truth (ledger)'];

  if (
    selection.groundTruth.length === 0 &&
    selection.contested.length === 0 &&
    selection.unverified.length === 0
  ) {
    lines.push('(no current truth entries)');
    return lines.join('\n');
  }

  for (const tb of selection.groundTruth) {
    lines.push(renderTb(tb));
  }

  for (const { tombstone, contestedBy } of selection.contested) {
    lines.push(`- [TB ⚠ CONTESTED] ${tombstone.claim} (signed: ${tombstone.signedBy ?? tombstone.author})`);
    for (const uv of contestedBy) {
      lines.push(`  - disputed by [UV — UNVERIFIED] ${uv.assertion} (${uv.author})`);
    }
  }

  for (const uv of selection.unverified) {
    // Contesting UVs already ride their TB above; open standalone UVs land here.
    if (uv.contests) continue;
    lines.push(renderUv(uv));
  }

  return lines.join('\n');
}

/**
 * Attach a truth selection to a compacted state. The section is rebuilt
 * from scratch — any truth text a previous round carried is displaced,
 * which is how overridden TBs and refuted UVs leave the cache.
 */
export function applyTruthToCompactedState(
  state: CompactedState,
  selection: TruthSelection,
  now: Date = new Date(),
): CompactedState {
  const truth: CompactedTruth = {
    syncedAt: now.toISOString(),
    groundTruth: selection.groundTruth,
    contested: selection.contested,
    unverified: selection.unverified,
    sourceEntryCount:
      selection.groundTruth.length +
      selection.contested.length +
      selection.unverified.length +
      selection.history.length,
  };

  // Strip any truth section a previous round attached — it is always
  // rebuilt from the current selection, never carried forward as text.
  const marker = '## Asserted Truth (ledger)';
  const markerIdx = state.summary.indexOf(marker);
  const baseSummary = markerIdx >= 0 ? state.summary.slice(0, markerIdx).trimEnd() : state.summary;

  const summary = `${baseSummary}\n\n${renderTruthSection(selection)}`;

  return {
    ...state,
    summary,
    truth,
    compactedTokenCount: estimateTokens(summary),
  };
}

// ---------------------------------------------------------------------------
// TruthAwareCompactor — a Compactor decorator
// ---------------------------------------------------------------------------

/**
 * Wraps any Compactor so every compacted state carries the current truth
 * selection. The selection is re-applied on recompaction, so deeper levels
 * keep the full section (truth is the durable residue — it never compacts
 * away) and stale entries are displaced.
 */
export class TruthAwareCompactor implements Compactor {
  constructor(
    private readonly inner: Compactor,
    private selection: TruthSelection,
  ) {}

  /** Replace the selection (e.g. after re-reading the wiki JSONL). */
  sync(selection: TruthSelection): void {
    this.selection = selection;
  }

  async compact(history: ConversationHistory, level: CompactionLevel): Promise<CompactedState> {
    const state = await this.inner.compact(history, level);
    return applyTruthToCompactedState(state, this.selection);
  }

  async recompact(state: CompactedState, targetLevel: CompactionLevel): Promise<CompactedState> {
    const next = await this.inner.recompact(state, targetLevel);
    return applyTruthToCompactedState(next, this.selection);
  }
}

// ---------------------------------------------------------------------------
// L4 bridge — invariants with the confidence type riding along
// ---------------------------------------------------------------------------

/** An L4-ready invariant record. The confidence axis must ride along. */
export interface TruthInvariantRecord {
  /** LWW register key (the entry id keeps records collision-free). */
  key: string;
  /** Marked value — the marker travels inside the stored string because L4 registers hold strings. */
  value: string;
  confidence: TruthConfidence;
  contested: boolean;
}

/**
 * Project the current truth selection into L4-shaped invariant records.
 * An L4 invariant is very often actually a UV — tribal knowledge that
 * compacted well but was never verified — so the marker is embedded in
 * the value itself and survives any string-typed store.
 */
export function truthToInvariantRecords(selection: TruthSelection): TruthInvariantRecord[] {
  const records: TruthInvariantRecord[] = [];

  for (const tb of selection.groundTruth) {
    records.push({
      key: `truth:${tb.id}`,
      value: `[TB] ${tb.claim}`,
      confidence: 'tb',
      contested: false,
    });
  }

  for (const { tombstone, contestedBy } of selection.contested) {
    const disputes = contestedBy.map((uv) => uv.assertion).join(' | ');
    records.push({
      key: `truth:${tombstone.id}`,
      value: `[TB ⚠ CONTESTED] ${tombstone.claim}${disputes ? ` — disputed: ${disputes}` : ''}`,
      confidence: 'tb',
      contested: true,
    });
  }

  for (const uv of selection.unverified) {
    if (uv.contests) continue;
    records.push({
      key: `truth:${uv.id}`,
      value: `[UV — UNVERIFIED] ${uv.assertion}`,
      confidence: 'uv',
      contested: false,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Proposal emission — compaction's only write path toward the ledger
// ---------------------------------------------------------------------------

export interface ProposeInvariantsOptions {
  /** Accountable author — anonymous/generic identities throw. */
  author: string;
  /** Agent session lineage for downstream provenance-independence checks. */
  agentSessionId?: string | null;
  /** Clock injection for deterministic tests. */
  now?: Date;
}

/**
 * Derive candidate invariants from a compacted state as PROPOSAL lines.
 * Entities that survived compaction with corrections settled, and
 * decisions that were never superseded, are exactly the "tribal knowledge
 * that compacted well but was never verified" the ledger models as UVs —
 * so they are proposed, never asserted.
 */
export function proposeInvariants(
  state: CompactedState,
  options: ProposeInvariantsOptions,
): InvariantProposalLine[] {
  assertAccountableAuthor(options.author);
  const ts = (options.now ?? new Date()).toISOString();
  const proposals: InvariantProposalLine[] = [];

  const push = (
    assertion: string,
    basis: string,
    targetRef: string,
    verifyValue: string,
  ): void => {
    proposals.push({
      type: 'PROPOSAL',
      kind: 'uv',
      id: ulid(),
      ts,
      author: options.author,
      draft: {
        assertion,
        basis,
        verifyBy: {
          kind: 'inspect',
          value: verifyValue,
          detail: 'confirm the compacted value still holds in the source conversation',
        },
      },
      signal: {
        source: 'shorthand-compaction',
        detail: `level ${state.level}, round ${state.roundNumber}, session ${state.sessionId}`,
      },
      targetRef,
      agentSessionId: options.agentSessionId ?? null,
    });
  };

  for (const entity of state.entities) {
    if (entity.type !== 'configuration') continue;
    const settled =
      entity.corrections.length > 0
        ? ` (settled after ${entity.corrections.length} correction${entity.corrections.length === 1 ? '' : 's'})`
        : '';
    push(
      `${entity.name} is ${String(entity.value)}.`,
      `Compacted from session ${state.sessionId}${settled}; last mentioned in message ${entity.lastMention}.`,
      `entity:${state.sessionId}:${entity.name}`,
      `message:${entity.lastMention}`,
    );
  }

  for (const decision of state.decisions) {
    if (decision.supersededBy) continue;
    push(
      `Decision holds: ${decision.description}.`,
      `Recorded at message ${decision.madeAt} in session ${state.sessionId}; ${decision.alternatives.length} alternative(s) rejected.`,
      `decision:${state.sessionId}:${decision.id}`,
      `message:${decision.madeAt}`,
    );
  }

  return proposals;
}

/** Serialize proposals as JSONL lines. */
export function serializeProposals(proposals: InvariantProposalLine[]): string[] {
  return proposals.map((p) => JSON.stringify(p));
}

/**
 * Append proposals to a JSONL file (created if absent), deduplicating by
 * `targetRef` against lines already present so repeated compaction rounds
 * do not re-propose the same invariant.
 */
export function appendProposalsFile(
  path: string,
  proposals: InvariantProposalLine[],
): { written: number; skipped: number } {
  const existingRefs = new Set<string>();
  if (existsSync(path)) {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { targetRef?: string | null };
        if (parsed.targetRef) existingRefs.add(parsed.targetRef);
      } catch {
        // Foreign or malformed lines never block the append path.
      }
    }
  }

  const fresh = proposals.filter((p) => !p.targetRef || !existingRefs.has(p.targetRef));
  if (fresh.length > 0) {
    appendFileSync(path, serializeProposals(fresh).map((l) => l + '\n').join(''));
  }
  return { written: fresh.length, skipped: proposals.length - fresh.length };
}
