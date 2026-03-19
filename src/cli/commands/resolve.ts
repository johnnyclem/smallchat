import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalEmbedder } from '../../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';
import { SelectorTable } from '../../core/selector-table.js';

export const resolveCommand = new Command('resolve')
  .description('Test dispatch resolution against a compiled artifact')
  .argument('<file>', 'Path to the compiled toolkit file')
  .argument('<intent>', 'Natural language intent to resolve')
  .action(async (file, intent) => {
    const filePath = resolve(file);

    let data: ToolkitArtifact;
    try {
      const content = readFileSync(filePath, 'utf-8');
      data = JSON.parse(content) as ToolkitArtifact;
    } catch (e) {
      console.error(`Failed to read ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }

    // Rebuild the selector table and vector index from the artifact
    const embedder = new LocalEmbedder();
    const vectorIndex = new MemoryVectorIndex();
    const selectorTable = new SelectorTable(vectorIndex, embedder);

    // Load selectors from the artifact
    for (const [, sel] of Object.entries(data.selectors)) {
      const s = sel as { canonical: string; vector: number[] };
      const vector = new Float32Array(s.vector);
      selectorTable.intern(vector, s.canonical);
    }

    // Resolve the intent
    const selector = await selectorTable.resolve(intent);

    // Find nearest selectors
    const matches = vectorIndex.search(selector.vector, 5, 0.5);

    console.log(`Intent: "${intent}"`);
    console.log(`Resolved selector: ${selector.canonical}`);
    console.log('');

    if (matches.length === 0) {
      console.log('No matches found.');
      return;
    }

    console.log('Matches:');
    for (const match of matches) {
      const confidence = ((1 - match.distance) * 100).toFixed(1);
      // Look up which provider owns this selector
      let provider = 'unknown';
      for (const [providerId, table] of Object.entries(data.dispatchTables)) {
        const methods = table as Record<string, { toolName: string }>;
        if (match.id in methods) {
          provider = providerId;
          break;
        }
      }
      console.log(`  → ${match.id} (confidence: ${confidence}%, provider: ${provider})`);
    }

    // Show the best match
    const best = matches[0];
    const bestConfidence = ((1 - best.distance) * 100).toFixed(1);
    if (parseFloat(bestConfidence) > 90) {
      console.log(`\n✓ Unambiguous: ${best.id} (${bestConfidence}%)`);
    } else if (matches.length > 1) {
      console.log(`\n? Ambiguous: top match is ${best.id} (${bestConfidence}%). Disambiguation may be needed.`);
    }
  });

interface ToolkitArtifact {
  selectors: Record<string, unknown>;
  dispatchTables: Record<string, unknown>;
}
