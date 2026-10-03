/**
 * Truth Ledger Interop — the agent quorum (stenographer spec/truth-format,
 * "Agent quorum")
 *
 * Agents settle claims only together: two or more agent sessions agreeing
 * from different angles at the same time. An agent on its own can only
 * attest. A settlement by agents — an ADDENDUM verifying or refuting a UV,
 * or a TB an agent signs — is valid only when its line carries a `quorum`:
 * one member per agreeing session, each with the evidence it brought.
 *
 * The rules (spec numbering):
 *   1. Two or more members, from distinct agent sessions, each an
 *      accountable identity.
 *   2. The writer is a member; a TB is signed by its writer.
 *   3. From different angles: every member cites settling evidence, no
 *      evidence item appears in two members (in any spelling: refs compare
 *      normalized for their kind), and the members' settling evidence spans
 *      two kinds or more. A kind the reader doesn't know is an unknown
 *      value, not a broken rule: it may be a newer writer's settling kind,
 *      so it never makes a line fail these clauses.
 *   4. At the same time: the members' and the line's timestamps lie within
 *      15 minutes of each other, read to the millisecond.
 *   5. Agreeing: an ADDENDUM's members agree, and carry the verdict each of
 *      its resolution links applies (those its `x-steno.links` lists: a
 *      top-level `links` is an unknown field), and a quorum never overrides. A TB
 *      carries the literals its members agreed on. (That the members
 *      drafted those literals is the writer's obligation: no reader sees
 *      the drafts.)
 *   6. The line shows its evidence: the members' items, and no others.
 *
 * Sessions and refs are trimmed of Unicode White_Space only, so every codec
 * trims the same characters. `checkQuorum` is line-local, like the link
 * rules: `decodeTruthLine` refuses a line that breaks it. Who is an agent —
 * an identity a signer registry lists with role `agent`, else one whose
 * key starts with `agent:` — is the reader's admission rule (wiki.ts): a TB
 * an agent signs is truth only with a quorum whose members are all agents.
 * The reader also fails closed where these rules can't: an agent's TB that
 * cites an evidence kind it doesn't know is never truth (`unknown-value`).
 * The reference is stenographer's src/truth/quorum.ts; the golden fixtures
 * pin this one to it.
 */

import { identityIssue, identityKey } from './identity.js';
import { isRfc3339 } from './time.js';
import { EVIDENCE_KINDS, SETTLING_EVIDENCE_KINDS, evidenceClass, type TruthQuorumMember } from './types.js';

/** Members' and the line's timestamps lie within this of each other: 15 minutes. */
export const QUORUM_WINDOW_MS = 900_000;
/** The fewest agent sessions that settle a claim together. */
export const QUORUM_MIN_MEMBERS = 2;

/** Without a signer registry, an agent is an identity whose key starts with this. */
export const AGENT_PREFIX = 'agent:';

/** The rule a reader applies without a signer registry: the identity's key starts with `agent:`. */
export function hasAgentPrefix(identity: string): boolean {
  return typeof identity === 'string' && identityKey(identity).startsWith(AGENT_PREFIX);
}

/** What a resolution link applies to its UV. */
const VERDICT_OF: Record<string, 'verified' | 'refuted'> = { verifies: 'verified', refutes: 'refuted' };

/**
 * Removes leading and trailing Unicode White_Space: the characters every
 * codec trims from a quorum member's session and an evidence ref. (Not
 * String.prototype.trim, which also removes U+FEFF and keeps U+0085.)
 */
function trimWhiteSpace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

/** An evidence item as rule 6 compares it: its kind and its ref, the ref trimmed. */
function evidenceKey(item: { kind: string; ref: string }): string {
  return JSON.stringify([item.kind, trimWhiteSpace(item.ref)]);
}

