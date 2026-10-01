/**
 * SourceIngester — adapts raw documents into the compaction pipeline.
 *
 * Accepts Source documents (markdown, plain text), chunks them into
 * ConversationMessages (ids `<sourceId>@<version>-chunk-<n>`), and feeds
 * them through the CompactionEngine.
 * This bridges Karpathy's "raw sources" layer with short-hand's LSM-tree.
 */

import type {
  ConversationMessage,
  IngestionConfig,
  IngestionEvent,
  Source,
} from '../types.js';
import { DEFAULT_INGESTION_CONFIG } from '../types.js';
import { estimateTokens, sha256Hex, splitSentences } from '../utils.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';

// ---------------------------------------------------------------------------
// Markdown-aware chunking
// ---------------------------------------------------------------------------

/** A heading boundary in the source text. */
interface HeadingBoundary {
  level: number;
  title: string;
  startOffset: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

/** Find all markdown heading positions in the text. */
function findHeadingBoundaries(text: string): HeadingBoundary[] {
  const boundaries: HeadingBoundary[] = [];
  let match: RegExpExecArray | null;
  HEADING_RE.lastIndex = 0;
  while ((match = HEADING_RE.exec(text)) !== null) {
    boundaries.push({
      level: match[1].length,
      title: match[2].trim(),
      startOffset: match.index,
    });
  }
  return boundaries;
}

/**
 * Split text into sections at markdown heading boundaries.
 * Each section includes its heading (if any) and body text.
 */
function splitByHeadings(text: string): Array<{ heading: string; body: string }> {
  const boundaries = findHeadingBoundaries(text);
  if (boundaries.length === 0) {
    return [{ heading: '', body: text }];
  }

  const sections: Array<{ heading: string; body: string }> = [];

  // Content before the first heading
  if (boundaries[0].startOffset > 0) {
    const preamble = text.slice(0, boundaries[0].startOffset).trim();
    if (preamble) {
      sections.push({ heading: '', body: preamble });
    }
  }

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].startOffset;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].startOffset : text.length;
    const sectionText = text.slice(start, end).trim();
    sections.push({ heading: boundaries[i].title, body: sectionText });
  }

  return sections;
}

/**
 * Split a text block into chunks of at most `maxTokens` (estimated) each.
 * Splits on paragraph boundaries (blank lines), then — for any paragraph
 * over budget — on sentence boundaries, then at whitespace, then hard
 * character cuts. Linear in the text length; no text is dropped (trailing
 * text without a sentence terminator included).
 */
function chunkText(text: string, maxTokens: number, overlapTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const maxChars = Math.max(1, maxTokens * 4);
  const overlapChars = Math.max(0, overlapTokens * 4);

  // Units no longer than maxChars, each with the separator that joins it
  // to the previous unit in the original text.
  const units: Array<{ text: string; joiner: string }> = [];
  for (const para of text.split(/\n[ \t]*\n/)) {
    if (para.length <= maxChars) {
      units.push({ text: para, joiner: '\n\n' });
      continue;
    }
    splitSentences(para, maxChars).forEach((sentence, i) => {
      units.push({ text: sentence, joiner: i === 0 ? '\n\n' : '' });
    });
  }

  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const unit of units) {
    const combined = current ? `${current}${unit.joiner}${unit.text}` : unit.text;
    if (combined.length <= maxChars) {
      current = combined;
      continue;
    }
    flush();
    // Overlap: start the next chunk with the tail of the previous one when
    // it still fits; otherwise start fresh with the unit.
    const tail = overlapChars > 0 ? current.slice(-overlapChars) : '';
    const withOverlap = tail ? `${tail}${unit.joiner || ' '}${unit.text}` : '';
    current = withOverlap && withOverlap.length <= maxChars ? withOverlap : unit.text;
  }
  flush();

  return chunks;
}

// ---------------------------------------------------------------------------
// SourceIngester
// ---------------------------------------------------------------------------

export class SourceIngester {
  private config: IngestionConfig;
  private events: IngestionEvent[] = [];
  /** Last ingested version of each source, and the message ids it produced. */
  private versions = new Map<string, { version: string; messageIds: string[] }>();
  /** The latest ingest queued per source: ingests of one source run one at a time, in call order. */
  private pending = new Map<string, Promise<unknown>>();

  constructor(config: Partial<IngestionConfig> = {}) {
    this.config = { ...DEFAULT_INGESTION_CONFIG, ...config };
  }

