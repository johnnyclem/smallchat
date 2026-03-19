import { Command } from 'commander';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProviderManifest } from '../../core/types.js';
import { ToolCompiler } from '../../compiler/compiler.js';
import { LocalEmbedder } from '../../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';

export const compileCommand = new Command('compile')
  .description('Compile tool definitions from MCP server manifests')
  .requiredOption('-s, --source <path>', 'Source directory containing manifest JSON files')
  .option('-o, --output <path>', 'Output file path', 'tools.toolkit.json')
  .action(async (options) => {
    const sourcePath = resolve(options.source);
    const outputPath = resolve(options.output);

    console.log(`Parsing manifests from ${sourcePath}...`);

    // Load all JSON manifests from the source directory
    const manifests: ProviderManifest[] = [];
    const files = findManifestFiles(sourcePath);

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const manifest = JSON.parse(content) as ProviderManifest;
        manifests.push(manifest);
        console.log(`  ${manifest.id ?? manifest.name}: ${manifest.tools.length} tools`);
      } catch (e) {
        console.error(`  Warning: Could not parse ${file}: ${(e as Error).message}`);
      }
    }

    if (manifests.length === 0) {
      console.error('No valid manifests found.');
      process.exit(1);
    }

    // Compile
    const embedder = new LocalEmbedder();
    const vectorIndex = new MemoryVectorIndex();
    const compiler = new ToolCompiler(embedder, vectorIndex);

    console.log(`\nEmbedding ${manifests.reduce((sum, m) => sum + m.tools.length, 0)} tools...`);
    console.log('  Model: hash-based (v0.0.1 placeholder)');

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

    // Serialize the compilation result
    const output = serializeResult(result);
    writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log(`\nOutput: ${outputPath}`);
    console.log(`  - ${result.uniqueSelectorCount} selectors`);
    console.log(`  - ${result.toolCount} tools`);
    console.log(`  - ${result.dispatchTables.size} providers`);

    // Generate header file
    const headerPath = outputPath.replace(/\.json$/, '.header.txt');
    const header = generateHeader(result);
    writeFileSync(headerPath, header);
    console.log(`\nHeader file: ${headerPath} (${header.split(/\s+/).length} tokens approx)`);
  });

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

function serializeResult(result: import('../../core/types.js').CompilationResult): object {
  const selectors: Record<string, object> = {};
  for (const [key, sel] of result.selectors) {
    selectors[key] = {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      // Vector stored as array for JSON
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
    version: '0.0.1',
    timestamp: new Date().toISOString(),
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
