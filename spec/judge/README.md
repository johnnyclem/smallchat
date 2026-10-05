# smallchat shortlist judge (`smallchat.judge.v1`)

An optional tie-breaker for `resolve(intent)` (`RuntimeOptions.judge`): a
judge may only pick among near-ties that the local ranking already
produced. It is never an authority. With no judge configured, resolution
is exactly what `spec/resolve/` describes; with one that is unreachable or
failing, it reaches the same outcome, choice and decision code, but its
proof records the attempt (D3, D4). A judge's verdicts are recorded so that
they replay without the network. The words MUST, MUST NOT and MAY are
normative.

The vectors are independent of any embedder and of any judge provider:
each tool's similarity is an input (as in `spec/resolve/`) and the judge is
a stub that gives the case's answer. The `wire` section is specific to the
TypeSafe client (`@smallchat/core/jev`).

## D1 When the judge is asked

Let `best` be the top-ranked candidate, `tier` its tier under the
runtime's configured thresholds (never a constant), `runnerUp` the
second-ranked candidate's score (none when there is one candidate), and
`margin` the judge's margin (default `0.05`, in `[0, 1)`). A runner-up is
*near* when `round((best − runnerUp)·10⁴) ≤ round(margin·10⁴)` (the score
quantum of `spec/ranking/`).

| tier | trigger |
|---|---|
| `exact`, `none` | never asked |
| `high` | `ambiguous` when the runner-up is near; otherwise never asked |
| `medium`, `low` | `ambiguous` when the runner-up is near; otherwise `low-confidence` |

There is no absolute cutoff: a HIGH winner with a far runner-up is not
asked, whatever its score. `metadata.ambiguous` on a dispatch result keeps
its own rule (more than one candidate and a score at or under 0.90); it is
a flag for callers and decides nothing. When a judge took part, every
dispatch result (the tool's, a refusal, `invalid-arguments`, `aborted`)
also carries `metadata.judge = { name, verdict, toolId }`.

## D2 What the judge is offered

1. Walk the ranked candidates best first and keep those whose score is
   near `best` (as in D1; `best` itself always is). Stop at the first that
   is not.
2. If `best`'s schema cannot be loaded, or the dispatch policy would refuse
   `best` even with the judge's approval, offer nothing: the judge is not
   asked, and resolution continues as if no judge were configured. A judge
   breaks ties; it MUST NOT run a runner-up where the policy refused the
   winner.
3. Drop a candidate whose schema cannot be loaded; one the dispatch policy
   would refuse even with the judge's approval (destructive below EXACT, a
   pin it does not satisfy, below LOW); and one the deterministic
   verification an approval still gets (D3) would refuse: a required
   parameter missing when the call's arguments are known and, when the
   candidate's own tier is verified (below HIGH, or below EXACT in strict
   mode), keyword overlap under 0.15 between the intent and the tool's
   name, description and parameters (verification's schema and keyword
   strategies). The judge can therefore never pick a tool that is then
   refused, and enabling it never turns a dispatch whose fitting alternate
   would run into a refusal. `best` itself may be dropped this way, as the
   verification without a judge would move past it.
4. Keep the first `maxCandidates` (default `8`, an integer ≥ 1).
5. Present them sorted by tool id (UTF-16 code unit order), never in rank
   order. Each description is the schema description when non-empty, else
   the selector canonical (`<providerId>.<toolName>` in the vectors), with
   every run of control characters and line or paragraph separators
   (U+0000–U+001F, U+007F–U+009F, U+2028, U+2029) replaced by one space,
   then cut to 240 UTF-16 code units; a cut never splits a surrogate pair
   (the description is then 239 units). Descriptions are tool-server text:
   a judge's instructions MUST label them untrusted.

The judge is asked only if at least one candidate remains and, for a HIGH
winner, at least two (a HIGH winner alone is no near-tie). Otherwise
resolution continues as if no judge were configured, and nothing is
recorded.

## D3 What an answer does

A judge answers a choice (an offered tool id, or none: abstain) with a
probability and a confidence, or that it is unavailable. The runtime holds
every judge to `timeoutMs` (default `4000`, in `(0, 2147483647]`) and to
the caller's abort signal, whatever the judge does with the signal it is
given: past the deadline the answer is `TIMEOUT`, after an abort `ABORTED`.
The runtime then decides, with `acceptThreshold` (default `0.7`, in
`(0, 1]`; a value outside it approves nothing):