/**
 * A ref as rule 3 compares it, normalized for its kind so that one piece of
 * evidence spelled two ways is one item: a `commit` lowercased; a `file`
 * path with `\` read as `/` and empty and `.` segments dropped (`./src//x.ts`
 * is `src/x.ts`; a leading `/` stays); a `test` or `claimed-command` with
 * each run of White_Space read as one space. Every ref is trimmed first.
 */
function evidenceRefKey(item: { kind: string; ref: string }): string {
  const ref = trimWhiteSpace(item.ref);
  switch (item.kind) {
    case 'commit':
      return ref.toLowerCase();
    case 'file': {
      const segments = ref.replace(/\\/g, '/').split('/');
      const absolute = segments[0] === '';
      const kept = segments.filter((s) => s !== '' && s !== '.');
      return (absolute ? '/' : '') + kept.join('/');
    }
    case 'test':
    case 'claimed-command':
      return ref.replace(/\p{White_Space}+/gu, ' ');
    default:
      return ref;
  }
}

/**
 * Whether two evidence items are the same evidence (rule 3): the same kind,
 * and refs equal once normalized for it, where a `commit` one that is a
 * prefix of the other also counts (an abbreviated hash).
 */
function sameEvidence(a: { kind: string; ref: string }, b: { kind: string; ref: string }): boolean {
  if (a.kind !== b.kind) return false;
  const x = evidenceRefKey(a);
  const y = evidenceRefKey(b);
  return x === y || (a.kind === 'commit' && x.length > 0 && y.length > 0 && (x.startsWith(y) || y.startsWith(x)));
}

/** Whether this version knows an evidence kind; one it doesn't know may be a newer writer's settling kind. */
const isKnownKind = (kind: string) => (EVIDENCE_KINDS as readonly string[]).includes(kind);

/**
 * A timestamp as rule 4 reads it: to the millisecond, any further
 * fractional digits dropped (not rounded). NaN when it isn't one.
 */
function quorumTime(ts: string): number {
  return Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
}

const describeItem = (item: { kind: string; ref: string }) => `${item.kind} ${trimWhiteSpace(item.ref)}`;

/**
 * What `checkQuorum` reads: a wiki line, or the parts of one. Any parsed
 * line object will do: it reads the fields below and no others, so a field
 * this version doesn't define never hides a rule or triggers one, a
 * top-level `links` among them (spec: Unknown values).
 */
export interface TruthQuorumSubject {
  type?: unknown;
  id?: unknown;
  author?: unknown;
  ts?: unknown;
  evidence?: unknown;
  quorum?: unknown;
  signedBy?: unknown;
  /** A TB's literals: a quorum TB carries the ones its members agreed on. */
  literals?: unknown;
  /**
   * Where an ADDENDUM's links are read (rule 5): `x-steno.links`, those
   * starting at `id`. Absent, or no list there: the line lists no link.
   */
  'x-steno'?: unknown;
}

function isEvidenceList(value: unknown): value is Array<{ kind: string; ref: string }> {
  return (
    Array.isArray(value) &&
    value.every((e) => e && typeof e === 'object' && typeof (e as { kind: unknown }).kind === 'string' && typeof (e as { ref: unknown }).ref === 'string')
  );
}

/**
 * The links an ADDENDUM writes, as rule 5 reads them: the ones its
 * `x-steno.links` lists starting at its `id` (spec: Agent quorum, "on an
 * ADDENDUM, rule 5 reads the links in `x-steno.links`"). Nothing else on the
 * line: a top-level `links` is a field this version doesn't define.
 */
function linksOf(subject: TruthQuorumSubject): ReadonlyArray<{ type: unknown }> {
  const x = subject['x-steno'] as { links?: unknown } | undefined;
  if (!x || typeof x !== 'object' || !Array.isArray(x.links)) return [];
  return (x.links as unknown[]).filter(
    (l): l is { type: unknown; fromId: unknown } => !!l && typeof l === 'object' && (l as { fromId?: unknown }).fromId === subject.id,
  );
}

