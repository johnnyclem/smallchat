import { Command } from 'commander';
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync, realpathSync, watch } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import type { Embedder, VectorIndex, ProviderManifest } from '../../core/types.js';
import type { SmallChatManifest } from '../../core/manifest.js';
import { safeJsonParse, PrototypePollutionError } from '../../core/safe-json.js';
import { ToolCompiler, DuplicateToolError, SelectorConflictError } from '../../compiler/compiler.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';
import { SqliteVectorIndex } from '../../embedding/sqlite-vector-index.js';
import { buildArtifact } from '../../artifact/format.js';
import { writeArtifact } from '../../artifact/io.js';
import {
  createEmbedder,
  describeFingerprint,
  EmbedderUnavailableError,
  fingerprintOf,
  parseEmbedderKind,
  type BuiltinEmbedderKind,
} from '../../artifact/embedder.js';
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

export function detectSourceType(sourcePath: string | undefined): { type: SourceType; path: string } {
  // No source given → auto-detect from cwd
  if (!sourcePath) {
    return { type: 'auto-detect', path: process.cwd() };
  }

  const resolved = resolve(sourcePath);

  // Check if it's a file
  if (existsSync(resolved) && statSync(resolved).isFile()) {
    try {
      // Detection only — strip silently so a benign config containing
      // a stray __proto__ key in deep metadata still gets type-tagged.
      const content = safeJsonParse(readFileSync(resolved, 'utf-8'), { onPollution: 'strip' });
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

/**
 * Manifest files already loaded in one compile run, by real path. A file
 * reached twice — through --source (or auto-detection) and again through
 * smallchat.json "manifests" or "dependencies", as in every `smallchat init`
 * project — is compiled once.
 */
type LoadedFiles = Set<string>;

/** Record `file` as loaded; false when it already was. */
function firstLoad(file: string, loaded: LoadedFiles): boolean {
  let key: string;
  try {
    key = realpathSync(file);
  } catch {
    key = resolve(file);
  }
  if (loaded.has(key)) return false;
  loaded.add(key);
  return true;
}

async function resolveManifests(
  source: { type: SourceType; path: string },
  options: { timeoutMs?: number } = {},
  loaded: LoadedFiles = new Set(),
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
          return loadManifestFiles(files, loaded);
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
      return loadManifestFiles(files, loaded);
    }
  }
}

function loadManifestFiles(files: string[], loaded: LoadedFiles): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];
  for (const file of files) {
    if (!firstLoad(file, loaded)) continue;
    try {
      const content = readFileSync(file, 'utf-8');
      const manifest = safeJsonParse(content) as ProviderManifest;
      if (!Array.isArray(manifest.tools)) {
        // Not a valid manifest (e.g. config file, metadata), skip silently
        continue;
      }
      manifests.push(manifest);
      console.log(`  ${manifest.id ?? manifest.name}: ${manifest.tools.length} tools`);
    } catch (e) {
      if (e instanceof PrototypePollutionError) {
        console.error(`  Error: Refusing to load ${file}: ${e.message}`);
        continue;
      }
      console.error(`  Warning: Could not parse ${file}: ${(e as Error).message}`);
    }
  }
  return manifests;
}

/**
 * Reject relative paths that escape the configured base directory.
 * Returns true when the resolved path stays inside `baseDir`.
 */
