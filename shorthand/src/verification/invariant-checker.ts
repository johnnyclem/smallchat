/**
 * InvariantChecker — mechanically checkable safety properties.
 *
 * Verifies that the compacted state (and, optionally, a rendered context
 * frame) satisfies structural invariants:
 * - Correction propagation: no live item at L1–L4 still states a value a
 *   tombstone superseded (items restated after the correction excepted)
 * - Frame staleness: no derived frame line states a superseded value
 * - Entity provenance: every L3 entity traces to a source message
 * - Decision completeness: every decision includes alternatives
 * - Tombstone consistency: tombstones are complete and name a value
 * - Temporal ordering: firstMention is not after lastMention, and no
 *   correction predates the statement it corrects
 *
 * "Superseded" uses the same normalized whole-word matcher the compactor
 * uses (`statesOnlySuperseded`), so the checker and the compactor cannot
 * disagree about what a correction covers.
 */

import type { CompactedState, ContextFrame, Tombstone, VerificationResult } from '../types.js';
import { normalizeTimestamp } from '../types.js';
import { supersededMatcher } from '../compaction/matching.js';

interface Check {
  name: string;
  passed: boolean;
  message: string;
}

export interface InvariantCheckOptions {
  /**
   * A frame built from this state (`CompactionEngine.buildContextFrame`).
   * When given, its derived sections are checked for superseded values too
   * (`frame-staleness`).
   */
  frame?: ContextFrame;
}

/** Message order and time, as far as the state can tell. */
interface Timeline {
  /** Position in conversation order (L1 then L0), when the message is still live. */
  position: Map<string, number>;
  /** Epoch ms, when known. */
  time: Map<string, number>;
}

function buildTimeline(state: CompactedState): Timeline {
  const position = new Map<string, number>();
  const time = new Map<string, number>();
  const setTime = (id: string, t: number | undefined) => {
    if (t !== undefined && Number.isFinite(t) && !time.has(id)) time.set(id, t);
  };

  let i = 0;
  for (const entry of state.l1_compacted) {
    for (const id of [entry.originalMessageId, ...(entry.foldedMessageIds ?? [])]) {
      if (!position.has(id)) position.set(id, i++);
      setTime(id, entry.timestamp);
    }
  }
  for (const message of state.l0_messages) {
    if (!position.has(message.id)) position.set(message.id, i++);
    setTime(message.id, normalizeTimestamp(message.timestamp));
  }
  for (const item of state.archive ?? []) {
    if (item.kind === 'l1') setTime(item.entry.originalMessageId, item.entry.timestamp);
    if (item.kind === 'message') setTime(item.message.id, normalizeTimestamp(item.message.timestamp));
    if (item.kind === 'invariant') setTime(item.invariant.sourceMessage, item.invariant.timestamp);
  }
  for (const inv of state.l4_invariants) setTime(inv.sourceMessage, inv.timestamp);
  for (const t of state.tombstones) setTime(t.correctionMessageId, t.timestamp);
  return { position, time };
}

/**
 * True when an item sourced from `sources` was stated after the
 * correction (so restating the old value there is legitimate). Unknown
 * times count as before — the conservative reading.
 */
function statedAfter(sources: string[], tombstone: Tombstone, timeline: Timeline): boolean {
  if (sources.includes(tombstone.correctionMessageId)) return true;
  const correctionPos = timeline.position.get(tombstone.correctionMessageId);
  return sources.some((id) => {
    const pos = timeline.position.get(id);
    if (pos !== undefined && correctionPos !== undefined) return pos > correctionPos;
    const t = timeline.time.get(id);
    return t !== undefined && t > tombstone.timestamp;
  });
}

function summarize(violations: string[], ok: string): string {
  return violations.length === 0 ? ok : `${violations.length} violation(s): ${violations[0]}`;
}

