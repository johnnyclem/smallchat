import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Auto-docs generation command.
 *
 * Reads a compiled .toolkit.json artifact and generates a Markdown file
 * listing all available tools and their schemas.
 */
export const docsCommand = new Command('docs')
  .description('Generate a Markdown file listing all available tools and their schemas')
  .argument('<file>', 'Path to the compiled toolkit file')
  .option('-o, --output <path>', 'Output Markdown file path', 'TOOLS.md')
  .action((file, options) => {
    const filePath = resolve(file);
    const outputPath = resolve(options.output);

    let data: ToolkitArtifact;
    try {
      const content = readFileSync(filePath, 'utf-8');
      data = JSON.parse(content) as ToolkitArtifact;
    } catch (e) {
      console.error(`Failed to read ${filePath}: ${(e as Error).message}`);
      console.error('');
      console.error('Hint: Run "smallchat compile" first to generate a toolkit artifact.');
      process.exit(1);
    }

    const markdown = generateMarkdown(data, filePath);
    writeFileSync(outputPath, markdown);
    console.log(`Documentation generated: ${outputPath}`);
    console.log(`  ${data.stats.toolCount} tools across ${data.stats.providerCount} providers`);
  });

function generateMarkdown(data: ToolkitArtifact, sourcePath: string): string {
  const lines: string[] = [];

  lines.push('# Tool Reference');
  lines.push('');
  lines.push(`> Auto-generated from \`${sourcePath.split('/').pop()}\` on ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Stats summary
  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total tools | ${data.stats.toolCount} |`);
  lines.push(`| Unique selectors | ${data.stats.uniqueSelectorCount} |`);
  lines.push(`| Providers | ${data.stats.providerCount} |`);
  lines.push(`| Collisions | ${data.stats.collisionCount} |`);
  if (data.embedding) {
    lines.push(`| Embedding model | ${data.embedding.model} |`);
    lines.push(`| Dimensions | ${data.embedding.dimensions} |`);
  }
  lines.push('');

  // Tools by provider
  lines.push('## Tools by Provider');
  lines.push('');

  for (const [providerId, table] of Object.entries(data.dispatchTables)) {
    const methods = table as Record<string, ToolEntry>;
    const toolCount = Object.keys(methods).length;

    lines.push(`### ${providerId} (${toolCount} tools)`);
    lines.push('');

    for (const [selector, tool] of Object.entries(methods)) {
      lines.push(`#### \`${tool.toolName}\``);
      lines.push('');
      lines.push(`- **Selector**: \`${selector}\``);
      lines.push(`- **Transport**: \`${tool.transportType}\``);

      // Look up the selector for schema info
      const selectorData = data.selectors[selector] as SelectorEntry | undefined;
      if (selectorData) {
        lines.push(`- **Arity**: ${selectorData.arity}`);
      }

      lines.push('');
    }
  }

  // Selectors reference
  lines.push('## Selector Reference');
  lines.push('');
  lines.push('| Selector | Arity | Parts |');
  lines.push('|----------|-------|-------|');

  for (const [, sel] of Object.entries(data.selectors)) {
    const s = sel as SelectorEntry;
    lines.push(`| \`${s.canonical}\` | ${s.arity} | ${s.parts.join(', ')} |`);
  }
  lines.push('');

  // Collisions
  if (data.collisions.length > 0) {
    lines.push('## Selector Collisions');
    lines.push('');
    lines.push('These selectors have high similarity and may cause ambiguous dispatch:');
    lines.push('');
    for (const collision of data.collisions) {
      lines.push(`- **${collision.selectorA}** vs **${collision.selectorB}** — similarity: ${(collision.similarity * 100).toFixed(1)}%`);
      lines.push(`  - ${collision.hint}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

interface ToolEntry {
  providerId: string;
  toolName: string;
  transportType: string;
}

interface SelectorEntry {
  canonical: string;
  parts: string[];
  arity: number;
}

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
  embedding?: {
    model: string;
    dimensions: number;
    embedderType: string;
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