/**
 * For a line that carries a `quorum`, the rules it breaks, each as one
 * message naming its rule; empty when it keeps them all. A member that
 * isn't shaped as the schema says is reported first, mostly without a
 * rule number. Call it only on such a line: on a TB or ADDENDUM without a
 * `quorum` it reports that a quorum is an array of members, and on any
 * other line that a quorum doesn't belong there, though neither line
 * breaks a rule. Line-local: a reader needs nothing but the line. That a
 * TB's members drafted the literals it carries (rule 5) is the writer's
 * obligation, not checked here; that it carries some is. `decodeTruthLine`
 * calls it only on a line with a `quorum`, and refuses that line when this
 * returns anything.
 */
export function checkQuorum(subject: TruthQuorumSubject): string[] {
  if (subject.type !== 'TB' && subject.type !== 'ADDENDUM') {
    return [`a quorum appears only on TB and ADDENDUM lines, not on a ${String(subject.type)} line`];
  }
  const raw = subject.quorum;
  if (!Array.isArray(raw)) return ['a quorum is an array of members'];

  // The members' shape, before any rule can be read
  const shape: string[] = [];
  raw.forEach((m, i) => {
    const n = i + 1;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return void shape.push(`quorum member ${n} is not an object`);
    const member = m as Record<string, unknown>;
    if (typeof member.author !== 'string') shape.push(`quorum member ${n} has no author`);
    if (typeof member.agentSessionId !== 'string') shape.push(`quorum member ${n} has no agent session (rule 1)`);
    if (typeof member.ts !== 'string' || !isRfc3339(member.ts)) shape.push(`quorum member ${n}'s ts is not an RFC 3339 date-time`);
    if (!isEvidenceList(member.evidence) || member.evidence.length === 0) shape.push(`quorum member ${n} cites no evidence`);
    if (subject.type === 'ADDENDUM' && member.verdict !== 'verified' && member.verdict !== 'refuted') {
      shape.push(`quorum member ${n}'s verdict is verified or refuted`);
    }
  });
  if (shape.length > 0) return shape;
  const members = raw as TruthQuorumMember[];
  const issues: string[] = [];

  // Rule 1: two or more, distinct sessions, accountable identities
  if (members.length < QUORUM_MIN_MEMBERS) {
    issues.push(`a quorum needs at least ${QUORUM_MIN_MEMBERS} members, and this one has ${members.length} (rule 1)`);
  }
  const sessions = new Map<string, number>();
  members.forEach((m, i) => {
    const session = trimWhiteSpace(m.agentSessionId);
    if (session.length === 0) {
      issues.push(`quorum member ${i + 1} names no agent session (rule 1)`);
    } else if (sessions.has(session)) {
      issues.push(`quorum members ${sessions.get(session)} and ${i + 1} share agent session ${session}: one session is one witness (rule 1)`);
    } else {
      sessions.set(session, i + 1);
    }
    const who = identityIssue(m.author);
    if (who) issues.push(`quorum member ${i + 1}: ${who} (rule 1)`);
  });

  // Rule 2: the writer is a member; a TB is signed by its writer
  const author = typeof subject.author === 'string' ? subject.author : '';
  if (!members.some((m) => identityKey(m.author) === identityKey(author))) {
    issues.push(`the line's author ${author} is not a quorum member: the agent whose attestation completed the quorum writes it (rule 2)`);
  }
  if (subject.type === 'TB' && (typeof subject.signedBy !== 'string' || identityKey(subject.signedBy) !== identityKey(author))) {
    issues.push(`a quorum TB is signed by its author (rule 2): signedBy ${String(subject.signedBy)} is not ${author}`);
  }

  // Rule 3: from different angles. A kind this version doesn't know may be a
  // newer writer's settling kind: an unknown value, which never refuses a line
  const settlingKinds = new Set<string>();
  const unknownKinds = members.some((m) => m.evidence.some((e) => !isKnownKind(e.kind)));
  members.forEach((m, i) => {
    const settling = m.evidence.filter((e) => evidenceClass(e.kind) === 'settling');
    if (settling.length === 0 && m.evidence.every((e) => isKnownKind(e.kind))) {
      issues.push(`quorum member ${i + 1} cites no settling evidence (${SETTLING_EVIDENCE_KINDS.join(', ')}) (rule 3)`);
    }
    for (const e of settling) settlingKinds.add(e.kind);
  });
  members.forEach((m, i) => {
    for (let j = 0; j < i; j++) {
      const shared = m.evidence.find((e) => members[j].evidence.some((o) => sameEvidence(e, o)));
      if (shared) {
        issues.push(`quorum members ${j + 1} and ${i + 1} both cite ${describeItem(shared)}: each member brings evidence of its own (rule 3)`);
        break;
      }
    }
  });
  if (settlingKinds.size === 1 && !unknownKinds) {
    issues.push(`a quorum's settling evidence spans at least two settling kinds, and this one cites only ${[...settlingKinds][0]} (rule 3)`);
  }

  // Rule 4: at the same time, to the millisecond
  const times = [...members.map((m) => m.ts), subject.ts].map((t) => (typeof t === 'string' ? quorumTime(t) : NaN));
  if (times.some((t) => !Number.isFinite(t))) {
    issues.push(`the line's ts is not a timestamp (rule 4)`);
  } else {
    const span = Math.max(...times) - Math.min(...times);
    if (span > QUORUM_WINDOW_MS) {
      issues.push(`the quorum's members and its line lie more than 15 minutes apart (${span} ms) (rule 4)`);
    }
  }

  // Rule 5: agreeing. An ADDENDUM's verdicts agree, with each other and with
  // the links it lists (one that lists no resolution link, or only types this
  // version doesn't know, is checked for agreeing verdicts only); a TB
  // carries the literals its members agreed on
  if (subject.type === 'TB' && (!Array.isArray(subject.literals) || subject.literals.length === 0)) {
    issues.push('a quorum TB carries the literals its members agreed on (literals, at least one) (rule 5)');
  }
  if (subject.type === 'ADDENDUM') {
    const verdicts = new Set(members.map((m) => m.verdict));
    if (verdicts.size > 1) issues.push(`the quorum's members disagree: ${[...verdicts].join(' and ')} (rule 5)`);
    const links = linksOf(subject);
    if (links.some((l) => l.type === 'overrides')) {
      issues.push("a quorum ADDENDUM never overrides a TB: overriding is a person's act (rule 5)");
    }
    for (const type of links.map((l) => l.type)) {
      if (typeof type !== 'string' || !Object.hasOwn(VERDICT_OF, type)) continue;
      members.forEach((m, i) => {
        if (m.verdict !== VERDICT_OF[type]) {
          issues.push(`quorum member ${i + 1}'s verdict ${m.verdict} is not the one its line's ${type} link applies (${VERDICT_OF[type]}) (rule 5)`);
        }
      });
    }
  }

  // Rule 6: the line's evidence is the members' evidence (items compare by kind and trimmed ref)
  if (!isEvidenceList(subject.evidence)) {
    issues.push(`the line's evidence is not an evidence list (rule 6)`);
  } else {
    const citedBy = new Set(members.flatMap((m) => m.evidence.map(evidenceKey)));
    const shown = new Set(subject.evidence.map(evidenceKey));
    members.forEach((m, i) => {
      for (const e of m.evidence) {
        if (!shown.has(evidenceKey(e))) issues.push(`the line's evidence lacks quorum member ${i + 1}'s ${describeItem(e)} (rule 6)`);
      }
    });
    for (const e of subject.evidence) {
      if (!citedBy.has(evidenceKey(e))) issues.push(`the line's evidence holds ${describeItem(e)}, which no quorum member cites (rule 6)`);
    }
  }
  return issues;
}
