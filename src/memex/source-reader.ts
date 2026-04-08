/**
 * Source Reader — discovers, reads, and hashes knowledge source files.
 *
 * Handles multiple source types (markdown, text, HTML, CSV, JSONL, transcripts)
 * and produces normalized text content for the claim extractor.
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { resolve, basename, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { KnowledgeSource, SourceType, KnowledgeSchema } from './types.js';

// ---------------------------------------------------------------------------
// Source type detection
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, SourceType> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.vtt': 'transcript',
  '.srt': 'transcript',
};

/**
 * Infer the source type from a file extension.
 */
export function inferSourceType(filePath: string): SourceType {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'text';
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of file contents.
 */
export function hashFileContents(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

/**
 * Discover source files from schema source globs and explicit paths.
 */
export function discoverSources(
  schema: KnowledgeSchema,
  additionalPaths: string[] = [],
  projectDir: string = process.cwd(),
): KnowledgeSource[] {
  const allGlobs = [...schema.sources, ...additionalPaths];
  const seenPaths = new Set<string>();
  const sources: KnowledgeSource[] = [];

  for (const pattern of allGlobs) {
    const resolvedPattern = resolve(projectDir, pattern);
    let files: string[];

    try {
      // If it's a direct file path, use it
      if (existsSync(resolvedPattern) && statSync(resolvedPattern).isFile()) {
        files = [resolvedPattern];
      } else {
        // Treat as glob pattern — use simple directory listing for now
        files = expandGlob(resolvedPattern, projectDir);
      }
    } catch {
      files = [];
    }

    for (const filePath of files) {
      const absPath = resolve(filePath);
      if (seenPaths.has(absPath)) continue;
      seenPaths.add(absPath);

      const type = inferSourceType(absPath);
      if (type === 'pdf') continue; // PDF requires special handling, skip for now

      const stat = statSync(absPath);
      const hash = hashFileContents(absPath);

      sources.push({
        id: generateSourceId(absPath, projectDir),
        type,
        path: absPath,
        title: basename(absPath, extname(absPath)),
        contentHash: hash,
        sizeBytes: stat.size,
      });
    }
  }

  return sources;
}

/**
 * Generate a stable source ID from a file path.
 */
export function generateSourceId(absPath: string, projectDir: string): string {
  const rel = relative(projectDir, absPath);
  // Slug-ify: replace path separators and dots with hyphens
  return rel
    .replace(/[/\\]/g, '-')
    .replace(/\.[^.]+$/, '') // remove extension
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Source reading
// ---------------------------------------------------------------------------

/** Content extracted from a source file, ready for claim extraction. */
export interface SourceContent {
  /** The source this content came from. */
  source: KnowledgeSource;
  /** Normalized text content (stripped of formatting where applicable). */
  text: string;
  /** Section boundaries — [title, startOffset, endOffset]. */
  sections: Array<{ title: string; start: number; end: number }>;
}

/**
 * Read a source file and normalize its content for extraction.
 */
export function readSource(source: KnowledgeSource): SourceContent {
  const rawContent = readFileSync(source.path, 'utf-8');

  switch (source.type) {
    case 'markdown':
      return parseMarkdown(source, rawContent);
    case 'html':
      return parseHTML(source, rawContent);
    case 'csv':
      return parseCSV(source, rawContent);
    case 'jsonl':
      return parseJSONL(source, rawContent);
    case 'transcript':
      return parseTranscript(source, rawContent);
    case 'text':
    default:
      return parsePlainText(source, rawContent);
  }
}

/**
 * Read multiple sources, skipping unchanged ones based on content hash.
 */
export function readSources(
  sources: KnowledgeSource[],
  previousSources?: Map<string, KnowledgeSource>,
): SourceContent[] {
  const contents: SourceContent[] = [];

  for (const source of sources) {
    // Skip if content hash hasn't changed
    if (previousSources) {
      const prev = previousSources.get(source.id);
      if (prev && prev.contentHash === source.contentHash) {
        continue;
      }
    }

    contents.push(readSource(source));
  }

  return contents;
}

// ---------------------------------------------------------------------------
// Format-specific parsers
// ---------------------------------------------------------------------------

function parseMarkdown(source: KnowledgeSource, raw: string): SourceContent {
  const sections: SourceContent['sections'] = [];
  const lines = raw.split('\n');
  let currentSection = { title: '(intro)', start: 0, end: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      // Close previous section
      const offset = lines.slice(0, i).join('\n').length;
      currentSection.end = offset;
      if (currentSection.end > currentSection.start) {
        sections.push({ ...currentSection });
      }
      // Start new section
      currentSection = {
        title: headingMatch[2].trim(),
        start: offset,
        end: 0,
      };
    }
  }

  // Close final section
  currentSection.end = raw.length;
  if (currentSection.end > currentSection.start) {
    sections.push({ ...currentSection });
  }

  // Strip markdown formatting for plain text extraction
  const text = stripMarkdown(raw);

  return { source, text, sections };
}

function parseHTML(source: KnowledgeSource, raw: string): SourceContent {
  // Simple HTML stripping — remove tags, decode basic entities
  const text = raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { source, text, sections: [{ title: '(document)', start: 0, end: text.length }] };
}

function parseCSV(source: KnowledgeSource, raw: string): SourceContent {
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) {
    return { source, text: '', sections: [] };
  }

  // Use first row as headers
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const pairs = headers.map((h, j) => `${h}: ${cells[j] ?? ''}`);
    rows.push(pairs.join('. '));
  }

  const text = rows.join('\n');
  return { source, text, sections: [{ title: '(data)', start: 0, end: text.length }] };
}

