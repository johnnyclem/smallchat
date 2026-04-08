import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadMemexConfig,
  saveMemexConfig,
  loadKnowledgeSchema,
  saveKnowledgeSchema,
  DEFAULT_MEMEX_CONFIG,
  DEFAULT_KNOWLEDGE_SCHEMA,
} from './config.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `memex-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadMemexConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadMemexConfig(undefined, '/nonexistent/path.json');
    expect(config).toEqual(DEFAULT_MEMEX_CONFIG);
  });

  it('merges file config with defaults', () => {
    const dir = createTempDir();
    const configPath = join(dir, 'smallchat.memex.json');
    writeFileSync(configPath, JSON.stringify({ embedder: 'local', watch: true }));

    const config = loadMemexConfig(undefined, configPath);
    expect(config.embedder).toBe('local');
    expect(config.watch).toBe(true);
    expect(config.outputPath).toBe(DEFAULT_MEMEX_CONFIG.outputPath);

    rmSync(dir, { recursive: true });
  });

  it('applies overrides on top of file config', () => {
    const dir = createTempDir();
    const configPath = join(dir, 'smallchat.memex.json');
    writeFileSync(configPath, JSON.stringify({ embedder: 'local' }));

    const config = loadMemexConfig({ embedder: 'onnx', outputPath: 'custom.json' }, configPath);
    expect(config.embedder).toBe('onnx'); // override wins
    expect(config.outputPath).toBe('custom.json');

    rmSync(dir, { recursive: true });
  });

  it('handles invalid JSON gracefully', () => {
    const dir = createTempDir();
    const configPath = join(dir, 'bad.json');
    writeFileSync(configPath, 'not json!!!');

    const config = loadMemexConfig(undefined, configPath);
    expect(config).toEqual(DEFAULT_MEMEX_CONFIG);

    rmSync(dir, { recursive: true });
  });
});

describe('saveMemexConfig', () => {
  it('writes config to disk and can be read back', () => {
    const dir = createTempDir();
    const configPath = join(dir, 'test.memex.json');

    const config = { ...DEFAULT_MEMEX_CONFIG, embedder: 'local' as const };
    saveMemexConfig(config, configPath);

    const loaded = loadMemexConfig(undefined, configPath);
    expect(loaded.embedder).toBe('local');

    rmSync(dir, { recursive: true });
  });
});

describe('loadKnowledgeSchema', () => {
  it('throws when schema file does not exist', () => {
    expect(() => loadKnowledgeSchema('/nonexistent/schema.json')).toThrow('not found');
  });

  it('loads and merges schema with defaults', () => {
    const dir = createTempDir();
    const schemaPath = join(dir, 'test.schema.json');
    writeFileSync(schemaPath, JSON.stringify({
      name: 'tolkien-kb',
      domain: 'tolkien-lore',
      entityTypes: ['character', 'place', 'event'],
      sources: ['./lore/**/*.md'],
    }));

    const schema = loadKnowledgeSchema(schemaPath);
    expect(schema.name).toBe('tolkien-kb');
    expect(schema.domain).toBe('tolkien-lore');
    expect(schema.entityTypes).toEqual(['character', 'place', 'event']);
    // Compiler defaults should be merged in
    expect(schema.compiler?.deduplicationThreshold).toBe(0.92);

    rmSync(dir, { recursive: true });
  });

  it('throws on invalid JSON', () => {
    const dir = createTempDir();
    const schemaPath = join(dir, 'bad.schema.json');
    writeFileSync(schemaPath, '{invalid json');

    expect(() => loadKnowledgeSchema(schemaPath)).toThrow('Invalid JSON');

    rmSync(dir, { recursive: true });
  });
});

describe('saveKnowledgeSchema', () => {
  it('round-trips schema through save and load', () => {
    const dir = createTempDir();
    const schemaPath = join(dir, 'rt.schema.json');

    saveKnowledgeSchema(DEFAULT_KNOWLEDGE_SCHEMA, schemaPath);
    const loaded = loadKnowledgeSchema(schemaPath);
    expect(loaded.name).toBe(DEFAULT_KNOWLEDGE_SCHEMA.name);
    expect(loaded.domain).toBe(DEFAULT_KNOWLEDGE_SCHEMA.domain);

    rmSync(dir, { recursive: true });
  });
});
