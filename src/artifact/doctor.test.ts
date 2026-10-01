/**
 * `smallchat doctor --artifact`: artifact ↔ embedder ↔ index compatibility
 * and near-duplicate tools.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { diagnoseArtifact, findNearDuplicates, formatDiagnosis } from './doctor.js';
import { buildArtifact, computeContentHash, serializeArtifact } from './format.js';
import { writeArtifact } from './io.js';
import type { ArtifactV1 } from './types.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { ToolCompiler } from '../compiler/compiler.js';
import type { ProviderManifest, ToolDefinition } from '../core/types.js';

const tool = (providerId: string, name: string, description: string): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object' },
  providerId,
  transportType: 'local',
});

const manifests: ProviderManifest[] = [
  {
    id: 'github',
    name: 'GitHub',
    transportType: 'local',
    tools: [
      tool('github', 'create_issue', 'Create a new issue in a repository'),
      tool('github', 'list_pull_requests', 'List open pull requests for a repository'),
    ],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    transportType: 'local',
    tools: [
      tool('gitlab', 'create_issue', 'Create a new issue in a project'),
      tool('gitlab', 'list_merge_requests', 'List merge requests for a project'),
    ],
  },
];

const dir = mkdtempSync(join(tmpdir(), 'sc5-doctor-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function compiled(): Promise<ArtifactV1> {
  const embedder = new HashEmbedder(64);
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex(), { allowDuplicates: true }).compile(manifests);
  return buildArtifact(result, manifests, embedder.fingerprint);
}

/** Write an edited artifact with a recomputed content hash (so it still reads). */
function writeEdited(name: string, artifact: ArtifactV1, edit: (a: ArtifactV1) => void): string {
  const copy = JSON.parse(JSON.stringify(artifact)) as ArtifactV1;
  edit(copy);
  copy.contentHash = computeContentHash(copy);
  const path = join(dir, name);
  writeFileSync(path, serializeArtifact(copy));
  return path;
}

const status = (d: Awaited<ReturnType<typeof diagnoseArtifact>>) => Object.fromEntries(d.checks.map(c => [c.name, c.status]));

describe('diagnoseArtifact', () => {
  it('passes an intact artifact and reports near-duplicates and shared names', async () => {
    const path = join(dir, 'ok.toolkit.json');
    await writeArtifact(path, await compiled());
    const d = await diagnoseArtifact(path, { nearDuplicateThreshold: 0.8 });

    expect(status(d)).toEqual({
      artifact: 'pass',
      embedder: 'pass',
      vectors: 'pass',
      reproduce: 'pass',
      index: 'pass',
      duplicates: 'warn',
      'shared names': 'info',
    });
    expect(d.ok).toBe(true);
    expect(d.nearDuplicates[0]).toMatchObject({ toolA: 'github/create_issue', toolB: 'gitlab/create_issue' });
    expect(d.checks.find(c => c.name === 'shared names')!.items).toEqual(['create_issue: github/create_issue, gitlab/create_issue']);
    expect(formatDiagnosis(d)).toContain('github/create_issue ~ gitlab/create_issue');
  });

  it('fails an artifact whose content hash does not match', async () => {
    const path = join(dir, 'tampered.toolkit.json');
    const artifact = await compiled();
    writeFileSync(path, serializeArtifact({ ...artifact, tools: { ...artifact.tools } }).replace('Create a new issue in a project', 'Delete the project'));
    const d = await diagnoseArtifact(path);
    expect(status(d)).toEqual({ artifact: 'fail' });
    expect(d.ok).toBe(false);
  });

  it('fails when the embedder in use is not the artifact embedder', async () => {
    const path = join(dir, 'ok.toolkit.json');
    const d = await diagnoseArtifact(path, { embedder: new HashEmbedder(32) });
    expect(status(d).embedder).toBe('fail');
    expect(d.checks.find(c => c.name === 'embedder')!.detail).toMatch(/not comparable|compiled with/);
  });

  it('warns when some selectors do not reproduce, and fails when most do not', async () => {
    const artifact = await compiled();
    const one = writeEdited('one-drift.toolkit.json', artifact, a => {
      a.tools['github/create_issue'].description = 'Something else entirely';
    });
    const some = await diagnoseArtifact(one);
    expect(status(some).reproduce).toBe('warn');
    expect(some.checks.find(c => c.name === 'reproduce')!.items![0]).toMatch(/^github\/create_issue \(cosine/);
    expect(some.ok).toBe(true);

    const all = writeEdited('all-drift.toolkit.json', artifact, a => {
      for (const t of Object.values(a.tools)) t.description = `${t.description} (rewritten)`;
    });
    const most = await diagnoseArtifact(all);
    expect(status(most).reproduce).toBe('fail');
    expect(most.ok).toBe(false);
  });

  it('fails vectors that are not unit length when the embedder normalizes', async () => {
    const path = writeEdited('scaled.toolkit.json', await compiled(), a => {
      const s = a.selectors['github.create_issue'];
      s.vector = s.vector.map(x => x * 2);
    });
    const d = await diagnoseArtifact(path);
    expect(status(d).vectors).toBe('fail');
  });

  it('checks the sqlite-vec index of a .db artifact read-only', async () => {
    const path = join(dir, 'tools.toolkit.db');
    await writeArtifact(path, await compiled());
    const good = await diagnoseArtifact(path);
    expect(status(good).index).toBe('pass');
    expect(good.checks.find(c => c.name === 'index')!.detail).toMatch(/sqlite-vec index: 4 selectors/);

    const db = new Database(path);
    sqliteVec.load(db);
    const stray = Buffer.from(new Float32Array(64).fill(0.125).buffer);
    db.prepare('INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)').run('stray.selector', stray);
    db.close();
    const bad = await diagnoseArtifact(path);
    expect(status(bad).index).toBe('fail');
    expect(bad.checks.find(c => c.name === 'index')!.items).toEqual(['unknown stray.selector']);
  });

  it('findNearDuplicates lists each pair of distinct tools once, most similar first', async () => {
    const artifact = await compiled();
    const pairs = findNearDuplicates(artifact, 0);
    const keys = pairs.map(p => `${p.toolA}|${p.toolB}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(6);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity);
    expect(readFileSync(join(dir, 'ok.toolkit.json'), 'utf-8')).toContain('"formatVersion": "1.0"');
  });
});
