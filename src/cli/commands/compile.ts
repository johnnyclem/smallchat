import { Command } from 'commander';
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Embedder, VectorIndex, ProviderManifest } from '../../core/types.js';
import { ToolCompiler } from '../../compiler/compiler.js';
import { LocalEmbedder } from '../../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';
import { ONNXEmbedder } from '../../embedding/onnx-embedder.js';
import { SqliteVectorIndex } from '../../embedding/sqlite-vector-index.js';
import {
  isMcpConfigFile,
  isMcpServerProject,
  introspectMcpConfigFile,
  introspectLocalMcpServer,
} from '../../mcp/client.js';

// ---------------------------------------------------------------------------
// Source type detection
// ---------------------------------------------------------------------------

type SourceType = 'directory' | 'mcp-config' | 'auto-detect';

function detectSourceType(sourcePath: string | undefined): { type: SourceType; path: string } {
  // No source given → auto-detect from cwd
  if (!sourcePath) {
    return { type: 'auto-detect', path: process.cwd() };
  }

  const resolved = resolve(sourcePath);

  // Check if it's a file
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    try {
      const content = JSON.parse(readFileSync(resolved, 'utf-8'));
      if (isMcpConfigFile(content)) {
        return { type: 'mcp-config', path: resolved };
      }
    } catch {
      // Not valid JSON, treat as directory
    }
    // Single file but not an MCP config — treat as directory containing it
    return { type: 'directory', path: resolved };
  }

  // Check if it's a directory
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return { type: 'directory', path: resolved };
  }

  // Path doesn't exist yet — assume directory (will error later)
  return { type: 'directory', path: resolved };
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

async function resolveManifests(
  source: { type: SourceType; path: string },
  options?: { timeoutMs?: number },
): Promise<ProviderManifest[]> {
  switch (source.type) {
    case 'mcp-config': {
      console.log(`Introspecting MCP servers from ${source.path}...\n`);
      return introspectMcpConfigFile(source.path, options);
    }

    case 'auto-detect': {
      console.log(`Auto-detecting MCP server project in ${source.path}...\n`);

      if (!isMcpServerProject(source.path)) {
        // Fall back to looking for manifest files in cwd
        const files = findManifestFiles(source.path);
        if (files.length > 0) {
          console.log(`Found ${files.length} manifest file(s) in ${source.path}`);
          return loadManifestFiles(files);
        }

        console.error('No MCP server project detected and no manifest files found.');
        console.error('');
        console.error('Usage:');
        console.error('  smallchat compile --source ./manifests       # Directory of manifest JSON files');
        console.error('  smallchat compile --source ~/.mcp.json       # MCP config file (mcpServers)');
        console.error('  cd my-mcp-server && smallchat compile        # Auto-detect from MCP server repo');
        return [];
      }

      const manifest = await introspectLocalMcpServer(source.path, options);
      return manifest ? [manifest] : [];
    }

    case 'directory': {
      console.log(`Parsing manifests from ${source.path}...`);
      const files = findManifestFiles(source.path);
      return loadManifestFiles(files);
    }
  }
}

function loadManifestFiles(files: string[]): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const manifest = JSON.parse(content) as ProviderManifest;
      if (!Array.isArray(manifest.tools)) {
        // Not a valid manifest (e.g. config file, metadata), skip silently
        continue;
      }
      manifests.push(manifest);
      console.log(`  ${manifest.id ?? manifest.name}: ${manifest.tools.length} tools`);
    } catch (e) {
      console.error(`  Warning: Could not parse ${file}: ${(e as Error).message}`);
    }
  }
  return manifests;
}

// ---------------------------------------------------------------------------
// Embedder / index factories
// ---------------------------------------------------------------------------

async function createEmbedder(type: string): Promise<Embedder> {
  if (type === 'onnx') {
    try {
      return new ONNXEmbedder();
    } catch (e) {
      console.warn(`  Warning: ONNX embedder failed to load: ${(e as Error).message}`);
      console.warn('  Falling back to local (hash-based) embedder.');
      console.warn('  Run "smallchat doctor" to diagnose. Ensure models/ directory exists.');
      return new LocalEmbedder();
    }
  }
  return new LocalEmbedder();
}

function createVectorIndex(type: string, dbPath: string): VectorIndex {
  if (type === 'sqlite') {
    return new SqliteVectorIndex(dbPath);
  }
  return new MemoryVectorIndex();
}

// ---------------------------------------------------------------------------
// Core compile
// ---------------------------------------------------------------------------

