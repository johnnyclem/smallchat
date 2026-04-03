/**
 * Strategy 2: Invariant Preservation Checking
 *
 * Semi-formal verification: define a set of invariants that compaction must
 * preserve, then mechanically check them after each compaction pass.
 *
 * These are properties you can check mechanically — they're not full
 * correctness proofs, but they catch the most dangerous failure modes:
 * silent information loss and silent reversion of corrections.
 *
 * Analogous to model checking à la TLA+ or SPIN: safety properties
 * verified against state transitions.
 *
 * Five invariant categories:
 *   1. Correction propagation: corrections must not be lost
 *   2. Entity provenance: every entity must trace to source messages
 *   3. Decision completeness: all decisions must survive compaction
 *   4. Tombstone consistency: superseded info must be marked
 *   5. Temporal ordering: event ordering must be preserved
 */

import type {
  CompactedState,
  CompactionInvariant,
  ConversationHistory,
  InvariantCheckResult,
  InvariantViolation,
} from './types.js';

// ---------------------------------------------------------------------------
// Invariant 1: Correction Propagation
// ---------------------------------------------------------------------------

/**
 * If a correction/tombstone exists at any level, the superseded information
 * must not appear at any lower level without the correction attached.
 */
export const correctionPropagation: CompactionInvariant = {
  id: 'INV-001',
  description:
    'If a correction exists, the superseded value must not appear in the ' +
    'compacted summary without the correction also being present.',
  category: 'correction_propagation',

  check(compacted, _original): InvariantViolation | null {
    const violations: string[] = [];
    const summaryLower = compacted.summary.toLowerCase();

    for (const entity of compacted.entities) {
      for (const correction of entity.corrections) {
        const oldValue = String(correction.previousValue).toLowerCase();
        const newValue = String(correction.correctedValue).toLowerCase();

        // If the old value appears in the summary but the new value doesn't,
        // the correction was silently reverted — a dangerous failure.
        if (
          oldValue.length > 2 &&
          summaryLower.includes(oldValue) &&
          !summaryLower.includes(newValue)
        ) {
          violations.push(
            `Entity "${entity.name}": superseded value "${correction.previousValue}" ` +
            `appears in summary but correction "${correction.correctedValue}" does not`,
          );
        }
      }
    }

    // Check tombstones are reflected
    for (const tombstone of compacted.tombstones) {
      const supersededLower = tombstone.supersededContent.toLowerCase().slice(0, 40);
      if (supersededLower.length > 5 && summaryLower.includes(supersededLower)) {
        // The superseded content appears — check if it's properly marked
        const hasMarker = summaryLower.includes('superseded') ||
          summaryLower.includes('corrected') ||
          summaryLower.includes('was:') ||
          summaryLower.includes('previously');
        if (!hasMarker) {
          violations.push(
            `Tombstoned content "${tombstone.supersededContent.slice(0, 50)}" ` +
            `appears in summary without correction marker`,
          );
        }
      }
    }

    if (violations.length === 0) return null;

    return {
      invariantId: 'INV-001',
      severity: 'error',
      message: `Correction propagation violated: ${violations.length} superseded values found without corrections`,
      affectedItems: violations,
      evidence: compacted.entities
        .flatMap(e => e.corrections.map(c => c.messageId)),
    };
  },
};

// ---------------------------------------------------------------------------
// Invariant 2: Entity Provenance
// ---------------------------------------------------------------------------

/**
 * Every entity in the compacted state must trace to at least one source
 * message in the raw history.
 */
