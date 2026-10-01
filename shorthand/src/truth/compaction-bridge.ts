/**
 * Truth Ledger Interop — rendering and the snapshot compaction bridge
 *
 * Renders the current-truth selection with the suite's frozen markers
 * (`[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`) and wires it into
 * snapshot compaction: the selection rides every `CompactedSnapshot` as
 * high-priority input that survives every level, and compaction may emit
 * its candidate invariants back as PROPOSAL lines. (The LSM engine syncs
 * the same selection via `CompactionEngine.syncTruthLedger`.)
 *
 * The contract this bridge enforces (§7):
 *   - Active TB      → ground truth: compacted, citable.
 *   - Contested TB   → carried WITH its contesting UVs; the dispute is
 *                      never resolved silently in either direction.
 *   - Open UV        → flagged `UNVERIFIED`; compaction never promotes a
 *                      UV into something that reads as proven, and never
 *                      drops one.
 *   - History        → excluded; a stale cached copy is displaced on the
 *                      next sync because the section is always rebuilt.
 *
 * Write direction: proposals only. There is no anonymous write path —
 * generic identities are rejected before a line is ever emitted, and the
 * compactor cannot sign its own output.
 */

import type {
  CompactedSnapshot,
  SnapshotLevel,
  SnapshotCompactor,
  ConversationHistory,
} from '../compaction/snapshot/types.js';
import { estimateTokens } from '../utils.js';
import { escapeUntrusted } from '../compaction/frame.js';
import type {
  CompactedTruth,
  TruthConfidence,
  TruthSelection,
  TruthTbEntry,
  TruthUvEntry,
  UvProposalLine,
} from './types.js';
import { TRUTH_SOURCE_PREFIX } from './types.js';
import { assertAccountableAuthor } from './identity.js';
import { uvProposal, type ProposeInvariantsOptions } from './proposal-export.js';

export type { ProposeInvariantsOptions } from './proposal-export.js';
// The proposals stream writer lives in proposals.ts; these two names have always been exported from here.
export { appendProposalsFile, serializeProposals } from './proposals.js';

// ---------------------------------------------------------------------------
// Rendering — the truth section that rides the compacted summary
// ---------------------------------------------------------------------------

/** Heading of the rendered truth section. */
export const TRUTH_SECTION_HEADING = '## Asserted Truth (ledger)';

/** Ledger fields are untrusted text: one line, no forged markers. */
function field(text: string): string {
  return escapeUntrusted(String(text), { singleLine: true });
}

function signature(tb: TruthTbEntry): string {
  return tb.signedBy ? `signed: ${field(tb.signedBy)}` : 'unsigned';
}

function renderTb(tb: TruthTbEntry): string {
  return `- [TB] ${field(tb.claim)} (${signature(tb)}, evidence: ${tb.evidence.length})`;
}

function renderUv(uv: TruthUvEntry): string {
  const contests = uv.contests ? `; contests ${field(uv.contests)}` : '';
  return `- [UV — UNVERIFIED] ${field(uv.assertion)} (basis: ${field(uv.basis)}; verify by ${field(uv.verifyBy.kind)}: ${field(uv.verifyBy.value)}${contests})`;
}

/** Ids of open UVs that ride a contested TB in this selection. */
function attachedUvIds(selection: TruthSelection): Set<string> {
  const ids = new Set<string>();
  for (const { contestedBy } of selection.contested) {
    for (const uv of contestedBy) ids.add(uv.id);
  }
  return ids;
}

/**
 * One budgetable unit of the truth section: a ground-truth TB, a contested
 * TB together with every UV disputing it (kept atomic — the dispute is
 * never shown without the TB, nor the TB without its dispute), or a
 * standalone open UV. `text` may span several lines; `sources` are ledger
 * entry ids.
 */
export interface TruthItem {
  kind: 'ground-truth' | 'contested' | 'unverified';
  text: string;
  sources: string[];
}

/**
 * Render a truth selection as budgetable items, in priority order: ground
 * truth, contested groups, open UVs. Each open UV appears exactly once:
 * beside its TB when that TB is contested in the selection, standalone
 * otherwise — including a UV contesting a TB the ledger has not (yet)
 * re-emitted as contested. Ledger fields are escaped (`escapeUntrusted`),
 * so a field can never forge a marker or a line.
 */
