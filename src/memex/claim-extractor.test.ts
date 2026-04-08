import { describe, it, expect } from 'vitest';
import {
  splitSentences,
  extractClaims,
  extractEntities,
  extractEntityMentions,
  extractRelationships,
  extractKnowledge,
  mergeKnowledgeIRs,
  generateClaimId,
  slugify,
} from './claim-extractor.js';
import type { SourceContent } from './source-reader.js';
import type { KnowledgeSchema, ExtractedClaim, ExtractedEntity } from './types.js';

const TEST_SCHEMA: KnowledgeSchema = {
  name: 'test',
  domain: 'test',
  entityTypes: ['concept', 'person', 'place', 'event'],
  sources: [],
};

function makeSourceContent(text: string): SourceContent {
  return {
    source: { id: 'test-source', type: 'text', path: '/test.txt' },
    text,
    sections: [{ title: '(document)', start: 0, end: text.length }],
  };
}

describe('splitSentences', () => {
  it('splits text into sentence spans', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const sentences = splitSentences(text);
    expect(sentences.length).toBe(3);
    expect(sentences[0].text).toBe('First sentence.');
    expect(sentences[1].text).toBe('Second sentence.');
    expect(sentences[2].text).toBe('Third sentence.');
  });

  it('splits on paragraph breaks', () => {
    const text = 'Paragraph one has content.\n\nParagraph two has more content.';
    const sentences = splitSentences(text);
    expect(sentences.length).toBe(2);
  });

  it('skips very short fragments', () => {
    const text = 'OK. This is a complete sentence with enough words.';
    const sentences = splitSentences(text);
    // "OK." is too short (< 10 chars)
    expect(sentences.length).toBe(1);
    expect(sentences[0].text).toContain('complete sentence');
  });
});

describe('extractEntityMentions', () => {
  it('extracts capitalized multi-word names', () => {
    const mentions = extractEntityMentions('The Battle of Pelennor Fields was decisive.');
    expect(mentions).toContain('Battle of Pelennor Fields');
  });

  it('extracts quoted terms', () => {
    const mentions = extractEntityMentions('The "Ring of Power" was forged in Mordor.');
    expect(mentions).toContain('Ring of Power');
  });

  it('ignores common English words', () => {
    const mentions = extractEntityMentions('However the First thing is important.');
    expect(mentions).not.toContain('However');
  });

  it('extracts mid-sentence capitalized words', () => {
    const mentions = extractEntityMentions('The army of Gondor marched east.');
    expect(mentions).toContain('Gondor');
  });
});

describe('extractClaims', () => {
  it('extracts factual sentences as claims', () => {
    const text = 'Gondor was founded in the Second Age. It is located in Middle-earth. What happened next?';
    const content = makeSourceContent(text);
    const sentences = splitSentences(text);
    const claims = extractClaims(sentences, 'src-1', content);

    // Should extract the two declarative sentences, not the question
    expect(claims.length).toBe(2);
    expect(claims.some((c) => c.text.includes('Gondor was founded'))).toBe(true);
    expect(claims.some((c) => c.text.includes('located in Middle-earth'))).toBe(true);
  });

  it('skips meta-language sentences', () => {
    const text = 'This document describes the history of Gondor. Gondor was a great kingdom.';
    const content = makeSourceContent(text);
    const sentences = splitSentences(text);
    const claims = extractClaims(sentences, 'src-1', content);

    expect(claims.length).toBe(1);
    expect(claims[0].text).toContain('great kingdom');
  });

  it('assigns confidence scores based on linguistic markers', () => {
    const factual = 'The kingdom was established in 3320 SA.';
    const hedged = 'The kingdom might possibly have been founded around that time.';

    const content1 = makeSourceContent(factual);
    const content2 = makeSourceContent(hedged);
    const claims1 = extractClaims(splitSentences(factual), 'src-1', content1);
    const claims2 = extractClaims(splitSentences(hedged), 'src-1', content2);

    expect(claims1.length).toBeGreaterThan(0);
    expect(claims2.length).toBeGreaterThan(0);
    // Factual claim with date should have higher confidence
    expect(claims1[0].confidence).toBeGreaterThan(claims2[0].confidence);
  });

  it('generates deterministic claim IDs', () => {
    const text = 'Gondor is a kingdom in Middle-earth.';
    const content = makeSourceContent(text);
    const sentences = splitSentences(text);
    const claims1 = extractClaims(sentences, 'src-1', content);
    const claims2 = extractClaims(sentences, 'src-1', content);

    expect(claims1[0].id).toBe(claims2[0].id);
  });
});