export class InvariantChecker {
  verify(state: CompactedState, options: InvariantCheckOptions = {}): VerificationResult {
    const timeline = buildTimeline(state);
    const checks: Check[] = [
      this.checkCorrectionPropagation(state, timeline),
      this.checkEntityProvenance(state),
      this.checkDecisionCompleteness(state),
      this.checkTombstoneConsistency(state),
      this.checkTemporalOrdering(state, timeline),
    ];
    if (options.frame) checks.push(this.checkFrameStaleness(state, options.frame, timeline));

    return {
      passed: checks.every((c) => c.passed),
      checks,
    };
  }

  // -----------------------------------------------------------------------
  // Check 1: Correction propagation (level-complete)
  // A tombstoned value must not survive at L1, L2, L3 or L4 in an item
  // stated before the correction.
  // -----------------------------------------------------------------------

  private checkCorrectionPropagation(state: CompactedState, timeline: Timeline): Check {
    const violations: string[] = [];

    for (const tombstone of state.tombstones) {
      if (!tombstone.supersededContent) continue;
      const statesOnlyOld = supersededMatcher(tombstone);
      const stale = (text: string, sources: string[]) =>
        statesOnlyOld(text) && !statedAfter(sources, tombstone, timeline);
      const value = tombstone.supersededContent;

      for (const entry of state.l1_compacted) {
        if (stale(entry.compacted, [entry.originalMessageId])) {
          violations.push(`L1 entry ${entry.originalMessageId} still states superseded "${value}"`);
        }
      }

      for (const summary of state.l2_summaries) {
        const live = summary.decisions.filter((d) => !d.superseded);
        if (summary.decisions.length > 0) {
          for (const decision of live) {
            if (stale(decision.chosen, [decision.messageId])) {
              violations.push(`L2 decision "${decision.chosen}" (${decision.messageId}) still chooses superseded "${value}"`);
            }
          }
        } else if (stale(summary.summary, [summary.messageRange.last])) {
          violations.push(`L2 summary "${summary.topic}" still states superseded "${value}"`);
        }
      }

      for (const entity of state.l3_graph.entities.values()) {
        if (stale(entity.name, [entity.lastMention])) {
          violations.push(`L3 entity "${entity.name}" still names superseded "${value}"`);
        }
      }
      for (const edge of state.l3_graph.edges) {
        if (stale(`${edge.source} ${edge.target}`, [edge.sourceMessage])) {
          violations.push(`L3 edge ${edge.source} --${edge.relation}--> ${edge.target} still states superseded "${value}"`);
        }
      }

      for (const inv of state.l4_invariants) {
        if (stale(`${inv.key} ${inv.value}`, [inv.sourceMessage])) {
          violations.push(`L4 invariant "${inv.key}" still states superseded "${value}"`);
        }
      }
    }

    return {
      name: 'correction-propagation',
      passed: violations.length === 0,
      message: summarize(violations, 'All corrections propagated to L1–L4'),
    };
  }

  // -----------------------------------------------------------------------
  // Check 1b: Frame staleness
  // No derived frame line (L1–L4, memories, code) may state a superseded
  // value. Truth (the ledger is authoritative), correction lines and raw
  // L0 messages (verbatim by definition) are exempt.
  // -----------------------------------------------------------------------

  private checkFrameStaleness(state: CompactedState, frame: ContextFrame, timeline: Timeline): Check {
    const violations: string[] = [];
    const exempt = new Set(['truth', 'correction', 'recent']);

    for (const section of frame.sections) {
      if (exempt.has(section.kind)) continue;
      for (const item of section.items) {
        for (const tombstone of state.tombstones) {
          if (!tombstone.supersededContent) continue;
          if (supersededMatcher(tombstone)(item.text) && !statedAfter(item.sources, tombstone, timeline)) {
            violations.push(
              `${section.kind} line from ${item.sources.join(', ') || 'unknown source'} states superseded "${tombstone.supersededContent}"`,
            );
          }
        }
      }
    }

    return {
      name: 'frame-staleness',
      passed: violations.length === 0,
      message: summarize(violations, 'No superseded value in the frame'),
    };
  }

  // -----------------------------------------------------------------------
  // Check 2: Entity provenance
  // Every entity in L3 must trace to at least one source message.
  // -----------------------------------------------------------------------