export const entityProvenance: CompactionInvariant = {
  id: 'INV-002',
  description:
    'Every entity in the compacted state must trace to at least one ' +
    'source message in the original conversation history.',
  category: 'entity_provenance',

  check(compacted, original): InvariantViolation | null {
    const originalIds = new Set(original.messages.map(m => m.id));
    const orphanedEntities: string[] = [];

    for (const entity of compacted.entities) {
      const hasFirstMention = originalIds.has(entity.firstMention);
      const hasLastMention = originalIds.has(entity.lastMention);

      if (!hasFirstMention && !hasLastMention) {
        orphanedEntities.push(
          `Entity "${entity.name}" references messages ` +
          `[${entity.firstMention}, ${entity.lastMention}] ` +
          `which don't exist in the original history`,
        );
      }
    }

    if (orphanedEntities.length === 0) return null;

    return {
      invariantId: 'INV-002',
      severity: 'error',
      message: `Entity provenance violated: ${orphanedEntities.length} entities have no traceable source`,
      affectedItems: orphanedEntities,
      evidence: compacted.entities
        .filter(e => !originalIds.has(e.firstMention))
        .map(e => e.firstMention),
    };
  },
};

// ---------------------------------------------------------------------------
// Invariant 3: Decision Completeness
// ---------------------------------------------------------------------------

/**
 * Every decision recorded in the original conversation should survive
 * compaction — decisions are the highest-priority information.
 */
