# smallchat canonical tool id (`smallchat.tool-id.v1`)

The canonical tool id names one upstream tool everywhere in the suite:
artifacts, call digests (`spec/call-digest/`), proofs, decision logs and
policies.

```
toolId = providerId "/" toolName
```

- `providerId` is non-empty and contains no `/`. The first `/` therefore
  ends it, and an id splits in exactly one way: `p/a/b` is provider `p`,
  tool `a/b`.
- `toolName` is non-empty and is the upstream tool name verbatim (no case
  folding, no Unicode normalization).
- An empty id, an id without `/`, an empty provider id or an empty tool
  name is invalid. The TypeScript `parseToolId` / `toolId` throw
  `TypeError`.

## MCP names (`smallchat serve`)

- **Aggregate mode** (default) exposes `providerId + "__" + toolName`, but
  only when the provider id matches `[A-Za-z0-9_-]+`, contains no `__` and
  does not end in `_` (so the first `__` always ends the provider id), and
  the whole name matches `^[A-Za-z0-9_-]{1,128}$`. A tool that fails either
  rule is not exposed under another name: it is reported as skipped and can
  be served with `--provider <id>`.
- **Per-provider mode** (`serve --provider <id>`) exposes that provider's
  tools under `toolName` verbatim.

## Golden vectors

`vectors.json`:

- `valid[]`: `{ id, providerId, toolName, aggregateName }` where
  `aggregateName` is `null` when aggregate mode skips the tool. Includes the
  128-character boundary (`p__` + 125 characters is exposed, + 126 is not).
- `invalid[]`: `{ id, reason }` ids every implementation must refuse.

The TypeScript suite runs them in `src/core/tool-id-vectors.test.ts`.
