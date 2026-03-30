/**
 * DreamCompiler — orchestrates the memory-driven tool re-compilation pipeline.
 *
 * This is the core of the /dream command. It:
 * 1. Reads Claude memory files
 * 2. Analyzes session logs for tool usage
 * 3. Prioritizes tools based on gathered intelligence
 * 4. Runs a fresh compile with priority hints
 * 5. Manages artifact versioning
 *
 * The main entry point is `compileLatest()`, aliased as `dream()`.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProviderManifest, Embedder, VectorIndex } from '../core/types.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { parseMCPManifest } from '../compiler/parser.js';
import {
  isMcpConfigFile,
  introspectMcpConfigFile,
  isMcpServerProject,
  introspectLocalMcpServer,
} from '../mcp/client.js';

import type {
  DreamConfig,
  DreamResult,
  DreamAnalysis,
  ToolPriorityHints,
} from './types.js';
import { loadDreamConfig } from './config.js';
import { readMemoryFiles, extractToolMentions } from './memory-reader.js';
import { discoverLogFiles, analyzeSessionLog, aggregateUsageStats } from './log-analyzer.js';
import { prioritizeTools, generateReport } from './tool-prioritizer.js';
import {
  archiveCurrentArtifact,
  promoteArtifact,
  pruneOldVersions,
} from './artifact-versioning.js';

// ---------------------------------------------------------------------------
// Manifest resolution (mirrors compile command logic)
// ---------------------------------------------------------------------------

function findManifestFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isFile() && entry.endsWith('.json')) {
        files.push(fullPath);
      } else if (stat.isDirectory()) {
        files.push(...findManifestFiles(fullPath));
      }
    }
  } catch {
    // Directory might not exist
  }
  return files;
}

function loadManifestFiles(files: string[]): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const manifest = JSON.parse(content) as ProviderManifest;
      if (!Array.isArray(manifest.tools)) continue;
      manifests.push(manifest);
    } catch {
      // Skip invalid files
    }
  }
  return manifests;
}

async function resolveManifests(sourcePath?: string): Promise<ProviderManifest[]> {
  const searchPath = sourcePath ? resolve(sourcePath) : process.cwd();

  // Check if it's an MCP config file
  if (existsSync(searchPath) && statSync(searchPath).isFile()) {
    try {
      const content = JSON.parse(readFileSync(searchPath, 'utf-8'));
      if (isMcpConfigFile(content)) {
        return introspectMcpConfigFile(searchPath);
      }
    } catch {
      // Not valid JSON
    }
  }

  // Check if it's an MCP server project
  if (isMcpServerProject(searchPath)) {
    const manifest = await introspectLocalMcpServer(searchPath);
    return manifest ? [manifest] : [];
  }

  // Fall back to manifest files in directory
  const files = findManifestFiles(searchPath);
  if (files.length > 0) {
    return loadManifestFiles(files);
  }

  return [];
}

/**
 * Extract all tool names from provider manifests.
 */
function extractKnownToolNames(manifests: ProviderManifest[]): string[] {
  const names = new Set<string>();
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      names.add(tool.name);
    }
  }
  return Array.from(names);
}

// ---------------------------------------------------------------------------
// Embedder/index factory
// ---------------------------------------------------------------------------

async function createEmbedder(type: string): Promise<Embedder> {
  if (type === 'onnx') {
    try {
      const { ONNXEmbedder } = await import('../embedding/onnx-embedder.js');
      return new ONNXEmbedder();
    } catch {
      return new LocalEmbedder();
    }
  }
  return new LocalEmbedder();
}

function createVectorIndex(embedderType: string): VectorIndex {
  // Only use SQLite for ONNX; local embedder uses memory index
  return new MemoryVectorIndex();
}

// ---------------------------------------------------------------------------
// Compile with priority hints
// ---------------------------------------------------------------------------