export const decisionCompleteness: CompactionInvariant = {
  id: 'INV-003',
  description:
    'All decisions from the original conversation must be present in ' +
    'the compacted state.',
  category: 'decision_completeness',

  check(compacted, original): InvariantViolation | null {
    // Extract decision-like messages from original
    const decisionPattern = /(?:decided to|going with|let's use|we'll use|choosing|I'll go with)\s+(.+?)(?:\.|$)/gim;
    const originalDecisions: Array<{ text: string; messageId: string }> = [];

    for (const msg of original.messages) {
      let match;
      while ((match = decisionPattern.exec(msg.content)) !== null) {
        originalDecisions.push({
          text: match[1].trim().toLowerCase(),
          messageId: msg.id,
        });
      }
    }

    if (originalDecisions.length === 0) return null;

    const summaryLower = compacted.summary.toLowerCase();
    const decisionDescriptions = compacted.decisions.map(d => d.description.toLowerCase());

    const missingDecisions: string[] = [];
    for (const od of originalDecisions) {
      const inSummary = summaryLower.includes(od.text.slice(0, 30));
      const inDecisions = decisionDescriptions.some(d => d.includes(od.text.slice(0, 30)));

      if (!inSummary && !inDecisions) {
        missingDecisions.push(`Decision "${od.text}" from message ${od.messageId}`);
      }
    }

    if (missingDecisions.length === 0) return null;

    return {
      invariantId: 'INV-003',
      severity: 'warning',
      message: `Decision completeness: ${missingDecisions.length}/${originalDecisions.length} decisions not found in compacted state`,
      affectedItems: missingDecisions,
      evidence: missingDecisions.map(d => d.split('message ')[1] ?? ''),
    };
  },
};

// ---------------------------------------------------------------------------
// Invariant 4: Tombstone Consistency
// ---------------------------------------------------------------------------

/**
 * If information was explicitly invalidated (correction, retraction),
 * the compacted state must either:
 *   (a) not contain the superseded information at all, OR
 *   (b) contain it with a tombstone/correction marker
 */
export const tombstoneConsistency: CompactionInvariant = {
  id: 'INV-004',
  description:
    'Superseded information must either be absent from the compacted state ' +
    'or be accompanied by a tombstone/correction marker.',
  category: 'tombstone_consistency',

  check(compacted, original): InvariantViolation | null {
    // Find messages that supersede others
    const supersedingMessages = original.messages.filter(m => m.supersedes);
    const inconsistencies: string[] = [];

    for (const msg of supersedingMessages) {
      const originalMsg = original.messages.find(m => m.id === msg.supersedes);
      if (!originalMsg) continue;

      // Check if the superseded content appears without a tombstone
      const supersededSnippet = originalMsg.content.toLowerCase().slice(0, 50);
      if (supersededSnippet.length < 5) continue;

      const summaryLower = compacted.summary.toLowerCase();
      if (summaryLower.includes(supersededSnippet)) {
        // It's in the summary — is there a tombstone for it?
        const hasTombstone = compacted.tombstones.some(
          t => t.originalMessageId === originalMsg.id,
        );
        if (!hasTombstone) {
          inconsistencies.push(
            `Superseded message "${originalMsg.id}" content appears in summary without tombstone`,
          );
        }
      }
    }

    if (inconsistencies.length === 0) return null;

    return {
      invariantId: 'INV-004',
      severity: 'error',
      message: `Tombstone consistency violated: ${inconsistencies.length} superseded items without tombstones`,
      affectedItems: inconsistencies,
      evidence: supersedingMessages.map(m => m.id),
    };
  },
};

// ---------------------------------------------------------------------------
// Invariant 5: Temporal Ordering
// ---------------------------------------------------------------------------

/**
 * The compacted state must preserve the temporal ordering of events:
 * if event A happened before event B in the original conversation,
 * they must not be reordered in the compacted state.
 */
export const temporalOrdering: CompactionInvariant = {
  id: 'INV-005',
  description:
    'Temporal ordering of events must be preserved in the compacted state.',
  category: 'temporal_ordering',

  check(compacted, original): InvariantViolation | null {
    // Check that entity firstMention/lastMention ordering is consistent
    const messageOrder = new Map<string, number>();
    original.messages.forEach((m, i) => messageOrder.set(m.id, i));

    const violations: string[] = [];

    for (const entity of compacted.entities) {
      const firstIdx = messageOrder.get(entity.firstMention);
      const lastIdx = messageOrder.get(entity.lastMention);

      if (firstIdx !== undefined && lastIdx !== undefined && firstIdx > lastIdx) {
        violations.push(
          `Entity "${entity.name}": firstMention (${entity.firstMention}, index ${firstIdx}) ` +
          `comes after lastMention (${entity.lastMention}, index ${lastIdx})`,
        );
      }
    }

    // Check decision ordering
    for (let i = 0; i < compacted.decisions.length - 1; i++) {
      const currentIdx = messageOrder.get(compacted.decisions[i].madeAt);
      const nextIdx = messageOrder.get(compacted.decisions[i + 1].madeAt);

      if (currentIdx !== undefined && nextIdx !== undefined && currentIdx > nextIdx) {
        violations.push(
          `Decision "${compacted.decisions[i].id}" (index ${currentIdx}) ` +
          `comes after "${compacted.decisions[i + 1].id}" (index ${nextIdx}) ` +
          `but appears first in the compacted decisions list`,
        );
      }
    }

    if (violations.length === 0) return null;

    return {
      invariantId: 'INV-005',
      severity: 'warning',
      message: `Temporal ordering violated: ${violations.length} ordering inconsistencies found`,
      affectedItems: violations,
      evidence: [],
    };
  },
};

// ---------------------------------------------------------------------------
// All built-in invariants
// ---------------------------------------------------------------------------

export const BUILTIN_INVARIANTS: CompactionInvariant[] = [
  correctionPropagation,
  entityProvenance,
  decisionCompleteness,
  tombstoneConsistency,
  temporalOrdering,
];

// ---------------------------------------------------------------------------
// Run invariant checks
// ---------------------------------------------------------------------------

/** Execute all invariant checks against a compacted state. */
export function checkInvariants(
  compacted: CompactedState,
  original: ConversationHistory,
  invariants: CompactionInvariant[] = BUILTIN_INVARIANTS,
): InvariantCheckResult {
  const violations: InvariantViolation[] = [];

  for (const invariant of invariants) {
    const violation = invariant.check(compacted, original);
    if (violation) {
      violations.push(violation);
    }
  }

  const errorCount = violations.filter(v => v.severity === 'error').length;
  const warningCount = violations.filter(v => v.severity === 'warning').length;

  return {
    compactedState: compacted,
    invariantsChecked: invariants.map(i => i.id),
    violations,
    passed: errorCount === 0,
    errorCount,
    warningCount,
  };
}