function parseJSONL(source: KnowledgeSource, raw: string): SourceContent {
  const lines = raw.split('\n').filter((l) => l.trim());
  const texts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Extract text from common fields
      const text = obj.text ?? obj.content ?? obj.message ?? obj.body ?? JSON.stringify(obj);
      texts.push(typeof text === 'string' ? text : JSON.stringify(text));
    } catch {
      // Skip unparseable lines
    }
  }

  const text = texts.join('\n');
  return { source, text, sections: [{ title: '(records)', start: 0, end: text.length }] };
}

function parseTranscript(source: KnowledgeSource, raw: string): SourceContent {
  // Strip VTT/SRT timing lines, keep only text
  const text = raw
    .replace(/^\d+$/gm, '')                           // SRT sequence numbers
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*$/gm, '') // Timing lines
    .replace(/^WEBVTT.*$/gm, '')                       // VTT header
    .replace(/^NOTE.*$/gm, '')                         // VTT notes
    .replace(/<[^>]+>/g, '')                            // VTT tags
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { source, text, sections: [{ title: '(transcript)', start: 0, end: text.length }] };
}

function parsePlainText(source: KnowledgeSource, raw: string): SourceContent {
  return {
    source,
    text: raw,
    sections: [{ title: '(document)', start: 0, end: raw.length }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip markdown formatting to produce plain text. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')          // code blocks
    .replace(/`[^`]+`/g, '')                  // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')     // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text
    .replace(/^#{1,6}\s+/gm, '')              // headings → text
    .replace(/^\s*[-*+]\s+/gm, '')            // list markers
    .replace(/^\s*\d+\.\s+/gm, '')            // ordered list markers
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
    .replace(/^\s*>\s*/gm, '')                // blockquotes
    .replace(/^---+$/gm, '')                  // horizontal rules
    .replace(/\|[^\n]+\|/g, '')               // tables
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Expand a glob pattern into file paths. Falls back to treating as a
 * directory if the pattern resolves to one.
 */
function expandGlob(pattern: string, _projectDir: string): string[] {
  // If the pattern is a directory, list its files
  try {
    if (existsSync(pattern) && statSync(pattern).isDirectory()) {
      const entries: string[] = readdirSync(pattern);
      return entries
        .map((e: string) => resolve(pattern, e))
        .filter((p: string) => {
          try { return statSync(p).isFile(); } catch { return false; }
        });
    }
  } catch {
    // Ignore
  }

  return [];
}
