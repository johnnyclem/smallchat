/**
 * Runs inside a fresh project that installed the packed @shorthand/core
 * (see scripts/pack-smoke.mjs): imports every subpath in the installed
 * package's "exports" through Node's own resolution and exercises a little
 * of each.
 */
import assert from 'node:assert/strict';
import pkg from '@shorthand/core/package.json' with { type: 'json' };

/** A value each subpath must export (a new subpath only needs to be non-empty). */
const SENTINELS = {
  '.': 'CompactionEngine',
  './compaction': 'DefaultCompactor',
  './crdt': 'AgentMemory',
  './importance': 'ImportanceDetector',
  './truth': 'parseWikiLines',
  './wiki': 'WikiRenderer',
  './ingestion': 'SourceIngester',
  './interpreter': 'HostInterpreter',
  './verification': 'InvariantChecker',
  './benchmark': 'ContextShiftBenchmark',
};

const subpaths = Object.keys(pkg.exports).filter((k) => k !== './package.json');
assert.deepEqual(
  [...subpaths].sort(),
  Object.keys(SENTINELS).sort(),
  'exports subpaths changed: update SENTINELS in test/smoke/runtime.mjs',
);

const modules = {};
for (const sub of subpaths) {
  const specifier = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
  const mod = await import(specifier);
  assert.ok(Object.keys(mod).length > 0, `${specifier} exports nothing`);
  assert.equal(typeof mod[SENTINELS[sub]], 'function', `${specifier} lacks ${SENTINELS[sub]}`);
  modules[sub] = mod;
  console.log(`ok ${specifier} (${Object.keys(mod).length} exports)`);
}

// The benchmark stays off the root barrel.
assert.equal(modules['.'].ContextShiftBenchmark, undefined, 'the root export must not carry the benchmark');

// Only "exports" is reachable.
await assert.rejects(import(`${pkg.name}/dist/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

// A little end-to-end through the installed code.
const { CompactionEngine, renderContextFrame, estimateTokens } = modules['.'];
const engine = new CompactionEngine({ memtableSize: 2 });
await engine.addMessages([
  { id: 'm1', role: 'user', content: 'We decided to use PostgreSQL instead of MySQL.', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'PostgreSQL it is.', timestamp: 2 },
  { id: 'm3', role: 'user', content: 'Deploy to eu-west-1.', timestamp: 3 },
]);
const frame = engine.buildContextFrame(200);
assert.ok(frame.tokenUsage <= 200);
assert.equal(frame.tokenUsage, estimateTokens(renderContextFrame(frame)));

const { canonicalizeJcs, evidenceClass, checkQuorum, QUORUM_MIN_MEMBERS } = modules['./truth'];
assert.equal(canonicalizeJcs({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
assert.equal(evidenceClass('commit'), 'settling');
assert.equal(evidenceClass('chat'), 'question');
// One agent session alone settles nothing
const alone = { author: 'agent:a', agentSessionId: 's1', ts: '2026-09-01T12:00:00Z', evidence: [{ kind: 'commit', ref: 'a1b2c3' }], verdict: 'verified' };
assert.equal(QUORUM_MIN_MEMBERS, 2);
assert.match(checkQuorum({ type: 'ADDENDUM', author: 'agent:a', ts: alone.ts, evidence: alone.evidence, quorum: [alone] }).join(), /at least 2 members/);

const { ContextShiftBenchmark, KeywordJudge, STARTER_FIXTURES } = modules['./benchmark'];
const { RegexInterpreter } = modules['./interpreter'];
const report = await new ContextShiftBenchmark({
  interpreter: new RegexInterpreter(),
  judge: new KeywordJudge(),
}).run(STARTER_FIXTURES);
assert.equal(report.gate.passed, false, 'the offline configuration must never pass the gate');

console.log(`ok runtime smoke for ${pkg.name}@${pkg.version}`);
