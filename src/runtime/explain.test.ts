/**
 * `smallchat explain` / runtime.explain(): the candidate table with tiers,
 * annotations, pins and the dispatch policy's verdict for each candidate.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatExplanation } from './explain.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { buildArtifact } from '../artifact/format.js';
import { writeArtifact } from '../artifact/io.js';
import { loadRuntime } from '../mcp/artifact.js';
import type { ProviderManifest } from '../core/types.js';

const manifests: ProviderManifest[] = [
  {
    id: 'notes',
    name: 'Notes',
    transportType: 'local',
    tools: [
      { name: 'create_note', description: 'Create a new note with a title and body', inputSchema: { type: 'object' }, providerId: 'notes', transportType: 'local' },
      { name: 'delete_note', description: 'Delete a note by id', inputSchema: { type: 'object' }, annotations: { destructiveHint: true }, providerId: 'notes', transportType: 'local' },
      { name: 'search_notes', description: 'Search notes by keyword', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, providerId: 'notes', transportType: 'local' },
    ],
  },
];

let dir: string;
let artifact: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sc5-explain-'));
  const embedder = new HashEmbedder(64);
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
  artifact = join(dir, 'notes.toolkit.json');
  await writeArtifact(artifact, buildArtifact(result, manifests, embedder.fingerprint));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('runtime.explain', () => {
  it('gives every candidate its rank, hints and the policy verdict on running it unasked', async () => {
    const { runtime } = await loadRuntime(artifact);
    const e = await runtime.explain('create a note');

    expect(e.outcome).toBe('needs-disambiguation');
    expect(e.decision).toBe('needs-llm-verifier');
    expect(e.candidates.map(c => [c.rank, c.toolId])).toEqual([[1, 'notes/create_note'], [2, 'notes/delete_note']]);
    const [create, del] = e.candidates;
    expect(create.verdict).toMatchObject({ allow: false, code: 'needs-llm-verifier' });
    expect(del.destructive).toBe(true);
    expect(del.annotations).toEqual({ destructiveHint: true });
    expect(del.verdict).toMatchObject({ allow: false, code: 'destructive-needs-exact' });
    expect(e.proofDigest).toBe(e.resolution.proof.proofDigest);

    const text = formatExplanation(e);
    expect(text).toContain('Outcome:     needs-disambiguation');
    expect(text).toMatch(/2\s+notes\/delete_note .* destructive\s+destructive-needs-exact/);
    expect(text).toContain(`Proof digest: ${e.proofDigest}`);
  });

  it('marks the chosen candidate, read-only hints, pins and excluded candidates', async () => {
    const { runtime } = await loadRuntime(artifact, {
      runtimeOptions: { intentPins: [{ canonical: 'notes.delete_note', policy: 'exact', aliases: ['remove the note'] }] },
    });
    const chosen = await runtime.explain('search_notes: Search notes by keyword');
    expect(chosen.chosen).toBe('notes/search_notes');
    const row = chosen.candidates.find(c => c.toolId === 'notes/search_notes')!;
    expect(row).toMatchObject({ rank: 1, chosen: true, destructive: false, verdict: { allow: true, code: 'allow' } });
    expect(formatExplanation(chosen)).toMatch(/\*notes\/search_notes .* read-only/);

    const pinned = await runtime.explain('delete_note: Delete a note by id');
    const excluded = pinned.candidates.find(c => c.toolId === 'notes/delete_note')!;
    expect(excluded).toMatchObject({ rank: null, pinned: true, excluded: 'pin-exact-required', verdict: null });
    expect(formatExplanation(pinned)).toContain('excluded: pin-exact-required');
  });

  it('executes nothing and learns nothing', async () => {
    const { runtime } = await loadRuntime(artifact);
    await runtime.explain('search_notes: Search notes by keyword');
    await runtime.explain('note');
    expect(runtime.cache.size).toBe(0);
    expect(runtime.semanticMap.size).toBe(0);
    expect(formatExplanation(await runtime.explain('note'))).toContain('No candidates scored at or above the LOW threshold.');
  });
});
