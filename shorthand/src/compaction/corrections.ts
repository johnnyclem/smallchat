/**
 * Level-complete tombstone application.
 *
 * A correction must reach every level that can still state the superseded
 * value: L1 entries, L2 summaries and their decisions, L3 entities and the
 * edges touching them, and L4 invariants. Nothing is deleted — every item a
 * tombstone removes is archived under the tombstone's id, so the step can
 * be reverted (`revertTombstone`). Invariants projected from the truth
 * ledger are never displaced by conversation corrections; the ledger sync
 * owns them.
 */

import type {
  ArchivedItem,
  CompactedEntry,
  CompactedState,
  Decision,
  Edge,
  Entity,
  Invariant,
  TopicSummary,
  Tombstone,
} from '../types.js';
import { TRUTH_SOURCE_PREFIX } from '../truth/types.js';
import { supersededMatcher } from './matching.js';

export interface ApplyTombstoneOptions {
  /**
   * Restrict the tombstone to items whose source message passes this test
   * (e.g. only messages older than the correction). Default: every item.
   */
  appliesToSource?: (messageId: string) => boolean;
}

function archiveOf(state: CompactedState): ArchivedItem[] {
  if (!state.archive) state.archive = [];
  return state.archive;
}

function insertByTime(entries: CompactedEntry[], entry: CompactedEntry): void {
  if (entry.timestamp === undefined) {
    entries.push(entry);
    return;
  }
  const at = entries.findIndex((e) => e.timestamp !== undefined && e.timestamp > entry.timestamp!);
  if (at === -1) entries.push(entry);
  else entries.splice(at, 0, entry);
}

/** Add `id` to an item's `alsoBy` list once. */
function addAlso(holder: { alsoBy?: string[] }, id: string): void {
  const list = holder.alsoBy ?? (holder.alsoBy = []);
  if (!list.includes(id)) list.push(id);
}

/**
 * Archive everything in `state` that states only the value `tombstone`
 * superseded. Mutates `state`; returns the number of items archived.
 * A tombstone without a superseded value (or without an id) is a no-op.
 * Items another tombstone already archived that this one supersedes too
 * are marked (`alsoBy`), so reverting that tombstone leaves them archived.
 */
