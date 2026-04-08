/**
 * Memex CLI Command — compile, ingest, query, lint, and inspect knowledge bases.
 *
 * Usage:
 *   smallchat memex compile --schema tolkien.schema.json
 *   smallchat memex ingest  --source new-paper.md
 *   smallchat memex query   "What is the relationship between X and Y?"
 *   smallchat memex lint
 *   smallchat memex inspect --page numenor
 *   smallchat memex export  --format markdown --output ./wiki/
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { compile } from '../../memex/knowledge-compiler.js';
import { resolveQuery } from '../../memex/resolver.js';
import { lint, listLintRules } from '../../memex/lint.js';
import {
  loadMemexConfig,
  loadKnowledgeSchema,
  DEFAULT_KNOWLEDGE_SCHEMA,
  saveKnowledgeSchema,
} from '../../memex/config.js';
import {
  deserializeKnowledgeBase,
  serializeKnowledgeBase,
} from '../../memex/knowledge-compiler.js';
import { renderIndexMarkdown, renderLogMarkdown } from '../../memex/wiki-emitter.js';
import type { MemexConfig, KnowledgeBase, KnowledgeSchema } from '../../memex/types.js';
import type { Embedder, VectorIndex } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Embedder/VectorIndex factory (shared with compile command)
// ---------------------------------------------------------------------------

async function createEmbedder(type: string): Promise<Embedder> {
  if (type === 'local') {
    const { LocalEmbedder } = await import('../../embedding/local-embedder.js');
    return new LocalEmbedder();
  }
  const { ONNXEmbedder } = await import('../../embedding/onnx-embedder.js');
  return new ONNXEmbedder();
}

function createVectorIndex(embedderType: string, dbPath?: string): VectorIndex {
  if (dbPath) {
    const { SqliteVectorIndex } = require('../../embedding/sqlite-vector-index.js');
    return new SqliteVectorIndex(dbPath);
  }
  const { MemoryVectorIndex } = require('../../embedding/memory-vector-index.js');
  return new MemoryVectorIndex();
}

function loadArtifact(artifactPath: string): KnowledgeBase {
  if (!existsSync(artifactPath)) {
    throw new Error(`Knowledge base artifact not found: ${artifactPath}`);
  }
  const raw = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  return deserializeKnowledgeBase(raw);
}

// ---------------------------------------------------------------------------
// Main memex command with subcommands
// ---------------------------------------------------------------------------

export const memexCommand = new Command('memex')
  .description('Knowledge base compiler — compile, query, and maintain knowledge wikis');

// ---------------------------------------------------------------------------
// memex compile
// ---------------------------------------------------------------------------

memexCommand
  .command('compile')
  .description('Compile knowledge sources into a knowledge base artifact')
  .option('-s, --schema <path>', 'Path to knowledge schema file', 'memex.schema.json')
  .option('--sources <paths...>', 'Additional source file paths')
  .option('-o, --output <path>', 'Output artifact path')
  .option('-e, --embedder <type>', 'Embedder: onnx (default) or local', 'onnx')
  .option('--db-path <path>', 'SQLite database path (enables sqlite format)')
  .option('--dry-run', 'Analyze without writing artifact')
  .option('--markdown <dir>', 'Also export wiki as markdown files')
  .option('--init', 'Initialize a new knowledge schema in the current directory')
  .action(async (options) => {
    // --- Init mode ---
    if (options.init) {
      const schemaPath = resolve(options.schema);
      if (existsSync(schemaPath)) {
        console.error(`Schema already exists: ${schemaPath}`);
        process.exit(1);
      }
      saveKnowledgeSchema(DEFAULT_KNOWLEDGE_SCHEMA, schemaPath);
      console.log(`Created knowledge schema: ${schemaPath}`);
      console.log('Edit the schema to configure your domain, entity types, and source paths.');
      return;
    }

    // --- Compile mode ---
    const schemaPath = resolve(options.schema);
    let schema: KnowledgeSchema;
    try {
      schema = loadKnowledgeSchema(schemaPath);
    } catch (err: any) {
      console.error(err.message);
      console.log('\nTo create a new schema, run: smallchat memex compile --init');
      process.exit(1);
      return; // unreachable, helps TS narrow
    }

    // Apply CLI overrides
    if (options.markdown) {
      schema.output = { ...schema.output, markdownDir: options.markdown };
    }

    console.log(`Compiling knowledge base: ${schema.name} (${schema.domain})`);
    console.log(`Schema: ${schemaPath}`);

    const embedder = await createEmbedder(options.embedder);
    const vectorIndex = createVectorIndex(options.embedder, options.dbPath);

    const result = await compile({
      schema,
      embedder,
      vectorIndex,
      additionalSources: options.sources ?? [],
      dryRun: options.dryRun ?? false,
      outputPath: options.output,
    });

    console.log('');
    console.log(result.report);

    if (result.artifactPath) {
      console.log(`Artifact written to: ${result.artifactPath}`);
    }

    if (result.warnings.length > 0 && !result.report.includes('Warnings:')) {
      console.log('\nWarnings:');
      for (const w of result.warnings) {
        console.log(`  - ${w}`);
      }
    }
  });

// ---------------------------------------------------------------------------
// memex query
// ---------------------------------------------------------------------------

memexCommand
  .command('query <question>')
  .description('Query the knowledge base with a natural language question')
  .option('-a, --artifact <path>', 'Knowledge base artifact path', 'knowledge.memex.json')
  .option('-e, --embedder <type>', 'Embedder: onnx (default) or local', 'onnx')
  .option('-k, --top-k <n>', 'Number of top matches', '5')
  .action(async (question, options) => {
    const kb = loadArtifact(resolve(options.artifact));
    const embedder = await createEmbedder(options.embedder);
    const vectorIndex = createVectorIndex(options.embedder);

    // Re-populate vector index from stored selectors
    for (const [id, sel] of kb.claimSelectors) {
      vectorIndex.insert(id, sel.vector);
    }

    const result = await resolveQuery(question, kb, embedder, vectorIndex, {
      topK: parseInt(options.topK, 10),
    });

    console.log(`Query: "${question}"`);
    console.log(`Tier:  ${result.tier}`);
    console.log('');

    if (result.page) {
      console.log(`Page:  ${result.page.title} (${result.page.slug})`);
      console.log('');
    }

    if (result.matchedClaims.length > 0) {
      console.log('Matched Claims:');
      for (const { claim, score } of result.matchedClaims.slice(0, 5)) {
        console.log(`  [${(score * 100).toFixed(1)}%] ${claim.text.slice(0, 100)}${claim.text.length > 100 ? '...' : ''}`);
      }
      console.log('');
    }

    if (result.synthesis) {
      console.log('Synthesis:');
      console.log(result.synthesis);
      console.log('');
    }

    if (result.subQueries && result.subQueries.length > 0) {
      console.log('Try these sub-queries:');
      for (const sq of result.subQueries) {
        console.log(`  - ${sq}`);
      }
      console.log('');
    }

    if (result.relatedPages.length > 0) {
      console.log('Related Pages:');
      for (const { page, relevance } of result.relatedPages) {
        console.log(`  [${(relevance * 100).toFixed(0)}%] ${page.title}`);
      }
    }
  });

// ---------------------------------------------------------------------------
// memex lint
// ---------------------------------------------------------------------------

memexCommand
  .command('lint')
  .description('Run health checks on the knowledge base')
  .option('-a, --artifact <path>', 'Knowledge base artifact path', 'knowledge.memex.json')
  .option('--list-rules', 'List available lint rules')
  .option('--disable <rules...>', 'Disable specific lint rules')
  .action(async (options) => {
    if (options.listRules) {
      console.log('Available lint rules:\n');
      for (const rule of listLintRules()) {
        console.log(`  ${rule.name}`);
        console.log(`    ${rule.description}\n`);
      }
      return;
    }

    const kb = loadArtifact(resolve(options.artifact));
    const report = lint(kb, { disabled: options.disable });

    console.log(report.summary);
    console.log('');

    if (report.findings.length > 0) {
      for (const finding of report.findings) {
        const icon = finding.severity === 'error' ? 'x' : finding.severity === 'warning' ? '!' : 'i';
        console.log(`  [${icon}] (${finding.rule}) ${finding.message}`);
        if (finding.suggestion) {
          console.log(`      Fix: ${finding.suggestion}`);
        }
      }
      console.log('');
    }

    if (!report.passed) {
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// memex inspect
// ---------------------------------------------------------------------------

memexCommand
  .command('inspect')
  .description('Inspect the knowledge base — view pages, entities, or stats')
  .option('-a, --artifact <path>', 'Knowledge base artifact path', 'knowledge.memex.json')
  .option('--page <slug>', 'View a specific wiki page')
  .option('--entity <id>', 'View a specific entity')
  .option('--stats', 'Show compilation statistics')
  .option('--index', 'Show the wiki index')
  .option('--log', 'Show the ingestion log')
  .action(async (options) => {
    const kb = loadArtifact(resolve(options.artifact));

    if (options.page) {
      const page = kb.pages.get(options.page);
      if (!page) {
        console.error(`Page not found: ${options.page}`);
        console.log('Available pages:');
        for (const slug of kb.pages.keys()) {
          console.log(`  ${slug}`);
        }
        process.exit(1);
        return; // unreachable, helps TS narrow
      }
      console.log(page.content);
      return;
    }

    if (options.entity) {
      const entity = kb.entities.get(options.entity);
      if (!entity) {
        console.error(`Entity not found: ${options.entity}`);
        process.exit(1);
        return; // unreachable, helps TS narrow
      }
      console.log(`Name:      ${entity.name}`);
      console.log(`Type:      ${entity.type}`);
      console.log(`Claims:    ${entity.claimCount}`);
      console.log(`Sources:   ${entity.sourceIds.join(', ')}`);
      if (entity.properties) {
        console.log('Properties:');
        for (const [k, v] of Object.entries(entity.properties)) {
          console.log(`  ${k}: ${v}`);
        }
      }
      return;
    }

    if (options.index) {
      const indexMd = renderIndexMarkdown(kb.index, kb.pages);
      console.log(indexMd);
      return;
    }

    if (options.log) {
      const logMd = renderLogMarkdown(kb.log);
      console.log(logMd);
      return;
    }

    // Default: show stats
    console.log(`Knowledge Base: ${kb.schema.name} (${kb.schema.domain})`);
    console.log(`Version:        ${kb.version}`);
    console.log(`Compiled:       ${kb.compiledAt}`);
    console.log('');
    console.log(`Sources:        ${kb.sourceCount}`);
    console.log(`Claims:         ${kb.claimCount}`);
    console.log(`Deduplicated:   ${kb.mergedClaimCount}`);
    console.log(`Entities:       ${kb.entityCount}`);
    console.log(`Pages:          ${kb.pageCount}`);
    console.log(`Contradictions: ${kb.contradictions.length}`);
    console.log('');

    // Top entities
    const topEntities = Array.from(kb.entities.values())
      .sort((a, b) => b.claimCount - a.claimCount)
      .slice(0, 10);

    if (topEntities.length > 0) {
      console.log('Top Entities:');
      for (const e of topEntities) {
        console.log(`  ${e.name} (${e.type}) — ${e.claimCount} claims`);
      }
      console.log('');
    }

    // Page list
    console.log('Pages:');
    for (const [slug, page] of kb.pages) {
      console.log(`  ${slug} — ${page.title} (${page.claimIds.length} claims)`);
    }
  });

// ---------------------------------------------------------------------------
// memex export
// ---------------------------------------------------------------------------

memexCommand
  .command('export')
  .description('Export the knowledge base as markdown files')
  .option('-a, --artifact <path>', 'Knowledge base artifact path', 'knowledge.memex.json')
  .option('-o, --output <dir>', 'Output directory for markdown files', './wiki')
  .action(async (options) => {
    const kb = loadArtifact(resolve(options.artifact));
    const outDir = resolve(options.output);

    mkdirSync(outDir, { recursive: true });

    // Write each page
    let count = 0;
    for (const [slug, page] of kb.pages) {
      const filePath = resolve(outDir, `${slug}.md`);
      writeFileSync(filePath, page.content + '\n');
      count++;
    }

    // Write index
    const indexContent = renderIndexMarkdown(kb.index, kb.pages);
    writeFileSync(resolve(outDir, 'index.md'), indexContent + '\n');

    // Write log
    const logContent = renderLogMarkdown(kb.log);
    writeFileSync(resolve(outDir, 'log.md'), logContent + '\n');

    console.log(`Exported ${count} pages + index + log to: ${outDir}`);
  });
