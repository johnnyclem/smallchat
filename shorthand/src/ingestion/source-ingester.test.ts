import { describe, it, expect } from 'vitest';
import { SourceIngester } from './source-ingester.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import type { Source } from '../types.js';
import { estimateTokens } from '../utils.js';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    title: 'Test Document',
    content: 'This is a test document with some content.',
    ...overrides,
  };
}

describe('SourceIngester', () => {
  describe('chunkSource', () => {
    it('returns a single chunk for small documents', () => {
      const ingester = new SourceIngester();
      const source = makeSource({ content: 'Short content.' });
      const chunks = ingester.chunkSource(source);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('Short content.');
    });

    it('chunks large plain text by paragraph boundaries', () => {
      const ingester = new SourceIngester({ chunkSize: 50, chunkOverlap: 0 });
      const paragraphs = Array.from(
        { length: 10 },
        (_, i) => `This is paragraph number ${i} with enough text to matter in the token count.`,
      );
      const source = makeSource({
        content: paragraphs.join('\n\n'),
        contentType: 'text/plain',
      });

      const chunks = ingester.chunkSource(source);

      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be within budget
      for (const chunk of chunks) {
        // Allow some tolerance since chunking is heuristic
        expect(chunk.length).toBeLessThan(50 * 4 + 200); // chunkSize * ~4 chars/token + margin
      }
    });

    it('respects markdown heading boundaries', () => {
      const ingester = new SourceIngester({ chunkSize: 100, chunkOverlap: 0 });
      const source = makeSource({
        content: [
          '# Introduction',
          '',
          'This is the introduction section with some text.',
          '',
          '# Methods',
          '',
          'This is the methods section with different text.',
          '',
          '# Results',
          '',
          'This is the results section with more text.',
        ].join('\n'),
        contentType: 'text/markdown',
      });

      const chunks = ingester.chunkSource(source);

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0]).toContain('Introduction');
      expect(chunks[1]).toContain('Methods');
      expect(chunks[2]).toContain('Results');
    });

    it('auto-detects markdown from content', () => {
      const ingester = new SourceIngester();
      const source = makeSource({
        content: '# A Heading\n\nSome text with [a link](http://example.com).',
        // No contentType specified
      });

      const chunks = ingester.chunkSource(source);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('chunksToMessages', () => {
    it('converts chunks to ConversationMessages with source metadata', () => {
      const ingester = new SourceIngester();
      const source = makeSource({ uri: 'https://example.com/doc' });
      const chunks = ['chunk 0', 'chunk 1'];

      const messages = ingester.chunksToMessages(chunks, source);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toBe('chunk 0');
      const version = ingester.versionOf(source);
      expect(version).toMatch(/^[0-9a-f]{12}$/);
      expect(messages[0].id).toBe(`src-1@${version}-chunk-0`);
      expect(messages[0].metadata).toEqual({
        sourceId: 'src-1',
        sourceTitle: 'Test Document',
        sourceUri: 'https://example.com/doc',
        chunkIndex: 0,
        totalChunks: 2,
        sourceVersion: version,
      });
      expect(messages[1].id).toBe(`src-1@${version}-chunk-1`);
      // Timestamps are monotonically increasing
      expect(messages[1].timestamp).toBeGreaterThan(messages[0].timestamp);
    });
  });

  describe('ingest', () => {
    it('ingests a source into a CompactionEngine', async () => {
      const ingester = new SourceIngester();
      const engine = new CompactionEngine({ memtableSize: 5 });
      const source = makeSource({
        content: 'We decided on using React for the frontend. We chose PostgreSQL for the database.',
      });

      const event = await ingester.ingest(source, engine);

      expect(event.sourceId).toBe('src-1');
      expect(event.sourceTitle).toBe('Test Document');
      expect(event.chunkCount).toBeGreaterThanOrEqual(1);
    });

    it('records ingestion events', async () => {
      const ingester = new SourceIngester();
      const engine = new CompactionEngine({ memtableSize: 5 });

      await ingester.ingest(
        makeSource({ id: 'src-1', title: 'Doc 1', content: 'First doc content.' }),
        engine,
      );
      await ingester.ingest(
        makeSource({ id: 'src-2', title: 'Doc 2', content: 'Second doc content.' }),
        engine,
      );

      const events = ingester.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0].sourceId).toBe('src-1');
      expect(events[1].sourceId).toBe('src-2');
    });

    it('extracts entities from source content through the pipeline', async () => {
      const ingester = new SourceIngester({ chunkSize: 20, chunkOverlap: 0 });
      const engine = new CompactionEngine({ memtableSize: 1 });
      const source = makeSource({
        content: [
          'We are building a REST API for user management.',
          '',
          'We are using TypeScript for the implementation.',
          '',
          'The app must handle 1000 requests per second.',
        ].join('\n'),
        contentType: 'text/plain',
      });

      await ingester.ingest(source, engine);

      const state = engine.getState();
      // The regex compactor should have picked up entities and/or constraints
      expect(
        state.l3_graph.entities.size + state.l4_invariants.length + state.l1_compacted.length,
      ).toBeGreaterThan(0);
    });
  });

  describe('ingestAll', () => {
    it('ingests multiple sources', async () => {
      const ingester = new SourceIngester();
      const engine = new CompactionEngine({ memtableSize: 5 });

      const sources: Source[] = [
        makeSource({ id: 'a', title: 'Alpha', content: 'Alpha content.' }),
        makeSource({ id: 'b', title: 'Beta', content: 'Beta content.' }),
        makeSource({ id: 'c', title: 'Gamma', content: 'Gamma content.' }),
      ];

      const events = await ingester.ingestAll(sources, engine);

      expect(events).toHaveLength(3);
      expect(events.map((e) => e.sourceId)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('chunking cost and coverage (SH-13)', () => {
    // Bound: a 200 KB paragraph with no sentence terminator chunks in well
    // under a second (the backtracking splitter took ~50 s).
    it('splits a 200 KB unpunctuated paragraph in linear time within chunkSize', () => {
      const ingester = new SourceIngester({ chunkSize: 800, chunkOverlap: 0 });
      const content = 'col_a,col_b,col_c,1234,5678 '.repeat(7_500);
      const start = performance.now();
      const chunks = ingester.chunkSource(makeSource({ content, contentType: 'text/plain' }));
      expect(performance.now() - start).toBeLessThan(500);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(800);
      expect(chunks.join('').replace(/\s+/g, '')).toBe(content.replace(/\s+/g, ''));
    });

    it('chunks 200 KB of minified JSON without a content type in linear time', () => {
      const ingester = new SourceIngester({ chunkSize: 800, chunkOverlap: 0 });
      const content = '[[1,2],[3,4]],'.repeat(15_000);
      const start = performance.now();
      const chunks = ingester.chunkSource(makeSource({ content }));
      expect(performance.now() - start).toBeLessThan(500);
      for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(800);
    });

    it('keeps trailing text without a sentence terminator', () => {
      const ingester = new SourceIngester({ chunkSize: 40, chunkOverlap: 0 });
      const para =
        'The deploy runs in three stages. Each stage waits for health checks. ' +
        'Rollbacks are rare but happen. IMPORTANT: the rollback command is kubectl rollout undo deploy/api';
      const chunks = ingester.chunkSource(makeSource({ content: para, contentType: 'text/plain' }));
      expect(chunks.join(' ')).toContain('kubectl rollout undo deploy/api');
    });

    it('enforces chunkSize for an oversize paragraph that follows a small one', () => {
      const ingester = new SourceIngester({ chunkSize: 100, chunkOverlap: 10 });
      const content = 'Tiny intro.\n\n' + 'This sentence is part of a very long paragraph. '.repeat(400);
      const chunks = ingester.chunkSource(makeSource({ content, contentType: 'text/plain' }));
      for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(100);
    });
  });

  describe('provenance and re-ingestion (SH-27)', () => {
    it('reports only the entities this source introduced', async () => {
      const ingester = new SourceIngester();
      const engine = new CompactionEngine({ memtableSize: 0 });
      const a = await ingester.ingest(makeSource({ id: 'a', title: 'A', content: 'We are using PostgreSQL for storage.' }), engine);
      const b = await ingester.ingest(makeSource({ id: 'b', title: 'B', content: 'Nothing technical here at all.' }), engine);
      expect(a.entitiesDiscovered).toEqual(['PostgreSQL']);
      expect(b.entitiesDiscovered).toEqual([]);
    });

    it('skips an unchanged source and retracts the previous version of an edited one', async () => {
      const ingester = new SourceIngester();
      const engine = new CompactionEngine({ memtableSize: 0 });
      const v1 = makeSource({ id: 'doc', content: 'The rollback command is helm rollback api.' });
      await ingester.ingest(v1, engine);

      const again = await ingester.ingest(v1, engine);
      expect(again.skipped).toBe(true);
      expect(engine.getState().l1_compacted).toHaveLength(1);

      const v2 = makeSource({ id: 'doc', content: 'The rollback command is kubectl rollout undo deploy/api.' });
      const event = await ingester.ingest(v2, engine);
      expect(event.retractedChunks).toBe(1);
      expect(event.version).not.toBe(again.version);
      const live = engine.getState().l1_compacted.map((e) => e.compacted).join('\n');
      expect(live).toContain('kubectl rollout undo');
      expect(live).not.toContain('helm rollback');
      expect(engine.getState().archive!.some((a) => a.reason === 'retracted')).toBe(true);
    });

    it('overlapping ingests of one source run in call order, so the later version retracts the earlier (SH-R10)', async () => {
      const ingester = new SourceIngester();
      const engine = new CompactionEngine({ memtableSize: 0 });
      const v1 = makeSource({ id: 'doc', content: 'The primary region is us-east-1.' });
      const v2 = makeSource({ id: 'doc', content: 'The primary region is us-west-2.' });
      const [first, second] = await Promise.all([ingester.ingest(v1, engine), ingester.ingest(v2, engine)]);
      expect(first.retractedChunks).toBe(0);
      expect(second.retractedChunks).toBe(1);
      expect(engine.getState().l1_compacted.map((e) => e.compacted)).toEqual(['The primary region is us-west-2.']);

      const again = await ingester.ingest(v2, engine);
      expect(again).toMatchObject({ skipped: true, retractedChunks: 0 });
      expect(engine.getState().l1_compacted.map((e) => e.compacted)).toEqual(['The primary region is us-west-2.']);

      // Other sources are not held up behind it
      const [, other] = await Promise.all([ingester.ingest(v1, engine), ingester.ingest(makeSource({ id: 'other', content: 'Unrelated.' }), engine)]);
      expect(other.skipped).toBeUndefined();
      expect(engine.getState().l1_compacted.map((e) => e.compacted).sort()).toEqual(['The primary region is us-east-1.', 'Unrelated.']);
    });
  });
});
