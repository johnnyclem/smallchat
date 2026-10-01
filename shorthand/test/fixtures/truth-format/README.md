# Stenographer truth format, version 2

This is the contract for truth streams: the JSONL that stenographer's `export_wiki_entries` writes and `import_wiki_entries` reads, and that [short-hand](https://github.com/johnnyclem/short-hand) (`@shorthand/core`), smallchat's vendored mirror and smallchat-swift read as ground truth. It also defines the PROPOSAL envelope that compactors write and stenographer's intake files.

- `wiki-line.v2.schema.json`: JSON Schema (2020-12) for one line.
- `fixtures/`: golden lines, valid and invalid, with the outcome each must have. Consumers run them in their own test suites (see [Fixtures](#fixtures)).
- The reference codec is `src/truth/wiki.ts` (`decodeWikiLine`, `checkWikiChain`, `wikiLineHash`) and, for PROPOSAL lines, `src/truth/intake.ts`. `test/truth-format.test.ts` builds the fixtures from a real ledger, requires them to match the committed files byte for byte, and checks each one against the schema and the codec.

"MUST", "MUST NOT", "SHOULD" and "MAY" are used as in RFC 2119.

## Streams

A truth file is UTF-8 JSONL: one JSON object per line, each ending in LF. Readers MUST skip blank lines and MUST count them when they report line numbers.

**One writer per file.** A file holds one writer's stream, and only that writer appends to it. A team shares truth by each member's stenographer exporting to a file of its own (for example `wiki/<handle>.jsonl`) and importing the others'. A tool that authors truth outside stenographer, such as the Swift messenger, writes through stenographer's API or MCP tools, never by appending to a file stenographer exports: it submits a PROPOSAL envelope (`POST /proposals` in stenographer's REST API) for a person to notarize.

**A stream is hash-chained.** Every line carries:

| Field | |
|---|---|
| `seq` | The line's position in its writer's stream: 1, 2, 3, … with no gaps. |
| `prevHash` | The previous line's `hash`; `null` on the line with `seq` 1, and only there. |
| `hash` | Lowercase hex SHA-256 of the UTF-8 bytes of the line's JCS form ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) with the `hash` field removed. |

A reader MUST refuse a line whose `hash` doesn't match, and a file in which a line's `seq` isn't the previous line's plus one or its `prevHash` isn't the previous line's `hash`. A file MAY start part-way through a stream (an incremental export); its first line's `prevHash` then names a line the file doesn't hold.

**What the chain shows, and what it doesn't.** A valid chain shows that no line was edited, removed, reordered or inserted between its first and last line, and that the lines come from one stream. It does not show who wrote them: anyone can write lines and compute their hashes. It doesn't show that lines were removed from the end either. To catch that, keep the hash of the last line you read and check that the stream still holds it. Authentication by key signature is planned for 1.x.

## Lines

Every line is a JSON object with `schemaVersion: 2`, `seq`, `id`, `type`, `ts`, `author`, `prevHash` and `hash`. A line without `schemaVersion` is version 1 (see [Version 1](#version-1-lines-and-upgrading)).

| Field | |
|---|---|
| `id` | Unique across the team's ledgers. Stenographer writes ULIDs. Letters, digits and `. _ : -`, 1–256 characters, starting with a letter or digit. |
| `type` | `TB`, `UV`, `ADDENDUM`, `RULING`, `PROPOSAL` or `TRANSITION`. |
| `ts` | RFC 3339 date-time naming a real time: no February 30, no `24:00`, no offset past `23:59`. Stenographer writes UTC with milliseconds, and its codec also refuses a leap second (`:60`) and a lower-case `t` or `z`. |
| `author` | Who wrote the entry (see [Identities](#identities)). |
| `x-steno` | Optional. Stenographer's own fields: `origin`, `provenance` (`{kind, ref?, line?}`), `agentSessionId`, `targetRef`, `links` (the links the entry's own write created, `{fromId, toId, type}`) and `ledgerHash` (the entry's hash in its writer's ledger chain, which `stenographer verify` checks). Readers that only fold statuses can ignore it. |

### TB: an asserted tombstone

A prior statement is stale or wrong, and someone stands behind saying so.

| Field | |
|---|---|
| `claim` | What is dead, and what replaced it, if anything. |
| `evidence` | At least one `{kind, ref, detail?}`. Known kinds: `commit`, `file`, `test`, `claimed-command`, `wiki`, `message`. `command` appears only on entries recorded before 1.0: since 1.0, command output a caller submits is recorded as `claimed-command`, because stenographer did not run it. |
| `signedBy` | The person (or, on a single-user setup, the agent identity) asserting it. `null` only on a backfilled TB (author `migration`), which is second-class and never truth on its own. |
| `literals` | Optional, at least one. Dead literals an objection can cite: `{dead, subject?, current?}`, values non-empty with no surrounding whitespace. Without a `subject`, `dead` must be a distinctive identifier: at least 4 characters, at least one ASCII letter. A bare `30` would match everything. |
| `status` | The TB's status when the line was written: `active`, `contested`, `overridden` or `struck`. |

### UV: an unverified assertion

Believed true, stated before anyone verified it. Flag it; don't block on it.

| Field | |
|---|---|
| `assertion` | The belief, in full sentences. |
| `basis` | Why the author believes it. |
| `verifyBy` | `{kind, value, detail?}`. Known kinds: `command`, `inspect`, `ask`, `observe`. |
| `contests` | The TB this UV disputes, or `null`. **The UV's line is the contest.** No other line carries it. |
| `status` | The UV's status when the line was written: `open`, `verified`, `refuted` or `struck`. |

### ADDENDUM and RULING: what changed a status

| Type | Fields | |
|---|---|---|
| `ADDENDUM` | `evidence` (at least one), `note` (string or null) | Evidence that verifies or refutes a UV, or overrides a TB. Verifying a UV that contests a TB is one addendum that does both. |
| `RULING` | `kind`, `opinion` (not blank), `target` | A judgment with written reasoning. A wiki stream carries strikes (`kind: "strike"`). |

Their `x-steno.links` say what they do (`verifies`, `refutes`, `overrides`, `strikes`), and they are the `cause.ref` of the TRANSITION lines that follow them.

### TRANSITION: a status changed

```json
{"schemaVersion":2,"seq":4,"id":"<cause id>:<target id>","type":"TRANSITION","ts":"…","author":"alex",
 "target":"<entry id>","status":"contested","cause":{"kind":"contest","ref":"<cause id>"},"prevHash":"…","hash":"…"}
```

| Field | |
|---|---|
| `target` | The TB or UV whose status changed. |
| `status` | Its new status. |
| `cause` | `{kind, ref}`. `kind` is `contest`, `override`, `strike`, `verify` or `refute`, or, in proposal streams, `dismiss` or `promote`. `ref` is the id of the entry that caused the change (the contesting UV, the addendum, the ruling), or `null` when that entry has no line in the stream (stenographer leaves out a pre-1.0 entry the format can't express, and reports it in the export's `skipped`). |
| `author`, `ts` | The cause's. No cause of a status change is written by `migration` or a detector, so a TRANSITION's author is never reserved. |
| `id` | Stenographer writes `<cause id>:<target id>`, or `transition:` and the SHA-256 hex of that when it would be longer than 256 characters. Readers don't derive anything from it. |

A status change is never an edit. It is an appended TRANSITION line. Stenographer writes one each time an exported entry's status changes, right after the line that caused it:

| Cause | TRANSITIONs |
|---|---|
| A UV that contests a TB | TB → `contested` |
| An addendum that overrides a TB | TB → `overridden` |
| An addendum that verifies or refutes a UV | UV → `verified` / `refuted`; a TB it contested → `active` again, unless another contest is open or it was overridden |
| A strike | entry → `struck`; a TB the struck UV contested → `active` again (cause `strike`), unless another contest is open or it was overridden |

## Status is a fold

A reader's current status for an entry is **the `status` of the highest-`seq` TRANSITION that targets it, else the entry line's own `status`**.

| Type | Known statuses | Current truth |
|---|---|---|
| TB | `active`, `contested`, `overridden`, `struck` | `active` (ground truth) and `contested` (ground truth with an asterisk) |
| UV | `open`, `verified`, `refuted`, `struck` | `open` (a heads-up) |

- **Fail closed.** A missing or unknown status means the entry is not current truth. The reader keeps the line as history and preserves it verbatim if it re-serializes.
- In a stenographer stream, `struck` never changes again, and `overridden`, `verified` and `refuted` can only become `struck` (a strike can target a resolved entry). This is the lattice below, one writer at a time.
- A UV that is open and contests a TB is attached to that TB whatever the TB's status says, so the dispute is always visible.
- Consumers SHOULD treat an active TB as ground truth, a contested TB as ground truth with a visible asterisk (cite the contesting UV), and an open UV as a heads-up, never a demand. A refuted UV and an overridden or struck TB are history: never cite them as support.
- Each file is one writer's view. A reader that merges several files folds each one on its own, then takes, per entry, the most advanced status on the lattice TB `active < contested < overridden < struck`, UV `open < verified < refuted < struck`.

Renderers that put truth into a model's context use these markers, and escape them when they appear inside untrusted text: `[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`.

## Unknown values

A newer writer may add fields or values this version doesn't define. Readers MUST NOT reject a line for an unknown field, or for an unknown value of `status`, an evidence or `verifyBy` `kind`, a provenance `kind`, a link `type`, a ruling `kind`, a `cause.kind` or a proposal `signal.source`. They keep such a line, preserve it verbatim on re-serialization, never coerce a value to a known one, and fail closed: an entry whose status they don't know is not current truth. Equality and conflict detection compare JCS bytes, so key order never matters. The schema is open in the same places. The line `type` and the required fields are closed: a reader refuses a line it can't identify.

Stenographer's import is stricter about what it admits as truth (see [Importing](#importing-stenographers-rules)).

## Identities

`author` and `signedBy` name someone who stands behind the entry. Readers MUST refuse a line whose identity:

- is anonymous or generic: `system`, `assistant`, `agent`, `ai`, `bot`, `anonymous`, `unknown`, `user`, `human`, `admin`, `null`, `none`, `me`, or empty;
- contains a control character (Unicode category Cc);
- is reserved where it doesn't belong: `migration` authors only an unsigned backfilled TB, and `detector:*` authors only PROPOSAL lines. A TRANSITION takes its cause's author, so it is never reserved.

Identities compare by key: Unicode NFKC, default-ignorable code points removed, trimmed, lowercased. So `Assistant` and `ａｓｓｉｓｔａｎｔ` are both refused, and `Alice` and `alice` are one person. Lines store identities as written.

## Links an entry may carry

A TB or UV line's `x-steno.links` speak only for that entry. Each link either starts at it with a type its type writes (TB: `supersedes`, `signs`; UV: `contests`, `signs`), or ends at it with a type that can target its type (TB: `overrides`, `contests`, `supersedes`, `strikes`; UV: `verifies`, `refutes`, `supersedes`, `strikes`). A UV's `contests` link points at the TB its `contests` field names. An ADDENDUM or RULING lists only links that start at it. No link is listed twice. Readers MUST refuse a line that breaks these rules, unless the link's type is one they don't know (see above).

## Hash: a worked example

The first line of `fixtures/valid/ledger.jsonl`:

<!-- worked-example -->
```json
{"schemaVersion":2,"seq":1,"id":"01M1E6JK80P9Y3CMA9HBZEND9H","type":"TB","ts":"2026-09-01T10:00:00.000Z","author":"johnnyclem","claim":"LOG_BUDGET is 100; the old value 30 is dead.","evidence":[{"kind":"commit","ref":"9f2c1ab"},{"kind":"claimed-command","ref":"grep LOG_BUDGET config.ts","detail":"LOG_BUDGET = 100"}],"signedBy":"johnnyclem","literals":[{"dead":"30","subject":"LOG_BUDGET","current":"100"},{"dead":"legacyRateLimiter"}],"status":"active","x-steno":{"origin":"local","provenance":{"kind":"manual"},"agentSessionId":null,"targetRef":null,"links":[],"ledgerHash":"bc7fba418e299b5e57b4fab85488163ba39fdc436f7a0dff9dd954ae3037c382"},"prevHash":null,"hash":"8c366a06018886baa0ca9456661e4895a272faebf88e188f409efc580b5465fb"}
```

Without `hash`, in JCS form:

```
{"author":"johnnyclem","claim":"LOG_BUDGET is 100; the old value 30 is dead.","evidence":[{"kind":"commit","ref":"9f2c1ab"},{"detail":"LOG_BUDGET = 100","kind":"claimed-command","ref":"grep LOG_BUDGET config.ts"}],"id":"01M1E6JK80P9Y3CMA9HBZEND9H","literals":[{"current":"100","dead":"30","subject":"LOG_BUDGET"},{"dead":"legacyRateLimiter"}],"prevHash":null,"schemaVersion":2,"seq":1,"signedBy":"johnnyclem","status":"active","ts":"2026-09-01T10:00:00.000Z","type":"TB","x-steno":{"agentSessionId":null,"ledgerHash":"bc7fba418e299b5e57b4fab85488163ba39fdc436f7a0dff9dd954ae3037c382","links":[],"origin":"local","provenance":{"kind":"manual"},"targetRef":null}}
```

Its SHA-256 is `8c366a06018886baa0ca9456661e4895a272faebf88e188f409efc580b5465fb`, the line's `hash`. The hash covers every field but `hash`, including unknown ones, which is one more reason a reader never rewrites a line it didn't write.

## What travels in a wiki stream

Stenographer's wiki export carries, in ledger order: every TB and UV; every ADDENDUM or RULING that changes the status of one; and a TRANSITION for every status change of an exported entry. It never carries proposals. A dismissal closes a proposal, so dismissals don't travel either: declining a wiki line is a local decision. Promotion, contempt and objection rulings change no status and don't travel. Neither do the ledger's `MARKER` entries.

## Importing (stenographer's rules)

`import_wiki_entries` applies these rules. Other readers SHOULD apply the parts that fit them.

1. **One transaction per file.** Every line is validated, the chain is checked, and each line is appended through the same admission check as a live write. If any line fails, nothing is written, and the result lists every failing line (`committed: false`, `errors: [{line, id, error}]`).
2. **Lines the ledger already holds.** An entry line whose id the ledger holds, with the same type, author and body (compared as JCS), is a no-op. A different one is a conflict: it is filed as a reconciliation `PROPOSAL`, and the held entry is left as it is. An ADDENDUM or RULING whose id is held with different content is an error.
3. **A TB lands as truth only when it is signed and verifiable.** Signed means `signedBy` is not null. Verifiable means a v2 line in a valid chain, and, when the importer has a signer registry, its author and signer listed there as a person or an agent. Any other TB becomes a reconciliation `PROPOSAL` that a person must notarize (`requiresNotary`, author `detector:wiki-sync`, `targetRef` the line's id). It is never active truth on its own.
4. **A UV lands when its author passes the registry**, when there is one. Otherwise it becomes a reconciliation proposal too.
5. **Fail closed.** A TB or UV line whose `status` stenographer doesn't know, or that says `struck` (only a strike, which travels, can set that), or that has an evidence, `verifyBy`, provenance or link value stenographer doesn't know, becomes a reconciliation proposal (`unknown-status`, `unknown-value`). It never becomes truth. A terminal status on an entry line (`overridden`, `verified`, `refuted`) is kept: no later line can undo it.
6. **Status changes come from their causes.** Stenographer applies an ADDENDUM or RULING through its links, when its author may perform the act: an override, a strike or any ruling needs a person (with a registry: one it lists as `human`), and a verification or refutation needs a person or an agent. A resolution also meets the contempt-of-corpus rule: its author can't be the UV's author or drafter, or come from the UV's agent session, and refuting a contest can't come from the contested TB's author, signer or drafter. One that fails these checks, or whose target the ledger doesn't hold, is **held**: it is reported, nothing is written, and a later import tries it again. A change whose effect is already in place, such as an override of a TB that was overridden here first, is recorded and changes nothing.
7. **TRANSITION lines are checked, not applied.** Stenographer derives status from the causes. A TRANSITION whose `cause.ref` is neither earlier in the file nor in the ledger is an error. One with a status stenographer doesn't know is held.
8. **PROPOSAL lines don't belong in a wiki file.** They are an error there; the intake files them.
9. **Re-importing is a no-op.** A line whose reconciliation proposal exists, in any status, is not filed again, so a dismissed one isn't raised again and a signed one isn't minted twice.

Without a signer registry, any identity that passes the identity rules is accepted where a registry would be consulted, as on stenographer's live operator paths. A valid chain then shows the lines are unchanged, not who wrote them.

## Exporting (stenographer's rules)

- The export is the ledger's stream from `seq` 1. The stream depends only on the ledger's entries in order, so it only grows at the end: line *n* is the same on every export.
- `sinceSeq` returns the lines after that seq. The result reports `lastSeq`, which is what to pass next time. `since` (an ISO timestamp) is a deprecated alias: it returns the stream from the first line written after that time, so the lines still chain.
- Exporting into a file appends, in one write, the lines of the stream the file doesn't hold yet. The file must hold a run of this ledger's stream and nothing else. A file holding a teammate's lines, or an edited line, is refused and left untouched. Export never truncates or rewrites a line.
- MCP callers name files relative to the wiki directory (`--wiki-dir`, default `wiki/` next to the state file). Absolute paths, `..`, names that aren't `*.jsonl`, symlinks that resolve outside the directory and the state file itself are refused.

## The PROPOSAL envelope

One envelope for every proposal in the suite: short-hand's and smallchat's compactors, smallchat-swift, and agents.

```json
{"schemaVersion":2,"seq":1,"id":"…","type":"PROPOSAL","ts":"…","author":"detector:short-hand",
 "kind":"tb","draft":{"claim":"…","evidence":[…],"literals":[…]},"targetRef":"shorthand:tombstone:msg_0101",
 "signal":{"source":"compaction-candidate","detail":"…"},"agentSessionId":null,"prevHash":null,"hash":"…"}
```

- `kind` is `tb` (draft: `claim`, `evidence`, `literals?`) or `uv` (draft: `assertion`, `basis`, `verifyBy`, `contests?`).
- `signal.source` is `compaction-candidate`, `agent`, or `detector:<name>`.
- A proposals file is a hash-chained stream like a wiki file, with one writer.
- Stenographer's intake files each line as an open `PROPOSAL` that only a person can turn into truth, and keeps the envelope's `id`, `author`, `signal.source` and `hash` under `meta.intake`. A line is filed once, by its `id`: re-importing it, after it was signed or dismissed too, files nothing, and envelopes that share a `targetRef` are each filed. An `id` names one envelope: the same envelope at another `seq` is the same envelope, and a different one under an `id` already filed is refused (compared as JCS without `seq`, `prevHash` and `hash`). A `signal.source`, evidence kind or `verifyBy` kind it doesn't know is kept as written and listed under `meta.intake.unknown`.
- An envelope submitted on its own (stenographer's `POST /proposals`) MAY leave out `seq`, `prevHash` and `hash`: it is then read as a stream of one line with `seq` 1. Any of them that is present is checked as in a stream. Streams and submissions share one `id` namespace: stenographer refuses (`409`) a submission whose `id` a proposals file filed first.
- The older bare short-hand line (`{kind: "tombstone", draft, signal, targetRef?}`) and the `shorthand-compaction` source are still read, and no longer written.

## Version 1 lines and upgrading

Stenographer 0.x wrote v1 lines: no `schemaVersion`, no `seq` or hash, a `status` field holding the status at export time, and `x-steno.links` that could include other entries' links. Stenographer 1.0 still reads them:

- They are validated like a live write. Identities are canonicalized (trimmed, NFC), `command` evidence becomes `claimed-command`, and a status stenographer doesn't know fails closed.
- A terminal `status` (TB `overridden`; UV `verified` or `refuted`) is kept. Other statuses are dropped, and links decide.
- Links that aren't the entry's own are dropped, not refused.
- A v1 TB has no hash, so it is unverifiable. It is filed as a reconciliation proposal for a person to sign. A v1 UV is admitted.

v1 couldn't carry status changes, and a 0.x full export rewrote the file, which one writer per file forbids. To move a team to v2, each member upgrades and exports into a new file of their own. Stenographer won't append v2 lines to a v1 file, since the file isn't a run of its stream.

## Fixtures

| File | What a conforming reader does |
|---|---|
| `signers.json` | The signer registry the fixtures assume: `{"signers": [{id, role}]}`. |
| `valid/ledger.jsonl` | One ledger's stream. It covers a TB with literals and `claimed-command` evidence, an open UV, a contest, an addendum that verifies the contest and overrides the TB, the superseding TB, a strike, an agent's UV refuted by a person, and a notarized agent draft whose `signs` link names a proposal that didn't travel, with a TRANSITION after each change. Every line passes the schema, every hash recomputes, and the lines chain. |
| `valid/ledger.expected.json` | The fold: `{id: {type, status, current}}` for every TB and UV. |
| `valid/proposals.jsonl`, `proposals.expected.json` | A PROPOSAL envelope stream and the kind each line files as. Two envelopes share a `targetRef` (each is filed), and one carries an unknown `signal.source` and evidence kind (filed; `unknown` lists them as stenographer records them). |
| `valid/unknown.jsonl`, `unknown.expected.json` | What a newer writer may send: an unknown field, unknown statuses, an unknown evidence kind and `verifyBy` kind. `fold` is what readers compute, failing closed. `import` is what stenographer does with each line. |
| `valid/routing.jsonl`, `routing.expected.json` | Valid lines stenographer doesn't simply take as truth, each imported on its own: `inserted` (with the resulting `status`), `proposal` (with a `reason`), or `held`. |
| `v1/legacy.jsonl`, `legacy.expected.json` | 0.x lines and their outcomes. The v2 schema refuses them; the codec reads them as version 1. |
| `invalid/schema.jsonl`, `schema.expected.json` | Lines the schema and the codec both refuse, with the `reason`. Each is otherwise valid and correctly hashed. |
| `invalid/codec.jsonl`, `codec.expected.json` | Lines the schema accepts and the codec refuses: hash, identity and link rules that JSON Schema can't express. `error` is a regular expression for stenographer's message; other readers need only refuse the line. |
| `invalid/chain-gap.jsonl`, `chain-fork.jsonl`, `chain.expected.json` | Valid lines that aren't one stream: a missing line, and a line from another writer. |

A consumer's test SHOULD validate every valid line against the schema, parse it with its own codec, recompute every `hash`, check the chain of each valid file except `routing.jsonl` (its lines come from two ledgers and are imported one at a time, so it is not one stream), fold `ledger.jsonl` and `unknown.jsonl` and compare the results with their expected files, and refuse every invalid line.

The fixtures come from a real ledger with the clock and the random source pinned, so the same code always writes the same bytes. A change to the fixtures is a change to the format. `UPDATE_TRUTH_FORMAT_FIXTURES=1 npx vitest run test/truth-format.test.ts` regenerates them; review the diff.

## Versioning

`schemaVersion` changes when a rule changes or a field's meaning does. Readers MUST refuse a `schemaVersion` they don't know rather than guess. A new optional field or value that readers can ignore, failing closed, keeps version 2 and is listed in stenographer's CHANGELOG.