export function applyTombstone(
  state: CompactedState,
  tombstone: Tombstone,
  options: ApplyTombstoneOptions = {},
): number {
  const by = tombstone.id;
  if (!by) return 0;
  const statesOnlyOld = supersededMatcher(tombstone);
  const eligible = options.appliesToSource ?? (() => true);
  const archive = archiveOf(state);
  const before = archive.length;

  // The original statement goes, and so does anything else that states only
  // the old value. The correction message itself never does.
  const l1Stale = (entry: CompactedEntry) =>
    entry.originalMessageId !== tombstone.correctionMessageId &&
    eligible(entry.originalMessageId) &&
    (entry.originalMessageId === tombstone.originalMessageId || statesOnlyOld(entry.compacted));
  const entityStale = (entity: Entity) => eligible(entity.lastMention) && statesOnlyOld(entity.name);
  const edgeStale = (edge: Edge) => eligible(edge.sourceMessage) && statesOnlyOld(`${edge.source} ${edge.target}`);
  const invariantStale = (inv: Invariant) =>
    !inv.sourceMessage.startsWith(TRUTH_SOURCE_PREFIX) && eligible(inv.sourceMessage) && statesOnlyOld(`${inv.key} ${inv.value}`);
  /** Decisions that chose the old value are superseded (or, if already, marked as superseded by this one too). */
  const supersedeDecisions = (summary: TopicSummary) => {
    for (const decision of summary.decisions) {
      if (!eligible(decision.messageId) || !statesOnlyOld(decision.chosen)) continue;
      if (!decision.superseded) {
        decision.superseded = true;
        decision.tombstoneId = by;
      } else if (decision.tombstoneId !== by) {
        addAlso(decision, by);
      }
    }
  };

  // L1
  const keptL1: CompactedEntry[] = [];
  for (const entry of state.l1_compacted) {
    if (l1Stale(entry)) archive.push({ kind: 'l1', reason: 'superseded', by, entry });
    else keptL1.push(entry);
  }
  state.l1_compacted = keptL1;

  // L2 — a summary goes to the archive when nothing in it still holds
  const keptL2: TopicSummary[] = [];
  for (const summary of state.l2_summaries) {
    supersedeDecisions(summary);
    const stale =
      summary.decisions.length > 0
        ? summary.decisions.every((d) => d.superseded) && summary.decisions.some((d) => d.tombstoneId === by)
        : eligible(summary.messageRange.last) && statesOnlyOld(summary.summary);
    if (stale) archive.push({ kind: 'summary', reason: 'superseded', by, summary });
    else keptL2.push(summary);
  }
  state.l2_summaries = keptL2;

  // L3 — entities named by the old value, and every edge touching them
  const removedEntities = new Set<string>();
  for (const [key, entity] of state.l3_graph.entities) {
    if (entityStale(entity)) {
      archive.push({ kind: 'entity', reason: 'superseded', by, entity });
      state.l3_graph.entities.delete(key);
      removedEntities.add(entity.name);
    }
  }

  // Items other tombstones archived before: does this one supersede them too?
  const earlier = archive.slice(0, before).filter((item) => item.reason === 'superseded' && item.by !== by);
  for (const item of earlier) {
    switch (item.kind) {
      case 'l1':
        if (l1Stale(item.entry)) addAlso(item, by);
        break;
      case 'summary':
        supersedeDecisions(item.summary);
        if (item.summary.decisions.length === 0 && eligible(item.summary.messageRange.last) && statesOnlyOld(item.summary.summary)) {
          addAlso(item, by);
        }
        break;
      case 'entity':
        if (entityStale(item.entity)) {
          addAlso(item, by);
          removedEntities.add(item.entity.name);
        }
        break;
      case 'invariant':
        if (invariantStale(item.invariant)) addAlso(item, by);
        break;
    }
  }
  for (const item of earlier) {
    if (item.kind !== 'edge') continue;
    const { edge } = item;
    if (removedEntities.has(edge.source) || removedEntities.has(edge.target) || edgeStale(edge)) addAlso(item, by);
  }

  const keptEdges: Edge[] = [];
  for (const edge of state.l3_graph.edges) {
    const stale = removedEntities.has(edge.source) || removedEntities.has(edge.target) || edgeStale(edge);
    if (stale) archive.push({ kind: 'edge', reason: 'superseded', by, edge });
    else keptEdges.push(edge);
  }
  state.l3_graph.edges = keptEdges;

  // L4 — invariants whose key and value together state only the old value
  const keptL4: Invariant[] = [];
  for (const inv of state.l4_invariants) {
    if (invariantStale(inv)) archive.push({ kind: 'invariant', reason: 'superseded', by, invariant: { ...inv, displacedBy: by } });
    else keptL4.push(inv);
  }
  state.l4_invariants = keptL4;

  return archive.length - before;
}

/**
 * Undo a tombstone: drop it and restore everything archived under its id,
 * except what another tombstone still present supersedes too — that stays
 * archived (and decisions superseded), under that tombstone. Mutates
 * `state`; returns false when no tombstone has that id.
 */
