/**
 * Feature: Artifact loading
 *
 * loadRuntime()/findManifests() read operator-supplied files off disk
 * (compiled artifacts, manifest directories). Both should go through
 * safeJsonParse rather than bare JSON.parse, matching the guarantee the
 * rest of the codebase (compile.ts) makes about manifest/config JSON.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRuntime, findManifests } from './artifact.js';

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

  describe('Scenario: Load a compiled .json artifact', () => {
    it('Given a minimal valid artifact file, When loadRuntime is called, Then it hydrates a runtime with no tools', async () => {
      const dir = makeTmpDir();
      const artifactPath = join(dir, 'tools.toolkit.json');
      writeFileSync(artifactPath, JSON.stringify({
        version: '0.5.0',
        stats: { toolCount: 0, uniqueSelectorCount: 0, providerCount: 0, collisionCount: 0 },
        selectors: {},
        dispatchTables: {},
      }));

      const { artifact } = await loadRuntime(artifactPath);

      expect(artifact.stats.toolCount).toBe(0);
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
});
