/**
 * Memex configuration — loading, saving, and defaults.
 *
 * Configuration lives in `smallchat.memex.json` in the project root,
 * or can be overridden via CLI flags.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MemexConfig, KnowledgeSchema } from './types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MEMEX_CONFIG: MemexConfig = {
  schemaPath: 'memex.schema.json',
  sourcePaths: [],
  outputPath: 'knowledge.memex.json',
  embedder: 'onnx',
  watch: false,
  maxRetainedVersions: 5,
};

export const DEFAULT_KNOWLEDGE_SCHEMA: KnowledgeSchema = {
  name: 'untitled',
  domain: 'general',
  entityTypes: ['concept', 'person', 'place', 'event', 'artifact'],
  sources: ['./sources'],
  compiler: {
    embedder: 'onnx',
    deduplicationThreshold: 0.92,
    contradictionThreshold: 0.85,
    minConfidence: 0.5,
    maxClaimsPerPage: 50,
  },
  output: {
    path: 'knowledge.memex.json',
    format: 'json',
  },
};

const CONFIG_FILENAME = 'smallchat.memex.json';

// ---------------------------------------------------------------------------
// Load / Save — MemexConfig
// ---------------------------------------------------------------------------

/**
 * Load memex config from disk, merging with defaults and any overrides.
 */
export function loadMemexConfig(
  overrides?: Partial<MemexConfig>,
  configPath?: string,
): MemexConfig {
  const filePath = configPath ?? resolve(CONFIG_FILENAME);
  let fileConfig: Partial<MemexConfig> = {};

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      fileConfig = JSON.parse(content) as Partial<MemexConfig>;
    } catch {
      // Invalid config file — use defaults
    }
  }

  return {
    ...DEFAULT_MEMEX_CONFIG,
    ...fileConfig,
    ...overrides,
  };
}

/**
 * Save memex config to disk.
 */
export function saveMemexConfig(
  config: MemexConfig,
  configPath?: string,
): void {
  const filePath = configPath ?? resolve(CONFIG_FILENAME);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Load — KnowledgeSchema
// ---------------------------------------------------------------------------

/**
 * Load a knowledge schema from a JSON file.
 */
export function loadKnowledgeSchema(schemaPath: string): KnowledgeSchema {
  const filePath = resolve(schemaPath);

  if (!existsSync(filePath)) {
    throw new Error(`Knowledge schema not found: ${filePath}`);
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<KnowledgeSchema>;

    return {
      ...DEFAULT_KNOWLEDGE_SCHEMA,
      ...parsed,
      compiler: {
        ...DEFAULT_KNOWLEDGE_SCHEMA.compiler,
        ...parsed.compiler,
      },
      output: {
        ...DEFAULT_KNOWLEDGE_SCHEMA.output,
        ...parsed.output,
      },
    };
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in knowledge schema: ${filePath}`);
    }
    throw err;
  }
}

/**
 * Save a knowledge schema to disk.
 */
export function saveKnowledgeSchema(
  schema: KnowledgeSchema,
  schemaPath: string,
): void {
  const filePath = resolve(schemaPath);
  writeFileSync(filePath, JSON.stringify(schema, null, 2) + '\n');
}