export function revertTombstone(state: CompactedState, id: string): boolean {
  const index = state.tombstones.findIndex((t) => t.id === id);
  if (index === -1) return false;
  state.tombstones.splice(index, 1);
  const remaining = new Set(state.tombstones.map((t) => t.id).filter((t): t is string => t !== undefined));
  const successor = (alsoBy: string[] | undefined) => alsoBy?.find((t) => remaining.has(t));
  const without = (alsoBy: string[] | undefined, ...ids: string[]) => {
    const rest = alsoBy?.filter((t) => !ids.includes(t));
    return rest && rest.length > 0 ? rest : undefined;
  };

  /** Hand a decision this tombstone superseded to the next one that supersedes it, or revive it. */
  const handOver = (decision: Decision) => {
    if (decision.tombstoneId !== id) {
      decision.alsoBy = without(decision.alsoBy, id);
      return;
    }
    const next = successor(decision.alsoBy);
    if (next) {
      decision.tombstoneId = next;
      decision.alsoBy = without(decision.alsoBy, id, next);
    } else {
      decision.superseded = false;
      decision.tombstoneId = undefined;
      decision.alsoBy = undefined;
    }
  };
  for (const summary of state.l2_summaries) summary.decisions.forEach(handOver);

  const kept: ArchivedItem[] = [];
  const restored: ArchivedItem[] = [];
  for (const item of state.archive ?? []) {
    if (item.reason !== 'superseded') {
      kept.push(item);
      continue;
    }
    if (item.kind === 'summary' && item.summary.decisions.length > 0) {
      item.summary.decisions.forEach(handOver);
      // A summary stays archived while every decision in it is superseded,
      // under a tombstone still present that superseded one of them
      const holders = item.summary.decisions.map((d) => d.tombstoneId).filter((t): t is string => t !== undefined && remaining.has(t));
      if (item.summary.decisions.every((d) => d.superseded) && holders.length > 0) {
        if (!holders.includes(item.by)) item.by = holders[0];
        item.alsoBy = without(item.alsoBy, id, item.by);
        kept.push(item);
      } else {
        restored.push(item);
      }
      continue;
    }
    if (item.by !== id) {
      item.alsoBy = without(item.alsoBy, id);
      kept.push(item);
      continue;
    }
    const next = successor(item.alsoBy);
    if (!next) {
      restored.push(item);
      continue;
    }
    item.by = next;
    item.alsoBy = without(item.alsoBy, id, next);
    if (item.kind === 'invariant') item.invariant = { ...item.invariant, displacedBy: next };
    kept.push(item);
  }
  state.archive = kept;

  for (const item of restored) {
    switch (item.kind) {
      case 'l1':
        insertByTime(state.l1_compacted, item.entry);
        break;
      case 'summary':
        state.l2_summaries.push(item.summary);
        break;
      case 'entity':
        if (!state.l3_graph.entities.has(item.entity.name)) state.l3_graph.entities.set(item.entity.name, item.entity);
        break;
      case 'edge':
        if (!state.l3_graph.edges.some((e) => sameEdge(e, item.edge))) state.l3_graph.edges.push(item.edge);
        break;
      case 'invariant': {
        const { displacedBy: _displacedBy, ...invariant } = item.invariant;
        state.l4_invariants.push(invariant);
        break;
      }
      case 'message':
        break;
    }
  }
  return true;
}

/** Edges are identified by (source, relation, target). */
export function sameEdge(a: Edge, b: Edge): boolean {
  return a.source === b.source && a.relation === b.relation && a.target === b.target;
}

/**
 * Retract messages (e.g. the chunks of a re-ingested document): corrections
 * they made are reverted, then every L0–L4 item that derives only from
 * them is archived. Mutates `state`; returns the number of items archived.
 */
export function retractMessages(state: CompactedState, messageIds: Iterable<string>, by: string): number {
  const ids = new Set(messageIds);
  for (const tombstone of state.tombstones.filter((t) => ids.has(t.correctionMessageId))) {
    if (tombstone.id) revertTombstone(state, tombstone.id);
    else state.tombstones = state.tombstones.filter((t) => t !== tombstone);
  }
  const archive = archiveOf(state);
  const before = archive.length;
  const only = (...sources: string[]) => sources.every((s) => ids.has(s));

  state.l0_messages = state.l0_messages.filter((message) => {
    if (!ids.has(message.id)) return true;
    archive.push({ kind: 'message', reason: 'retracted', by, message });
    return false;
  });
  state.l1_compacted = state.l1_compacted.filter((entry) => {
    if (!only(entry.originalMessageId, ...(entry.foldedMessageIds ?? []))) return true;
    archive.push({ kind: 'l1', reason: 'retracted', by, entry });
    return false;
  });
  state.l2_summaries = state.l2_summaries.filter((summary) => {
    const sources = summary.decisions.length > 0
      ? summary.decisions.map((d) => d.messageId)
      : [summary.messageRange.first, summary.messageRange.last];
    if (!only(...sources)) return true;
    archive.push({ kind: 'summary', reason: 'retracted', by, summary });
    return false;
  });
  const removed = new Set<string>();
  for (const [key, entity] of state.l3_graph.entities) {
    if (only(entity.firstMention, entity.lastMention)) {
      archive.push({ kind: 'entity', reason: 'retracted', by, entity: entity as Entity });
      state.l3_graph.entities.delete(key);
      removed.add(entity.name);
    }
  }
  state.l3_graph.edges = state.l3_graph.edges.filter((edge) => {
    if (!removed.has(edge.source) && !removed.has(edge.target) && !ids.has(edge.sourceMessage)) return true;
    archive.push({ kind: 'edge', reason: 'retracted', by, edge });
    return false;
  });
  state.l4_invariants = state.l4_invariants.filter((invariant) => {
    if (!ids.has(invariant.sourceMessage)) return true;
    archive.push({ kind: 'invariant', reason: 'retracted', by, invariant });
    return false;
  });
  return archive.length - before;
}