describe('extractEntities', () => {
  it('extracts entities from claims and counts occurrences', () => {
    const claims: ExtractedClaim[] = [
      {
        id: 'c1', text: 'Gondor was a kingdom.', entities: ['Gondor'],
        sourceId: 'src-1', sourceSpan: [0, 10], confidence: 0.8,
      },
      {
        id: 'c2', text: 'Gondor fought against Mordor.', entities: ['Gondor', 'Mordor'],
        sourceId: 'src-1', sourceSpan: [10, 20], confidence: 0.8,
      },
    ];

    const entities = extractEntities(claims, TEST_SCHEMA);
    expect(entities.length).toBe(2);

    const gondor = entities.find((e) => e.name === 'Gondor');
    expect(gondor).toBeDefined();
    expect(gondor!.claimCount).toBe(2);

    const mordor = entities.find((e) => e.name === 'Mordor');
    expect(mordor).toBeDefined();
    expect(mordor!.claimCount).toBe(1);
  });

  it('infers entity types from name patterns', () => {
    const claims: ExtractedClaim[] = [
      {
        id: 'c1', text: 'The Battle of Helm was fierce.', entities: ["Battle of Helm"],
        sourceId: 'src-1', sourceSpan: [0, 30], confidence: 0.8,
      },
    ];

    const entities = extractEntities(claims, TEST_SCHEMA);
    const battle = entities.find((e) => e.name === "Battle of Helm");
    expect(battle?.type).toBe('event');
  });
});

describe('extractRelationships', () => {
  it('extracts "is-a" relationships', () => {
    const claims: ExtractedClaim[] = [{
      id: 'c1', text: 'Gondor is a kingdom.', entities: ['Gondor'],
      sourceId: 'src-1', sourceSpan: [0, 20], confidence: 0.8,
    }];
    const entities: ExtractedEntity[] = [
      { id: 'gondor', type: 'place', name: 'gondor', sourceIds: ['src-1'], claimCount: 1 },
      { id: 'kingdom', type: 'concept', name: 'kingdom', sourceIds: ['src-1'], claimCount: 1 },
    ];

    const rels = extractRelationships(claims, entities);
    expect(rels.some((r) => r.relation === 'is-a')).toBe(true);
  });

  it('deduplicates identical relationships', () => {
    const claims: ExtractedClaim[] = [
      {
        id: 'c1', text: 'Gondor is a kingdom.', entities: ['Gondor'],
        sourceId: 'src-1', sourceSpan: [0, 20], confidence: 0.8,
      },
      {
        id: 'c2', text: 'Gondor is a kingdom of Men.', entities: ['Gondor'],
        sourceId: 'src-2', sourceSpan: [0, 27], confidence: 0.8,
      },
    ];
    const entities: ExtractedEntity[] = [
      { id: 'gondor', type: 'place', name: 'gondor', sourceIds: ['src-1'], claimCount: 2 },
      { id: 'kingdom', type: 'concept', name: 'kingdom', sourceIds: ['src-1'], claimCount: 2 },
    ];

    const rels = extractRelationships(claims, entities);
    const isACount = rels.filter((r) => r.relation === 'is-a').length;
    expect(isACount).toBe(1); // deduplicated
  });
});

describe('extractKnowledge', () => {
  it('extracts claims, entities, and relationships from source content', () => {
    const text = 'Gondor was founded by Elendil in the Second Age. The kingdom of Gondor is located in Middle-earth. Mordor lies to the east of Gondor.';
    const content = makeSourceContent(text);

    const ir = extractKnowledge(content, TEST_SCHEMA);
    expect(ir.claims.length).toBeGreaterThan(0);
    expect(ir.entities.length).toBeGreaterThan(0);
    expect(ir.sourceId).toBe('test-source');
  });
});

describe('mergeKnowledgeIRs', () => {
  it('merges entities from multiple IRs', () => {
    const ir1 = {
      claims: [{
        id: 'c1', text: 'Gondor is great.', entities: ['Gondor'],
        sourceId: 'src-1', sourceSpan: [0, 16] as [number, number], confidence: 0.8,
      }],
      entities: [{ id: 'gondor', type: 'place', name: 'Gondor', sourceIds: ['src-1'], claimCount: 1 }],
      relationships: [],
      sourceId: 'src-1',
    };
    const ir2 = {
      claims: [{
        id: 'c2', text: 'Gondor fought well.', entities: ['Gondor'],
        sourceId: 'src-2', sourceSpan: [0, 19] as [number, number], confidence: 0.7,
      }],
      entities: [{ id: 'gondor', type: 'place', name: 'Gondor', sourceIds: ['src-2'], claimCount: 1 }],
      relationships: [],
      sourceId: 'src-2',
    };

    const merged = mergeKnowledgeIRs([ir1, ir2]);
    expect(merged.claims.length).toBe(2);
    expect(merged.entities.length).toBe(1); // deduplicated
    expect(merged.entities[0].claimCount).toBe(2);
    expect(merged.entities[0].sourceIds).toContain('src-1');
    expect(merged.entities[0].sourceIds).toContain('src-2');
  });
});

describe('generateClaimId', () => {
  it('produces deterministic IDs', () => {
    const id1 = generateClaimId('src-1', 0, 50);
    const id2 = generateClaimId('src-1', 0, 50);
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different inputs', () => {
    const id1 = generateClaimId('src-1', 0, 50);
    const id2 = generateClaimId('src-1', 50, 100);
    expect(id1).not.toBe(id2);
  });

  it('produces 16-character hex strings', () => {
    const id = generateClaimId('src-1', 0, 50);
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });
});

describe('slugify', () => {
  it('converts names to URL-safe slugs', () => {
    expect(slugify('Battle of Pelennor Fields')).toBe('battle-of-pelennor-fields');
    expect(slugify('Gondor')).toBe('gondor');
    expect(slugify("Frodo's Ring")).toBe('frodo-s-ring');
  });

  it('handles edge cases', () => {
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('A')).toBe('a');
  });
});
