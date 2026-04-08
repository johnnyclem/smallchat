/**
 * Claim Extractor — extracts claims, entities, and relationships from text.
 *
 * Uses heuristic NLP techniques (sentence splitting, entity recognition,
 * relationship patterns) to produce a KnowledgeIR from source content.
 * Designed to be fast and deterministic — no LLM calls in the extraction
 * phase. LLM-assisted extraction can be layered on top via the schema's
 * extractionHints.
 */

import { createHash } from 'node:crypto';
import type {
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelationship,
  KnowledgeIR,
  KnowledgeSchema,
} from './types.js';
import type { SourceContent } from './source-reader.js';

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

/**
 * Extract claims, entities, and relationships from a source's content.
 */
export function extractKnowledge(
  content: SourceContent,
  schema: KnowledgeSchema,
): KnowledgeIR {
  const sourceId = content.source.id;
  const text = content.text;

  // Step 1: Split text into sentences / claim candidates
  const sentences = splitSentences(text);

  // Step 2: Extract claims from sentences
  const claims = extractClaims(sentences, sourceId, content);

  // Step 3: Extract entities from claims
  const entities = extractEntities(claims, schema);

  // Step 4: Extract relationships between entities
  const relationships = extractRelationships(claims, entities);

  return { claims, entities, relationships, sourceId };
}

/**
 * Extract knowledge from multiple sources.
 */
export function extractKnowledgeBatch(
  contents: SourceContent[],
  schema: KnowledgeSchema,
): KnowledgeIR[] {
  return contents.map((c) => extractKnowledge(c, schema));
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Split text into sentence-level spans.
 *
 * Uses a conservative approach: split on sentence-ending punctuation
 * followed by whitespace and a capital letter, or on double newlines.
 */
export function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];

  // Split on paragraph breaks first
  const paragraphs = text.split(/\n\s*\n/);
  let offset = 0;

  for (const para of paragraphs) {
    if (!para.trim()) {
      offset += para.length + 2; // account for \n\n
      continue;
    }

    // Split paragraph into sentences
    const sentenceRegex = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
    let match;
    while ((match = sentenceRegex.exec(para)) !== null) {
      const sentence = match[0].trim();
      if (sentence.length < 10) continue; // skip very short fragments

      const start = offset + match.index;
      spans.push({
        text: sentence,
        start,
        end: start + sentence.length,
      });
    }

    offset += para.length + 2;
  }

  return spans;
}

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

/**
 * Extract claims from sentence spans.
 *
 * Filters out non-factual sentences (questions, imperatives, etc.) and
 * assigns confidence scores based on linguistic markers.
 */
export function extractClaims(
  sentences: SentenceSpan[],
  sourceId: string,
  content: SourceContent,
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];

  for (const sentence of sentences) {
    // Skip questions
    if (sentence.text.endsWith('?')) continue;

    // Skip very short sentences
    if (sentence.text.split(/\s+/).length < 4) continue;

    // Skip meta-language (e.g., "This document describes...")
    if (isMetaLanguage(sentence.text)) continue;

    // Compute confidence
    const confidence = scoreSentenceConfidence(sentence.text);

    // Find containing section
    const section = findSection(sentence.start, content.sections);

    // Generate deterministic ID
    const id = generateClaimId(sourceId, sentence.start, sentence.end);

    // Extract entity mentions (simple NER)
    const entities = extractEntityMentions(sentence.text);

    claims.push({
      id,
      text: sentence.text,
      entities,
      sourceId,
      sourceSpan: [sentence.start, sentence.end],
      confidence,
      section: section?.title,
    });
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extract entities from claims using pattern matching.
 *
 * Recognizes: capitalized multi-word names, quoted terms, and terms matching
 * the schema's entity types.
 */
export function extractEntities(
  claims: ExtractedClaim[],
  schema: KnowledgeSchema,
): ExtractedEntity[] {
  const entityMap = new Map<string, ExtractedEntity>();

  for (const claim of claims) {
    for (const name of claim.entities) {
      const id = slugify(name);
      const existing = entityMap.get(id);

      if (existing) {
        existing.claimCount++;
        if (!existing.sourceIds.includes(claim.sourceId)) {
          existing.sourceIds.push(claim.sourceId);
        }
      } else {
        const type = inferEntityType(name, schema.entityTypes);
        entityMap.set(id, {
          id,
          type,
          name,
          sourceIds: [claim.sourceId],
          claimCount: 1,
        });
      }
    }
  }

  return Array.from(entityMap.values());
}

/**
 * Extract entity name mentions from a sentence.
 *
 * Heuristic: multi-word capitalized sequences, quoted terms, or
 * words after definite articles that are capitalized.
 */
export function extractEntityMentions(text: string): string[] {
  const mentions = new Set<string>();

  // Pattern 1: Multi-word capitalized names (e.g., "Battle of Pelennor Fields")
  const capitalizedRegex = /\b([A-Z][a-z]+(?:\s+(?:of|the|and|in|on|at|for|de|von|van|del|la|el)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  let match;
  while ((match = capitalizedRegex.exec(text)) !== null) {
    mentions.add(match[1].trim());
  }

  // Pattern 2: Single capitalized words that aren't sentence starters
  // (only if they appear mid-sentence)
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z]/g, '');
    if (word.length >= 3 && /^[A-Z][a-z]+$/.test(word) && !isCommonWord(word)) {
      mentions.add(word);
    }
  }

  // Pattern 3: Quoted terms (may be technical terms or proper nouns)
  const quotedRegex = /"([^"]{2,50})"/g;
  while ((match = quotedRegex.exec(text)) !== null) {
    mentions.add(match[1]);
  }

  return Array.from(mentions);
}

