/**
 * Truth format v2 conformance — stenographer's golden fixtures.
 *
 * test/fixtures/truth-format/ is a copy of stenographer's
 * spec/truth-format (README, JSON Schema, fixtures), made by
 * scripts/sync-truth-fixtures.mjs, which records the source commit and
 * every file's sha256 in SOURCE. Each fixture's *.expected.json states the
 * outcome a conforming reader must reach; this file checks that this
 * package's codec reaches it.
 *
 * Several expected files also describe stenographer's own import (whether a
 * line is inserted into its ledger, filed as a reconciliation proposal, or
 * held). A reader does not import: the parts that apply to it are that
 * `inserted` lines are read with that status, that `proposal` lines never
 * become current truth (for the reasons a reader applies: unsigned,
 * unverifiable, an unknown status), and that `held` lines change no status.
 * Each describe block says how its expected file is read.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { canonicalize } from './jcs.js';
import { checkTruthChain, decodeTruthLine, truthLineHash, type DecodedTruthLine } from './format.js';
import { parseProposalLines } from './proposals.js';
import { classifyEntry, parseWikiLines, serializeWikiEntries, truthStatusTable } from './wiki.js';
import type { TruthSignerFile } from './identity.js';

const DIR = fileURLToPath(new URL('../../test/fixtures/truth-format/', import.meta.url));
const read = (path: string) => readFileSync(join(DIR, path), 'utf8');
const lines = (path: string) => read(path).split('\n').filter((l) => l.length > 0);
const expected = <T>(path: string): T => JSON.parse(read(path)) as T;
const parse = (text: string) => JSON.parse(text) as Record<string, any>;
const signers = (): TruthSignerFile => expected('signers.json');

// ajv-formats is CommonJS: its default export arrives wrapped under ESM interop
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(read('wiki-line.v2.schema.json')));
const schemaValid = (line: string) => validate(JSON.parse(line)) as boolean;

function decodeAll(path: string): DecodedTruthLine[] {
  return lines(path).map((l) => decodeTruthLine(l));
}

describe('fixture provenance', () => {
  it('SOURCE names the stenographer commit, and every file matches the hash it recorded', () => {
    const source = read('SOURCE');
    expect(source).toMatch(/^commit: [0-9a-f]{40}$/m);
    const listed = new Map(
      [...source.matchAll(/^ {2}([0-9a-f]{64}) {2}(\S+)$/gm)].map((m) => [m[2], m[1]] as const),
    );
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [relative(DIR, join(dir, e.name)).split(sep).join('/')],
      );
    const present = walk(DIR).filter((f) => f !== 'SOURCE').sort();
    expect(present, 're-run scripts/sync-truth-fixtures.mjs').toEqual([...listed.keys()].sort());
    for (const file of present) {
      const sha = createHash('sha256').update(readFileSync(join(DIR, file))).digest('hex');
      expect(sha, `${file} was edited by hand; re-run scripts/sync-truth-fixtures.mjs`).toBe(listed.get(file));
    }
  });
});

describe('the spec document', () => {
  it("reproduces the worked example's canonical form and hash exactly", () => {
    const readme = read('README.md');
    const example = readme.match(/<!-- worked-example -->\s*```json\n([^\n]+)\n```/);
    expect(example, 'README.md has a worked example').not.toBeNull();
    const line = example![1];
    expect(lines('valid/ledger.jsonl')).toContain(line);

    const { hash, ...rest } = parse(line);
    const jcs = canonicalize(rest);
    // The README prints the JCS form in its own code block, byte for byte
    expect(readme).toContain('```\n' + jcs + '\n```');
    expect(createHash('sha256').update(jcs, 'utf8').digest('hex')).toBe(hash);
    expect(truthLineHash(line)).toBe(hash);
    expect(hash).toBe('8c366a06018886baa0ca9456661e4895a272faebf88e188f409efc580b5465fb');
  });
});

describe('valid/ledger.jsonl: one ledger, every kind of wiki line', () => {
  const file = 'valid/ledger.jsonl';

  it('every line passes the schema and the codec, its hash recomputes, and the lines chain', () => {
    const all = lines(file);
    for (const [i, line] of all.entries()) {
      expect(schemaValid(line), `line ${i + 1}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(decodeTruthLine(line)).toMatchObject({ version: 2, seq: i + 1, hash: parse(line).hash });
      expect(truthLineHash(line)).toBe(parse(line).hash);
    }
    expect(checkTruthChain(decodeAll(file))).toEqual([]);
  });

  it('folds to ledger.expected.json (highest-seq TRANSITION, else the line’s own status)', () => {
    const result = parseWikiLines(read(file));
    expect(result.errors).toEqual([]);
    expect(result.refused).toBe(false);
    expect(truthStatusTable(result.entries)).toEqual(expected('valid/ledger.expected.json'));
  });

  it('folds the same with the fixtures’ signer registry', () => {
    const result = parseWikiLines(read(file), { signers: signers() });
    expect(truthStatusTable(result.entries)).toEqual(expected('valid/ledger.expected.json'));
  });

  it('re-serializes every entry line byte for byte, and keeps every line of the stream verbatim', () => {
    const result = parseWikiLines(read(file));
    const entryLines = lines(file).filter((l) => ['TB', 'UV'].includes(parse(l).type));
    expect(serializeWikiEntries(result.entries)).toEqual(entryLines);
    expect(result.lines.map((l) => l.text)).toEqual(lines(file));
    expect(result.head).toEqual({ seq: 15, hash: parse(lines(file)[14]).hash });
  });
});

describe('valid/proposals.jsonl: the suite PROPOSAL envelope', () => {
  // proposals.expected.json names the kind stenographer files each line as
  // ('tombstone' is its internal name for a tb proposal).
  const filedAs: Record<string, string> = { tombstone: 'tb', uv: 'uv' };

  it('passes the schema and the codec, chains, and reads with the kind each line files as', () => {
    const fixture = lines('valid/proposals.jsonl');
    for (const line of fixture) {
      expect(schemaValid(line), ajv.errorsText(validate.errors)).toBe(true);
      expect(decodeTruthLine(line)).toMatchObject({ version: 2, type: 'PROPOSAL' });
    }
    const result = parseProposalLines(fixture);
    expect(result.errors).toEqual([]);
    expect(result.refused).toBe(false);
    const want = expected<Array<{ line: number; outcome: string; kind: string }>>('valid/proposals.expected.json');
    expect(result.proposals.map((p) => p.kind)).toEqual(want.map((w) => filedAs[w.kind]));
    expect(result.proposals.map((p) => p.text)).toEqual(fixture);
  });

  it('reads every envelope, those sharing a targetRef too, and keeps values it does not know as written', () => {
    const result = parseProposalLines(lines('valid/proposals.jsonl'));
    const want = expected<Array<{ line: number; unknown?: string[] }>>('valid/proposals.expected.json');
    const targets = result.proposals.map((p) => p.targetRef).filter((t) => t !== null);
    expect(new Set(targets).size).toBeLessThan(targets.length);
    // `unknown` lists them as stenographer records them: "signal.source 'x'", "evidence kind 'x'", "verifyBy kind 'x'"
    for (const w of want.filter((w) => w.unknown)) {
      const p = result.proposals.find((p) => p.line === w.line)!;
      const kept: string[] = [
        `signal.source '${p.signal.source}'`,
        ...((p.draft.evidence as Array<{ kind: string }> | undefined) ?? []).map((e) => `evidence kind '${e.kind}'`),
        ...(p.draft.verifyBy ? [`verifyBy kind '${(p.draft.verifyBy as { kind: string }).kind}'`] : []),
      ];
      for (const value of w.unknown!) expect(kept, `line ${w.line}`).toContain(value);
    }
  });

  it('is refused as a wiki stream: proposals never travel in one', () => {
    const result = parseWikiLines(lines('valid/proposals.jsonl'));
    expect(result.refused).toBe(true);
    expect(result.entries).toEqual([]);
  });
});

describe('valid/unknown.jsonl: what a newer writer may send', () => {
  const file = 'valid/unknown.jsonl';
  const want = () =>
    expected<{ fold: Record<string, unknown>; import: Array<{ line: number; outcome: string; reason?: string }> }>(
      'valid/unknown.expected.json',
    );

  it('passes the schema and the codec and folds with unknown statuses failing closed', () => {
    for (const line of lines(file)) {
      expect(schemaValid(line), ajv.errorsText(validate.errors)).toBe(true);
      expect(() => decodeTruthLine(line)).not.toThrow();
    }
    const result = parseWikiLines(read(file));
    expect(result.errors).toEqual([]);
    expect(truthStatusTable(result.entries)).toEqual(want().fold);
  });

  it('keeps every line verbatim: an unknown field, unknown statuses, kinds and cause', () => {
    const result = parseWikiLines(read(file));
    const entryLines = lines(file).filter((l) => ['TB', 'UV'].includes(parse(l).type));
    expect(serializeWikiEntries(result.entries)).toEqual(entryLines);
    expect(result.transitions).toMatchObject([{ status: 'archived', cause: { kind: 'archive', ref: null } }]);
    const tb1 = result.entries.find((e) => e.id === '01J9UNKNOWNTB00000000000001')!;
    expect(tb1.extra?.reviewers).toEqual(['sam']);
    expect(tb1.source?.lineStatus).toBe('active');
  });

  it("reads stenographer's import outcomes as a reader: unknown statuses never become truth", () => {
    // 'inserted' and 'unknown-value' lines are read and current (a reader
    // folds statuses; evidence and verifyBy kinds are not its to judge);
    // 'unknown-status' lines are history; the 'held' TRANSITION is kept
    // and moves its target to a status no one knows, which fails closed.
    const result = parseWikiLines(read(file));
    const byLine = new Map(lines(file).map((l, i) => [i + 1, parse(l)]));
    for (const w of want().import) {
      const line = byLine.get(w.line)!;
      if (line.type === 'TRANSITION') {
        expect(w.outcome).toBe('held');
        const target = result.entries.find((e) => e.id === line.target)!;
        expect(target.status).toBe(line.status);
        expect(classifyEntry(target)).toBe('history');
        continue;
      }
      const entry = result.entries.find((e) => e.id === line.id)!;
      const current = classifyEntry(entry) !== 'history';
      if (w.outcome === 'proposal' && w.reason === 'unknown-status') expect(current, `line ${w.line}`).toBe(false);
      else expect(entry.source?.lineStatus, `line ${w.line}`).toBe(line.status);
    }
  });
});

describe('valid/routing.jsonl: valid lines stenographer does not simply take as truth', () => {
  type Want = { line: number; outcome: string; reason?: string; status?: string };

  it('pass the schema and the codec, and read (each on its own) as routing.expected.json says', () => {
    const fixture = lines('valid/routing.jsonl');
    for (const w of expected<Want[]>('valid/routing.expected.json')) {
      const line = fixture[w.line - 1];
      expect(schemaValid(line), `line ${w.line}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      // A single line part-way through a stream is a valid partial stream
      const result = parseWikiLines([line], { signers: signers() });
      expect(result.errors, `line ${w.line}`).toEqual([]);
      const entry = result.entries.find((e) => e.id === parse(line).id);
      if (w.outcome === 'inserted') {
        expect(entry!.status, `line ${w.line}`).toBe(w.status);
      } else if (w.outcome === 'proposal') {
        expect(classifyEntry(entry!), `line ${w.line}`).toBe('history');
        expect(entry!.inadmissible?.reason, `line ${w.line}`).toBe(w.reason);
      } else {
        // held: an ADDENDUM changes nothing for a reader; only TRANSITIONs move statuses
        expect(entry, `line ${w.line}`).toBeUndefined();
        expect(result.transitions, `line ${w.line}`).toEqual([]);
      }
    }
  });

  it('without a signer registry, an identity that passes the identity rules is accepted', () => {
    const mallory = lines('valid/routing.jsonl')[1];
    const [entry] = parseWikiLines([mallory]).entries;
    expect(classifyEntry(entry)).toBe('ground-truth');
  });
});

describe('v1/legacy.jsonl: 0.x lines are still read', () => {
  type Want = { line: number; outcome: string; reason?: string; status?: string; draftEvidenceKinds?: string[] };

  it('decode as version 1 (the v2 schema refuses them) and read as legacy.expected.json says', () => {
    const fixture = lines('v1/legacy.jsonl');
    for (const line of fixture) {
      expect(decodeTruthLine(line)).toMatchObject({ version: 1 });
      expect(schemaValid(line)).toBe(false);
    }
    const result = parseWikiLines(fixture, { signers: signers() });
    expect(result.errors).toEqual([]);
    for (const w of expected<Want[]>('v1/legacy.expected.json')) {
      const entry = result.entries.find((e) => e.id === parse(fixture[w.line - 1]).id)!;
      if (w.outcome === 'inserted') {
        expect(entry.status, `line ${w.line}`).toBe(w.status);
        continue;
      }
      // A v1 TB carries no hash: never truth on its own (filed for a person to sign)
      expect(entry.inadmissible?.reason, `line ${w.line}`).toBe(w.reason);
      expect(classifyEntry(entry), `line ${w.line}`).toBe('history');
      if (w.draftEvidenceKinds && entry.type === 'TB') {
        expect(entry.evidence.map((e) => e.kind), `line ${w.line}`).toEqual(w.draftEvidenceKinds);
      }
    }
    // The lines themselves are never rewritten: 'command' stays 'command' on the wire
    expect(serializeWikiEntries(result.entries)).toEqual(fixture);
  });
});

describe('invalid fixtures', () => {
  it('invalid/schema.jsonl: every line fails the schema and the codec', () => {
    const fixture = lines('invalid/schema.jsonl');
    const want = expected<Array<{ line: number; reason: string }>>('invalid/schema.expected.json');
    expect(want).toHaveLength(fixture.length);
    for (const [i, line] of fixture.entries()) {
      expect(schemaValid(line), `line ${i + 1} (${want[i].reason})`).toBe(false);
      expect(() => decodeTruthLine(line), `line ${i + 1} (${want[i].reason})`).toThrow();
    }
  });

  it('invalid/codec.jsonl: every line passes the schema and fails the codec with the expected error', () => {
    const fixture = lines('invalid/codec.jsonl');
    const want = expected<Array<{ line: number; reason: string; error: string }>>('invalid/codec.expected.json');
    expect(want).toHaveLength(fixture.length);
    for (const [i, line] of fixture.entries()) {
      expect(schemaValid(line), `line ${i + 1} (${want[i].reason}): ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(() => decodeTruthLine(line), `line ${i + 1} (${want[i].reason})`).toThrow(new RegExp(want[i].error));
    }
  });

  it('invalid/chain-*.jsonl: valid lines that are not one stream; the reader refuses the file', () => {
    const chains = expected<Record<string, Array<{ line: number; error: string }>>>('invalid/chain.expected.json');
    for (const [file, want] of Object.entries(chains)) {
      const fixture = lines(`invalid/${file}`);
      for (const line of fixture) expect(schemaValid(line), file).toBe(true);
      const result = parseWikiLines(fixture);
      expect(result.refused, file).toBe(true);
      expect(result.entries, file).toEqual([]);
      for (const w of want) {
        expect(
          result.errors.some((e) => e.line === w.line && e.error.startsWith(w.error)),
          `${file} line ${w.line}: ${JSON.stringify(result.errors)}`,
        ).toBe(true);
      }
    }
  });
});

describe('timestamps (SH-REV-C5)', () => {
  const withTs = (ts: string) => {
    const line = parse(lines('valid/ledger.jsonl')[0]);
    line.ts = ts;
    line.hash = truthLineHash(line);
    return JSON.stringify(line);
  };

  it('refuses a leap second, as stenographer does, and never one the schema refuses', () => {
    for (const ts of ['2026-09-01T10:00:60.000Z', '2026-09-01T23:59:60Z', '2026-09-01T23:59:60.5+00:00']) {
      expect(() => decodeTruthLine(withTs(ts)), ts).toThrow(/leap second/);
    }
    expect(schemaValid(withTs('2026-09-01T10:00:60.000Z'))).toBe(false);
  });

  it('refuses impossible dates and accepts ordinary ones', () => {
    expect(() => decodeTruthLine(withTs('2026-02-30T00:00:00Z'))).toThrow(/^ts:/);
    expect(() => decodeTruthLine(withTs('2026-09-01T24:00:00Z'))).toThrow(/^ts:/);
    expect(() => decodeTruthLine(withTs('2026-09-01T10:00:00+24:00'))).toThrow(/^ts:/);
    expect(decodeTruthLine(withTs('2028-02-29T23:59:59.999+05:30')).version).toBe(2);
  });

  it('refuses a lower-case t or z, as the schema’s pattern and stenographer’s codec do', () => {
    for (const ts of ['2026-09-01t10:00:00.000Z', '2026-09-01T10:00:00.000z']) {
      expect(schemaValid(withTs(ts)), ts).toBe(false);
      expect(() => decodeTruthLine(withTs(ts)), ts).toThrow(/^ts:/);
    }
  });
});

describe('the zero-dependency codec agrees with the JSON Schema', () => {
  // Mutate valid fixture lines one field at a time (re-hashed, so only the
  // mutation is wrong): whatever the codec accepts, the schema must accept,
  // and whatever the schema accepts but the codec refuses must be one of the
  // rules JSON Schema can't express (hash, identity, links), or a leap
  // second, which date-time allows at 23:59 UTC and stenographer's codec
  // refuses (SH-REV-C5).
  const CODEC_ONLY = /anonymous|reserved|control character|cannot carry the link|only the links it writes|contests link|contests field|each link once|hash mismatch|canonicalized|leap second/;
  const valid = ['valid/ledger.jsonl', 'valid/proposals.jsonl', 'valid/unknown.jsonl', 'valid/routing.jsonl'].flatMap((f) => lines(f));
  const POOL: unknown[] = [null, '', ' ', 0, -1, 1, 1.5, 'x', 'Assistant', 'migration', [], {}, true, '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-09-01T10:00:60.000Z', '2026-09-01T23:59:60Z', '2026-09-01T23:59:60+01:00', '2026-09-01t10:00:00z', 'a'.repeat(300), 'ab'.repeat(32), '\u0007'];

  function paths(value: unknown, prefix: Array<string | number> = [], depth = 0): Array<Array<string | number>> {
    if (depth > 3 || typeof value !== 'object' || value === null) return [];
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
    return keys.flatMap((k) => [[...prefix, k], ...paths((value as Record<string, unknown>)[k as string], [...prefix, k], depth + 1)]);
  }

  it('on any single-field mutation', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        fc.constantFrom('delete', 'set', 'add'),
        fc.nat(),
        (lineIndex, pathIndex, op, poolIndex) => {
          const line = parse(valid[lineIndex % valid.length]);
          const all = paths(line);
          const path = all[pathIndex % all.length];
          const parent = path.slice(0, -1).reduce<any>((o, k) => o[k], line);
          const key = path[path.length - 1];
          const value = POOL[poolIndex % POOL.length];
          if (op === 'delete') {
            if (Array.isArray(parent)) parent.splice(key as number, 1);
            else delete parent[key];
          } else if (op === 'set') parent[key] = value;
          else if (typeof parent[key] === 'object' && parent[key] !== null && !Array.isArray(parent[key])) parent[key]['x-new'] = value;
          if (line.schemaVersion !== 2) return; // a version 1 line is the codec's alone
          if (key !== 'hash') line.hash = truthLineHash(line);
          const text = JSON.stringify(line);
          let codecError: string | null = null;
          try {
            decodeTruthLine(text);
          } catch (err) {
            codecError = (err as Error).message;
          }
          const schemaOk = schemaValid(text);
          if (codecError === null) expect(schemaOk, `codec accepted what the schema refuses: ${text}`).toBe(true);
          else if (schemaOk) expect(codecError, text).toMatch(CODEC_ONLY);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
