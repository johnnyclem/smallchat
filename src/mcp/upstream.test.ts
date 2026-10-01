/**
 * UpstreamPool launch-spec handling: ${VAR} templates and stderr draining.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpstreamPool } from './upstream.js';
import type { ArtifactV1 } from '../artifact/types.js';

const QUIRKY = fileURLToPath(new URL('./__fixtures__/quirky-server.mjs', import.meta.url));

const pools: UpstreamPool[] = [];
afterEach(async () => {
  while (pools.length > 0) await pools.pop()!.close();
});

function poolFor(launch: NonNullable<ArtifactV1['providers'][string]['launch']>, options: ConstructorParameters<typeof UpstreamPool>[1]) {
  const artifact = {
    providers: { q: { id: 'q', name: 'quirky', transportType: 'mcp', launch } },
    tools: {},
  } as unknown as Pick<ArtifactV1, 'providers' | 'tools'>;
  const pool = new UpstreamPool(artifact, { log: () => {}, ...options });
  pools.push(pool);
  return pool;
}

describe('UpstreamPool', () => {
  it('expands ${VAR} templates recorded in the launch spec from serve\'s environment', async () => {
    const pool = poolFor(
      { transport: 'stdio', command: '${SC6_NODE}', args: ['${SC6_DIR}/quirky-server.mjs'], env: [] },
      { env: { SC6_NODE: process.execPath, SC6_DIR: dirname(QUIRKY) }, stderr: 'ignore' },
    );
    const result = await pool.callTool('q', 't1', {});
    expect(result.content).toEqual([{ type: 'text', text: 'ran t1' }]);
  }, 20_000);

  it('names a template variable that is not set', async () => {
    const pool = poolFor(
      { transport: 'stdio', command: process.execPath, args: ['${SC6_UNSET_FIXTURE_DIR}/quirky-server.mjs'], env: [] },
      { env: {}, stderr: 'ignore' },
    );
    await expect(pool.callTool('q', 't1', {})).rejects.toThrow(/SC6_UNSET_FIXTURE_DIR/);
  });

  it("drains a noisy upstream's stderr with stderr: 'pipe' instead of stalling", async () => {
    const pool = poolFor(
      { transport: 'stdio', command: process.execPath, args: [QUIRKY], env: ['FIXTURE_STDERR_BYTES'] },
      { env: { FIXTURE_STDERR_BYTES: String(2_400_000) }, stderr: 'pipe', requestTimeoutMs: 8_000 },
    );
    const result = await pool.callTool('q', 't2', {});
    expect(result.content).toEqual([{ type: 'text', text: 'ran t2' }]);
  }, 20_000);
});