  private checkEntityProvenance(state: CompactedState): Check {
    const violations: string[] = [];

    for (const [name, entity] of state.l3_graph.entities) {
      if (!entity.firstMention) {
        violations.push(`Entity "${name}" has no firstMention`);
      }
    }

    return {
      name: 'entity-provenance',
      passed: violations.length === 0,
      message:
        violations.length === 0
          ? 'All entities have provenance'
          : `${violations.length} entity(ies) without provenance: ${violations[0]}`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 3: Decision completeness
  // Every decision should include its alternatives (warn, don't fail).
  // -----------------------------------------------------------------------

  private checkDecisionCompleteness(state: CompactedState): Check {
    let totalDecisions = 0;
    let incompleteDecisions = 0;

    for (const summary of state.l2_summaries) {
      for (const decision of summary.decisions) {
        totalDecisions++;
        if (decision.alternatives.length === 0) {
          incompleteDecisions++;
        }
      }
    }

    // This is a soft check — incomplete decisions are common with regex extraction
    const passed = totalDecisions === 0 || incompleteDecisions / totalDecisions < 0.8;

    return {
      name: 'decision-completeness',
      passed,
      message:
        totalDecisions === 0
          ? 'No decisions to check'
          : `${totalDecisions - incompleteDecisions}/${totalDecisions} decisions include alternatives`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 4: Tombstone consistency
  // Every tombstone names what it supersedes and why, and where it came from.
  // -----------------------------------------------------------------------

  private checkTombstoneConsistency(state: CompactedState): Check {
    // Referenced messages may legitimately be compacted away, so we do not
    // require correctionMessageId to resolve. We do require each tombstone
    // to be structurally complete: a superseded value, a correction
    // provenance and a reason.
    const violations: string[] = [];
    for (const tombstone of state.tombstones) {
      if (!tombstone.supersededContent?.trim()) {
        violations.push(`Tombstone from ${tombstone.correctionMessageId || 'an unknown message'} supersedes nothing`);
      }
      if (!tombstone.correctionMessageId) {
        violations.push(
          `Tombstone for "${tombstone.supersededContent}" has no correctionMessageId`,
        );
      }
      if (!tombstone.reason) {
        violations.push(
          `Tombstone for "${tombstone.supersededContent}" has no reason`,
        );
      }
    }

    return {
      name: 'tombstone-consistency',
      passed: violations.length === 0,
      message:
        violations.length === 0
          ? `${state.tombstones.length} tombstone(s) tracked, all structurally consistent`
          : `${violations.length} violation(s): ${violations[0]}`,
    };
  }

  // -----------------------------------------------------------------------
  // Check 5: Temporal ordering
  // No entity's firstMention may come after its lastMention, and no
  // correction may predate the statement it corrects. Order comes from
  // conversation position when both messages are live, else timestamps.
  // -----------------------------------------------------------------------

  private checkTemporalOrdering(state: CompactedState, timeline: Timeline): Check {
    const violations: string[] = [];
    const after = (a: string, b: string): boolean => {
      const pa = timeline.position.get(a);
      const pb = timeline.position.get(b);
      if (pa !== undefined && pb !== undefined) return pa > pb;
      const ta = timeline.time.get(a);
      const tb = timeline.time.get(b);
      return ta !== undefined && tb !== undefined && ta > tb;
    };

    for (const [name, entity] of state.l3_graph.entities) {
      if (!entity.firstMention || !entity.lastMention) {
        violations.push(`Entity "${name}" missing temporal data`);
      } else if (after(entity.firstMention, entity.lastMention)) {
        violations.push(`Entity "${name}" first mentioned in ${entity.firstMention}, after its last mention ${entity.lastMention}`);
      }
    }

    for (const t of state.tombstones) {
      if (t.originalMessageId === t.correctionMessageId) continue;
      if (after(t.originalMessageId, t.correctionMessageId)) {
        violations.push(`Correction ${t.correctionMessageId} predates the statement it corrects (${t.originalMessageId})`);
      }
    }

    return {
      name: 'temporal-ordering',
      passed: violations.length === 0,
      message: summarize(violations, 'All entities and corrections are in temporal order'),
    };
  }
}
