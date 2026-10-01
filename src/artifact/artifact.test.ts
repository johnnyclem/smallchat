/**
 * Feature: Artifact format 1.0
 *
 * One writer (buildArtifact) and one validating reader (validateArtifact /
 * readArtifact): full upstream tool definitions keyed by canonical tool id,
 * an embedder fingerprint, launch specs without secrets, and a content hash.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ToolCompiler } from '../compiler/compiler.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { introspectMcpConfigFile } from '../mcp/client.js';
import type { Embedder, ProviderManifest } from '../core/types.js';
import {
  ARTIFACT_SCHEMA_PATH,
  ArtifactFormatError,
  ArtifactVersionError,
  EmbedderMismatchError,
  buildArtifact,
  computeContentHash,
  createArtifactIndex,
  fingerprintsEqual,
  parseArtifact,
  readArtifact,
  serializeArtifact,
  validateArtifact,
  writeArtifact,
  type ArtifactV1,
  type EmbedderFingerprint,
} from './index.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'artifact', 'fixtures');

function manifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
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
    ],
    ...overrides,
  };
}

async function build(manifests: ProviderManifest[]): Promise<ArtifactV1> {
  const embedder = new HashEmbedder(32);
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
  return buildArtifact(result, manifests, embedder.fingerprint);
}

/** A copy of `artifact` with `mutate` applied and the content hash recomputed. */
function rehashed(artifact: ArtifactV1, mutate: (a: ArtifactV1) => void): ArtifactV1 {
  const copy = JSON.parse(JSON.stringify(artifact)) as ArtifactV1;
  mutate(copy);
  copy.contentHash = computeContentHash(copy);
  return copy;
}