function isWithin(baseDir: string, resolved: string): boolean {
  const rel = relative(baseDir, resolved);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Index factory
// ---------------------------------------------------------------------------

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
export function findSmallChatManifest(startDir: string): { manifest: SmallChatManifest; path: string } | null {
  let dir = startDir;
  const root = resolve('/');

  while (dir !== root) {
    const candidate = join(dir, 'smallchat.json');
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        const manifest = safeJsonParse(content) as SmallChatManifest;
        // Basic validation — must have a name
        if (manifest.name) {
          return { manifest, path: candidate };
        }
      } catch (e) {
        if (e instanceof PrototypePollutionError) {
          console.error(`  Error: Refusing to load ${candidate}: ${e.message}`);
        }
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
  loaded: LoadedFiles = new Set(),
): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];

  // Resolve local manifest paths declared in "manifests" array
  if (manifest.manifests) {
    for (const p of manifest.manifests) {
      const resolved = resolve(manifestDir, p);
      if (!isWithin(manifestDir, resolved)) {
        console.warn(`  Warning: skipping manifest path "${p}" — escapes the smallchat.json directory`);
        continue;
      }
      if (existsSync(resolved)) {
        if (statSync(resolved).isDirectory()) {
          manifests.push(...loadManifestFiles(findManifestFiles(resolved), loaded));
        } else if (resolved.endsWith('.json') && firstLoad(resolved, loaded)) {
          try {
            const content = readFileSync(resolved, 'utf-8');
            const m = safeJsonParse(content) as ProviderManifest;
            if (Array.isArray(m.tools)) {
              manifests.push(m);
            }
          } catch (e) {
            if (e instanceof PrototypePollutionError) {
              console.error(`  Error: Refusing to load ${resolved}: ${e.message}`);
            }
            /* skip invalid */
          }
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
        if (!isWithin(manifestDir, resolved)) {
          console.warn(`  Warning: skipping dependency "${_name}" — path "${specifier}" escapes the smallchat.json directory`);
          continue;
        }
        if (existsSync(resolved) && resolved.endsWith('.json') && firstLoad(resolved, loaded)) {
          try {
            const content = readFileSync(resolved, 'utf-8');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = safeJsonParse(content) as any;
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
          } catch (e) {
            if (e instanceof PrototypePollutionError) {
              console.error(`  Error: Refusing to load ${resolved}: ${e.message}`);
            }
            /* skip invalid */
          }
        }
      } else {
        // Registry-based resolution for semver specifiers is not implemented;
        // warn instead of silently ignoring the declared dependency.
        console.warn(`  Warning: skipping dependency "${_name}" — semver specifier "${specifier}" is not supported yet (only local ./ or ../ paths are resolved)`);
      }
    }
  }

  return manifests;
}

/**
 * Every manifest one compile run sees: the source's (a directory, an MCP
 * config, or auto-detected from the source path), then the project's
 * smallchat.json "manifests" and local "dependencies". Each manifest file
 * is loaded once, however many of those reach it.
 */
export async function collectManifests(
  source: { type: SourceType; path: string },
  project: { manifest: SmallChatManifest; path: string } | null,
  options: { timeoutMs?: number } = {},
): Promise<ProviderManifest[]> {
  const loaded: LoadedFiles = new Set();
  const manifests = await resolveManifests(source, options, loaded);
  if (!project) return manifests;
  const depManifests = resolvePackageDependencies(project.manifest, dirname(project.path), loaded);
  if (depManifests.length > 0) {
    console.log(`\nResolved ${depManifests.length} manifest(s) from smallchat.json dependencies`);
  }
  return [...manifests, ...depManifests];
}

// ---------------------------------------------------------------------------
// Core compile
// ---------------------------------------------------------------------------

type OutputFormat = 'json' | 'sqlite';

async function runCompile(
  manifests: ProviderManifest[],
  outputPath: string,
  embedderKind: BuiltinEmbedderKind,
  dbPath: string,
  sourceType?: SourceType,
  format: OutputFormat = 'json',
  projectManifest?: SmallChatManifest,
  allowDuplicates = false,
): Promise<boolean> {
  if (manifests.length === 0) {
    console.error('No valid manifests found.');
    return false;
  }

  let embedder: Embedder;
  try {
    embedder = await createEmbedder(embedderKind);
  } catch (e) {
    if (!(e instanceof EmbedderUnavailableError)) throw e;
    console.error(`\n${e.message}`);
    console.error('  Run "smallchat doctor" to diagnose, or compile with --embedder hash');
    console.error('  (hash-based placeholder vectors; dev/test only).');
    return false;
  }
  const fingerprint = fingerprintOf(embedder);
  const vectorIndex = createVectorIndex(
    embedderKind === 'onnx' ? 'sqlite' : 'memory',
    dbPath,
  );
  const compiler = new ToolCompiler(embedder, vectorIndex, {
    allowDuplicates,
    duplicateThreshold: projectManifest?.compiler?.duplicateThreshold ?? projectManifest?.compiler?.deduplicationThreshold,
  });

  console.log(`\nEmbedding ${manifests.reduce((sum, m) => sum + m.tools.length, 0)} tools...`);
  console.log(`  Embedder: ${describeFingerprint(fingerprint)}`);

  let result;
  try {
    result = await compiler.compile(manifests, projectManifest);
  } catch (e) {
    if (!(e instanceof DuplicateToolError || e instanceof SelectorConflictError)) throw e;
    console.error(`\nError: ${e.message}`);
    return false;
  }

  console.log(`  Tools: ${result.toolCount} (${result.uniqueSelectorCount} selectors, none shared)`);
  if (result.duplicates.length > 0) {
    console.log(`  ${result.duplicates.length} near-duplicate tool pair(s) kept (--allow-duplicates):`);
    for (const d of result.duplicates) {
      console.log(`    ⚠ ${d.toolA} <-> ${d.toolB} (cosine: ${d.similarity.toFixed(3)})`);
    }
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

  const artifact = buildArtifact(result, manifests, fingerprint);
  const artifactPath = format === 'sqlite' && !outputPath.endsWith('.db')
    ? `${outputPath.replace(/\.json$/, '')}.db`
    : outputPath;
  await writeArtifact(artifactPath, artifact);
  console.log(`\nOutput${format === 'sqlite' ? ' (SQLite)' : ''}: ${artifactPath}`);

  console.log(`  - format ${artifact.formatVersion}, content hash ${artifact.contentHash.slice(0, 16)}…`);
  console.log(`  - ${artifact.stats.selectorCount} selectors`);
  console.log(`  - ${artifact.stats.toolCount} tools`);
  console.log(`  - ${artifact.stats.providerCount} providers`);

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
  .option('-e, --embedder <type>', 'Embedder: onnx (default) or hash (dev/test placeholder; "local" is accepted as an alias)')
  .option('--allow-duplicates', 'Keep near-duplicate tools (cosine >= 0.95) as a warning instead of a compile error')
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

      if (projectManifest.compiler?.embedder && options.embedder === undefined) {
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
    let embedderKind: BuiltinEmbedderKind;
    try {
      embedderKind = parseEmbedderKind(options.embedder);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    const allowDuplicates = options.allowDuplicates === true || projectManifest?.compiler?.allowDuplicates === true;
    const dbPath = resolve(options.dbPath);
    const format = (options.format === 'sqlite' ? 'sqlite' : 'json') as OutputFormat;

    // Resolve manifests from source + smallchat.json dependencies (each file once)
    const manifests = await collectManifests(source, projectResult, { timeoutMs });

    const ok = await runCompile(manifests, outputPath, embedderKind, dbPath, source.type, format, projectManifest, allowDuplicates);

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
        const newManifests = await collectManifests(source, projectResult, { timeoutMs });
        await runCompile(newManifests, outputPath, embedderKind, dbPath, source.type, format, projectManifest, allowDuplicates);
        console.log(`\nWatching ${watchPath} for changes...`);
      }, 200);
    });
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Manifest JSON files under `dir`, skipping node_modules and dot-directories. */
function findManifestFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isFile() && entry.endsWith('.json')) {
        files.push(fullPath);
      } else if (stat.isDirectory() && entry !== 'node_modules' && !entry.startsWith('.')) {
        files.push(...findManifestFiles(fullPath));
      }
    }
  } catch {
    // Directory might not exist
  }
  return files;
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
