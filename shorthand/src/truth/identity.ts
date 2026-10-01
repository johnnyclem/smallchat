/**
 * Truth Ledger Interop — identities (spec/truth-format, "Identities")
 *
 * `author` and `signedBy` name someone who stands behind an entry. A reader
 * refuses a line whose identity is anonymous or generic, contains a control
 * character, or is reserved where it doesn't belong (`migration` authors
 * only an unsigned backfilled TB; `detector:*` authors only PROPOSAL lines;
 * a TRANSITION takes its cause's author, so it is never reserved).
 * Identities compare by key — Unicode NFKC, default-ignorable code points
 * removed, trimmed, lowercased — so `Assistant`, `ａｓｓｉｓｔａｎｔ` and
 * `assis​tant` are all refused, and `Alice` and `alice` are one person.
 * Lines keep identities as written.
 *
 * The optional signer registry is the one stenographer's import uses
 * (`signers.json`): an allowlist of names and roles, not a credential
 * store. Nothing here authenticates anyone; a hash chain shows lines are
 * unchanged, not who wrote them.
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

/** Reserved for the backfill of pre-assertion tombstones (an unsigned TB). */
export const MIGRATION_AUTHOR = 'migration';

/** Reserved prefix for the pipelines that file proposals. */
export const DETECTOR_PREFIX = 'detector:';

/**
 * The comparison form of an identity: NFKC (full-width and ligature
 * look-alikes fold), default-ignorable code points removed, trimmed,
 * lowercased.
 */
export function identityKey(identity: string): string {
  return identity
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim()
    .toLowerCase();
}

export function isAnonymousIdentity(identity: string): boolean {
  return ANONYMOUS_IDENTITIES.has(identityKey(identity));
}

/** `migration` and `detector:*` belong to internal write paths only. */
export function isReservedIdentity(identity: string): boolean {
  const key = identityKey(identity);
  return key === MIGRATION_AUTHOR || key.startsWith(DETECTOR_PREFIX);
}

/** Control characters (Unicode Cc: newlines, escapes) have no place in a name someone stands behind. */
export function hasControlCharacters(identity: string): boolean {
  return /\p{Cc}/u.test(identity);
}

/**
 * Why `identity` can't stand behind a line, or null when it can.
 * `reserved: 'detector'` admits `detector:*` (PROPOSAL authors).
 */
export function identityIssue(identity: unknown, options: { reserved?: 'detector' } = {}): string | null {
  if (typeof identity !== 'string') return 'an identity is a string';
  if (isAnonymousIdentity(identity)) {
    return `anonymous or generic identities cannot assert truth (got ${JSON.stringify(identity)}) — use a registered human handle or agent identity`;
  }
  if (hasControlCharacters(identity)) return `identities cannot contain control characters (got ${JSON.stringify(identity)})`;
  if (isReservedIdentity(identity)) {
    const detector = identityKey(identity).startsWith(DETECTOR_PREFIX);
    if (options.reserved === 'detector' && detector) return null;
    return `'${MIGRATION_AUTHOR}' and '${DETECTOR_PREFIX}*' are reserved for the backfill and detector paths (got ${JSON.stringify(identity)})`;
  }
  return null;
}

/**
 * Throws unless `author` may write a PROPOSAL line: a specific, accountable
 * identity (a person's handle, an agent identity, or a `detector:<name>`
 * pipeline) — never anonymous, generic, `migration`, or containing a
 * control character.
 */
export function assertAccountableAuthor(author: string): void {
  const issue = identityIssue(author, { reserved: 'detector' });
  if (!issue) return;
  throw new Error(
    issue.startsWith('anonymous')
      ? `anonymous or generic identities cannot write toward the truth ledger (got ${JSON.stringify(author)}) — use a registered human handle or agent identity`
      : issue,
  );
}

// ---------------------------------------------------------------------------
// Signer registry (signers.json)
// ---------------------------------------------------------------------------

export type TruthSignerRole = 'human' | 'agent' | 'detector';

export interface TruthSigner {
  /** The handle. A trailing `*` (e.g. `agent:*`) matches any identity with that prefix. */
  id: string;
  role: TruthSignerRole;
  /** Other spellings that resolve to `id`. */
  aliases?: string[];
}

/** stenographer's registry file: `{"signers": [{"id", "role", "aliases?"}]}`. */
export interface TruthSignerFile {
  signers: TruthSigner[];
}

export interface TruthSignerRegistry {
  /** The listed signer an identity resolves to (by identity key), or null. */
  lookup(identity: string): { id: string; role: TruthSignerRole } | null;
}

const ROLES: readonly TruthSignerRole[] = ['human', 'agent', 'detector'];

/** Builds a registry; throws on a malformed file or a name listed for two signers. */
export function createSignerRegistry(source: TruthSignerFile | TruthSigner[] | TruthSignerRegistry): TruthSignerRegistry {
  if (!Array.isArray(source) && typeof (source as TruthSignerRegistry).lookup === 'function') {
    return source as TruthSignerRegistry;
  }
  const signers = Array.isArray(source) ? source : (source as TruthSignerFile).signers;
  if (!Array.isArray(signers)) throw new Error('signer registry: expected { signers: [...] }');

  const exact = new Map<string, { id: string; role: TruthSignerRole }>();
  const prefixes: Array<{ prefix: string; role: TruthSignerRole }> = [];
  for (const [i, signer] of signers.entries()) {
    if (!signer || typeof signer.id !== 'string' || signer.id.trim().length === 0) {
      throw new Error(`signer registry: signers[${i}].id must be a non-empty string`);
    }
    if (!ROLES.includes(signer.role)) throw new Error(`signer registry: signers[${i}].role must be one of ${ROLES.join(', ')}`);
    const id = signer.id.normalize('NFC').trim();
    if (id.endsWith('*')) {
      prefixes.push({ prefix: identityKey(id.slice(0, -1)), role: signer.role });
      continue;
    }
    for (const name of [id, ...(signer.aliases ?? [])]) {
      const key = identityKey(name);
      const prior = exact.get(key);
      if (prior && prior.id !== id) throw new Error(`signer registry: '${name}' names both '${prior.id}' and '${id}'`);
      exact.set(key, { id, role: signer.role });
    }
  }
  // Longest prefix wins, so `agent:ci:*` can narrow `agent:*`
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    lookup(identity: string) {
      const key = identityKey(identity);
      const listed = exact.get(key);
      if (listed) return listed;
      const match = prefixes.find((p) => key.startsWith(p.prefix) && key.length > p.prefix.length);
      return match ? { id: identity, role: match.role } : null;
    },
  };
}
