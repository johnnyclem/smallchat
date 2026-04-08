# Memex — Knowledge Base Compiler for Smallchat

> *"The human should curate sources and ask good questions; the LLM handles everything else."*
> — Andrej Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Motivation

Karpathy's core thesis: stop re-deriving knowledge on every query (RAG). Instead, **compile** sources once into a persistent, LLM-maintained wiki, then keep it current incrementally. He calls this the "LLM Wiki" pattern — three layers (Raw Sources → Wiki → Schema), with operations for Ingest, Query, and Lint.

The insight behind this module is that **knowledge compilation is structurally the same problem as tool compilation**, just with different input/output types. Smallchat already compiles tool manifests into semantic dispatch artifacts. Memex extends that same pipeline to compile document sources into semantic knowledge artifacts.

## How It Maps to Smallchat

| Karpathy's LLM Wiki | Smallchat Today | Memex Extension |
|---|---|---|
| Raw Sources (docs, papers) | Tool Manifests (MCP/OpenAPI) | `KnowledgeSource` (markdown, HTML, CSV, JSONL, transcripts) |
| Compilation (extract → structure → cross-ref) | Parse → Embed → Link | Read → Extract → Embed → Link → Emit |
| The Wiki (markdown pages) | Dispatch Artifact (selector table) | `WikiPage` map with cross-references |
| The Schema (CLAUDE.md-like config) | `SmallChatManifest` | `KnowledgeSchema` |
| Ingest (incremental update) | Dream (memory-driven recompile) | `ingest()` with content-hash change detection |
| Query (ask questions) | Resolve (intent → tool) | `resolveQuery()` with confidence tiers |
| Lint (contradictions, staleness) | Doctor (health checks) | 6 lint rules |
| Cross-references | Superclass chains | Entity-relationship graph + inbound/outbound links |

Existing infrastructure reused directly:
- **`Embedder` + `VectorIndex`** — ONNX/local embeddings and sqlite-vec indexes
- **Confidence tiers** — EXACT/HIGH/MEDIUM/LOW/NONE, same as tool dispatch
- **Cosine similarity** — for claim deduplication and contradiction detection
- **Module patterns** — types.ts, config.ts, CLI command structure, Vitest tests

## Module Structure

```
src/memex/
├── types.ts                 30+ type definitions
├── config.ts                MemexConfig + KnowledgeSchema load/save
├── source-reader.ts         Multi-format source discovery and parsing
├── claim-extractor.ts       Sentence splitting, entity recognition, relationship extraction
├── knowledge-compiler.ts    Main pipeline + incremental ingestion + serialization
├── wiki-emitter.ts          Wiki page generation with cross-references
├── resolver.ts              Confidence-tiered query resolution
├── lint.ts                  6 health check rules
├── index.ts                 Module exports
├── config.test.ts           9 tests
├── source-reader.test.ts    18 tests
├── claim-extractor.test.ts  18 tests
├── knowledge-compiler.test.ts  9 tests
├── wiki-emitter.test.ts     9 tests
├── resolver.test.ts         6 tests
└── lint.test.ts             10 tests

src/cli/commands/memex.ts    CLI with compile/query/lint/inspect/export subcommands
```

**Total: 19 files, ~5,100 lines, 88 tests passing.**

## Compilation Pipeline

```
┌─────────────────────────────────────────────────────┐
│  INPUT: Source Documents (markdown, HTML, CSV, ...)  │
└────────────────────┬────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │  Phase 1: READ      │
          │  discoverSources()  │
          │  readSources()      │
          │  → SourceContent[]  │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Phase 2: EXTRACT   │
          │  splitSentences()   │
          │  extractClaims()    │
          │  extractEntities()  │
          │  extractRelations() │
          │  → KnowledgeIR[]    │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Phase 3: EMBED     │
          │  embedBatch()       │
          │  vectorIndex.insert │
          │  → ClaimSelector[]  │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Phase 4: LINK      │
          │  deduplicateClaims  │
          │  detectContradicts  │
          │  → filtered claims  │
          │  → Contradiction[]  │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Phase 5: EMIT      │
          │  emitWikiPages()    │
          │  emitWikiIndex()    │
          │  → WikiPage map     │
          │  → WikiIndex        │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  OUTPUT:            │
          │  KnowledgeBase      │
          │  (JSON or SQLite)   │
          └─────────────────────┘
```

