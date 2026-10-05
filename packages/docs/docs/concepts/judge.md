---
title: Shortlist judge
sidebar_label: Shortlist judge
---

# Shortlist judge

A shortlist judge is an optional tie-breaker. When the local ranking cannot
settle a choice on its own (two candidates within a hair of each other, or a
winner below HIGH confidence), the runtime can ask a judge which of the
near-ties fits the intent. The judge is never an authority:

- it is only asked about near-ties the ranking already produced, never about
  an EXACT match or a winner the dispatch policy refuses, and never offered a
  candidate more than `margin` (default 0.05) below the winner;
- it is only offered tools it could then run: the policy would allow them
  and the deterministic verification would pass them;
- if it is unset, dispatch is what it is without one. If it is unreachable,
  times out or returns a malformed answer, the decision is the one it would
  be without a judge, but the call waits up to the judge's `timeoutMs`, the
  proof records the attempt (so its digest differs from a run with no judge)
  and the resolution is not cached;
- an answer that abstains or names a tool it was not offered is a decline:
  the result is `needs-disambiguation`;
- its verdicts are recorded, and replay uses the record instead of calling
  it again.

It is off by default; nothing is sent anywhere unless you configure one. The
normative rules and conformance vectors are in
[`spec/judge/`](https://github.com/johnnyclem/smallchat/tree/main/spec/judge).

## Configuring one

`RuntimeOptions.judge` takes any `ShortlistJudge`. TypeSafe's Jev model is
the experimental `@smallchat/core/jev` subpath:

```typescript
import { ToolRuntime, MemoryVectorIndex } from '@smallchat/core';
import { JevJudge } from '@smallchat/core/jev';

const judged = new ToolRuntime(new MemoryVectorIndex(), embedder, {
  // Reads TYPESAFE_API_KEY (and TYPESAFE_BASE_URL, if set).
  judge: JevJudge.fromEnv({
    redactIntent: intent => intent.replace(/\S+@\S+/g, '[email]'),
  }),
});
```

| `JevJudge` option | Default | Meaning |
|---|---|---|
| `apiKey` | — (required; `fromEnv()` reads `TYPESAFE_API_KEY`) | Held in a private field: never logged, serialized or echoed |
| `baseURL` | `https://api.typesafe.ai` | As the TypeSafe SDK's `baseURL`; `/v1/systemone` is appended. https only (http for localhost) |
| `model` | `jev-1.13.0` | A pinned version; `jev-latest` moves when TypeSafe ships a release |
| `margin` | `0.05` | How close a runner-up must be to count as a near-tie |
| `maxCandidates` | `8` | Most tools offered per request |
| `acceptThreshold` | `0.7` | Probability Jev must give its choice for it to count |
| `timeoutMs` | `4000` | Budget per judgement, retries included; the runtime waits no longer either |
| `maxRetries` | `2` | Retries of 408, 429 and 5xx within the budget (honouring `Retry-After`) |
| `redactIntent` | none | Rewrites the intent before it is sent |
| `dangerouslyAllowBrowser` | `false` | `JevJudge` refuses to run in a browser, where the key would ship to every visitor |

Build the runtime that holds a judge on a server. A `@smallchat/react` or
Next.js app should call a server route that owns the runtime, never construct
`JevJudge` in client code.

### What is sent

When the judge is asked, `JevJudge` sends TypeSafe the intent text (after
`redactIntent`) and, for each offered tool, its id and description (one
line, at most 240 characters). It sends no arguments, no principal and no
other tools. `smallchat serve`, `resolve`, `replay` and `explain` never
configure a judge; it is a library option.

## When it is asked

With the winner's tier under your thresholds and the runner-up's score:

| Winner's tier | Asked? |
|---|---|
| EXACT, NONE | never |
| HIGH | only when the runner-up is within `margin` (`ambiguous`) |
| MEDIUM, LOW | always (`ambiguous` with a near runner-up, else `low-confidence`) |

So a clear HIGH winner (0.90 against 0.70) runs without a round trip, and a
near-tie (0.88 against 0.86) is the judge's to break.

## What it is offered

Candidates within `margin` of the winner that the judge could choose and
then run: the dispatch policy would allow them on its approval, and the
checks an approval still gets would pass — the call's required parameters
when the arguments are known, and keyword overlap with the intent wherever
the candidate's tier is verified (below HIGH, or below EXACT in strict
mode). At most `maxCandidates`, presented sorted by tool id rather than by
rank, so the judge cannot lean on the order. Tool descriptions come from
tool servers; they are folded to one line, capped, and labelled untrusted
in the question.

The margin decides how far below the winner an offered tool can be. A wide
margin lets a judge choose across tiers: with `margin: 0.1`
and the default thresholds, a MEDIUM candidate at 0.82 is offered next to a
HIGH winner at 0.90, and the judge may pick it (it still gets the checks
above and the policy).

