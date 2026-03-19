import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const inspectCommand = new Command('inspect')
  .description('Inspect a compiled .toolkit artifact')
  .argument('<file>', 'Path to the compiled toolkit file')
  .option('--selectors', 'Show all selectors')
  .option('--protocols', 'Show protocol conformances')
  .option('--collisions', 'Show selector collisions')
  .option('--providers', 'Show providers and their tools')
  .action((file, options) => {
    const filePath = resolve(file);

    let data: ToolkitArtifact;
    try {
      const content = readFileSync(filePath, 'utf-8');
      data = JSON.parse(content) as ToolkitArtifact;
    } catch (e) {
      console.error(`Failed to read ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }

    console.log(`ToolKit artifact: ${filePath}`);
    console.log(`Version: ${data.version}`);
    console.log(`Compiled: ${data.timestamp}`);
    console.log(`Stats:`);
    console.log(`  Tools: ${data.stats.toolCount}`);
    console.log(`  Unique selectors: ${data.stats.uniqueSelectorCount}`);
    console.log(`  Merged: ${data.stats.mergedCount}`);
    console.log(`  Providers: ${data.stats.providerCount}`);
    console.log(`  Collisions: ${data.stats.collisionCount}`);

    if (options.selectors) {
      console.log('\nSelectors:');
      for (const [key, sel] of Object.entries(data.selectors)) {
        const s = sel as { canonical: string; parts: string[]; arity: number };
        console.log(`  ${s.canonical} (arity: ${s.arity})`);
      }
    }

    if (options.providers) {
      console.log('\nProviders:');
      for (const [providerId, table] of Object.entries(data.dispatchTables)) {
        const methods = Object.values(table as Record<string, { toolName: string }>);
        console.log(`  ${providerId}: ${methods.length} tools`);
        for (const method of methods) {
          console.log(`    - ${method.toolName}`);
        }
      }
    }

    if (options.collisions) {
      console.log('\nCollisions:');
      if (data.collisions.length === 0) {
        console.log('  None');
      } else {
        for (const c of data.collisions) {
          console.log(`  ⚠ ${c.selectorA} ↔ ${c.selectorB} (${(c.similarity * 100).toFixed(1)}%)`);
          console.log(`    ${c.hint}`);
        }
      }
    }
  });

interface ToolkitArtifact {
  version: string;
  timestamp: string;
  stats: {
    toolCount: number;
    uniqueSelectorCount: number;
    mergedCount: number;
    providerCount: number;
    collisionCount: number;
  };
  selectors: Record<string, unknown>;
  dispatchTables: Record<string, unknown>;
  collisions: Array<{
    selectorA: string;
    selectorB: string;
    similarity: number;
    hint: string;
  }>;
}
