/**
 * Truth Ledger Interop — JSONL codec and consumption-rule selection
 *
 * Reads and writes stenographer's append-only wiki JSONL format
 * losslessly. One entry per line; later lines for the same id supersede
 * earlier ones (the ledger is append-only, so a status change arrives as
 * a re-emitted line). Fields short-hand does not interpret — the
 * namespaced `x-steno` key in particular — are preserved byte-for-byte
 * modulo JSON key order, so `serializeWikiEntries(parseWikiLines(lines))`
 * round-trips.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type {
  ConsumptionAction,
  TbStatus,
  TruthEvidence,
  TruthLedgerEntry,
  TruthSelection,
  TruthTbEntry,
  TruthUvEntry,
  TruthVerifyBy,
  UvStatus,
  WikiEntryLine,
} from './types.js';

// ---------------------------------------------------------------------------
// Line ↔ entry conversion
// ---------------------------------------------------------------------------

const TB_STATUSES: readonly TbStatus[] = ['active', 'contested', 'overridden'];
const UV_STATUSES: readonly UvStatus[] = ['open', 'verified', 'refuted'];

export function wikiLineToEntry(line: WikiEntryLine): TruthLedgerEntry {
  if (!line.id || typeof line.id !== 'string') {
    throw new Error('wiki entry is missing an id');
  }

  if (line.type === 'TB') {
    const status = TB_STATUSES.includes(line.status as TbStatus)
      ? (line.status as TbStatus)
      : 'active';
    const entry: TruthTbEntry = {
      id: line.id,
      type: 'TB',
      ts: line.ts ?? '',
      author: line.author ?? '',
      claim: line.claim ?? '',
      evidence: (line.evidence as TruthEvidence[]) ?? [],
      signedBy: line.signedBy ?? null,
      status,
    };
    if (line['x-steno'] !== undefined) entry.xSteno = line['x-steno'];
    return entry;
  }

  if (line.type === 'UV') {
    const status = UV_STATUSES.includes(line.status as UvStatus)
      ? (line.status as UvStatus)
      : 'open';
    const entry: TruthUvEntry = {
      id: line.id,
      type: 'UV',
      ts: line.ts ?? '',
      author: line.author ?? '',
      assertion: line.assertion ?? '',
      basis: line.basis ?? '',
      verifyBy: (line.verifyBy as TruthVerifyBy) ?? { kind: 'ask', value: line.author ?? '' },
      contests: line.contests ?? null,
      status,
    };
    if (line['x-steno'] !== undefined) entry.xSteno = line['x-steno'];
    return entry;
  }

  throw new Error(`unsupported entry type: ${String((line as { type?: unknown }).type)}`);
}

export function entryToWikiLine(entry: TruthLedgerEntry): WikiEntryLine {
  const base = {
    id: entry.id,
    type: entry.type,
    ts: entry.ts,
    author: entry.author,
  };

  if (entry.type === 'TB') {
    const line: WikiEntryLine = {
      ...base,
      claim: entry.claim,
      evidence: entry.evidence,
      signedBy: entry.signedBy,
      status: entry.status,
    };
    if (entry.xSteno !== undefined) line['x-steno'] = entry.xSteno;
    return line;
  }

  const line: WikiEntryLine = {
    ...base,
    assertion: entry.assertion,
    basis: entry.basis,
    verifyBy: entry.verifyBy,
    contests: entry.contests,
    status: entry.status,
  };
  if (entry.xSteno !== undefined) line['x-steno'] = entry.xSteno;
  return line;
}

// ---------------------------------------------------------------------------
// Parsing & serialization
// ---------------------------------------------------------------------------

export interface WikiParseResult {
  /** Deduplicated entries — the LAST line for each id wins (append-only ledger). */
  entries: TruthLedgerEntry[];
  /** Lines that could not be parsed; the rest of the file is still usable. */
  errors: Array<{ line: number; error: string }>;
}

/** Parse raw JSONL lines (or one blob with newlines) into ledger entries. */
export function parseWikiLines(input: string | string[]): WikiParseResult {
  const lines = Array.isArray(input) ? input : input.split('\n');
  const byId = new Map<string, TruthLedgerEntry>();
  const errors: WikiParseResult['errors'] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw.length === 0) continue;
    try {
      const entry = wikiLineToEntry(JSON.parse(raw) as WikiEntryLine);
      // Later lines supersede earlier ones; re-insert to keep append order.
      byId.delete(entry.id);
      byId.set(entry.id, entry);
    } catch (err) {
      errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { entries: Array.from(byId.values()), errors };
}

/** Serialize entries back to JSONL lines (no trailing newline handling). */
export function serializeWikiEntries(entries: TruthLedgerEntry[]): string[] {
  return entries.map((e) => JSON.stringify(entryToWikiLine(e)));
}

/** Read and parse a wiki JSONL file. */
export function readWikiFile(path: string): WikiParseResult {
  return parseWikiLines(readFileSync(path, 'utf8'));
}

/** Write entries to a wiki JSONL file (one entry per line). */
export function writeWikiFile(path: string, entries: TruthLedgerEntry[]): void {
  writeFileSync(path, serializeWikiEntries(entries).map((l) => l + '\n').join(''));
}

// ---------------------------------------------------------------------------
// Consumption rules (§7)
// ---------------------------------------------------------------------------

/** Classify a single entry per the §7 consumption rules. */
export function classifyEntry(entry: TruthLedgerEntry): ConsumptionAction {
  if (entry.type === 'TB') {
    if (entry.status === 'active') return 'ground-truth';
    if (entry.status === 'contested') return 'contested';
    return 'history'; // overridden
  }
  // UV: open is a flag; verified minted a TB elsewhere, refuted is dead —
  // both are history here.
  return entry.status === 'open' ? 'flag' : 'history';
}

/**
 * Partition ledger entries into the selection compaction consumes.
 * Contested TBs are paired with their live contesting UVs so both carry
 * through compaction — the dispute is never resolved silently.
 */
export function selectCurrentTruth(entries: TruthLedgerEntry[]): TruthSelection {
  const selection: TruthSelection = {
    groundTruth: [],
    contested: [],
    unverified: [],
    history: [],
  };

  const openContestsByTb = new Map<string, TruthUvEntry[]>();
  for (const entry of entries) {
    if (entry.type === 'UV' && entry.status === 'open' && entry.contests) {
      const list = openContestsByTb.get(entry.contests) ?? [];
      list.push(entry);
      openContestsByTb.set(entry.contests, list);
    }
  }

  for (const entry of entries) {
    switch (classifyEntry(entry)) {
      case 'ground-truth':
        selection.groundTruth.push(entry as TruthTbEntry);
        break;
      case 'contested':
        selection.contested.push({
          tombstone: entry as TruthTbEntry,
          contestedBy: openContestsByTb.get(entry.id) ?? [],
        });
        break;
      case 'flag':
        selection.unverified.push(entry as TruthUvEntry);
        break;
      case 'history':
        selection.history.push(entry);
        break;
    }
  }

  return selection;
}
