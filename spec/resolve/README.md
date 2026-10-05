# smallchat resolve outcomes (`smallchat.resolve.v1`)

What `resolve(intent)` decides once similarities are known: the dispatch
policy, tiers, ranking, verification gating and intent pins. The vectors
are independent of any embedder; each tool's cosine similarity to the
intent is an input. The ranking and tier rules they rely on are
`spec/ranking/`.

## Running a case

1. Embed the intent as the unit vector `e₀`, and give tool *i* (0-based, in
   `tools` order) the selector vector `score·e₀ + √(1−score²)·e₍ᵢ₊₁₎`, so its
   cosine similarity to the intent is `score`. The selector canonical is
   `<providerId>.<toolName>`; every tool is a plain (non-overloaded) method
   of a class named after its provider.
2. Each tool's description is the case's intent text, so keyword
   verification passes; its input schema is `{ "type": "object" }`; its
   `annotations` are as given (absent: none).
3. `pins` become intent pins on the tool's selector canonical: `phrases`
   are the pin's aliases; `threshold` is an `elevated` pin's bar.
4. `options.llm.approve` lists the tool **names** an LLM verifier approves
   (absent: no LLM verifier is configured). `requireLLMForSubHighDispatch`
   (default `true`) and `treatUnannotatedAsDestructive` (default `false`)
   are runtime options. Thresholds are the defaults.
5. Resolve the intent (no arguments, nothing executes) and compare:
   `outcome`; `decision` (the proof's decision code); `tier` of the chosen
   or best candidate; `chosen` (or `null`); `candidates`, the eligible tool
   ids best first; and, when given, `excluded`, the candidates the pin gate
   removed with their reason.

## Outcomes and decisions

| outcome | decision codes in the vectors |
|---|---|
| `resolved` | `ranked` (EXACT/HIGH), `llm-verified`, `verified` (keyword verification, with `requireLLMForSubHighDispatch: false`), `pin-exact` |
| `needs-disambiguation` | `needs-llm-verifier`, `verification-failed`, `destructive-needs-exact` |
| `unresolved` | `no-candidates` |

The TypeScript suite runs them in `src/runtime/resolve-vectors.test.ts`.
Not covered here: learned preferences, the cache, overloads, decomposition
and rate limiting, which depend on runtime history rather than on one
call's inputs.

These vectors assume no shortlist judge (`RuntimeOptions.judge` unset):
run them without one. With a judge, a near-tie or a below-HIGH winner may
be decided by it, with the decision codes `judge-approved` and
`judge-declined`; that is specified, with its own vectors, in
`spec/judge/`.
