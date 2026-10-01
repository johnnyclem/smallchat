---
title: resolve
sidebar_label: resolve
---

# `resolve`

Shows which tool the runtime would choose for a natural-language intent, and why. It runs the same resolution as `runtime.resolve()` and `serve`'s `smallchat_resolve`: tiers, intent pins, the dispatch policy from the nearest `smallchat.json`, and verification. It prints the outcome, the candidate table and the proof digest. Nothing executes unless you pass `--execute`.

## Usage

```bash
npx -y @smallchat/core resolve <file> "<intent>" [--execute [--force]] [--args '<json>'] [--json]
```

## Arguments and options

| | Description |
|---|---|
| `<file>` | Path to a compiled artifact |
| `"<intent>"` | Natural-language intent to resolve |
| `-e, --embedder <type>` | Expected embedder. Refuses if the artifact was compiled with another. |
| `-x, --execute` | Run the chosen tool on its upstream server. Only a `resolved` outcome at **EXACT or HIGH** tier runs. |
| `--force` | With `--execute`: run the chosen tool (or, when nothing was chosen, the top-ranked candidate) at any tier |
| `--args <json>` | Arguments for the call. They are validated against the tool's `inputSchema` and also used to choose among overloads. |
| `--timeout <ms>` | Upstream call timeout (default 30000) |
| `--json` | Print the resolution (and result) as JSON |
| `--decision-log <path>` | Append the resolution (and, with `--execute`, the call) to a hash-chained JSONL decision log |

## Example

```bash
npx -y @smallchat/core resolve tools.toolkit.json "search for code"
```

```
Intent: "search for code"
Outcome: resolved (tier HIGH, decision ranked)
Chosen: github/search_code  (serve name: github__search_code)

Candidates:
  github/search_code  score 0.912  HIGH  via vector
  gitlab/search_code  score 0.801  MEDIUM  via vector

Proof digest: 4c1f…
```

`--execute` runs the chosen tool through the same path as `serve`: `dispatchById`, argument validation, then the upstream MCP server from the artifact's launch spec. Below HIGH tier, or when the outcome is `needs-disambiguation` / `unresolved`, it prints why and exits with code 1 without running anything, unless `--force` is given.

## Exit codes

- **0**: resolved (and, with `--execute`, the tool ran without `isError`)
- **1**: load error, execution refused, or the tool returned `isError`

Without `--execute` the exit code is 0 whatever the outcome. Use `--json` and check `resolution.outcome` and `resolution.chosen` in CI.