## CLI Usage

```bash
# Initialize a schema for a new knowledge domain
smallchat memex compile --init

# Compile sources into a knowledge base
smallchat memex compile --schema tolkien.schema.json

# Query the knowledge base
smallchat memex query "What is the relationship between Gondor and Mordor?"

# Run health checks
smallchat memex lint

# Inspect a page or view stats
smallchat memex inspect --page gondor
smallchat memex inspect --stats

# Export as markdown files
smallchat memex export --output ./wiki/
```

## Knowledge Schema Example

```json
{
  "name": "tolkien-kb",
  "domain": "tolkien-lore",
  "entityTypes": ["character", "place", "event", "artifact", "language"],
  "sources": ["./sources/**/*.md", "./sources/**/*.txt"],
  "compiler": {
    "embedder": "onnx",
    "deduplicationThreshold": 0.92,
    "contradictionThreshold": 0.85,
    "minConfidence": 0.5,
    "maxClaimsPerPage": 50
  },
  "output": {
    "path": "tolkien.memex.json",
    "markdownDir": "./wiki"
  }
}
```

## Query Resolution: Confidence Tiers

The resolver uses the same tiered dispatch model as the tool runtime:

| Tier | Score | Behavior |
|---|---|---|
| **EXACT** | ≥ 0.95 | Direct entity/page match by name → return page |
| **HIGH** | ≥ 0.85 | Strong claim match → return page + highlight claims |
| **MEDIUM** | ≥ 0.70 | Moderate match → synthesize from multiple pages |
| **LOW** | ≥ 0.50 | Weak match → decompose into sub-queries |
| **NONE** | < 0.50 | No match → suggest related pages |

## Lint Rules

| Rule | Severity | What it checks |
|---|---|---|
| `contradictions` | error/warning | Claims that contradict across sources |
| `orphan-pages` | info | Pages with no inbound links |
| `stale-sources` | warning | Sources not re-ingested within threshold |
| `coverage-gaps` | info | Entities with very few backing claims |
| `missing-cross-refs` | info | Claims mentioning entities without linking to their pages |
| `empty-pages` | warning | Pages with zero claims |

## Design Decisions

1. **No LLM in the hot path.** Extraction uses heuristic NLP (sentence splitting, capitalization patterns, relationship regex). This keeps compilation fast and deterministic. LLM-assisted extraction can be layered on top via the schema's `extractionHints` field.

2. **Incremental ingestion.** The `ingest()` function adds or updates a single source without full recompilation. Content hashing (`SHA-256`) detects changes — unchanged sources are skipped.

3. **CRDT-ready types.** `ExtractedEntity` maps to the CRDT module's `L3Entity`, `WikiPage` summaries map to `L2Summary`, and core facts map to `L4` invariants. Multi-agent wiki building is a future extension that falls naturally out of existing infrastructure.

4. **Serialization round-trips.** `serializeKnowledgeBase` / `deserializeKnowledgeBase` handle `Float32Array` vectors, `Map` structures, and all nested types. The artifact format is JSON (with optional SQLite).

5. **Convention-matching.** The module follows the exact patterns established by the Dream module: types.ts for all interfaces, config.ts with load/save/defaults, a main pipeline function, a CLI command with subcommands, and Vitest tests using temp directories.

## Future Directions

- **LLM-assisted extraction** — Use the `LLMClient` interface (Pillar 2's micro-check) for higher-quality claim extraction and entity typing
- **CRDT backing store** — Replace the in-memory `Map<string, WikiPage>` with `AgentMemory` for distributed multi-agent wiki building
- **Watch mode** — File system watcher that triggers `ingest()` on source changes
- **Compaction integration** — Use the compaction module's `extractEntities` and `extractDecisions` for richer claim extraction
- **Importance scoring** — Use the importance detector's three-signal system to rank claims and prioritize wiki page content
- **Dream integration** — Memory-driven re-compilation that learns which entities and topics matter most from query logs
