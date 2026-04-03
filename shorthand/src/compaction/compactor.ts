/**
 * Compactor — multi-level conversation state compaction engine.
 *
 * Implements hierarchical summarization of conversation history:
 *   L0: Raw messages (identity — no compaction)
 *   L1: Within-turn deduplication and noise removal
 *   L2: Cross-turn summarization with entity/decision extraction
 *   L3: High-level state snapshot (entities + decisions + corrections only)
 *
 * Each level is a refinement of the level above it — it should preserve
 * all decision-relevant information while reducing token count.
 */

import type {
  Compactor,
  CompactedState,
  CompactionLevel,
  ConversationHistory,
  ConversationMessage,
  Decision,
  EntityCorrection,
  ExtractedEntity,
  Tombstone,
} from './types.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token count: ~4 chars per token (GPT/Claude heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for an entire conversation. */
export function estimateConversationTokens(history: ConversationHistory): number {
  return history.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extract entities from conversation messages. Entities are identified by
 * patterns like key-value assignments, explicit mentions with context, and
 * tool results that name specific resources.
 */
export function extractEntities(messages: ConversationMessage[]): ExtractedEntity[] {
  const entityMap = new Map<string, ExtractedEntity>();

  for (const msg of messages) {
    // Extract from tool calls
    if (msg.toolCall) {
      const toolEntity: ExtractedEntity = {
        name: `tool:${msg.toolCall.name}`,
        type: 'tool_invocation',
        firstMention: msg.id,
        lastMention: msg.id,
        value: msg.toolCall.isError ? `error` : 'success',
        corrections: [],
      };
      mergeEntity(entityMap, toolEntity);
    }

    // Extract key-value patterns: "X is Y", "X: Y", "chose X", "selected X"
    const kvPatterns = [
      /(?:chose|selected|picked|decided on|using|switched to)\s+["']?([A-Za-z][\w.-]+)["']?/gi,
      /(?:database|framework|language|tool|library|service|provider)\s*(?:is|:)\s*["']?([A-Za-z][\w.-]+)["']?/gi,
      /(?:set|configured|changed)\s+(\w+)\s+to\s+["']?([^"'\n,]+)["']?/gi,
    ];

    for (const pattern of kvPatterns) {
      let match;
      while ((match = pattern.exec(msg.content)) !== null) {
        const name = match[1];
        const value = match[2] ?? match[1];
        const entity: ExtractedEntity = {
          name: name.toLowerCase(),
          type: 'configuration',
          firstMention: msg.id,
          lastMention: msg.id,
          value,
          corrections: [],
        };
        mergeEntity(entityMap, entity);
      }
    }

    // Extract correction patterns: "actually X", "correction: X", "not X but Y"
    const correctionPatterns = [
      /(?:actually|correction|no,|wait,)\s+(?:it's|it is|use|the)\s+["']?([A-Za-z][\w.-]+)["']?/gi,
      /(?:not|instead of)\s+["']?([A-Za-z][\w.-]+)["']?\s*(?:but|,\s*use)\s+["']?([A-Za-z][\w.-]+)["']?/gi,
    ];

    for (const pattern of correctionPatterns) {
      let match;
      while ((match = pattern.exec(msg.content)) !== null) {
        if (match[2]) {
          // "not X but Y" pattern — X was wrong, Y is correct
          const wrongName = match[1].toLowerCase();
          const rightName = match[2].toLowerCase();

          const existing = entityMap.get(wrongName);
          if (existing) {
            const correction: EntityCorrection = {
              messageId: msg.id,
              previousValue: existing.value,
              correctedValue: rightName,
              reason: `Corrected in message ${msg.id}`,
            };
            existing.corrections.push(correction);
            existing.value = rightName;
            existing.lastMention = msg.id;
          }
        }
      }
    }

    // Track supersedes relationships
    if (msg.supersedes) {
      const supersededMsg = messages.find(m => m.id === msg.supersedes);
      if (supersededMsg) {
        for (const [, entity] of entityMap) {
          if (entity.lastMention === msg.supersedes) {
            entity.lastMention = msg.id;
          }
        }
      }
    }
  }

  return Array.from(entityMap.values());
}

function mergeEntity(
  map: Map<string, ExtractedEntity>,
  entity: ExtractedEntity,
): void {
  const existing = map.get(entity.name);
  if (existing) {
    existing.lastMention = entity.lastMention;
    if (entity.value !== existing.value) {
      existing.corrections.push({
        messageId: entity.lastMention,
        previousValue: existing.value,
        correctedValue: entity.value,
        reason: 'Value changed',
      });
      existing.value = entity.value;
    }
  } else {
    map.set(entity.name, { ...entity });
  }
}

// ---------------------------------------------------------------------------
// Decision extraction
// ---------------------------------------------------------------------------

/** Extract decisions from conversation messages. */
export function extractDecisions(messages: ConversationMessage[]): Decision[] {
  const decisions: Decision[] = [];
  let decisionCounter = 0;

  for (const msg of messages) {
    // Look for decision language
    const decisionPatterns = [
      /(?:decided to|going with|let's use|we'll use|choosing|I'll go with)\s+(.+?)(?:\.|$)/gim,
      /(?:rejected|ruled out|won't use|not going with)\s+(.+?)\s+because\s+(.+?)(?:\.|$)/gim,
      /(?:rejected|ruled out|won't use|not going with)\s+(.+?)(?:\.|$)/gim,
    ];

    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(msg.content)) !== null) {
        const isRejection = /rejected|ruled out|won't use|not going with/i.test(match[0]);

        if (isRejection) {
          // This is an alternative that was rejected — attach to most recent decision
          const lastDecision = decisions[decisions.length - 1];
          if (lastDecision) {
            lastDecision.alternatives.push({
              description: match[1].trim(),
              reason: match[2]?.trim() ?? 'Not specified',
            });
          }
        } else {
          decisionCounter++;
          decisions.push({
            id: `decision-${decisionCounter}`,
            description: match[1].trim(),
            madeAt: msg.id,
            alternatives: [],
            involvedEntities: [],
          });
        }
      }
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Tombstone detection
// ---------------------------------------------------------------------------

/** Detect tombstones — information explicitly invalidated during conversation. */
export function detectTombstones(
  messages: ConversationMessage[],
  entities: ExtractedEntity[],
): Tombstone[] {
  const tombstones: Tombstone[] = [];

  // Entities with corrections produce tombstones
  for (const entity of entities) {
    for (const correction of entity.corrections) {
      tombstones.push({
        supersededContent: `${entity.name} = ${String(correction.previousValue)}`,
        originalMessageId: entity.firstMention,
        correctionMessageId: correction.messageId,
        reason: correction.reason ?? 'Entity value was corrected',
      });
    }
  }

  // Messages that explicitly supersede others
  for (const msg of messages) {
    if (msg.supersedes) {
      const original = messages.find(m => m.id === msg.supersedes);
      if (original) {
        tombstones.push({
          supersededContent: original.content.slice(0, 200),
          originalMessageId: original.id,
          correctionMessageId: msg.id,
          reason: 'Message explicitly superseded',
        });
      }
    }
  }

  return tombstones;
}

// ---------------------------------------------------------------------------
// Summarization helpers
// ---------------------------------------------------------------------------

/** Remove noise: system messages, empty messages, duplicate content. */
function deduplicateMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const seen = new Set<string>();
  return messages.filter(msg => {
    if (!msg.content.trim()) return false;

    // Deduplicate identical content within the same role
    const key = `${msg.role}:${msg.content.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Generate a textual summary at L1: deduplication and noise removal. */
function summarizeL1(messages: ConversationMessage[]): string {
  const cleaned = deduplicateMessages(messages);
  return cleaned
    .map(m => {
      const role = m.role.toUpperCase();
      const toolInfo = m.toolCall ? ` [tool:${m.toolCall.name}]` : '';
      return `[${role}${toolInfo}] ${m.content}`;
    })
    .join('\n\n');
}

/** Generate a textual summary at L2: entity/decision-aware summarization. */
function summarizeL2(
  messages: ConversationMessage[],
  entities: ExtractedEntity[],
  decisions: Decision[],
): string {
  const sections: string[] = [];

  // Conversation flow (condensed)
  const keyMessages = messages.filter(m =>
    m.role === 'user' ||
    (m.role === 'assistant' && m.content.length > 50) ||
    m.toolCall !== undefined,
  );
  if (keyMessages.length > 0) {
    sections.push('## Conversation Flow');
    for (const m of keyMessages) {
      const toolInfo = m.toolCall
        ? ` [${m.toolCall.name}: ${m.toolCall.isError ? 'ERROR' : 'OK'}]`
        : '';
      sections.push(`- ${m.role.toUpperCase()}${toolInfo}: ${m.content.slice(0, 300)}`);
    }
  }

  // Entities
  if (entities.length > 0) {
    sections.push('\n## Entities');
    for (const entity of entities) {
      const correctionNote = entity.corrections.length > 0
        ? ` (corrected ${entity.corrections.length}x, was: ${entity.corrections.map(c => String(c.previousValue)).join(' → ')})`
        : '';
      sections.push(`- ${entity.name} [${entity.type}]: ${String(entity.value)}${correctionNote}`);
    }
  }

  // Decisions
  if (decisions.length > 0) {
    sections.push('\n## Decisions');
    for (const decision of decisions) {
      sections.push(`- ${decision.description}`);
      for (const alt of decision.alternatives) {
        sections.push(`  - Rejected: ${alt.description} (${alt.reason})`);
      }
    }
  }

  return sections.join('\n');
}

/** Generate a textual summary at L3: minimal state snapshot. */
function summarizeL3(
  entities: ExtractedEntity[],
  decisions: Decision[],
  tombstones: Tombstone[],
): string {
  const sections: string[] = [];

  sections.push('# State Snapshot');

  if (entities.length > 0) {
    sections.push('\n## Current Entities');
    for (const entity of entities) {
      sections.push(`${entity.name}: ${String(entity.value)}`);
    }
  }

  if (decisions.length > 0) {
    sections.push('\n## Active Decisions');
    for (const decision of decisions) {
      if (!decision.supersededBy) {
        sections.push(`- ${decision.description}`);
      }
    }
  }

  if (tombstones.length > 0) {
    sections.push('\n## Invalidated (Tombstones)');
    for (const tombstone of tombstones) {
      sections.push(`- SUPERSEDED: ${tombstone.supersededContent} (${tombstone.reason})`);
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// DefaultCompactor — the main compaction engine
// ---------------------------------------------------------------------------

export class DefaultCompactor implements Compactor {
  async compact(
    history: ConversationHistory,
    level: CompactionLevel,
  ): Promise<CompactedState> {
    const messages = history.messages;
    const entities = extractEntities(messages);
    const decisions = extractDecisions(messages);
    const tombstones = detectTombstones(messages, entities);

    let summary: string;
    switch (level) {
      case 'L0':
        summary = messages.map(m => `[${m.role}] ${m.content}`).join('\n\n');
        break;
      case 'L1':
        summary = summarizeL1(messages);
        break;
      case 'L2':
        summary = summarizeL2(messages, entities, decisions);
        break;
      case 'L3':
        summary = summarizeL3(entities, decisions, tombstones);
        break;
    }

    return {
      level,
      sessionId: history.sessionId,
      compactedAt: new Date().toISOString(),
      roundNumber: 1,
      summary,
      entities,
      decisions,
      tombstones,
      originalMessageCount: messages.length,
      compactedTokenCount: estimateTokens(summary),
      originalTokenCount: estimateConversationTokens(history),
      sourceMessageIds: messages.map(m => m.id),
    };
  }

  async recompact(
    state: CompactedState,
    targetLevel: CompactionLevel,
  ): Promise<CompactedState> {
    const levelOrder: CompactionLevel[] = ['L0', 'L1', 'L2', 'L3'];
    const currentIdx = levelOrder.indexOf(state.level);
    const targetIdx = levelOrder.indexOf(targetLevel);

    if (targetIdx <= currentIdx) {
      throw new Error(
        `Cannot recompact from ${state.level} to ${targetLevel} — ` +
        `target must be a deeper compaction level`,
      );
    }

    // Re-compact by generating a tighter summary from current state
    let summary: string;
    switch (targetLevel) {
      case 'L2': {
        const sections: string[] = ['## Re-compacted State'];
        if (state.entities.length > 0) {
          sections.push('\n## Entities');
          for (const e of state.entities) {
            sections.push(`- ${e.name}: ${String(e.value)}`);
          }
        }
        if (state.decisions.length > 0) {
          sections.push('\n## Decisions');
          for (const d of state.decisions) {
            sections.push(`- ${d.description}`);
          }
        }
        summary = sections.join('\n');
        break;
      }
      case 'L3':
        summary = summarizeL3(state.entities, state.decisions, state.tombstones);
        break;
      default:
        summary = state.summary;
    }

    return {
      ...state,
      level: targetLevel,
      compactedAt: new Date().toISOString(),
      roundNumber: state.roundNumber + 1,
      summary,
      compactedTokenCount: estimateTokens(summary),
    };
  }
}
