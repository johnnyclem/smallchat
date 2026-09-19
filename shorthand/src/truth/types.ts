/**
 * Truth Ledger Interop — Types
 *
 * Consumer-side types for stenographer's TB/UV v2 asserted-truth ledger
 * (stenographer PR #7). Short-hand interoperates at the JSONL seam
 * (Option B of the convergence decision): signed TB/UV entries arrive as
 * append-only JSONL wiki lines, and compaction may emit candidate
 * invariants back as PROPOSAL lines — never as signed truth.
 *
 * The design principle that must survive any refactor: TWO AXES, NOT ONE.
 * Every entry carries provenance (where did this come from) and confidence
 * type (how much should you trust it). Collapsing TB and UV back into a
 * single "invariant" bucket is a regression.
 */

// ---------------------------------------------------------------------------
// Confidence types & statuses
// ---------------------------------------------------------------------------

/**
 * The confidence axis: TB (asserted tombstone, evidence-backed) vs UV
 * (unverified assertion — "there be dragons").
 */
export type TruthConfidence = 'tb' | 'uv';

export type TbStatus = 'active' | 'contested' | 'overridden';
export type UvStatus = 'open' | 'verified' | 'refuted';

// ---------------------------------------------------------------------------
// Evidence & verification hints (mirrors stenographer src/truth/types.ts)
// ---------------------------------------------------------------------------

/** A piece of evidence attached to a TB. */
export interface TruthEvidence {
  kind: 'commit' | 'file' | 'test' | 'command' | 'wiki' | 'message';
  /** Commit sha, file/line, test name, command line, wiki entry id, or message id. */
  ref: string;
  /** What the evidence shows (e.g. captured command output). */
  detail?: string;
}

/** Machine-actionable verification hint carried by every UV. */
export interface TruthVerifyBy {
  kind: 'command' | 'inspect' | 'ask' | 'observe';
  /** The command to run, file/symbol to read, person to ask, or condition to observe. */
  value: string;
  /** For `inspect`: what to look for. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Wiki JSONL line — the wire format (one entry per line)
// ---------------------------------------------------------------------------

/**
 * One line of the append-only JSONL truth ledger, exactly as stenographer's
 * `export_wiki_entries` emits it. Stenographer-specific fields travel under
 * the namespaced `x-steno` key, which short-hand preserves opaquely so the
 * round-trip invariant `serialize(parse(line)) == line` holds field-for-field.
 */
export interface WikiEntryLine {
  id: string;
  type: 'TB' | 'UV';
  ts: string;
  author: string;
  // TB fields
  claim?: string;
  evidence?: unknown[];
  signedBy?: string | null;
  // UV fields
  assertion?: string;
  basis?: string;
  verifyBy?: unknown;
  contests?: string | null;
  status: string;
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
  /** The asserting author (distinct from `author` when an agent drafted and a human signed). */
  signedBy: string | null;
  status: TbStatus;
  /** Opaque stenographer namespace, preserved for round-tripping. */
  xSteno?: Record<string, unknown>;
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
  /** Id of a TB this UV disputes — puts that TB into `contested`. */
  contests: string | null;
  status: UvStatus;
  xSteno?: Record<string, unknown>;
}

export type TruthLedgerEntry = TruthTbEntry | TruthUvEntry;

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
  /** Refuted UV / overridden TB / verified UV — history, never citable. */
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
  /** Open UVs — flagged, never presented as proven. */
  unverified: TruthUvEntry[];
  /** Overridden TBs, refuted/verified UVs — excluded from current truth. */
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

// ---------------------------------------------------------------------------
// Authorship — no anonymous write path
// ---------------------------------------------------------------------------

/**
 * Identities that cannot stand behind anything. Proposal emission carrying
 * one is rejected at the schema level — mirrors stenographer's floor.
 */
const ANONYMOUS_IDENTITIES = new Set([
  '',
  'system',
  'assistant',
  'agent',
  'ai',
  'bot',
  'anonymous',
  'unknown',
  'user',
  'human',
  'admin',
  'null',
  'none',
  'me',
]);

export function isAnonymousIdentity(identity: string): boolean {
  return ANONYMOUS_IDENTITIES.has(identity.trim().toLowerCase());
}

/** Throws unless `author` is a specific, accountable identity. */
export function assertAccountableAuthor(author: string): void {
  if (isAnonymousIdentity(author)) {
    throw new Error(
      `anonymous or generic identities cannot write toward the truth ledger ` +
        `(got ${JSON.stringify(author)}) — use a registered human handle or agent identity`,
    );
  }
}

// ---------------------------------------------------------------------------
// Outbound PROPOSAL lines — the only write path short-hand has
// ---------------------------------------------------------------------------

/**
 * A candidate invariant emitted by compaction as a machine-drafted proposal.
 * Stenographer ingests these as `PROPOSAL(kind: 'uv')` entries; nothing
 * becomes truth until a named author signs it on the stenographer side.
 */
export interface InvariantProposalLine {
  type: 'PROPOSAL';
  kind: 'uv';
  /** ULID — sortable, unique. */
  id: string;
  ts: string;
  /** Accountable author — anonymous identities are rejected. */
  author: string;
  /** The UV body this proposal drafts. */
  draft: {
    assertion: string;
    basis: string;
    verifyBy: TruthVerifyBy;
  };
  /** What triggered the proposal. */
  signal: {
    source: 'shorthand-compaction';
    detail?: string;
  };
  /** Dedupe key — the entity/decision this proposal targets. */
  targetRef?: string | null;
  /** Agent session lineage, for provenance-independence checks downstream. */
  agentSessionId?: string | null;
}

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
