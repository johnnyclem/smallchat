import { Command } from 'commander';
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync, watch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { Embedder, VectorIndex, ProviderManifest } from '../../core/types.js';
import type { SmallChatManifest } from '../../core/manifest.js';
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
import { SqliteArtifactStore } from '../../mcp/sqlite-artifact.js';
import type { SerializedArtifact } from '../../mcp/artifact.js';

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
// smallchat.json loading
// ---------------------------------------------------------------------------

/**
 * Attempt to find and load a smallchat.json manifest.
 * Searches upward from the given directory.
 */
function findSmallChatManifest(startDir: string): { manifest: SmallChatManifest; path: string } | null {
  let dir = startDir;
  const root = resolve('/');

  while (dir !== root) {
    const candidate = join(dir, 'smallchat.json');
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        const manifest = JSON.parse(content) as SmallChatManifest;
        // Basic validation — must have a name
        if (manifest.name) {
          return { manifest, path: candidate };
        }
      } catch {
        // Invalid JSON, skip
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Resolve additional manifests declared in smallchat.json dependencies.
 * Local file paths are resolved relative to the smallchat.json location.
 */
function resolvePackageDependencies(
  manifest: SmallChatManifest,
  manifestDir: string,
): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];

  // Resolve local manifest paths declared in "manifests" array
  if (manifest.manifests) {
    for (const p of manifest.manifests) {
      const resolved = resolve(manifestDir, p);
      if (existsSync(resolved)) {
        if (statSync(resolved).isDirectory()) {
          manifests.push(...loadManifestFiles(findManifestFiles(resolved)));
        } else if (resolved.endsWith('.json')) {
          try {
            const content = readFileSync(resolved, 'utf-8');
            const m = JSON.parse(content) as ProviderManifest;
            if (Array.isArray(m.tools)) {
              manifests.push(m);
            }
          } catch { /* skip invalid */ }
        }
      }
    }
  }

  // Resolve local file dependencies (semver registry resolution is future work)
  if (manifest.dependencies) {
    for (const [_name, specifier] of Object.entries(manifest.dependencies)) {
      // Local file paths start with ./ or ../
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const resolved = resolve(manifestDir, specifier);
        if (existsSync(resolved) && resolved.endsWith('.json')) {
          try {
            const content = readFileSync(resolved, 'utf-8');
            const m = JSON.parse(content);
            if (Array.isArray(m.tools)) {
              manifests.push(m as ProviderManifest);
            } else if (Array.isArray(m.providers)) {
              // Pre-compiled package format — extract provider manifests
              for (const provider of m.providers) {
                if (Array.isArray(provider.tools)) {
                  manifests.push({
                    id: provider.id,
                    name: provider.name,
                    tools: provider.tools,
                    transportType: provider.transportType ?? 'mcp',
                    endpoint: provider.endpoint,
                    version: provider.version,
                    compilerHints: provider.compilerHints,
                  } as ProviderManifest);
                }
              }
            }
          } catch { /* skip invalid */ }
        }
      }
      // TODO: registry-based resolution for semver specifiers
    }
  }

  return manifests;
}

// ---------------------------------------------------------------------------
// Core compile
// ---------------------------------------------------------------------------

type OutputFormat = 'json' | 'sqlite';

