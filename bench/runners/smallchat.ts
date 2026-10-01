/**
 * Smallchat runner — the system under test is the real dispatch pipeline.
 *
 * The bench catalog (tools.json) is turned into provider manifests, compiled
 * in-process by loadRuntime() — the same compiler, artifact builder and
 * runtime hydration `smallchat serve --source <manifest dir>` uses — with
 * the default embedder (ONNX all-MiniLM-L6-v2) unless one is injected. Each
 * query is answered by `runtime.resolve(query)` with learning off, so cases
 * never influence each other and the order of cases does not matter.
 *
 * The result carries the runtime's ranking (the tools it offers, best
 * first: its eligible candidates, else its refinement options) and its
 * decision: `outcome` is what the runtime would do on its own
 * ('resolved' runs `chosen`; 'needs-disambiguation' and 'unresolved' run
 * nothing). No keyword tables, provider signals or other dataset-specific
 * scoring are involved.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Embedder, JSONSchemaType, ProviderManifest, ToolDefinition } from '../../src/core/types.js';
import { createEmbedder } from '../../src/artifact/embedder.js';
import { loadRuntime } from '../../src/mcp/artifact.js';
import type { ToolRuntime, RuntimeOptions } from '../../src/runtime/runtime.js';
import type { Resolution } from '../../src/runtime/dispatch.js';
import type { BenchTool, Runner, RunnerResult } from './types.js';

export interface SmallchatRunnerOptions {
  /** Embedder to compile and resolve with (default: the compile default, ONNX) */
  embedder?: Embedder;
  /** Runtime options (thresholds, policy, LLM client); default: the runtime defaults */
  runtimeOptions?: RuntimeOptions;
}

export class SmallchatRunner implements Runner {
  name = 'smallchat';
  /** The runtime under test (set by init) */
  runtime: ToolRuntime | null = null;
  /** Number of near-duplicate tool pairs the compiler reported */
  duplicateCount = 0;

  private readonly options: SmallchatRunnerOptions;
  private readonly benchIdByToolId = new Map<string, string>();

  constructor(options: SmallchatRunnerOptions = {}) {
    this.options = options;
  }

  async init(tools: BenchTool[]): Promise<void> {
    const manifests = benchManifests(tools);
    for (const tool of tools) this.benchIdByToolId.set(canonicalIdOf(tool), tool.id);

    const embedder = this.options.embedder ?? await createEmbedder();
    const dir = mkdtempSync(join(tmpdir(), 'smallchat-bench-'));
    try {
      for (const manifest of manifests) {
        writeFileSync(join(dir, `${manifest.id}-manifest.json`), JSON.stringify(manifest));
      }
      // Same-selector tools of different providers are deliberately close;
      // they are kept distinct (never merged) and reported.
      const loaded = await loadRuntime(dir, {
        embedder,
        runtimeOptions: this.options.runtimeOptions,
        compilerOptions: { allowDuplicates: true },
      });
      this.runtime = loaded.runtime;
      this.duplicateCount = loaded.artifact.duplicates.length;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The bench id (tools.json `id`) of a canonical tool id. */
  benchIdOf(toolId: string): string {
    return this.benchIdByToolId.get(toolId) ?? toolId;
  }

  async resolve(query: string): Promise<RunnerResult> {
    if (!this.runtime) throw new Error('SmallchatRunner.init() was not called');
    const start = performance.now();
    const resolution = await this.runtime.resolve(query);
    const latencyMs = performance.now() - start;

    return {
      caseId: '',
      ranked: offeredTools(resolution).map(c => ({
        toolId: this.benchIdOf(c.toolId),
        score: c.score,
        components: { score: c.score },
      })),
      outcome: resolution.outcome,
      ...(resolution.chosen ? { chosen: this.benchIdOf(resolution.chosen) } : {}),
      tier: resolution.tier,
      proofDigest: resolution.proof.proofDigest,
      latencyMs,
    };
  }
}

/**
 * The tools the runtime offers for a query, best first: its eligible
 * candidates (at or above the LOW threshold) or, when there are none, the
 * nearest tools it lists as refinement options ("did you mean").
 */
export function offeredTools(resolution: Resolution): Array<{ toolId: string; score: number }> {
  if (resolution.candidates.length > 0) {
    return resolution.candidates.map(c => ({ toolId: c.toolId, score: c.score }));
  }
  const offered: Array<{ toolId: string; score: number }> = [];
  for (const option of resolution.refinement?.options ?? []) {
    if (option.toolId && !offered.some(o => o.toolId === option.toolId)) {
      offered.push({ toolId: option.toolId, score: option.confidence });
    }
  }
  return offered;
}

/** Canonical tool id a bench tool compiles to: `<provider>/<selector with '_' for '.'>`. */
function canonicalIdOf(tool: BenchTool): string {
  return `${tool.provider}/${toolNameOf(tool)}`;
}

function toolNameOf(tool: BenchTool): string {
  return tool.selector.replace(/\./g, '_');
}

/** One provider manifest per bench provider; tools keep their description and arguments. */
export function benchManifests(tools: BenchTool[]): ProviderManifest[] {
  const byProvider = new Map<string, ToolDefinition[]>();
  for (const tool of tools) {
    const properties: Record<string, JSONSchemaType> = {};
    const required: string[] = [];
    for (const [name, arg] of Object.entries(tool.args)) {
      properties[name] = { ...argSchema(arg.type), description: arg.description };
      if (arg.required) required.push(name);
    }
    const definitions = byProvider.get(tool.provider) ?? [];
    definitions.push({
      name: toolNameOf(tool),
      description: tool.description,
      inputSchema: { type: 'object', properties, required },
      providerId: tool.provider,
      transportType: 'local',
    });
    byProvider.set(tool.provider, definitions);
  }
  return [...byProvider].map(([id, defs]) => ({
    id,
    name: id,
    transportType: 'local',
    tools: defs,
  }));
}

function argSchema(type: string): JSONSchemaType {
  if (type.endsWith('[]')) return { type: 'array', items: argSchema(type.slice(0, -2)) };
  switch (type) {
    case 'number': return { type: 'number' };
    case 'integer': return { type: 'integer' };
    case 'boolean': return { type: 'boolean' };
    case 'object': return { type: 'object' };
    default: return { type: 'string' };
  }
}
