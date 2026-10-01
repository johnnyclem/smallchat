---
title: replay
sidebar_label: replay
---

# `replay`

Checks golden dispatch traces against a compiled artifact: for each intent, the runtime must decide what the trace expects. Use it in CI so a changed description, embedder, threshold or policy cannot silently change which tool an intent selects.

## Usage

```bash
npx -y @smallchat/core replay <artifact> <traces...> [--json] [--config smallchat.json] [--semantic-map map.json]
```

| Argument / option | Description |
|---|---|
| `<artifact>` | Compiled artifact (`.json` or `.db`) |
| `<traces...>` | Trace files (`.jsonl`, `.json`), directories of them (searched recursively), or decision logs |
| `--config <file>` | Take the dispatch policy from this `smallchat.json` (default: the nearest one, as `serve` does) |
| `--semantic-map <file>` | Learned state to replay with (`runtime.semanticMap.toJSON()`); read, never written |
| `--json` | Print the report as JSON |

Exit codes: **0** every case passed, **1** a mismatch (or a decision log whose hash chain is broken or whose outcomes no longer reproduce), **2** could not run (artifact or embedder unavailable, unreadable trace file, no cases).

## Trace format

JSONL, one case per line (blank lines and `#` comments are skipped), or JSON (an array of cases, or `{"cases": [...]}`):

```jsonl
{"intent": "send a slack message", "expect": {"toolId": "slack/send_message", "tier": "high"}}
{"intent": "create_issue", "expect": {"outcome": "needs-disambiguation", "candidates": ["github/create_issue", "gitlab/create_issue"]}}
{"intent": "make me a sandwich", "expect": {"outcome": "unresolved"}}
```

| `expect` | Passes when |
|---|---|
| `{toolId, tier?}` | the runtime resolves, on its own, to exactly that canonical tool id (at that tier, when given) |
| `{outcome: "needs-disambiguation", candidates?}` | the runtime refuses to pick; every listed id is among its candidates (or its refinement options when nothing reached LOW) |
| `{outcome: "unresolved"}` | nothing matched |

A case may also carry `args` (used to choose among overloads and in verification), `principal` and `name`.

## What "frozen" means

Cases run through `runtime.resolve()` with learning off: nothing executes, nothing is cached, the semantic map and feedback are read but never written, and case order cannot change a result. The same artifact, embedder, policy and learned state give the same results on one platform; scores are quantized to 1e-4 so small cross-platform float differences do not flip a decision, but a score sitting within that distance of a threshold can still differ.

## Decision logs

A file whose lines are decision-log records (`serve --decision-log`, `RuntimeOptions.decisionLog`) is recognised automatically: its hash chain is verified, then its intents are re-resolved against the artifact and each outcome, tool id and tier is compared with what was logged. Lines recorded against another artifact or embedder, and decisions that rested on inputs the log does not hold (an LLM verifier's answer, a decomposition, the rate limiter), are reported as skipped.

## Example traces

`examples/traces/` holds traces for the example manifests; `npm run test:traces` compiles `examples/*-manifest.json` and replays them, and CI runs it.