describe('Feature: Artifact format 1.0', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'smallchat-format-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  describe('Scenario: golden fixture', () => {
    it('Given the committed fixture, When it is validated and rebuilt from its manifest, Then both match byte for byte', async () => {
      const text = readFileSync(join(FIXTURES, 'minimal.v1.json'), 'utf-8');
      const fixture = parseArtifact(text, 'minimal.v1.json');
      expect(fixture.contentHash).toBe(computeContentHash(fixture));

      const source = JSON.parse(readFileSync(join(FIXTURES, 'minimal.manifest.json'), 'utf-8')) as ProviderManifest;
      const embedder = new HashEmbedder(fixture.embedder.dims);
      const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile([source]);
      expect(serializeArtifact(buildArtifact(result, [source], embedder.fingerprint))).toBe(text);
    });

    it('ships the normative JSON Schema next to the package', () => {
      const schema = JSON.parse(readFileSync(ARTIFACT_SCHEMA_PATH, 'utf-8')) as Record<string, unknown>;
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect((schema.properties as Record<string, unknown>).formatVersion).toEqual({ const: '1.0' });
    });
  });

  describe('Scenario: the writer keeps full upstream definitions (SC-INF-19)', () => {
    it('Given two providers exposing the same tool name, When built, Then each tool keeps its own id, schema and description', async () => {
      const artifact = await build([
        manifest(),
        manifest({
          id: 'gitlab',
          name: 'GitLab',
          tools: [{
            name: 'search_code',
            description: 'Find source files in GitLab projects by keyword',
            inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, term: { type: 'string' } } },
            providerId: 'gitlab',
            transportType: 'mcp',
          }],
        }),
      ]);

      expect(Object.keys(artifact.tools)).toEqual(['github/search_code', 'gitlab/search_code']);
      expect(artifact.tools['github/search_code'].inputSchema).toEqual(manifest().tools[0].inputSchema);
      expect(artifact.tools['gitlab/search_code'].description).toBe('Find source files in GitLab projects by keyword');
      expect(artifact.selectors[artifact.tools['gitlab/search_code'].selector].toolId).toBe('gitlab/search_code');
      expect(artifact.stats).toEqual({ toolCount: 2, selectorCount: 2, providerCount: 2, collisionCount: 0, duplicateCount: 0 });
    });

    it('Given a manifest with a bare endpoint, When built, Then the provider records a remote launch spec', async () => {
      const artifact = await build([manifest({ endpoint: 'https://mcp.example.com/mcp' })]);
      expect(artifact.providers.github.launch).toEqual({ transport: 'streamable-http', url: 'https://mcp.example.com/mcp' });
    });

    it('Given an introspected stdio server with secrets in env, When compiled, Then the artifact records env NAMES and tool metadata but no secret values', async () => {
      const dir = tmp();
      const serverPath = join(dir, 'server.mjs');
      writeFileSync(serverPath, `
        import { createInterface } from 'node:readline';
        const rl = createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
              protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1.0.0' } } }) + '\\n');
          } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
              name: 'delete_note', title: 'Delete note', description: 'Permanently delete a note',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
              outputSchema: { type: 'object', properties: { deleted: { type: 'boolean' } } },
              annotations: { destructiveHint: true, idempotentHint: true, futureHint: 'dropped' },
            }] } }) + '\\n');
          }
        });
      `);
      const configPath = join(dir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { notes: { command: process.execPath, args: [serverPath], env: { NOTES_API_TOKEN: 'sk-live-SECRET-VALUE' } } },
      }));

      const manifests = await introspectMcpConfigFile(configPath, { timeoutMs: 10_000 });
      const artifact = await build(manifests);
      const text = serializeArtifact(artifact);

      expect(artifact.providers.notes.launch).toEqual({
        transport: 'stdio', command: process.execPath, args: [serverPath], env: ['NOTES_API_TOKEN'],
      });
      expect(text).not.toContain('sk-live-SECRET-VALUE');
      const tool = artifact.tools['notes/delete_note'];
      expect(tool.title).toBe('Delete note');
      expect(tool.outputSchema).toEqual({ type: 'object', properties: { deleted: { type: 'boolean' } } });
      expect(tool.annotations).toEqual({ destructiveHint: true, idempotentHint: true });
    }, 20_000);
  });

  describe('Scenario: the reader refuses anything but an intact 1.0 artifact', () => {
    it('Given a 0.x artifact, Then it asks for a recompile', () => {
      expect(() => validateArtifact({ version: '0.5.0', selectors: {}, dispatchTables: {} }))
        .toThrow(/pre-1\.0 smallchat artifact \(version 0\.5\.0\).*recompile with smallchat 1\.0/s);
    });

    it('Given a future formatVersion, Then it is refused as a version error', async () => {
      const artifact = rehashed(await build([manifest()]), a => { (a as { formatVersion: string }).formatVersion = '2.0'; });
      expect(() => validateArtifact(artifact)).toThrow(ArtifactVersionError);
    });

    it('Given an edited artifact, Then the content-hash check fails', async () => {
      const artifact = JSON.parse(JSON.stringify(await build([manifest()]))) as ArtifactV1;
      artifact.tools['github/search_code'].description = 'Delete every repository';
      expect(() => validateArtifact(artifact)).toThrow(/content-hash check/);
    });

    it('Given an artifact without an embedder fingerprint, Then the schema check fails', async () => {
      const artifact = rehashed(await build([manifest()]), a => { delete (a as Partial<ArtifactV1>).embedder; });
      expect(() => validateArtifact(artifact)).toThrow(/must have required property 'embedder'/);
    });

    it('Given a selector vector of the wrong dimension, Then it is inconsistent', async () => {
      const artifact = rehashed(await build([manifest()]), a => { a.selectors['github.search_code'].vector.pop(); });
      expect(() => validateArtifact(artifact)).toThrow(/31 dimensions; the embedder has 32/);
    });

    it('Given a selector that points at another tool, Then it is inconsistent', async () => {
      const artifact = rehashed(await build([manifest()]), a => { a.selectors['github.search_code'].toolId = 'github/missing'; });
      expect(() => validateArtifact(artifact)).toThrow(ArtifactFormatError);
    });

    it('Given a 0.x SQLite artifact, Then readArtifact asks for a recompile', async () => {
      const path = join(tmp(), 'legacy.db');
      const db = new Database(path);
      db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO metadata VALUES ('version', '0.5.0');");
      db.close();
      await expect(readArtifact(path)).rejects.toThrow(/pre-1\.0.*recompile with smallchat 1\.0/s);
    });
  });

  describe('Scenario: JSON and SQLite files hold the same artifact', () => {
    it('Given one artifact written as .json and .db, When read back, Then both equal the original', async () => {
      const dir = tmp();
      const artifact = await build([manifest(), manifest({ id: 'slack', name: 'Slack', tools: [{
        name: 'post_message', description: 'Post a message to a Slack channel',
        inputSchema: { type: 'object', properties: { channel: { type: 'string' } } }, providerId: 'slack', transportType: 'mcp',
      }] })]);
      await writeArtifact(join(dir, 'a.json'), artifact);
      await writeArtifact(join(dir, 'a.db'), artifact);
      await writeArtifact(join(dir, 'a.db'), artifact); // overwrite in place

      expect(await readArtifact(join(dir, 'a.json'))).toEqual(artifact);
      expect(await readArtifact(join(dir, 'a.db'))).toEqual(artifact);
    });
  });

  describe('Scenario: createArtifactIndex enforces the fingerprint', () => {
    it('Given a hash artifact, When indexed, Then every selector is searchable with the matching embedder', async () => {
      const artifact = await build([manifest()]);
      const { selectorTable, embedder } = await createArtifactIndex(artifact);
      expect(embedder.fingerprint).toEqual(artifact.embedder);
      const hits = await selectorTable.searchTools(await embedder.embed('search_code: Search for code across repositories'), 1, 0.9);
      expect(hits[0]?.id).toBe('github.search_code');
    });

    it('Given a hash artifact, When an embedder with other dimensions is injected, Then it is refused', async () => {
      const artifact = await build([manifest()]);
      await expect(createArtifactIndex(artifact, { embedder: new HashEmbedder(64) })).rejects.toThrow(EmbedderMismatchError);
    });
  });

  describe('Scenario: every loader refuses the negative fixtures (spec/artifact/fixtures/invalid)', () => {
    const index = JSON.parse(readFileSync(join(FIXTURES, 'invalid', 'index.json'), 'utf-8')) as {
      artifacts: Array<{ file: string; rule: number; error: string }>;
      embedderMismatches: { artifact: string; cases: Array<{ field: string; fingerprint: EmbedderFingerprint }> };
    };

    it('covers every loader rule', () => {
      expect(new Set(index.artifacts.map(c => c.rule))).toEqual(new Set([1, 2, 3, 4]));
      expect(index.embedderMismatches.cases.map(c => c.field).sort()).toEqual(
        ['dims', 'kind', 'maxLength', 'model', 'modelSha256', 'normalize', 'pooling'],
      );
    });

    for (const { file, rule, error } of index.artifacts) {
      it(`refuses ${file} (rule ${rule})`, () => {
        const text = readFileSync(join(FIXTURES, 'invalid', file), 'utf-8');
        expect(() => parseArtifact(text, file)).toThrow(ArtifactFormatError);
        expect(() => parseArtifact(text, file)).toThrow(error);
      });
    }

    /** The fixture's hash embedder, declaring `fingerprint` instead of its own. */
    function declaring(fingerprint: EmbedderFingerprint): Embedder {
      const inner = new HashEmbedder(16);
      return { dimensions: inner.dimensions, fingerprint, embed: t => inner.embed(t), embedBatch: t => inner.embedBatch(t) };
    }

    it('accepts the fixture with an embedder that declares its exact fingerprint (control)', async () => {
      const fixture = parseArtifact(readFileSync(join(FIXTURES, index.embedderMismatches.artifact), 'utf-8'));
      await expect(createArtifactIndex(fixture, { embedder: declaring({ ...fixture.embedder }) })).resolves.toBeDefined();
    });

    for (const { field, fingerprint } of index.embedderMismatches.cases) {
      it(`refuses an embedder whose fingerprint differs only in ${field} (rule 5)`, async () => {
        const fixture = parseArtifact(readFileSync(join(FIXTURES, index.embedderMismatches.artifact), 'utf-8'));
        const differing = Object.keys(fingerprint).filter(k => fingerprint[k as keyof EmbedderFingerprint] !== fixture.embedder[k as keyof EmbedderFingerprint]);
        expect(differing).toEqual([field]);
        expect(fingerprintsEqual(fingerprint, fixture.embedder)).toBe(false);
        await expect(createArtifactIndex(fixture, { embedder: declaring(fingerprint) })).rejects.toThrow(EmbedderMismatchError);
      });
    }
  });
});
