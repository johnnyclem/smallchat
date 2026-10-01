/**
 * Feature: collision-free MCP tool names for `smallchat serve`.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateToolName,
  buildToolTable,
  closeMatches,
  MAX_TOOL_NAME_LENGTH,
  isAggregateProviderId,
  MCP_TOOL_NAME_PATTERN,
} from './tool-names.js';
import type { ArtifactV1, ArtifactTool } from '../artifact/types.js';

function artifactWith(tools: Array<[providerId: string, name: string]>): ArtifactV1 {
  const providers: ArtifactV1['providers'] = {};
  const toolMap: Record<string, ArtifactTool> = {};
  for (const [providerId, name] of tools) {
    providers[providerId] = { id: providerId, name: providerId, transportType: 'mcp' };
    const id = `${providerId}/${name}`;
    toolMap[id] = {
      id, providerId, name, description: name, inputSchema: { type: 'object' }, transportType: 'mcp', selector: id,
    };
  }
  return { providers, tools: toolMap } as unknown as ArtifactV1;
}

describe('aggregate names', () => {
  it('accept provider ids that cannot blur the separator', () => {
    for (const id of ['github', 'brave-search', 'my_server', 'a1']) expect(isAggregateProviderId(id)).toBe(true);
    for (const id of ['a__b', 'trailing_', 'has.dot', 'has/slash', 'with space', '']) expect(isAggregateProviderId(id)).toBe(false);
  });

  it('map back to exactly one (provider, tool): no two inputs share a name', () => {
    // Exhaustive over a small alphabet that includes the separator character.
    const parts = ['a', 'b', '_', 'a_', '_a', 'a_b', '__', 'a__', '__b', 'a___b'];
    const seen = new Map<string, string>();
    for (const provider of parts.filter(isAggregateProviderId)) {
      for (const tool of parts) {
        const name = aggregateToolName(provider, tool);
        const key = `${provider}\u0000${tool}`;
        expect(seen.get(name) ?? key).toBe(key);
        seen.set(name, key);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('leave out (and report) tools whose names cannot be represented — never rename them', () => {
    const table = buildToolTable(artifactWith([
      ['github', 'create_issue'],
      ['files', 'read.file'],
      ['bad__id', 'x'],
      ['long', 'x'.repeat(130)],
    ]));
    expect(table.entries.map(e => e.name)).toEqual(['github__create_issue']);
    expect(table.skipped.map(s => s.toolId).sort()).toEqual(['bad__id/x', 'files/read.file', `long/${'x'.repeat(130)}`]);
    expect(table.skipped.every(s => s.reason.includes('--provider'))).toBe(true);
    for (const entry of table.entries) expect(entry.name).toMatch(MCP_TOOL_NAME_PATTERN);
  });

  it('serve one provider verbatim with --provider, whatever its names look like', () => {
    const table = buildToolTable(artifactWith([['files', 'read.file'], ['files', 'write'], ['other', 'write']]), { provider: 'files' });
    expect(table.entries.map(e => e.name)).toEqual(['read.file', 'write']);
    expect(table.byName.get('write')!.toolId).toBe('files/write');
    expect(() => buildToolTable(artifactWith([['files', 'x']]), { provider: 'nope' })).toThrow('Provider "nope" is not in the artifact');
  });
});

describe('closeMatches', () => {
  const names = ['github__create_issue', 'gitlab__create_issue', 'github__get_issue', 'files__read_file'];

  it('suggests the provider-qualified names of a bare upstream name', () => {
    expect(closeMatches('create_issue', names).slice(0, 2)).toEqual(['github__create_issue', 'gitlab__create_issue']);
  });

  it('suggests near spellings and ignores unrelated names', () => {
    expect(closeMatches('github__get_isue', names)[0]).toBe('github__get_issue');
    expect(closeMatches('github/get_issue', names)[0]).toBe('github__get_issue');
    expect(closeMatches('send_email', names)).toEqual([]);
  });

  it('does no edit-distance work for a name longer than any valid tool name', () => {
    const many = Array.from({ length: 200 }, (_, i) => `provider${i}__tool_number_${i}`);
    const started = performance.now();
    expect(closeMatches('q'.repeat(200_000), many)).toEqual([]);
    expect(closeMatches('x'.repeat(MAX_TOOL_NAME_LENGTH + 1), many)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
