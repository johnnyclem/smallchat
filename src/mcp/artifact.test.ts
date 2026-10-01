/**
 * Feature: Artifact loading
 *
 * loadRuntime() is the one path from a compiled artifact (or a manifest
 * directory) to a dispatch-ready ToolRuntime. It must use the embedder the
 * artifact was compiled with, refuse artifacts it cannot load faithfully,
 * and only resolve once every tool class is registered.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntime, findManifests, buildToolList } from './artifact.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { ONNXEmbedder } from '../embedding/onnx-embedder.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { SelectorNamespace, SelectorShadowingError } from '../core/selector-namespace.js';
import { buildArtifact, serializeArtifact } from '../artifact/format.js';
import { writeArtifact } from '../artifact/io.js';
import { EmbedderMismatchError, ArtifactVersionError } from '../artifact/types.js';
import { DEFAULT_EMBEDDER_KIND } from '../artifact/embedder.js';
import type { Embedder, ProviderManifest } from '../core/types.js';
import type { ToolRuntime } from '../runtime/runtime.js';

const manifests: ProviderManifest[] = [
  {
    id: 'github',
    name: 'GitHub',
    transportType: 'mcp',
    tools: [
      {
        name: 'search_code',
        description: 'Search for code across repositories',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        providerId: 'github',
        transportType: 'mcp',
      },
      {
        name: 'create_issue',
        title: 'Create issue',
        description: 'Open a new GitHub issue',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, repo: { type: 'string' } } },
        outputSchema: { type: 'object', properties: { number: { type: 'integer' } } },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
        providerId: 'github',
        transportType: 'mcp',
      },
    ],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    transportType: 'mcp',
    tools: [
      {
        name: 'create_issue',
        description: 'File a ticket in a GitLab project tracker',
        inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } },
        providerId: 'gitlab',
        transportType: 'mcp',
      },
    ],
  },
];

/** Resolve an intent without executing anything: the best-ranked tool id. */
async function bestToolFor(runtime: ToolRuntime, intent: string): Promise<string | undefined> {
  const resolution = await runtime.resolve(intent);
  return resolution.candidates[0]?.toolId;
}