function serializeResult(
  result: import('../core/types.js').CompilationResult,
  embedderType: string,
  hints: ToolPriorityHints,
): object {
  const selectors: Record<string, object> = {};
  for (const [key, sel] of result.selectors) {
    selectors[key] = {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      vector: Array.from(sel.vector),
    };
  }

  const dispatchTables: Record<string, Record<string, object>> = {};
  for (const [providerId, table] of result.dispatchTables) {
    const methods: Record<string, object> = {};
    for (const [canonical, imp] of table) {
      methods[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        transportType: imp.transportType,
      };
    }
    dispatchTables[providerId] = methods;
  }

  // Serialize priority hints for runtime use
  const dreamMetadata: Record<string, unknown> = {
    boosted: Object.fromEntries(hints.boosted),
    demoted: Object.fromEntries(hints.demoted),
    excluded: Array.from(hints.excluded),
    reasoning: Object.fromEntries(hints.reasoning),
    generatedAt: new Date().toISOString(),
  };

  return {
    version: '0.3.0',
    timestamp: new Date().toISOString(),
    embedding: {
      model: embedderType === 'onnx' ? 'all-MiniLM-L6-v2' : 'hash-based',
      dimensions: 384,
      embedderType,
    },
    stats: {
      toolCount: result.toolCount,
      uniqueSelectorCount: result.uniqueSelectorCount,
      mergedCount: result.mergedCount,
      providerCount: result.dispatchTables.size,
      collisionCount: result.collisions.length,
    },
    selectors,
    dispatchTables,
    collisions: result.collisions,
    dreamMetadata,
  };
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export interface CompileLatestOptions {
  /** Override config values from CLI flags. */
  configOverrides?: Partial<DreamConfig>;
  /** Path to config file. */
  configPath?: string;
  /** If true, analyze only — don't compile or write artifacts. */
  dryRun?: boolean;
  /** Project directory (defaults to cwd). */
  projectDir?: string;
}

/**
 * Run the dream pipeline: analyze memory + logs, then compile with insights.
 *
 * This is the primary API. Also aliased as `dream()`.
 */
export async function compileLatest(options: CompileLatestOptions = {}): Promise<DreamResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const config = loadDreamConfig(options.configOverrides, options.configPath);

  // Step 1: Resolve source manifests
  console.log('Resolving tool manifests...');
  const manifests = await resolveManifests(config.sourcePath);
  const knownTools = extractKnownToolNames(manifests);
  console.log(`  Found ${manifests.length} manifest(s) with ${knownTools.length} tools`);

  // Step 2: Read memory files
  console.log('\nReading memory files...');
  const memoryFiles = readMemoryFiles(config, projectDir);
  console.log(`  Found ${memoryFiles.length} memory file(s)`);

  // Step 3: Extract tool mentions from memory
  const allMentions = memoryFiles.flatMap(f =>
    extractToolMentions(f.content, knownTools, f.path),
  );
  console.log(`  Extracted ${allMentions.length} tool mention(s)`);

  // Step 4: Analyze session logs
  console.log('\nAnalyzing session logs...');
  const logFiles = discoverLogFiles(config.logDir);
  console.log(`  Found ${logFiles.length} log file(s)`);

  const allRecords = logFiles.flatMap(f => analyzeSessionLog(f));
  const usageStats = aggregateUsageStats(allRecords);
  console.log(`  Analyzed ${allRecords.length} tool call(s) across ${usageStats.length} unique tool(s)`);

  // Step 5: Prioritize tools
  console.log('\nPrioritizing tools...');
  const hints = prioritizeTools(allMentions, usageStats, knownTools);
  console.log(`  Boosted: ${hints.boosted.size}, Demoted: ${hints.demoted.size}, Excluded: ${hints.excluded.size}`);

  // Step 6: Generate report
  const report = generateReport(hints, usageStats, allMentions);

  const analysis: DreamAnalysis = {
    memoryMentions: allMentions,
    usageStats,
    priorityHints: hints,
    report,
    timestamp: new Date().toISOString(),
  };

  // Dry run — return analysis only
  if (options.dryRun) {
    console.log('\n' + report);
    return {
      analysis,
      artifactPath: null,
      archivedPath: null,
      autoPromoted: false,
    };
  }

  // Step 7: Archive current artifact before overwriting
  console.log('\nArchiving current artifact...');
  const archived = archiveCurrentArtifact(projectDir, config.outputPath, false);
  if (archived) {
    console.log(`  Archived to: ${archived.path}`);
  }

  // Step 8: Compile with priority hints
  console.log('\nCompiling with dream insights...');

  // Filter out excluded tools from manifests
  const filteredManifests: ProviderManifest[] = manifests.map(m => ({
    ...m,
    tools: m.tools.filter(t => !hints.excluded.has(t.name)),
  }));

  const embedder = await createEmbedder(config.embedder);
  const vectorIndex = createVectorIndex(config.embedder);
  const compiler = new ToolCompiler(embedder, vectorIndex);
  const result = await compiler.compile(filteredManifests);

  // Serialize with dream metadata
  const output = serializeResult(result, config.embedder, hints);
  const outputPath = resolve(projectDir, config.outputPath);
  const newArtifactPath = outputPath + '.dream-pending.json';
  writeFileSync(newArtifactPath, JSON.stringify(output, null, 2));

  console.log(`  Compiled: ${result.toolCount} tools, ${result.uniqueSelectorCount} selectors`);

  // Step 9: Auto-promote if enabled
  let autoPromoted = false;
  if (config.autoDream) {
    promoteArtifact(projectDir, newArtifactPath, config.outputPath);
    autoPromoted = true;
    console.log(`\nAuto-promoted new artifact to: ${config.outputPath}`);

    // Prune old versions
    const pruned = pruneOldVersions(projectDir, config.maxRetainedVersions);
    if (pruned.length > 0) {
      console.log(`  Pruned ${pruned.length} old version(s)`);
    }
  } else {
    console.log(`\nNew artifact ready at: ${newArtifactPath}`);
    console.log('Run with --auto to replace automatically, or manually copy to overwrite.');
  }

  console.log('\n' + report);

  return {
    analysis,
    artifactPath: newArtifactPath,
    archivedPath: archived?.path ?? null,
    autoPromoted,
  };
}

/** Alias for compileLatest. */
export const dream = compileLatest;