// ---------------------------------------------------------------------------
// Relationship extraction
// ---------------------------------------------------------------------------

/** Patterns that indicate relationships between entities. */
const RELATIONSHIP_PATTERNS: Array<{ regex: RegExp; relation: string }> = [
  { regex: /(\w+)\s+is\s+(?:a|an|the)\s+(\w+)/i, relation: 'is-a' },
  { regex: /(\w+)\s+(?:is\s+)?(?:located|situated)\s+in\s+(\w+)/i, relation: 'located-in' },
  { regex: /(\w+)\s+(?:is\s+)?part\s+of\s+(\w+)/i, relation: 'part-of' },
  { regex: /(\w+)\s+(?:founded|created|built|established)\s+(\w+)/i, relation: 'created' },
  { regex: /(\w+)\s+(?:rules?|governs?|leads?|commands?)\s+(\w+)/i, relation: 'rules' },
  { regex: /(\w+)\s+(?:belongs?\s+to|is\s+owned\s+by)\s+(\w+)/i, relation: 'belongs-to' },
  { regex: /(\w+)\s+(?:contains?|includes?|comprises?)\s+(\w+)/i, relation: 'contains' },
  { regex: /(\w+)\s+(?:depends?\s+on|requires?)\s+(\w+)/i, relation: 'depends-on' },
  { regex: /(\w+)\s+(?:preceded|came\s+before)\s+(\w+)/i, relation: 'precedes' },
  { regex: /(\w+)\s+(?:succeeded|came\s+after|followed)\s+(\w+)/i, relation: 'follows' },
];

/**
 * Extract relationships between known entities from claims.
 */
