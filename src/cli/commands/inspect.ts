import { Command } from 'commander';
import { resolve } from 'node:path';
import type { ArtifactV1 } from '../../artifact/types.js';
import { readArtifact } from '../../artifact/io.js';
import { describeFingerprint } from '../../artifact/embedder.js';

export const inspectCommand = new Command('inspect')
  .description('Inspect a compiled .toolkit artifact')
  .argument('<file>', 'Path to the compiled toolkit file (.json or .db)')
  .option('--selectors', 'Show all selectors')
  .option('--collisions', 'Show selector collisions and near-duplicate tools')
  .option('--providers', 'Show providers and their tools')
  .option('--embeddings', 'Show embedding model info')
  .action(async (file, options) => {
    const filePath = resolve(file);

    let data: ArtifactV1;
    try {
      data = await readArtifact(filePath);
    } catch (e) {
      console.error(`Failed to read ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }

    console.log(`ToolKit artifact: ${filePath}`);
    console.log(`Format: ${data.formatVersion}`);
    console.log(`Content hash: ${data.contentHash}`);
    console.log(`Stats:`);
    console.log(`  Tools: ${data.stats.toolCount}`);
    console.log(`  Selectors: ${data.stats.selectorCount}`);
    console.log(`  Providers: ${data.stats.providerCount}`);
    console.log(`  Collisions: ${data.stats.collisionCount}`);
    console.log(`  Near-duplicates: ${data.stats.duplicateCount}`);

    if (options.embeddings) {
      console.log('\nEmbedder:');
      console.log(`  ${describeFingerprint(data.embedder)}`);
      if (data.embedder.modelSha256) {
        console.log(`  Model SHA-256: ${data.embedder.modelSha256}`);
      }
    }

    if (options.selectors) {
      console.log('\nSelectors:');
      for (const sel of Object.values(data.selectors)) {
        console.log(`  ${sel.canonical} → ${sel.toolId}${sel.kind === 'alias' ? ' (alias)' : ''}`);
      }
    }

    if (options.providers) {
      console.log('\nProviders:');
      for (const provider of Object.values(data.providers)) {
        const tools = Object.values(data.tools).filter(t => t.providerId === provider.id);
        const launch = provider.launch
          ? provider.launch.transport === 'stdio'
            ? ` [stdio: ${provider.launch.command}]`
            : ` [${provider.launch.transport}: ${provider.launch.url}]`
          : '';
        console.log(`  ${provider.id}: ${tools.length} tools${launch}`);
        for (const tool of tools) {
          console.log(`    - ${tool.name}`);
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
      if (data.duplicates.length > 0) {
        console.log('\nNear-duplicate tools (compiled with --allow-duplicates):');
        for (const d of data.duplicates) {
          console.log(`  ⚠ ${d.toolA} ↔ ${d.toolB} (${(d.similarity * 100).toFixed(1)}%)`);
        }
      }
    }
  });