async function runCompile(
  manifests: ProviderManifest[],
  outputPath: string,
  embedderType: string,
  dbPath: string,
): Promise<boolean> {
  if (manifests.length === 0) {
    console.error('No valid manifests found.');
    return false;
  }

  const embedder = await createEmbedder(embedderType);
  const vectorIndex = createVectorIndex(
    embedderType === 'onnx' ? 'sqlite' : 'memory',
    dbPath,
  );
  const compiler = new ToolCompiler(embedder, vectorIndex);

  const modelLabel = embedderType === 'onnx'
    ? 'all-MiniLM-L6-v2 (ONNX, 384-dim)'
    : 'hash-based (v0.0.1 placeholder)';

  console.log(`\nEmbedding ${manifests.reduce((sum, m) => sum + m.tools.length, 0)} tools...`);
  console.log(`  Model: ${modelLabel}`);

  const result = await compiler.compile(manifests);

  console.log(`  Selectors generated: ${result.toolCount}`);
  console.log(`  After dedup (threshold 0.95): ${result.uniqueSelectorCount} unique selectors`);
  if (result.mergedCount > 0) {
    console.log(`  ${result.mergedCount} tools merged as semantically equivalent`);
  }

  console.log('\nLinking...');
  console.log(`  Dispatch tables: ${result.dispatchTables.size}`);

  if (result.collisions.length > 0) {
    console.log(`  Selector collisions: ${result.collisions.length} (warnings emitted)`);
    for (const collision of result.collisions) {
      console.log(`    ⚠ ${collision.selectorA} and ${collision.selectorB} (cosine: ${collision.similarity.toFixed(2)})`);
      console.log(`      ${collision.hint}`);
    }
  }

  const output = serializeResult(result, embedderType);
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\nOutput: ${outputPath}`);
  console.log(`  - ${result.uniqueSelectorCount} selectors`);
  console.log(`  - ${result.toolCount} tools`);
  console.log(`  - ${result.dispatchTables.size} providers`);

  // Write manifest files for MCP config / auto-detect sources
  const manifestDir = outputPath.replace(/\.json$/, '.manifests');
  if (manifests.some(m => !findManifestFiles('.').some(f => {
    try { return JSON.parse(readFileSync(f, 'utf-8')).id === m.id; } catch { return false; }
  }))) {
    // These manifests were discovered via introspection — save them
    const { mkdirSync } = await import('node:fs');
    try {
      mkdirSync(manifestDir, { recursive: true });
      for (const m of manifests) {
        const manifestPath = join(manifestDir, `${m.id}-manifest.json`);
        writeFileSync(manifestPath, JSON.stringify(m, null, 2));
      }
      console.log(`\nManifests saved: ${manifestDir}/`);
    } catch {
      // Non-critical, skip
    }
  }

  const headerPath = outputPath.replace(/\.json$/, '.header.txt');
  const header = generateHeader(result);
  writeFileSync(headerPath, header);
  console.log(`Header file: ${headerPath} (${header.split(/\s+/).length} tokens approx)`);

  return true;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const compileCommand = new Command('compile')
  .description('Compile tool definitions from MCP server manifests, config files, or auto-detect')
  .option('-s, --source [path]', 'Source: directory of manifests, MCP config file, or omit to auto-detect')
  .option('-o, --output <path>', 'Output file path', 'tools.toolkit.json')
  .option('-w, --watch', 'Watch source and recompile on changes')
  .option('-e, --embedder <type>', 'Embedder to use: onnx (default) or local', 'onnx')
  .option('--db-path <path>', 'Path to sqlite-vec database', 'smallchat.db')
  .option('--timeout <ms>', 'Timeout for MCP server introspection (ms)', '30000')
  .action(async (options) => {
    const source = detectSourceType(options.source);
    const outputPath = resolve(options.output);
    const embedderType = options.embedder;
    const dbPath = resolve(options.dbPath);
    const timeoutMs = parseInt(options.timeout, 10);

    const manifests = await resolveManifests(source, { timeoutMs });
    const ok = await runCompile(manifests, outputPath, embedderType, dbPath);

    if (!options.watch) {
      if (!ok) process.exit(1);
      return;
    }

    if (!ok) {
      console.log('\nInitial compile failed, watching for changes...');
    }

    const watchPath = source.path;
    console.log(`\nWatching ${watchPath} for changes...`);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    watch(watchPath, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith('.json') && !filename?.endsWith('.ts')) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log(`\n--- Recompiling (${filename} changed) ---\n`);
        const newManifests = await resolveManifests(source, { timeoutMs });
        await runCompile(newManifests, outputPath, embedderType, dbPath);
        console.log(`\nWatching ${watchPath} for changes...`);
      }, 200);
    });
  });

// ---------------------------------------------------------------------------
// Helpers
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

function serializeResult(result: import('../../core/types.js').CompilationResult, embedderType?: string): object {
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

  return {
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    embedding: {
      model: embedderType === 'onnx' ? 'all-MiniLM-L6-v2' : 'hash-based',
      dimensions: embedderType === 'onnx' ? 384 : 384,
      embedderType: embedderType ?? 'local',
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
  };
}

function generateHeader(result: import('../../core/types.js').CompilationResult): string {
  const lines: string[] = ['Available capabilities:'];

  for (const [providerId, table] of result.dispatchTables) {
    const tools = Array.from(table.values()).map(imp => imp.toolName);
    lines.push(`- ${providerId}: ${tools.join(', ')}`);
  }

  lines.push('');
  lines.push('To use a tool, describe what you want to do. The runtime will resolve');
  lines.push('the best tool and provide the required arguments.');

  return lines.join('\n');
}
