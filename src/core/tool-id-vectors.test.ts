/**
 * Conformance with spec/tool-id/vectors.json (smallchat.tool-id.v1): how a
 * canonical tool id splits, which ids are refused, and the MCP name
 * `smallchat serve` gives each tool in aggregate mode. smallchat-swift runs
 * the same vectors.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseToolId, toolId } from './tool-id.js';
import { callDigest } from './call-digest.js';
import { buildToolTable } from '../mcp/tool-names.js';
import type { ArtifactV1 } from '../artifact/types.js';

const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../spec/tool-id/vectors.json', import.meta.url)), 'utf8')) as {
  version: string;
  valid: Array<{ id: string; providerId: string; toolName: string; aggregateName: string | null }>;
  invalid: Array<{ id: string; reason: string }>;
};

/** Just enough of an artifact for buildToolTable: providers and tools. */
function artifactOf(ids: Array<{ id: string; providerId: string; toolName: string }>): ArtifactV1 {
  const providers: Record<string, unknown> = {};
  const tools: Record<string, unknown> = {};
  for (const t of ids) {
    providers[t.providerId] = { id: t.providerId, name: t.providerId, transportType: 'mcp' };
    tools[t.id] = { id: t.id, providerId: t.providerId, name: t.toolName, inputSchema: { type: 'object' } };
  }
  return { providers, tools } as unknown as ArtifactV1;
}

describe('canonical tool id vectors (spec/tool-id/vectors.json)', () => {
  it('is smallchat.tool-id.v1', () => {
    expect(spec.version).toBe('smallchat.tool-id.v1');
  });

  for (const v of spec.valid) {
    it(`splits ${JSON.stringify(v.id.length > 40 ? `${v.id.slice(0, 40)}…` : v.id)}`, () => {
      expect(parseToolId(v.id)).toEqual({ providerId: v.providerId, toolName: v.toolName });
      if (!v.providerId.includes('/')) expect(toolId(v.providerId, v.toolName)).toBe(v.id);
    });
  }

  it('maps each tool to its aggregate MCP name, or skips it, exactly as the vectors say', () => {
    const table = buildToolTable(artifactOf(spec.valid));
    for (const v of spec.valid) {
      expect(table.byToolId.get(v.id)?.name ?? null, v.id).toBe(v.aggregateName);
      if (v.aggregateName !== null) expect(table.byName.get(v.aggregateName)?.toolId).toBe(v.id);
      else expect(table.skipped.map(s => s.toolId)).toContain(v.id);
    }
  });

  it('serves every tool of one provider under its upstream name with --provider', () => {
    const table = buildToolTable(artifactOf(spec.valid), { provider: 'p' });
    expect(table.entries.map(e => [e.name, e.toolId]).sort()).toEqual(
      spec.valid.filter(v => v.providerId === 'p').map(v => [v.toolName, v.id]).sort(),
    );
  });

  for (const v of spec.invalid) {
    it(`refuses ${JSON.stringify(v.id)} (${v.reason})`, () => {
      expect(() => parseToolId(v.id)).toThrow(TypeError);
      expect(() => callDigest(v.id, {})).toThrow(TypeError);
    });
  }
});
