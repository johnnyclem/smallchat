/**
 * Truth Ledger Interop — Types
 *
 * Consumer-side types for stenographer's TB/UV asserted-truth ledger.
 * @shorthand/core interoperates at the JSONL seam defined by stenographer's
 * truth format v2 (spec/truth-format): signed TB/UV entries arrive as one
 * writer's hash-chained JSONL stream, status changes as appended TRANSITION
 * lines, and compaction may emit candidates back as PROPOSAL lines — never
 * as signed truth. Format-level contract only — no code dependency on
 * stenographer.
 *
 * The design principle that must survive any refactor: TWO AXES, NOT ONE.
 * Every entry carries provenance (where did this come from) and confidence
 * type (how much should you trust it). Collapsing TB and UV back into a
 * single "invariant" bucket is a regression.
 *
 * Fail closed: a status this package does not know is kept verbatim (it
 * round-trips) but never counts as current truth.
 */

import type { WikiParseResult } from './wiki.js';

// ---------------------------------------------------------------------------
// Confidence types & statuses
// ---------------------------------------------------------------------------

/**
 * The confidence axis: TB (asserted tombstone, evidence-backed) vs UV
 * (unverified assertion — "there be dragons").
 */
export type TruthConfidence = 'tb' | 'uv';

/** TB statuses this package understands. `struck` = ruled inadmissible. */
export type TbStatus = 'active' | 'contested' | 'overridden' | 'struck';
/** UV statuses this package understands. `struck` = ruled inadmissible. */
export type UvStatus = 'open' | 'verified' | 'refuted' | 'struck';

/**
 * A status string outside the known vocabulary (a newer stenographer, a
 * typo, a hand edit). Kept verbatim so the line round-trips; always
 * classified as history (excluded from current truth).
 */
export type UnknownStatus = string & { readonly __unknownStatus?: never };

// ---------------------------------------------------------------------------
// Evidence & verification hints (mirrors stenographer src/truth/types.ts)
// ---------------------------------------------------------------------------

/**
 * A piece of evidence attached to a TB. `command` appears only on entries
 * recorded before stenographer 1.0 (version 1 lines read it as
 * `claimed-command`); a newer writer may send kinds this version does not
 * know, which are kept as written.
 */
export interface TruthEvidence {
  kind: 'commit' | 'file' | 'test' | 'command' | 'claimed-command' | 'wiki' | 'message' | (string & {});
  /** Commit sha, file/line, test name, command line, wiki entry id, or message id. */
  ref: string;
  /** What the evidence shows (e.g. captured command output). */
  detail?: string;
}

/**
 * A dead literal a tombstone declares (§12) — what a real-time objection can
 * cite. `subject` names the identifier a bare value belongs to; `current` is
 * the replacement, if any. Mirrors stenographer's `TombstonedLiteralSchema`.
 */
export interface TruthTombstonedLiteral {
  /** The dead value or identifier, e.g. "30" or "legacyRateLimit". */
  dead: string;
  /** The identifier the value belongs to, e.g. "LOG_BUDGET". */
  subject?: string;
  /** What replaced it, if anything. */
  current?: string;
}