describe('Feature: Artifact loading', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'smallchat-artifact-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  async function compileTo(path: string, embedder: Embedder): Promise<void> {
    const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
    await writeArtifact(path, buildArtifact(result, manifests, embedder.fingerprint!));
  }

  describe('Scenario: embedder identity (SC-INF-01, SC-SURF-06)', () => {
    it('Given an ONNX-compiled artifact, When loadRuntime is called, Then exact tool names resolve with the ONNX embedder', async () => {
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      await compileTo(path, new ONNXEmbedder());

      const { runtime, embedder, artifact } = await loadRuntime(path);

      expect(artifact.embedder.kind).toBe('onnx');
      expect(embedder.fingerprint).toEqual(artifact.embedder);
      expect(await bestToolFor(runtime, 'search_code')).toBe('github/search_code');
    }, 60_000);

    it('Given an ONNX-compiled artifact, When a hash embedder is injected, Then loading is refused with EmbedderMismatchError', async () => {
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      await compileTo(path, new ONNXEmbedder());

      await expect(loadRuntime(path, { embedder: new HashEmbedder() })).rejects.toThrow(EmbedderMismatchError);
      await expect(loadRuntime(path, { embedder: new HashEmbedder() })).rejects.toThrow(/compiled with onnx all-MiniLM-L6-v2/);
    }, 60_000);

    it('Given an artifact from a custom embedder, When no embedder is injected, Then loading is refused', async () => {
      const inner = new HashEmbedder(64);
      const custom: Embedder = {
        dimensions: 64,
        fingerprint: { kind: 'custom', model: 'acme-embed', modelSha256: null, dims: 64, maxLength: null, pooling: 'none', normalize: true },
        embed: (text: string) => inner.embed(text),
        embedBatch: (texts: string[]) => inner.embedBatch(texts),
      };
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      await compileTo(path, custom);

      await expect(loadRuntime(path)).rejects.toThrow(/custom embedder/);
      const { artifact } = await loadRuntime(path, { embedder: custom });
      expect(artifact.embedder.model).toBe('acme-embed');
    });

    it('Given a manifest directory, When loadRuntime compiles it, Then it uses the same default embedder as smallchat compile', async () => {
      const dir = makeTmpDir();
      writeFileSync(join(dir, 'github.json'), JSON.stringify(manifests[0]));

      const { artifact } = await loadRuntime(dir);

      expect(DEFAULT_EMBEDDER_KIND).toBe('onnx');
      expect(artifact.embedder.kind).toBe(DEFAULT_EMBEDDER_KIND);
    }, 60_000);
  });

  describe('Scenario: hydration completes before loadRuntime resolves (SC-INF-18, SC-SURF-28)', () => {
    it('Given a compiled artifact, When loadRuntime resolves, Then every provider class is already registered', async () => {
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      await compileTo(path, new HashEmbedder());

      const { runtime } = await loadRuntime(path);

      expect(runtime.context.getClasses().map(c => c.name).sort()).toEqual(['github', 'gitlab']);
    });

    it('Given an artifact that shadows a protected core selector, When loadRuntime is called, Then it rejects instead of raising an unhandled rejection', async () => {
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      await compileTo(path, new HashEmbedder());
      const selectorNamespace = new SelectorNamespace();
      selectorNamespace.registerCoreSelectors('core', [{ canonical: 'github.search_code', swizzlable: false }]);

      await expect(loadRuntime(path, { runtimeOptions: { selectorNamespace } })).rejects.toThrow(SelectorShadowingError);
    });
  });

  describe('Scenario: only 1.0 artifacts load (SC-INF-19)', () => {
    it('Given a pre-1.0 artifact file, When loadRuntime is called, Then it refuses and asks for a recompile', async () => {
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      writeFileSync(path, JSON.stringify({
        version: '0.5.0',
        stats: { toolCount: 0, uniqueSelectorCount: 0, providerCount: 0, collisionCount: 0 },
        selectors: {},
        dispatchTables: {},
      }));

      await expect(loadRuntime(path)).rejects.toThrow(ArtifactVersionError);
      await expect(loadRuntime(path)).rejects.toThrow(/recompile with smallchat 1\.0/);
    });

    it('Given a SQLite artifact, When loadRuntime is called, Then it loads the same artifact and resolves tools', async () => {
      const dir = makeTmpDir();
      await compileTo(join(dir, 'tools.toolkit.json'), new HashEmbedder());
      await compileTo(join(dir, 'tools.toolkit.db'), new HashEmbedder());

      const fromJson = await loadRuntime(join(dir, 'tools.toolkit.json'));
      const fromDb = await loadRuntime(join(dir, 'tools.toolkit.db'));

      expect(fromDb.artifact.contentHash).toBe(fromJson.artifact.contentHash);
      expect(fromDb.runtime.context.getClasses()).toHaveLength(2);
      // The exact embedding text of a tool resolves on the sqlite-vec index
      // (paraphrase scoring there depends on its distance metric, SC-INF-02).
      expect(await bestToolFor(fromDb.runtime, 'search_code: Search for code across repositories')).toBe('github/search_code');
    });
  });

  describe('Scenario: tools/list carries upstream definitions (SC-SURF-07, artifact side)', () => {
    it('Given two providers with a same-named tool, When the tool list is built, Then each keeps its own description and schema', async () => {
      const path = join(makeTmpDir(), 'tools.toolkit.json');
      await compileTo(path, new HashEmbedder());
      const { artifact } = await loadRuntime(path);

      const tools = buildToolList(artifact) as Array<Record<string, unknown> & { inputSchema: { properties: object } }>;
      const github = tools.find(t => t.description === 'Open a new GitHub issue')!;
      const gitlab = tools.find(t => t.description === 'File a ticket in a GitLab project tracker')!;

      // Serve side (SC-SURF-07): provider-qualified, collision-free names.
      expect(github.name).toBe('github__create_issue');
      expect(gitlab.name).toBe('gitlab__create_issue');
      expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
      expect(buildToolList(artifact, { provider: 'gitlab' }).map(t => t.name)).toContain('create_issue');

      expect(Object.keys(github.inputSchema.properties)).toEqual(['title', 'repo']);
      expect(Object.keys(gitlab.inputSchema.properties)).toEqual(['projectId']);
      expect(github.title).toBe('Create issue');
      expect(github.outputSchema).toEqual({ type: 'object', properties: { number: { type: 'integer' } } });
      expect(github.annotations).toEqual({ destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(artifact.tools['github/create_issue'].inputSchema).not.toEqual(artifact.tools['gitlab/create_issue'].inputSchema);
    });
  });

  describe('Scenario: findManifests skips prototype-pollution payloads', () => {
    it('Given a directory with a valid manifest and a __proto__-polluted one, When findManifests is called, Then only the valid manifest is returned and Object.prototype stays clean', () => {
      const dir = makeTmpDir();
      writeFileSync(
        join(dir, 'good.json'),
        JSON.stringify({ id: 'good', name: 'Good', tools: [], transportType: 'local' }),
      );
      // A raw JSON.parse would happily produce an object with an own
      // "__proto__" key; safeJsonParse's default 'throw' mode rejects it,
      // and findManifests' try/catch turns that into a silent skip.
      writeFileSync(join(dir, 'evil.json'), '{"__proto__": {"polluted": true}}');

      const manifests = findManifests(dir);

      expect(manifests).toHaveLength(1);
      expect(manifests[0]!.id).toBe('good');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Scenario: serialized artifacts are byte-stable', () => {
    it('Given the same manifests and embedder, When compiled twice, Then the serialized artifacts are identical', async () => {
      const dir = makeTmpDir();
      await compileTo(join(dir, 'a.json'), new HashEmbedder());
      await compileTo(join(dir, 'b.json'), new HashEmbedder());
      expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe(readFileSync(join(dir, 'b.json'), 'utf-8'));
      const { artifact } = await loadRuntime(join(dir, 'a.json'));
      expect(serializeArtifact(artifact)).toBe(readFileSync(join(dir, 'a.json'), 'utf-8'));
    });
  });
});
