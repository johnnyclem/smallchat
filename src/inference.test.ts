/**
 * Feature: Tier-1/Tier-2 layering boundary
 *
 * ARCHITECTURE.md's "Two tiers" section documents `@smallchat/core/inference`
 * (src/inference.ts) as the durable, transport-agnostic engine: everything
 * that turns an intent into a resolved tool, independent of any concrete
 * wire protocol. A prior audit found this violated in practice — ToolProxy
 * (re-exported from inference.ts) statically imported src/mcp/transport.ts,
 * pulling ~550 lines of HTTP/JSON-RPC/SSE/gRPC wire-protocol code into the
 * "engine and nothing else" entry point. Fixed by having ToolProxy depend on
 * a ToolTransport interface instead, with concrete transports injected by
 * callers that construct one (the compiler, the MCP artifact loader).
 *
 * This test pins that boundary at the source level so it can't silently
 * regress: nothing inference.ts pulls in (core/, runtime/, or inference.ts
 * itself) may statically import mcp/transport.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Feature: Tier-1/Tier-2 layering boundary', () => {
  it('Given the inference-core source files (core/, runtime/, inference.ts), When scanned for imports, Then none statically import mcp/transport.ts', () => {
    const candidates = [
      join(SRC_DIR, 'inference.ts'),
      ...listTsFiles(join(SRC_DIR, 'core')),
      ...listTsFiles(join(SRC_DIR, 'runtime')),
    ];

    const offenders = candidates.filter((file) => {
      const content = readFileSync(file, 'utf-8');
      return /from\s+['"].*mcp\/transport(\.js)?['"]/.test(content);
    });

    expect(offenders).toEqual([]);
  });
});