  /**
   * Ingest a source document into a CompactionEngine.
   *
   * 1. Chunks the document respecting markdown structure
   * 2. Converts chunks to ConversationMessages with source metadata
   * 3. Feeds them into the engine (triggering auto-flush/compaction)
   * 4. Records an ingestion event for the wiki log
   *
   * Sources are versioned by content hash. Re-ingesting the same version
   * is a no-op (`skipped: true`); ingesting a new version of a source this
   * ingester has seen first retracts the previous version's chunks
   * (`CompactionEngine.retract`), so stale text does not stay live beside
   * the update. Ingests of one source run one at a time in call order (a
   * file watcher firing twice), so each sees the version before it; other
   * sources are not held up.
   */
  async ingest(source: Source, engine: CompactionEngine): Promise<IngestionEvent> {
    const run = (this.pending.get(source.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.ingestNow(source, engine));
    this.pending.set(source.id, run);
    try {
      return await run;
    } finally {
      if (this.pending.get(source.id) === run) this.pending.delete(source.id);
    }
  }

  private async ingestNow(source: Source, engine: CompactionEngine): Promise<IngestionEvent> {
    const version = this.versionOf(source);
    const previous = this.versions.get(source.id);
    if (previous?.version === version) {
      return {
        timestamp: Date.now(),
        sourceId: source.id,
        sourceTitle: source.title,
        chunkCount: 0,
        entitiesDiscovered: [],
        version,
        retractedChunks: 0,
        skipped: true,
      };
    }

    let retractedChunks = 0;
    if (previous) {
      await engine.retract(previous.messageIds, `source ${source.id}@${previous.version} superseded by @${version}`);
      retractedChunks = previous.messageIds.length;
    }

    const knownEntities = new Set(engine.getState().l3_graph.entities.keys());
    const chunks = this.chunkSource(source);
    const messages = this.chunksToMessages(chunks, source);

    await engine.addMessages(messages);

    // Flush to ensure content moves through the pipeline
    await engine.flush();
    this.versions.set(source.id, { version, messageIds: messages.map((m) => m.id) });

    // Only entities this source added — not everything the engine knows
    const entitiesDiscovered = Array.from(engine.getState().l3_graph.entities.keys()).filter(
      (name) => !knownEntities.has(name),
    );

    const event: IngestionEvent = {
      timestamp: Date.now(),
      sourceId: source.id,
      sourceTitle: source.title,
      chunkCount: chunks.length,
      entitiesDiscovered,
      version,
      retractedChunks,
    };

    this.events.push(event);
    return event;
  }

  /** Content version of a source: the first 12 hex digits of the sha256 of its content. */
  versionOf(source: Source): string {
    return sha256Hex(source.content).slice(0, 12);
  }

  /**
   * Ingest multiple sources sequentially.
   */
  async ingestAll(sources: Source[], engine: CompactionEngine): Promise<IngestionEvent[]> {
    const events: IngestionEvent[] = [];
    for (const source of sources) {
      events.push(await this.ingest(source, engine));
    }
    return events;
  }

  /** Get all ingestion events recorded by this ingester. */
  getEvents(): IngestionEvent[] {
    return [...this.events];
  }

  /**
   * Chunk a source document into text segments.
   */
  chunkSource(source: Source): string[] {
    const isMarkdown =
      source.contentType === 'text/markdown' ||
      (!source.contentType && this.looksLikeMarkdown(source.content));

    if (isMarkdown && this.config.respectMarkdownBoundaries) {
      return this.chunkMarkdown(source.content);
    }

    return chunkText(source.content, this.config.chunkSize, this.config.chunkOverlap);
  }

  /**
   * Convert text chunks into ConversationMessages suitable for the engine.
   * Each message carries source metadata so provenance is preserved through
   * the compaction pipeline.
   */
  chunksToMessages(chunks: string[], source: Source): ConversationMessage[] {
    const baseTimestamp = source.createdAt ?? Date.now();
    const version = this.versionOf(source);

    return chunks.map((chunk, index) => ({
      id: `${source.id}@${version}-chunk-${index}`,
      role: 'system' as const,
      content: chunk,
      timestamp: baseTimestamp + index, // Monotonic ordering within source
      metadata: {
        sourceId: source.id,
        sourceTitle: source.title,
        sourceUri: source.uri,
        chunkIndex: index,
        totalChunks: chunks.length,
        sourceVersion: version,
      },
    }));
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private chunkMarkdown(content: string): string[] {
    const sections = splitByHeadings(content);
    const allChunks: string[] = [];

    for (const section of sections) {
      const sectionChunks = chunkText(
        section.body,
        this.config.chunkSize,
        this.config.chunkOverlap,
      );
      allChunks.push(...sectionChunks);
    }

    return allChunks.filter((c) => c.trim().length > 0);
  }

  private looksLikeMarkdown(content: string): boolean {
    // Quick heuristic: contains headings, links, or code fences
    // Bounded link pattern: `\[.+\]\(.+\)` backtracks quadratically on a
    // long line full of brackets (minified JSON)
    return /^#{1,6}\s/m.test(content) || /\[[^\]\n]{1,200}\]\([^)\n]{1,500}\)/.test(content) || /```/.test(content);
  }
}