If the policy refuses the winner itself (a destructive tool below EXACT,
say), or its schema cannot be loaded, the judge is not asked: it breaks
ties, it does not pick a runner-up to run where the policy refused the
winner. A HIGH winner left with no near-tie to choose from is not judged
either.

## What its answer does

| Verdict | When | Result |
|---|---|---|
| approved | it chose an offered tool with probability ≥ `acceptThreshold` | that tool is chosen; verification (minus the LLM check, which the approval replaces) and the policy still run; decision `judge-approved` |
| declined | it abstained, chose a tool it was not offered, or was not sure enough | `needs-disambiguation`, decision `judge-declined`, with the reason |
| unavailable | network error, timeout, HTTP error after retries, an answer outside the contract, an abort | the decision it would be without a judge: the HIGH winner runs, a MEDIUM one goes to your LLM verifier, and the decision code is that path's. The call still waited for the judge, its proof has a `judge-unavailable` step and `proof.judge` (so its digest differs from a run with no judge), and the result carries `metadata.judge` |

A resolution the judge took part in, whatever the verdict, is never cached,
so the next identical intent is judged again rather than served a remote
model's pick (or a pick made while the judge was down) from the cache.
Neither is one resolved with a per-call `judge` option (`false` or a
recorded verdict) on a runtime that has a judge.

## What is recorded

Every judged resolution has a `judge` step in its proof and a
`proof.judge` record:

```typescript
const r = await runtime.resolve('email the quarterly report');
if (r.proof.judge) {
  const { name, model, verdict, toolId, probability, reason } = r.proof.judge;
  console.log(`${name} (${model}) ${verdict} ${toolId ?? ''} p=${probability} (${reason})`);
}
```

The proof digest covers the judge's name, model, verdict and chosen tool id
only, so two runs that made the same decision have the same digest even if
the judge's probabilities moved. Every dispatch result the judge took part
in — the tool's, a refusal, `invalid-arguments`, `aborted` — carries
`metadata.judge = { name, verdict, toolId }`, next to `metadata.ambiguous`.
The decision log line carries the whole record.

## Replay and explain never call it

```typescript
const resolution = await runtime.resolve('email the quarterly report');

// Re-decide with the recorded verdict instead of the network:
const again = await runtime.resolve('email the quarterly report', { judge: resolution.proof.judge ?? false });

// Explain the decision as it was made, the judge's verdict included:
const explanation = await runtime.explain(resolution);
console.log(explanation.judge.consulted?.verdict, again.proof.proofDigest === resolution.proof.proofDigest);
```

- `smallchat replay` and `replayDecisionLog` answer each logged line with
  its recorded verdict; a line without one replays with no judge.
- A golden-trace case may carry a verdict:
  `{"intent": "…", "expect": {"toolId": "mail/send"}, "judge": {"verdict": "approved", "toolId": "mail/send"}}`.
  A verdict without `name` and `model` is recorded as `recorded (unknown)`,
  never under your runtime judge's name, and one without a `reason` records
  none.
- Replaying a verdict rebuilds the near-ties with the recorded `margin` and
  `maxCandidates`; an approved tool that is no longer among them becomes a
  decline (`outside-shortlist`), so replay reports the difference.
- `runtime.explain(intent)` resolves without consulting the judge, says one
  is configured and whether a live dispatch would ask it
  (`explanation.judge.wouldAsk`: the trigger and the tools it would be
  offered, or `null`); `runtime.explain(resolution)` reports what it
  decided.

## Writing your own

A judge only answers; the runtime does everything else.

```typescript
import type { JudgeAnswer, JudgeRequest, ShortlistJudge } from '@smallchat/core';

const inHouse: ShortlistJudge = {
  name: 'in-house',
  model: 'ranker-2026-09',
  timeoutMs: 1500,
  async judge(request: JudgeRequest): Promise<JudgeAnswer> {
    const pick = request.candidates.find(c => c.description.toLowerCase().includes('email'));
    return pick
      ? { status: 'answered', choice: pick.toolId, probability: 0.9, confidence: 0.9 }
      : { status: 'answered', choice: null, probability: null, confidence: null };
  },
};
```

Return `{ status: 'unavailable', error: 'TIMEOUT' }` (or `NETWORK`, `AUTH`,
`RATE_LIMITED`, `HTTP_<status>`, `MALFORMED`, `ABORTED`) when you have no
answer; a judge that throws counts as unavailable too.

The runtime holds every judge to its `timeoutMs` (default 4000; set it on
your judge object) and to the caller's `AbortSignal`, whether or not the
judge honours them: when either fires, the call goes on as without a judge
(`TIMEOUT` or `ABORTED`), and `request.signal` fires so your judge can stop
its work. A judge that never answers cannot hold a dispatch.
