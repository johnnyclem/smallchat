import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inferSourceType,
  hashFileContents,
  discoverSources,
  generateSourceId,
  readSource,
  stripMarkdown,
} from './source-reader.js';
import type { KnowledgeSource } from './types.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `memex-source-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('inferSourceType', () => {
  it('identifies markdown files', () => {
    expect(inferSourceType('notes.md')).toBe('markdown');
    expect(inferSourceType('doc.markdown')).toBe('markdown');
  });

  it('identifies text files', () => {
    expect(inferSourceType('readme.txt')).toBe('text');
  });

  it('identifies HTML files', () => {
    expect(inferSourceType('page.html')).toBe('html');
    expect(inferSourceType('page.htm')).toBe('html');
  });

  it('identifies CSV files', () => {
    expect(inferSourceType('data.csv')).toBe('csv');
    expect(inferSourceType('data.tsv')).toBe('csv');
  });

  it('identifies JSONL files', () => {
    expect(inferSourceType('logs.jsonl')).toBe('jsonl');
    expect(inferSourceType('data.ndjson')).toBe('jsonl');
  });

  it('identifies transcript files', () => {
    expect(inferSourceType('talk.vtt')).toBe('transcript');
    expect(inferSourceType('movie.srt')).toBe('transcript');
  });

  it('defaults to text for unknown extensions', () => {
    expect(inferSourceType('file.xyz')).toBe('text');
  });
});

describe('hashFileContents', () => {
  it('produces consistent SHA-256 hashes', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'hello world');

    const hash1 = hashFileContents(filePath);
    const hash2 = hashFileContents(filePath);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex

    rmSync(dir, { recursive: true });
  });

  it('produces different hashes for different content', () => {
    const dir = createTempDir();
    const file1 = join(dir, 'a.txt');
    const file2 = join(dir, 'b.txt');
    writeFileSync(file1, 'content A');
    writeFileSync(file2, 'content B');

    expect(hashFileContents(file1)).not.toBe(hashFileContents(file2));

    rmSync(dir, { recursive: true });
  });
});

describe('generateSourceId', () => {
  it('generates a slug from relative path', () => {
    const id = generateSourceId('/project/sources/my-doc.md', '/project');
    expect(id).toBe('sources-my-doc');
  });

  it('handles nested paths', () => {
    const id = generateSourceId('/project/deep/nested/file.txt', '/project');
    expect(id).toBe('deep-nested-file');
  });
});

describe('discoverSources', () => {
  it('discovers files in a source directory', () => {
    const dir = createTempDir();
    const sourcesDir = join(dir, 'sources');
    mkdirSync(sourcesDir);
    writeFileSync(join(sourcesDir, 'doc1.md'), '# Document 1\nSome content.');
    writeFileSync(join(sourcesDir, 'doc2.txt'), 'Plain text document.');

    const sources = discoverSources(
      { name: 'test', domain: 'test', entityTypes: [], sources: ['./sources'] },
      [],
      dir,
    );

    expect(sources.length).toBe(2);
    expect(sources.some((s) => s.type === 'markdown')).toBe(true);
    expect(sources.some((s) => s.type === 'text')).toBe(true);
    expect(sources.every((s) => s.contentHash != null)).toBe(true);

    rmSync(dir, { recursive: true });
  });

  it('discovers explicit file paths', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'single.md');
    writeFileSync(filePath, '# Single file');

    const sources = discoverSources(
      { name: 'test', domain: 'test', entityTypes: [], sources: [] },
      [filePath],
      dir,
    );

    expect(sources.length).toBe(1);
    expect(sources[0].type).toBe('markdown');

    rmSync(dir, { recursive: true });
  });

  it('deduplicates sources by path', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'doc.md');
    writeFileSync(filePath, '# Doc');

    const sources = discoverSources(
      { name: 'test', domain: 'test', entityTypes: [], sources: [filePath] },
      [filePath], // same path in additionalPaths
      dir,
    );

    expect(sources.length).toBe(1);

    rmSync(dir, { recursive: true });
  });
});

describe('readSource', () => {
  it('reads and parses a markdown file', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'test.md');
    writeFileSync(filePath, '# Introduction\n\nSome content here.\n\n# Details\n\nMore details.');

    const source: KnowledgeSource = {
      id: 'test',
      type: 'markdown',
      path: filePath,
    };

    const content = readSource(source);
    expect(content.text).toContain('Some content here');
    expect(content.text).toContain('More details');
    expect(content.sections.length).toBeGreaterThanOrEqual(2);

    rmSync(dir, { recursive: true });
  });

  it('reads and parses a CSV file', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'data.csv');
    writeFileSync(filePath, 'name,type,location\nGondor,kingdom,Middle-earth\nRohan,kingdom,Middle-earth');

    const source: KnowledgeSource = {
      id: 'data',
      type: 'csv',
      path: filePath,
    };

    const content = readSource(source);
    expect(content.text).toContain('name: Gondor');
    expect(content.text).toContain('location: Middle-earth');

    rmSync(dir, { recursive: true });
  });

  it('reads and parses HTML, stripping tags', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'page.html');
    writeFileSync(filePath, '<html><body><h1>Title</h1><p>Content here.</p></body></html>');

    const source: KnowledgeSource = {
      id: 'page',
      type: 'html',
      path: filePath,
    };

    const content = readSource(source);
    expect(content.text).toContain('Title');
    expect(content.text).toContain('Content here');
    expect(content.text).not.toContain('<h1>');

    rmSync(dir, { recursive: true });
  });

  it('reads and parses JSONL', () => {
    const dir = createTempDir();
    const filePath = join(dir, 'records.jsonl');
    writeFileSync(filePath, '{"text":"First record"}\n{"text":"Second record"}');

    const source: KnowledgeSource = {
      id: 'records',
      type: 'jsonl',
      path: filePath,
    };

    const content = readSource(source);
    expect(content.text).toContain('First record');
    expect(content.text).toContain('Second record');

    rmSync(dir, { recursive: true });
  });
});

describe('stripMarkdown', () => {
  it('removes headings', () => {
    expect(stripMarkdown('## Heading\nContent')).toContain('Heading');
    expect(stripMarkdown('## Heading\nContent')).not.toContain('##');
  });

  it('removes links but preserves text', () => {
    expect(stripMarkdown('[click here](http://example.com)')).toBe('click here');
  });

  it('removes code blocks', () => {
    const md = 'Before\n```\ncode here\n```\nAfter';
    const stripped = stripMarkdown(md);
    expect(stripped).toContain('Before');
    expect(stripped).toContain('After');
    expect(stripped).not.toContain('code here');
  });

  it('removes bold and italic markers', () => {
    expect(stripMarkdown('**bold** and *italic*')).toContain('bold');
    expect(stripMarkdown('**bold** and *italic*')).toContain('italic');
    expect(stripMarkdown('**bold** and *italic*')).not.toContain('**');
  });
});
