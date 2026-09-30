import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactV1 } from '../../artifact/types.js';
import { readArtifact } from '../../artifact/io.js';
import { describeFingerprint } from '../../artifact/embedder.js';

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
  .action(async (file, options) => {
    const filePath = resolve(file);
    const outputPath = resolve(options.output);

    let data: ArtifactV1;
    try {
      data = await readArtifact(filePath);
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

function generateMarkdown(data: ArtifactV1, sourcePath: string): string {
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
  lines.push(`| Selectors | ${data.stats.selectorCount} |`);
  lines.push(`| Providers | ${data.stats.providerCount} |`);
  lines.push(`| Collisions | ${data.stats.collisionCount} |`);
  lines.push(`| Embedder | ${describeFingerprint(data.embedder)} |`);
  lines.push(`| Content hash | \`${data.contentHash}\` |`);
  lines.push('');

  // Tools by provider
  lines.push('## Tools by Provider');
  lines.push('');

  for (const provider of Object.values(data.providers)) {
    const tools = Object.values(data.tools).filter(t => t.providerId === provider.id);

    lines.push(`### ${provider.id} (${tools.length} tools)`);
    lines.push('');

    for (const tool of tools) {
      lines.push(`#### \`${tool.name}\``);
      lines.push('');
      if (tool.description) {
        lines.push(tool.description);
        lines.push('');
      }
      lines.push(`- **Tool id**: \`${tool.id}\``);
      lines.push(`- **Selector**: \`${tool.selector}\``);
      lines.push(`- **Transport**: \`${tool.transportType}\``);

      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
      const required = new Set((tool.inputSchema.required ?? []) as string[]);
      const names = Object.keys(properties);
      if (names.length > 0) {
        lines.push('- **Arguments**:');
        for (const name of names) {
          const prop = properties[name];
          const req = required.has(name) ? ', required' : '';
          const desc = prop.description ? ` — ${prop.description}` : '';
          lines.push(`  - \`${name}\` (${prop.type ?? 'any'}${req})${desc}`);
        }
      }

      lines.push('');
    }
  }

  // Selectors reference
  lines.push('## Selector Reference');
  lines.push('');
  lines.push('| Selector | Tool | Kind |');
  lines.push('|----------|------|------|');

  for (const sel of Object.values(data.selectors)) {
    lines.push(`| \`${sel.canonical}\` | \`${sel.toolId}\` | ${sel.kind} |`);
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