| verdict | when | then |
|---|---|---|
| `approved` | the choice is an offered id and its probability ≥ `acceptThreshold` | that candidate is chosen |
| `declined` | abstain (`abstained`), an id that was not offered (`outside-shortlist`), a probability below the threshold or absent (`below-threshold`) | `needs-disambiguation`, decision `judge-declined`; the reason code appears in `Resolution.reason` |
| `unavailable` | no usable answer: `AUTH`, `RATE_LIMITED`, `HTTP_<status>`, `TIMEOUT`, `NETWORK`, `MALFORMED` (a probability or confidence that is not a finite number in `[0, 1]`, a body outside the contract), `ABORTED` | resolution continues as without a judge (verification, the LLM verifier, the policy) to the same outcome and choice, and the final decision code is that path's; the proof records the attempt (D4), so its digest differs from a run with no judge, and the resolution is not cached |

After an approval the deterministic checks still run: wherever the
no-judge path would verify the chosen candidate (below HIGH, or below
EXACT in strict mode), it gets the schema and keyword strategies, with the
approval standing in for the LLM micro-check only (D2 offers only
candidates that pass them, so a failure here, `verification-failed`, is a
safeguard); then the dispatch policy, with the approval counting as an
LLM verifier's for the policy's below-HIGH rule (a MEDIUM or LOW candidate
runs only with an LLM verifier's approval while
`requireLLMForSubHighDispatch` is on). A decline is final: the LLM verifier
is not asked after it.

## D4 What is recorded

- Decision codes: `judge-approved` (the judge chose this candidate, at any
  tier or rank) and `judge-declined`. An unavailable judge leaves the
  fallback path's code.
- A proof stage `judge`, whose step is, with `who` = `<name> (<model>)`:
  - `judge-approved: <who> chose <toolId> from <n> offered (<trigger>)`
  - `judge-declined: <who> chose none of the <n> offered (<trigger>)`
  - `judge-unavailable: <who> gave no usable answer (<trigger>); deciding as without a judge`

  with detail `{ judge, model, verdict, toolId, trigger, offered }`
  (`offered` in presentation order; `toolId` null unless approved).