async function runCompile(
  manifests: ProviderManifest[],
  outputPath: string,
  embedderType: string,
  dbPath: string,
  sourceType?: SourceType,
  format: OutputFormat = 'json',
  projectManifest?: SmallChatManifest,
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

  const result = await compiler.compile(manifests, projectManifest);

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

  const output = serializeResult(result, embedderType, manifests);

  if (format === 'sqlite') {
    const sqlitePath = outputPath.replace(/\.json$/, '.db');
    const store = new SqliteArtifactStore(sqlitePath);
    store.save(output as unknown as SerializedArtifact);
    store.close();
    console.log(`\nOutput (SQLite): ${sqlitePath}`);
  } else {
    writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\nOutput: ${outputPath}`);
  }

  console.log(`  - ${result.uniqueSelectorCount} selectors`);
  console.log(`  - ${result.toolCount} tools`);
  console.log(`  - ${result.dispatchTables.size} providers`);

  // Save discovered manifests as shareable files when introspected
  if (sourceType === 'mcp-config' || sourceType === 'auto-detect') {
    const { mkdirSync } = await import('node:fs');
    const manifestDir = outputPath.replace(/\.json$/, '.manifests');
    try {
      mkdirSync(manifestDir, { recursive: true });
      for (const m of manifests) {
        const manifestPath = join(manifestDir, `${m.id}-manifest.json`);
        writeFileSync(manifestPath, JSON.stringify(m, null, 2));
      }
      console.log(`\nManifests saved: ${manifestDir}/`);
      console.log('  (Shareable manifest files for each discovered server)');
    } catch {
      // Non-critical
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
  .option('-f, --format <type>', 'Output format: json (default) or sqlite', 'json')
  .option('--db-path <path>', 'Path to sqlite-vec database', 'smallchat.db')
  .option('--timeout <ms>', 'Timeout for MCP server introspection (ms)', '30000')
  .action(async (options) => {
    const source = detectSourceType(options.source);
    const timeoutMs = parseInt(options.timeout, 10);

    // Look for smallchat.json project manifest
    const projectResult = findSmallChatManifest(process.cwd());
    let projectManifest: SmallChatManifest | undefined;

    if (projectResult) {
      projectManifest = projectResult.manifest;
      const manifestDir = dirname(projectResult.path);
      console.log(`Found smallchat.json: ${projectResult.path}`);

      if (projectManifest.compiler?.embedder && !options.embedder) {
        options.embedder = projectManifest.compiler.embedder;
      }
      if (projectManifest.output?.path && options.output === 'tools.toolkit.json') {
        options.output = resolve(manifestDir, projectManifest.output.path);
      }
      if (projectManifest.output?.format && options.format === 'json') {
        options.format = projectManifest.output.format;
      }
      if (projectManifest.output?.dbPath && options.dbPath === 'smallchat.db') {
        options.dbPath = resolve(manifestDir, projectManifest.output.dbPath);
      }
    }

    const outputPath = resolve(options.output);
    const embedderType = options.embedder;
    const dbPath = resolve(options.dbPath);
    const format = (options.format === 'sqlite' ? 'sqlite' : 'json') as OutputFormat;

    // Resolve manifests from source + smallchat.json dependencies
    let manifests = await resolveManifests(source, { timeoutMs });

    if (projectResult && projectManifest) {
      const manifestDir = dirname(projectResult.path);
      const depManifests = resolvePackageDependencies(projectManifest, manifestDir);
      if (depManifests.length > 0) {
        console.log(`\nResolved ${depManifests.length} manifest(s) from smallchat.json dependencies`);
        manifests = [...manifests, ...depManifests];
      }
    }

    const ok = await runCompile(manifests, outputPath, embedderType, dbPath, source.type, format, projectManifest);

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
        let newManifests = await resolveManifests(source, { timeoutMs });
        if (projectResult && projectManifest) {
          const manifestDir = dirname(projectResult.path);
          newManifests = [...newManifests, ...resolvePackageDependencies(projectManifest, manifestDir)];
        }
        await runCompile(newManifests, outputPath, embedderType, dbPath, source.type, format, projectManifest);
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

function serializeResult(
  result: import('../../core/types.js').CompilationResult,
  embedderType?: string,
  manifests?: import('../../core/types.js').ProviderManifest[],
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

  // Build hint indexes from manifests
  const toolHintIndex = new Map<string, Record<string, unknown>>();
  const providerHints: Record<string, object> = {};
  if (manifests) {
    for (const m of manifests) {
      if (m.compilerHints) {
        providerHints[m.id] = m.compilerHints;
      }
      for (const tool of m.tools) {
        if (tool.compilerHints) {
          toolHintIndex.set(tool.name, tool.compilerHints as unknown as Record<string, unknown>);
        }
      }
    }
  }

  const dispatchTables: Record<string, Record<string, object>> = {};
  for (const [providerId, table] of result.dispatchTables) {
    const methods: Record<string, object> = {};
    for (const [canonical, imp] of table) {
      methods[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        transportType: imp.transportType,
        ...(toolHintIndex.has(imp.toolName) ? { compilerHints: toolHintIndex.get(imp.toolName) } : {}),
      };
    }
    dispatchTables[providerId] = methods;
  }

  // Build channel metadata from manifests
  const channels: Record<string, object> = {};
  if (manifests) {
    for (const m of manifests) {
      if (m.channel?.isChannel) {
        channels[m.id] = {
          isChannel: true,
          twoWay: m.channel.twoWay,
          permissionRelay: m.channel.permissionRelay,
          replyToolName: m.channel.replyToolName,
          instructions: m.channel.instructions,
        };
      }
    }
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
      channelCount: Object.keys(channels).length,
    },
    selectors,
    dispatchTables,
    collisions: result.collisions,
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
    ...(Object.keys(providerHints).length > 0 ? { providerHints } : {}),
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