/** Machine-actionable verification hint carried by every UV. */
export interface TruthVerifyBy {
  /** Known: command, inspect, ask, observe. Unknown kinds are kept as written. */
  kind: 'command' | 'inspect' | 'ask' | 'observe' | (string & {});
  /** The command to run, file/symbol to read, person to ask, or condition to observe. */
  value: string;
  /** For `inspect`: what to look for. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Wiki JSONL line — the wire format (one entry per line)
// ---------------------------------------------------------------------------

/**
 * A TB or UV line of a truth stream, as stenographer's `export_wiki_entries`
 * emits it (version 2 adds `schemaVersion`, `seq`, `prevHash` and `hash`).
 * Stenographer-specific fields travel under the namespaced `x-steno` key,
 * which short-hand preserves opaquely; a line read from a stream is written
 * back exactly as read.
 */
export interface WikiEntryLine {
  /** Any other key (the v2 chain fields, a newer writer's fields) — carried through verbatim. */
  [key: string]: unknown;
  id: string;
  type: 'TB' | 'UV';
  ts: string;
  author: string;
  // TB fields
  claim?: string;
  evidence?: unknown[];
  signedBy?: string | null;
  /** Matchable dead literals (§12). Absent when the TB declares none. */
  literals?: unknown[];
  // UV fields
  assertion?: string;
  basis?: string;
  verifyBy?: unknown;
  contests?: string | null;
  /** The status when the line was written. Missing or unknown ⇒ not current truth. */
  status?: string;
  /** Stenographer-namespaced extras; preserved opaquely, never interpreted. */
  'x-steno'?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsed entries — the consumer view
// ---------------------------------------------------------------------------

/** A signed, evidence-backed tombstone: ground truth once active. */
export interface TruthTbEntry {
  id: string;
  type: 'TB';
  /** ISO timestamp the entry was asserted. */
  ts: string;
  author: string;
  /** What is dead and what replaces it (if anything). */
  claim: string;
  evidence: TruthEvidence[];
  /** The asserting author (distinct from `author` when an agent drafted and a human signed). Null = unsigned: never truth on its own. */
  signedBy: string | null;
  /**
   * The current status: the highest-seq TRANSITION's, else the line's own.
   * An unknown one is kept verbatim; null means the line had none. Either
   * way the entry is not current truth.
   */
  status: TbStatus | UnknownStatus | null;
  /** Matchable dead literals (§12). Only present when the TB declares some. */
  literals?: TruthTombstonedLiteral[];
  /** Opaque stenographer namespace, preserved for round-tripping. */
  xSteno?: Record<string, unknown>;
  /** Top-level keys this package does not interpret, preserved for round-tripping. */
  extra?: Record<string, unknown>;
  /** Where the entry was read from. Absent on entries built by hand. */
  source?: TruthEntrySource;
  /** Set when the reader will not take the entry as truth whatever its status (see `TruthInadmissible`). */
  inadmissible?: TruthInadmissible;
}

/** An unverified assertion: believed true, stated before verification exists. */
export interface TruthUvEntry {
  id: string;
  type: 'UV';
  ts: string;
  author: string;
  /** The belief, in full sentences. */
  assertion: string;
  /** Why the author believes it. */
  basis: string;
  verifyBy: TruthVerifyBy;
  /** Id of a TB this UV disputes. While the UV is open, it is attached to that TB whatever the TB's recorded status. */
  contests: string | null;
  /** The current status (see `TruthTbEntry.status`). */
  status: UvStatus | UnknownStatus | null;
  xSteno?: Record<string, unknown>;
  /** Top-level keys this package does not interpret, preserved for round-tripping. */
  extra?: Record<string, unknown>;
  /** Where the entry was read from. Absent on entries built by hand. */
  source?: TruthEntrySource;
  /** Set when the reader will not take the entry as truth whatever its status. */
  inadmissible?: TruthInadmissible;
}

export type TruthLedgerEntry = TruthTbEntry | TruthUvEntry;

/** Where a parsed entry came from, and what the fold made of it. */
export interface TruthEntrySource {
  /** 2: a hash-chained line. 1: a stenographer 0.x line (no hash, so a TB is unverifiable). */
  version: 1 | 2;
  /** The entry line exactly as read. Re-serialization writes this back; a reader never rewrites a line. */
  text: string;
  /** 1-based line number in its input (blank lines count). */
  line: number;
  /** v2 only. */
  seq: number | null;
  hash: string | null;
  /** The status the entry line itself states (null when it has none); `status` may have moved on. */
  lineStatus: string | null;
  /** The TRANSITION that set `status`, when one did. */
  transition?: { id: string; seq: number; ts: string; author: string; cause: { kind: string; ref: string | null } };
  /** The file it was read from, when read with `parseWikiFiles`. */
  file?: string;
}

/**
 * Why a reader will not take an entry as truth whatever its status:
 * - `unsigned`: a TB with no signer (the backfill's second-class TB).
 * - `unverifiable`: a version 1 TB (no hash), or, with a signer registry,
 *   an author or signer the registry does not list.
 * - `conflict`: two lines (or two files) give the same id different content.
 */
export interface TruthInadmissible {
  reason: 'unsigned' | 'unverifiable' | 'conflict';
  detail: string;
}

/** A TRANSITION line: an entry's status changed. Kept even when its target is not in the stream read. */
export interface TruthTransition {
  id: string;
  seq: number;
  ts: string;
  author: string;
  /** The TB or UV whose status changed. */
  target: string;
  /** Its new status — an open string; unknown statuses fail closed. */
  status: string;
  /** What changed it: `kind` (contest, override, strike, verify, refute, …) and the causing entry's id. */
  cause: { kind: string; ref: string | null };
  /** 1-based line number in its input. */
  line: number;
  /** The file it was read from, when read with `parseWikiFiles`. */
  file?: string;
}

// ---------------------------------------------------------------------------
// Consumption rules (§7) — the contract downstream consumers must not break
// ---------------------------------------------------------------------------

/** How a consumer (compaction included) must treat an entry. */
export type ConsumptionAction =
  /** Active TB — ground truth. Compact it, rely on it, cite it. */
  | 'ground-truth'
  /** Contested TB — ground truth with a visible asterisk: carry the TB and its contesting UVs. */
  | 'contested'
  /** Open UV — flag, don't block. Never let it read as proven. */
  | 'flag'
  /** Refuted or verified UV, overridden or struck TB, or any unknown status — history, never citable. */
  | 'history';

/** Shipped verbatim from stenographer so consumers inherit identical rules. */
export const CONSUMPTION_RULES = `Consumption rules by confidence type:
- Active TB: treat as ground truth. A reviewer may block on it; a code agent may rely on it.
- Contested TB: ground truth with a visible asterisk — cite both the TB and the contesting UV.
- Open UV: FLAG, DON'T BLOCK. A finding grounded only in a UV is phrased as a question or heads-up, never a demanded change. If your current task would settle the UV cheaply, do so via resolve_uv.
- Refuted UV / overridden TB: retrievable for history, excluded from current-truth by default, never citable as support for a claim.`;

/**
 * Current truth partitioned by consumption action. This is what compaction
 * consumes: `groundTruth` and `contested` survive every compaction level,
 * `unverified` survives with the dragon marker attached, `history` never
 * enters the compacted state (and displaces any cached copy on sync).
 */
export interface TruthSelection {
  /** Active TBs — ground truth. */
  groundTruth: TruthTbEntry[];
  /** Contested TBs paired with their live contesting UVs — carry both. */
  contested: Array<{ tombstone: TruthTbEntry; contestedBy: TruthUvEntry[] }>;
  /**
   * Open UVs — flagged, never presented as proven. Contesting UVs appear
   * here as well as beside their contested TB; renderers show each open UV
   * once (beside its TB when the TB is in `contested`, standalone otherwise).
   */
  unverified: TruthUvEntry[];
  /** Overridden/struck TBs, refuted/verified/struck UVs, unknown or missing statuses, inadmissible entries — excluded from current truth. */
  history: TruthLedgerEntry[];
}

// ---------------------------------------------------------------------------
// Compacted truth — how a selection rides a CompactedState
// ---------------------------------------------------------------------------

/**
 * The truth section attached to a compacted state. It is rebuilt from the
 * current ledger selection on every compaction round — never carried
 * forward as text — so an entry that was overridden or refuted since the
 * last sync is displaced instead of surviving as a stale cache.
 */
export interface CompactedTruth {
  /** ISO timestamp of the sync that produced this section. */
  syncedAt: string;
  /** Active TBs — compacted as ground truth. */
  groundTruth: TruthTbEntry[];
  /** Contested TBs with their contesting UVs — both carried, dispute visible. */
  contested: Array<{ tombstone: TruthTbEntry; contestedBy: TruthUvEntry[] }>;
  /** Open UVs — carried with the unverified marker, never as proven fact. */
  unverified: TruthUvEntry[];
  /** How many ledger entries were considered (including excluded history). */
  sourceEntryCount: number;
}

/** What `CompactionEngine.syncTruthLedger` returns. */
export interface TruthSyncResult {
  /** The current-truth selection the engine now renders first in every frame. */
  selection: TruthSelection;
  /** L4 invariants removed because their backing ledger entry is no longer ground truth. */
  displacedInvariantKeys: string[];
  /** Lines refused, and chain breaks. With a v2 stream, any of them refuses the whole stream. */
  errors: Array<{ line: number; error: string; id?: string; file?: string }>;
  /** True when the stream was refused: the selection is empty and nothing it said is truth. */
  refused: boolean;
  /**
   * The stream this sync read (null when it was given entries, or refused).
   * To sync only the lines after it next time, pass it as `{ base }`.
   */
  read: WikiParseResult | null;
}

// ---------------------------------------------------------------------------
// L4 projection marker
// ---------------------------------------------------------------------------

/**
 * Prefix marking an invariant as projected from a ledger entry
 * (`Invariant.sourceMessage` / `TruthInvariantRecord.key`). It is the
 * displacement hook: a projected invariant whose entry is no longer ground
 * truth is removed on the next sync, and proposal export skips it.
 */
export const TRUTH_SOURCE_PREFIX = 'truth:';

// ---------------------------------------------------------------------------
// Outbound PROPOSAL lines — the only write path @shorthand/core has
// ---------------------------------------------------------------------------

/** What triggered a proposal (suite PROPOSAL envelope, `signal.source`). */
export type ProposalSignalSource = 'compaction-candidate' | 'agent' | `detector:${string}`;

/**
 * Fields every PROPOSAL line carries: the suite PROPOSAL envelope
 * (spec/truth-format, "The PROPOSAL envelope"). `seq`, `prevHash` and
 * `hash` are added when the line is written to a proposals stream
 * (`ProposalStream`, `serializeProposals`, `appendProposalsFile`): a
 * proposals file is one writer's hash-chained stream, like a wiki file.
 */
interface ProposalEnvelope {
  schemaVersion: 2;
  type: 'PROPOSAL';
  /** ULID — sortable, unique. */
  id: string;
  ts: string;
  /** Accountable author: a person, an agent identity, or a `detector:<name>` pipeline. */
  author: string;
  /** What the proposal is about — the entity, invariant or message it targets. */
  targetRef: string | null;
  /** What triggered the proposal. */
  signal: {
    source: ProposalSignalSource;
    detail?: string;
  };
  /** Agent session lineage, for provenance-independence checks downstream. */
  agentSessionId?: string | null;
  /** Position in the proposals stream; set when written. */
  seq?: number;
  /** The previous line's hash (null on seq 1); set when written. */
  prevHash?: string | null;
  /** sha256 of the line's JCS form without `hash`; set when written. */
  hash?: string;
}

/** The UV body a `kind: 'uv'` proposal drafts. */
export interface UvProposalDraft {
  assertion: string;
  basis: string;
  verifyBy: TruthVerifyBy;
  /** The TB this UV would dispute, if any. */
  contests?: string | null;
}

/** The TB body a `kind: 'tb'` proposal drafts. Unsigned by construction: a person signs it in stenographer. */
export interface TbProposalDraft {
  claim: string;
  evidence: TruthEvidence[];
  literals?: TruthTombstonedLiteral[];
}

/** A candidate unverified assertion. */
export interface UvProposalLine extends ProposalEnvelope {
  kind: 'uv';
  draft: UvProposalDraft;
}

/** A candidate tombstone. Nothing becomes truth until a named person signs it. */
export interface TbProposalLine extends ProposalEnvelope {
  kind: 'tb';
  draft: TbProposalDraft;
}

/**
 * One PROPOSAL line, in the suite's single envelope. Stenographer files it
 * as a PROPOSAL; nothing becomes truth until a named author signs it on
 * the stenographer side.
 */
export type ProposalLine = UvProposalLine | TbProposalLine;

/** A PROPOSAL line as written in a stream: its chain fields are set. */
export type WrittenProposalLine = ProposalLine & { seq: number; prevHash: string | null; hash: string };

/** @deprecated Use `UvProposalLine` (or `ProposalLine`). Kept for smallchat's re-export. */
export type InvariantProposalLine = UvProposalLine;

// ---------------------------------------------------------------------------
// ULID (Crockford base32, time-prefixed) — no new dependency
// ---------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRandom: number[] = [];

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }

  let rand: number[];
  if (now === lastTime) {
    // Monotonic within the same millisecond: increment the random part
    rand = [...lastRandom];
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }
  lastTime = now;
  lastRandom = rand;

  return time + rand.map((v) => B32[v]).join('');
}