- `proof.judge = { name, model, verdict, toolId, probability, confidence,
  reason, margin, maxCandidates, requestId? }`. `model` is the model that
  answered when the judge reports a plain model name (an ASCII letter or
  digit, then up to 99 of `[A-Za-z0-9._:/@-]`), else the configured one;
  `reason` is `approved`, a decline reason or an error code (null only as
  D4's replay rules say); `requestId` is optional: the provider's request
  id, recorded only when it is 1 to 128 of `[A-Za-z0-9._-]`, and never
  digested.
  `proofDigest` covers `judge` reduced to `{ name, model, verdict, toolId }`:
  never the probabilities, the reason or the settings, so one decision has
  one digest however the judge's numbers or errors vary. A proof without a
  judge has no `judge` field, and its digest is unchanged.
- A decision-log line carries the proof's `judge` (when present).
- A recorded verdict is recorded under its own `name` and `model`; when it
  carries none, they are `recorded` and `unknown`, never the runtime
  judge's, so a caller cannot write a line that reads as that judge's
  decision.
- Replay never calls a judge. A decision-log line or a golden-trace case
  with a recorded `judge` replays with that verdict answering in the
  judge's place; one without replays with no judge. Replaying a recorded
  verdict:
  - D1 and D2 run again with the recorded `margin` and `maxCandidates`,
    else the runtime judge's, else the defaults: the trigger and the
    shortlist both use them.
  - If D1 does not trigger or D2 offers nothing (or, for a HIGH winner,
    one tool), the judge is not asked and nothing is recorded.
  - `approved` with a `toolId` that is offered approves it, whatever its
    recorded probability (it is not compared with a threshold again); an
    id that is no longer offered is `declined` (`outside-shortlist`).
  - `declined` and `unavailable` keep their recorded `reason` when it is a
    valid one, else record `null`: a replay invents no reason.
  - `probability` and `confidence` are kept when they are numbers in
    `[0, 1]`, else `null`.
- `explain(intent)` does not consult the judge; it reports whether a live
  dispatch would ask it (D1, D2) and what it would be offered. Explaining a
  recorded resolution reports its verdict.
- A resolution the judge took part in (any verdict) is never cached, nor is
  one resolved with a per-call judge setting (`false` or a recorded verdict)
  on a runtime that has a judge: neither may answer a later live call in
  the judge's place.

## The TypeSafe wire (`@smallchat/core/jev`)

Only the TypeSafe client follows this section; other judges answer
`judge()` however they reach their model.

- The request is `POST {baseURL}/v1/systemone` with `{ model, state,
  questions: { tool: { type: "choice", instructions, criteria } } }`,
  where `state` is the intent (after `redactIntent`) and `instructions`
  is the text in the `wire.request` vector. `criteria` has one member per
  offered tool, in tool-id order (D2 item 5), whose value is its
  description, then `__none__` with the value `None of these tools fit the
  intent`.
- The answer is `answers.tool`, `{ type: "choice", choice, confidence,
  probabilities }`, and the model that answered is the body's `model`
  (recorded as D4 says). `choice` `__none__` means abstain. The
  probability is `probabilities[choice]`; when it is absent there is none,
  which declines an offered choice as `below-threshold`.
- Any value in `probabilities`, or a `confidence` that is present, that is
  not a finite number in `[0, 1]` is `MALFORMED`; so is a body over 64 KiB,
  a body that is not JSON, and an answer that is not a `choice` with a
  string `choice` and a `probabilities` object.
- 401 and 403 are `AUTH`, 429 is `RATE_LIMITED`, any other non-2xx status
  is `HTTP_<status>`.

## Running the vectors

- `trigger`: `judgeTrigger({ tier, bestScore: best, runnerUpScore:
  runnerUp, margin })` (margin default from `defaults`) is `expect`.
- `resolve`: build the runtime as in `spec/resolve/README.md`, with these
  additions: a tool's `description` (default: the intent; `""` is an empty
  description, not an absent one) and `required` parameters (its schema's
  required arguments); `options.strict` and `options.thresholds`; the
  case's `args` passed to resolve. The judge is named `stub`, model
  `stub-1`, with the case's `margin`, `maxCandidates` and
  `acceptThreshold` (defaults in `defaults`), and answers `judge.answer`:
  `{ choice, probability, confidence, model? }` (`choice` null: abstain;
  `model`: the model it reports answering) or `{ unavailable: <code> }`.
  Compare `asked`, the request's `trigger` and `offered` ids in order,
  when given `descriptions` (the offered descriptions, in the same order),
  `outcome`, `decision`, `tier`, `chosen`, the proof's `judge` (digested
  fields), when given `record` (the rest of the proof's `judge`: `reason`,
  `probability`, `confidence`, `margin`, `maxCandidates`) and its `judge`
  step.
- `replay`: the `resolve` runtime, whose own judge (`stub`) MUST NOT be
  called; resolve the intent with `recorded` answering in the judge's place
  (D4). Compare `outcome`, `decision`, `tier`, `chosen`, the proof's
  `judge` (digested fields and `reason`) and its `judge` step.
- `wire` (TypeSafe client only): `request.expect` is the request
  `@typesafe-ai/sdk` 0.6.0 sends for the criteria a client derives from
  `request.input` (D2 item 5); a client sends the same URL, method, those
  headers and that body, with the `criteria` members in that order.
  `responses.cases`: the client, with no retries, reads an HTTP response
  of `status` with `body` (or `bodyText`), and the answer accepted against
  `offered` and `acceptThreshold` gives `expect`.

The TypeScript suite runs `trigger`, `resolve`, `replay` and
`wire.responses` in `src/runtime/judge-vectors.test.ts`, and
`wire.request` in `src/jev/jev-judge.test.ts`. A port runs `trigger`,
`resolve` and `replay` once it implements the judge; until then it MUST
still decode the decision codes `judge-approved` and `judge-declined`, the
proof stage `judge` and a proof's `judge` field, which TypeScript proofs
and decision logs may carry.