export function extractRelationships(
  claims: ExtractedClaim[],
  entities: ExtractedEntity[],
): ExtractedRelationship[] {
  const entityNames = new Set(entities.map((e) => e.name.toLowerCase()));
  const entityIdByName = new Map<string, string>();
  for (const e of entities) {
    entityIdByName.set(e.name.toLowerCase(), e.id);
  }

  const relationships: ExtractedRelationship[] = [];
  const seen = new Set<string>();

  for (const claim of claims) {
    for (const pattern of RELATIONSHIP_PATTERNS) {
      const match = pattern.regex.exec(claim.text);
      if (!match) continue;

      const subjectName = match[1].toLowerCase();
      const objectName = match[2].toLowerCase();

      const fromId = entityIdByName.get(subjectName);
      const toId = entityIdByName.get(objectName);

      if (!fromId || !toId || fromId === toId) continue;

      const key = `${fromId}:${pattern.relation}:${toId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      relationships.push({
        from: fromId,
        to: toId,
        relation: pattern.relation,
        establishedBy: claim.id,
      });
    }
  }

  return relationships;
}

// ---------------------------------------------------------------------------
// Merging IRs from multiple sources
// ---------------------------------------------------------------------------

/**
 * Merge multiple KnowledgeIR instances into a single consolidated IR.
 * Deduplicates entities by ID, aggregates claim counts.
 */
export function mergeKnowledgeIRs(irs: KnowledgeIR[]): KnowledgeIR {
  const allClaims: ExtractedClaim[] = [];
  const entityMap = new Map<string, ExtractedEntity>();
  const allRelationships: ExtractedRelationship[] = [];
  const seenRelationKeys = new Set<string>();

  for (const ir of irs) {
    allClaims.push(...ir.claims);

    for (const entity of ir.entities) {
      const existing = entityMap.get(entity.id);
      if (existing) {
        existing.claimCount += entity.claimCount;
        for (const sid of entity.sourceIds) {
          if (!existing.sourceIds.includes(sid)) {
            existing.sourceIds.push(sid);
          }
        }
        // Merge properties
        if (entity.properties) {
          existing.properties = { ...existing.properties, ...entity.properties };
        }
      } else {
        entityMap.set(entity.id, { ...entity });
      }
    }

    for (const rel of ir.relationships) {
      const key = `${rel.from}:${rel.relation}:${rel.to}`;
      if (!seenRelationKeys.has(key)) {
        seenRelationKeys.add(key);
        allRelationships.push(rel);
      }
    }
  }

  return {
    claims: allClaims,
    entities: Array.from(entityMap.values()),
    relationships: allRelationships,
    sourceId: '__merged__',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic claim ID from source + span. */
export function generateClaimId(
  sourceId: string,
  start: number,
  end: number,
): string {
  const input = `${sourceId}:${start}:${end}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Convert a name to a URL-safe slug. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Check if a sentence is meta-language (about the document, not factual). */
function isMetaLanguage(text: string): boolean {
  const metaPatterns = [
    /^this (?:document|section|chapter|page|article)/i,
    /^in this (?:section|chapter|document)/i,
    /^(?:see|refer to|note that|please note)/i,
    /^(?:table of contents|bibliography|references|appendix)/i,
    /^(?:copyright|all rights reserved|license)/i,
  ];
  return metaPatterns.some((p) => p.test(text.trim()));
}

/** Score sentence confidence based on linguistic markers. */
function scoreSentenceConfidence(text: string): number {
  let score = 0.7; // base confidence

  // Hedging language reduces confidence
  if (/\b(?:maybe|perhaps|possibly|might|could|allegedly|reportedly)\b/i.test(text)) {
    score -= 0.15;
  }

  // Definitive language increases confidence
  if (/\b(?:is|are|was|were|has|have|had|will|shall)\b/i.test(text)) {
    score += 0.1;
  }

  // Numbers and dates increase confidence (factual markers)
  if (/\b\d{4}\b/.test(text) || /\b\d+(?:\.\d+)?%?\b/.test(text)) {
    score += 0.1;
  }

  // Superlatives are sometimes opinion
  if (/\b(?:best|worst|greatest|most|least)\b/i.test(text)) {
    score -= 0.05;
  }

  return Math.max(0.1, Math.min(1.0, score));
}

/** Find the section containing a given character offset. */
function findSection(
  offset: number,
  sections: SourceContent['sections'],
): { title: string; start: number; end: number } | undefined {
  for (const section of sections) {
    if (offset >= section.start && offset < section.end) {
      return section;
    }
  }
  return sections[sections.length - 1];
}

/** Infer entity type from name using heuristics. */
function inferEntityType(name: string, allowedTypes: string[]): string {
  // Date-like → event
  if (/\b\d{4}\b/.test(name) && allowedTypes.includes('event')) return 'event';
  // "Battle of", "War of" → event
  if (/^(?:Battle|War|Siege|Fall)\b/i.test(name) && allowedTypes.includes('event')) return 'event';
  // "Mount", "River", "City" → place
  if (/^(?:Mount|River|Lake|City|Tower|Gate|Land|Kingdom)\b/i.test(name) && allowedTypes.includes('place')) return 'place';
  // Default to first allowed type (usually "concept")
  return allowedTypes[0] ?? 'concept';
}

/** Common English words that shouldn't be treated as entities. */
const COMMON_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'Here', 'There', 'Where',
  'When', 'What', 'Which', 'Who', 'How', 'Why', 'Then', 'Than',
  'Also', 'However', 'Although', 'Because', 'Since', 'While',
  'After', 'Before', 'During', 'Until', 'About', 'Above', 'Below',
  'Between', 'Through', 'Into', 'Each', 'Every', 'Some', 'Many',
  'Much', 'Most', 'Other', 'Another', 'Such', 'First', 'Second',
  'Third', 'Last', 'Next', 'New', 'Old', 'Great', 'Little', 'Long',
  'High', 'Low', 'Large', 'Small', 'Good', 'Bad', 'Right', 'Left',
  'True', 'False', 'Yes', 'All', 'Any', 'But', 'Not', 'Only',
  'Very', 'Just', 'Still', 'Even', 'Yet', 'May', 'Can', 'Will',
  'Shall', 'Should', 'Would', 'Could', 'Must', 'Need', 'Let',
]);

function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word);
}
