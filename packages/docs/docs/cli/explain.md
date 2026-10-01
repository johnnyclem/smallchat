---
title: explain
sidebar_label: explain
---

# `explain`

Shows why the runtime would (or would not) pick a tool for an intent. Nothing executes.

## Usage

```bash
npx -y @smallchat/core explain <artifact> "<intent>" [--args '{...}'] [--principal id] [--config smallchat.json] [--decision-log file] [--json]
```

## Output

- The artifact's content hash, the embedder fingerprint, the tier thresholds and the guards in force (LLM verifier, strict mode).
- The outcome (`resolved`, `needs-disambiguation`, `unresolved`), the decision code and tier, the chosen tool and the reason.
- The candidate table: rank, canonical tool id, score, similarity from the intent's own embedding, tier, source (vector, cache, pin, learned…), MCP hints (read-only, destructive, pinned) and the dispatch policy's verdict on running that candidate without the caller naming it — the same policy every dispatch path applies. Excluded candidates show the rule that excluded them.
- The proof's steps and its `proofDigest`.

```
Outcome:     needs-disambiguation  (decision needs-llm-verifier, tier MEDIUM)
Reason:      gitlab/create_issue scored 0.759 (medium); below HIGH a tool runs only after an LLM verifier approves it

  #   tool                 score   sim     tier    source  hints  policy
  1   gitlab/create_issue  0.7589  0.7589  MEDIUM  vector  —      needs-llm-verifier
  2   linear/create_issue  0.7278  0.7278  LOW     vector  —      needs-llm-verifier
  3   github/create_issue  0.6677  0.6677  LOW     vector  —      needs-llm-verifier
```

The policy comes from the nearest `smallchat.json` (as `serve` reads it) unless `--config` names one. The library equivalent is `runtime.explain(intent)`.