export function renderTruthItems(selection: TruthSelection): TruthItem[] {
  const items: TruthItem[] = [];

  for (const tb of selection.groundTruth) {
    items.push({ kind: 'ground-truth', text: renderTb(tb), sources: [tb.id] });
  }

  for (const { tombstone, contestedBy } of selection.contested) {
    const lines = [`- [TB ⚠ CONTESTED] ${field(tombstone.claim)} (${signature(tombstone)})`];
    for (const uv of contestedBy) {
      lines.push(`  - disputed by [UV — UNVERIFIED] ${field(uv.assertion)} (${field(uv.author)})`);
    }
    items.push({ kind: 'contested', text: lines.join('\n'), sources: [tombstone.id, ...contestedBy.map((uv) => uv.id)] });
  }

  const attached = attachedUvIds(selection);
  for (const uv of selection.unverified) {
    if (attached.has(uv.id)) continue;
    items.push({ kind: 'unverified', text: renderUv(uv), sources: [uv.id] });
  }

  return items;
}

/** Render a truth selection as marked lines, without the heading (see `renderTruthItems`). */
export function renderTruthLines(selection: TruthSelection): string[] {
  return renderTruthItems(selection).flatMap((item) => item.text.split('\n'));
}

/**
 * Render a truth selection as the markdown section appended to compacted
 * summaries and placed first in context frames. Markers are load-bearing:
 * `[TB]` may be relied on, `[TB ⚠ CONTESTED]` carries its dispute,
 * `[UV — UNVERIFIED]` is the dragon marker and must never be dropped by
 * deeper compaction.
 */
export function renderTruthSection(selection: TruthSelection): string {
  const lines = renderTruthLines(selection);
  if (lines.length === 0) return `${TRUTH_SECTION_HEADING}\n(no current truth entries)`;
  return [TRUTH_SECTION_HEADING, ...lines].join('\n');
}

/**
 * Attach a truth selection to a compacted snapshot. The section is rebuilt
 * from scratch — any truth text a previous round carried is displaced,
 * which is how overridden TBs and refuted UVs leave the cache. The
 * compacted conversation it sits beside is untrusted text: it goes through
 * `escapeUntrusted`, so a message or tool output that reproduces a `[TB]`
 * line or the truth heading can never pass for ledger truth (SH-04).
 */
export function applyTruthToSnapshot(
  state: CompactedSnapshot,
  selection: TruthSelection,
  now: Date = new Date(),
): CompactedSnapshot {
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

  // Strip the truth section a previous round appended — it is always
  // rebuilt from the current selection, never carried forward as text.
  // Only that exact trailing section goes: the heading can also appear
  // inside conversation text (a pasted summary), and everything around it
  // must survive.
  const baseSummary = stripAppendedTruth(state);

  const summary = `${escapeUntrusted(baseSummary)}\n\n${renderTruthSection(selection)}`;

  return {
    ...state,
    summary,
    truth,
    compactedTokenCount: estimateTokens(summary),
  };
}

function stripAppendedTruth(state: CompactedSnapshot): string {
  if (!state.truth) return state.summary;
  const previous = renderTruthSection({
    groundTruth: state.truth.groundTruth,
    contested: state.truth.contested,
    unverified: state.truth.unverified,
    history: [],
  });
  const suffix = `\n\n${previous}`;
  return state.summary.endsWith(suffix) ? state.summary.slice(0, -suffix.length) : state.summary;
}

/** @deprecated Renamed to `applyTruthToSnapshot` (it takes a `CompactedSnapshot`). */
export const applyTruthToCompactedState = applyTruthToSnapshot;

// ---------------------------------------------------------------------------
// TruthAwareCompactor — a SnapshotCompactor decorator
// ---------------------------------------------------------------------------

/**
 * Wraps any SnapshotCompactor so every compacted snapshot carries the current truth
 * selection. The selection is re-applied on recompaction, so deeper levels
 * keep the full section (truth is the durable residue — it never compacts
 * away) and stale entries are displaced.
 */
