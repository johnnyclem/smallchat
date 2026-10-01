# smallchat candidate ranking (`smallchat.rank.v1`)

How resolution turns similarity scores into an ordered candidate list and a
confidence tier. Every suite implementation (TypeScript `quantizeScore`,
`compareRanked` and `computeTier` in `src/core/confidence.ts`,
smallchat-swift) must produce the same results for the vectors in
`vectors.json`.

## Rules

1. **Quantize.** Every score is rounded to 4 decimal places before it is
   compared with anything: `q(s) = round(s × 10000) / 10000`, rounding half
   away from zero, clamped to `[0, 1]`; a non-finite score is `0`. Vector
   backends (float32 SQLite, float64 in-memory) and platforms differ in the
   last bits of a cosine similarity; quantizing keeps those differences from
   changing an outcome. The golden vectors avoid exact half-quantum inputs,
   whose binary representation makes the rounding direction
   implementation-sensitive.
2. **Order.** Candidates are sorted by quantized score, highest first;
   equal quantized scores are ordered by canonical tool id
   (`<providerId>/<toolName>`), compared by UTF-16 code units, ascending.
3. **Threshold.** A candidate is above a threshold `t` when `q(s) >= t`.
   Tiers use the default thresholds unless configured: EXACT `>= 0.95`,
   HIGH `>= 0.85`, MEDIUM `>= 0.75`, LOW `>= 0.60`, otherwise NONE.
4. **Similarity.** Scores are cosine similarities `1 − d`, where `d` is the
   cosine distance a vector index reports (SQLite indexes declare
   `distance_metric=cosine`).

## Determinism property

For the same compiled artifact (`contentHash`), the same embedder
(fingerprint) and the same runtime state — registered classes, intent pins,
semantic map, negative examples from feedback, resolution cache, runtime
options — resolving the same intent text yields the same outcome, chosen
tool, candidate order and `proofDigest`. Other intents the process resolved
before do not enter into it (runtime intents are never interned into the
tool index). Not covered: answers from an LLM verifier or decomposer (an
input like any other), an opted-in rate limiter's window, and float drift
larger than half a quantum between platforms.

## Golden vectors

`vectors.json` holds three lists:

- `quantize`: `{ input, expected }`.
- `rank`: `{ name, candidates: [{ toolId, score }], expected: [toolId…] }`.
- `tier`: `{ score, expected }` with the default thresholds.
