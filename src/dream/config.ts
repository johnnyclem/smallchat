/**
 * Dream configuration — loading, saving, and defaults.
 *
 * Configuration lives in `smallchat.dream.json` in the project root,
 * or can be overridden via CLI flags.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DreamConfig } from './types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  autoDream: false,
  memoryPaths: [],
  logDir: '',
  maxRetainedVersions: 5,
  outputPath: 'tools.toolkit.json',
  embedder: 'onnx',
};

const CONFIG_FILENAME = 'smallchat.dream.json';

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load dream config from disk, merging with defaults and any overrides.
 */
export function loadDreamConfig(
  overrides?: Partial<DreamConfig>,
  configPath?: string,
): DreamConfig {
  const filePath = configPath ?? resolve(CONFIG_FILENAME);
  let fileConfig: Partial<DreamConfig> = {};

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      fileConfig = JSON.parse(content) as Partial<DreamConfig>;
    } catch {
      // Invalid config file — use defaults
    }
  }

  return {
    ...DEFAULT_DREAM_CONFIG,
    ...fileConfig,
    ...overrides,
  };
}

/**
 * Save dream config to disk.
 */
export function saveDreamConfig(
  config: DreamConfig,
  configPath?: string,
): void {
  const filePath = configPath ?? resolve(CONFIG_FILENAME);
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
}