export class TruthAwareCompactor implements SnapshotCompactor {
  constructor(
    private readonly inner: SnapshotCompactor,
    private selection: TruthSelection,
  ) {}

  /** Replace the selection (e.g. after re-reading the wiki JSONL). */
  sync(selection: TruthSelection): void {
    this.selection = selection;
  }

  async compact(history: ConversationHistory, level: SnapshotLevel): Promise<CompactedSnapshot> {
    const state = await this.inner.compact(history, level);
    return applyTruthToSnapshot(state, this.selection);
  }

  async recompact(state: CompactedSnapshot, targetLevel: SnapshotLevel): Promise<CompactedSnapshot> {
    const next = await this.inner.recompact(state, targetLevel);
    return applyTruthToSnapshot(next, this.selection);
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
      key: `${TRUTH_SOURCE_PREFIX}${tb.id}`,
      value: `[TB] ${field(tb.claim)}`,
      confidence: 'tb',
      contested: false,
    });
  }

  for (const { tombstone, contestedBy } of selection.contested) {
    const disputes = contestedBy.map((uv) => field(uv.assertion)).join(' | ');
    records.push({
      key: `${TRUTH_SOURCE_PREFIX}${tombstone.id}`,
      value: `[TB ⚠ CONTESTED] ${field(tombstone.claim)}${disputes ? ` — disputed: ${disputes}` : ''}`,
      confidence: 'tb',
      contested: true,
    });
  }

  const attached = attachedUvIds(selection);
  for (const uv of selection.unverified) {
    if (attached.has(uv.id)) continue;
    records.push({
      key: `${TRUTH_SOURCE_PREFIX}${uv.id}`,
      value: `[UV — UNVERIFIED] ${field(uv.assertion)}`,
      confidence: 'uv',
      contested: false,
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Proposal emission — compaction's only write path toward the ledger
// ---------------------------------------------------------------------------

/**
 * Derive candidate invariants from a compacted state as PROPOSAL lines.
 * Entities that survived compaction with corrections settled, and
 * decisions that were never superseded, are exactly the "tribal knowledge
 * that compacted well but was never verified" the ledger models as UVs —
 * so they are proposed, never asserted.
 */
export function proposeInvariants(
  state: CompactedSnapshot,
  options: ProposeInvariantsOptions,
): UvProposalLine[] {
  assertAccountableAuthor(options.author);
  const proposals: UvProposalLine[] = [];
  const detail = `level ${state.level}, round ${state.roundNumber}, session ${state.sessionId}`;

  const push = (assertion: string, basis: string, targetRef: string, sourceMessageId: string): void => {
    proposals.push(
      uvProposal(
        {
          assertion,
          basis,
          verifyBy: {
            kind: 'inspect',
            value: `message:${sourceMessageId}`,
            detail: 'confirm the compacted value still holds in the source conversation',
          },
        },
        { targetRef, detail },
        options,
      ),
    );
  };

  for (const entity of state.entities) {
    if (entity.type !== 'configuration') continue;
    // "chose postgres" names a value, not a fact about one: "postgres is postgres." says nothing (SAT-10)
    if (sameText(String(entity.value), entity.name)) continue;
    const settled =
      entity.corrections.length > 0
        ? ` (settled after ${entity.corrections.length} correction${entity.corrections.length === 1 ? '' : 's'})`
        : '';
    push(
      `${entity.name} is ${String(entity.value)}.`,
      `Compacted from session ${state.sessionId}${settled}; last mentioned in message ${entity.lastMention}.`,
      `entity:${state.sessionId}:${entity.name}`,
      entity.lastMention,
    );
  }

  for (const decision of state.decisions) {
    if (decision.supersededBy) continue;
    push(
      `Decision holds: ${decision.description}.`,
      `Recorded at message ${decision.madeAt} in session ${state.sessionId}; ${decision.alternatives.length} alternative(s) rejected.`,
      `decision:${state.sessionId}:${decision.id}`,
      decision.madeAt,
    );
  }

  return proposals;
}

function sameText(a: string, b: string): boolean {
  const key = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return key(a) === key(b);
}
