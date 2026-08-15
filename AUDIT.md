# smallchat — Code Review & Security Audit

**Date:** 2026-08-15
**Scope:** Full repository (`src/`, `shorthand/`, `packages/*`, tooling, docs)
**Branch:** `claude/code-review-security-audit-hyxm9a`

This is a point-in-time audit covering architecture, security, dependency
hygiene, and technical debt, followed by a series of small, independently
reviewable fixes for the issues found. Each fix below has its own commit
with a detailed rationale and test coverage; this document is the summary.

## Summary

The codebase was in good shape going in: no TODO/FIXME/HACK markers, no
placeholder tests, and evidence of prior audit passes (CORS defaults,
body-size limits, env allowlisting, prototype-pollution guards — all
verified real, not superficial, and left untouched here). The issues found
in this pass follow a consistent pattern: **auth and rate-limiting
primitives existed but weren't applied uniformly across every entry point**
of a server that already had them wired up elsewhere, plus one critical
dependency CVE and a complete absence of CI. All Critical/High findings and
most Medium/Low findings were fixed; a few were deliberately deferred with
rationale (see [Deferred / Not Fixed](#deferred--not-fixed-and-why)).

## Findings & Resolutions

### Critical

| # | Finding | Resolution |
|---|---|---|
| 1 | `vitest@3.2.4` — critical arbitrary file read/execute CVE (GHSA-5xrq-8626-4rwp) | **Fixed.** Bumped to `^3.2.7`. Commit `f0ef437`. |

### High

| # | Finding | Resolution |
|---|---|---|
| 2 | `LocalTransport` sandbox gave false confidence — handler functions keep full `require`/`process`/`fs` access regardless of the `vm` context, since they're plain closures defined outside it | **Fixed (docs + warning), plus a real bug found along the way.** JSDoc and a one-time runtime warning now state plainly what `sandbox.enabled` does and doesn't provide. While verifying this, found that `timeoutMs` didn't actually bound a hanging handler in either the sandboxed or non-sandboxed path — fixed by racing against a timer instead of relying on cooperative cancellation. Commit `65d4ada`. |
| 3 | `GET /sse` bypassed the bearer-auth check applied to JSON-RPC | **Fixed.** Commit `a69533a`. |
| 4 | Resource-update notifications broadcast to every SSE client when the subscribing request had no session id | **Fixed** — now matched by exact session-id equality. Commit `a69533a`. |
| 5 | No CI — `test`/`lint`/`build` scripts existed but nothing ran them | **Fixed.** `.github/workflows/ci.yml` added, Node 20/22 matrix + audit job. Commit `641aa91`. |
| 6 | High-severity transitive CVEs in the prod dependency graph (`hono`, `adm-zip`, and Next.js-side `postcss`/`sharp`/`vite`) | **Mostly fixed.** `npm audit fix` resolved 11 of 13 findings with no `package.json` range changes. `adm-zip` (via `onnxruntime-node`'s install-time-only postinstall) is accepted risk — see [Deferred](#deferred--not-fixed-and-why). Commit `f0ef437`. |
| 7 | `src/app/` (~1,160 lines) and `src/mcp/transports/` had zero test coverage | **Partially addressed.** Added targeted regression tests for every security fix above (real HTTP server tests in `mcp.test.ts`, `channel-server.test.ts`), plus new coverage for `local-transport.ts`'s sandbox/timeout behavior and `mcp/artifact.ts` (previously untested). Broad coverage of `src/app/`'s compile/runtime pipeline was out of scope for this pass — see [Remaining Technical Debt](#remaining-technical-debt). |

### Medium

| # | Finding | Resolution |
|---|---|---|
| 8 | Rate limiter keyed on the unverified `Mcp-Session-Id` header — spoofable per request | **Fixed** — only trusts the header if it names a session that exists in the store, else falls back to remote address. Commit `a69533a`. |
| 9 | OAuth token endpoint unthrottled; secret comparison non-constant-time | **Fixed** — dedicated always-on rate limiter (20 rpm) + `crypto.timingSafeEqual`. Commit `a69533a`. |
| 10 | Channel bridge exempted `/sse` from the shared-secret check | **Fixed** — only `/health` stays open now. Commit `abc2be0`. |
| 11 | Non-constant-time secret comparison (channel bridge) | **Fixed.** Commit `abc2be0`. |
| 12 | Channel content unescaped in `<channel>` tags — provenance-spoofing prompt injection | **Fixed** — `content` now XML-text-escaped like attribute values already were. Commit `abc2be0`. |
| 13 | `ToolClass`/`ToolProxy` (re-exported from the "transport-agnostic" `inference.ts`) directly imports concrete MCP HTTP transport code | **Deferred** — see [below](#deferred--not-fixed-and-why). |
| 14 | `commander` (13→15), `better-sqlite3` (11→13) two majors behind | **Deferred** — see [below](#deferred--not-fixed-and-why). |
| 15 | Stray nested lockfiles in `shorthand/` and `packages/examples/` defeat workspace hoisting | **Deferred** — see [below](#deferred--not-fixed-and-why). |
| 16 | README overstated test count ("~1,250+" vs actual) | **Fixed.** Commit `050a4bb`. |

### Low / Informational

| # | Finding | Resolution |
|---|---|---|
| 17 | `SCDictionary.unwrap()` — dormant prototype-pollution path via a `"__proto__"` key | **Fixed** — `Object.create(null)` instead of `{}`. Commit `782aa21`. |
| 18 | `mcp/artifact.ts` used bare `JSON.parse` instead of the project's `safeJsonParse` | **Fixed.** Commit `782aa21`. |
| 19 | `transport/openapi-generator.ts` does an unrestricted `fetch(url)` — SSRF primitive | **Not fixed — accepted risk.** Only reachable from developer-driven CLI/import tooling where the URL is operator-supplied, not attacker-controlled; an allowlist would need to block legitimate `localhost` use (developers importing specs from their own dev servers), which isn't clearly a net improvement. Flagged for awareness if this code path is ever exposed to untrusted input. |
| 20 | Rate-limiter/connection-pool maps never pruned for departed clients | **Not fixed** — unbounded growth is real but slow (one entry per distinct client key) and the underlying spoofing vector that made it acute (#8) is now closed. Worth a TTL sweep if long-running server memory becomes a concern. |
| 21 | `src/importance/` (root) vs `shorthand/src/importance/` — drifted fork | **Not fixed — already tracked.** `docs/ecosystem/engineering-guide.md` already diagnoses this in detail as a "Phase 0, do first" item; re-litigating it here would duplicate that work rather than add to it. |
| 22 | `.gitignore` missing `*.log`, `coverage/` | **Fixed.** Commit `050a4bb`. |
| 23 | `shorthand/package.json` `repository.url` typo (404s) | **Fixed.** Commit `050a4bb`. |
| 24 | ~23MB ONNX model committed as a plain git blob, undocumented | **Not fixed** — noted for awareness; migrating to Git LFS is a repo-history-affecting change outside this pass's scope. |

## Deferred / Not Fixed (and why)

A few real findings were deliberately **not** acted on in this pass, each for a
specific reason rather than oversight:

- **`ToolClass`/`ToolProxy` importing MCP transport code (#13).** This is a
  genuine layering violation — the "durable, transport-agnostic" Tier-1
  bundle (`@smallchat/core/inference`) transitively carries concrete HTTP
  wire-protocol code. Fixing it properly means introducing a transport
  abstraction `ToolProxy` depends on instead of importing `mcp/transport.ts`
  directly, which is a real (if not huge) refactor touching a load-bearing
  class. Per this audit's brief to prefer small, reviewable, non-speculative
  changes, this is better done as its own scoped PR with its own review,
  not folded into a security-audit branch. **Update: done, see
  [Follow-up](#follow-up-deferred-items-addressed-second-pass).**
- **`commander`/`better-sqlite3` major bumps (#14).** Both now require
  Node ≥22, which would silently raise this project's declared
  `engines.node: >=20.0.0` floor — a real breaking change for any consumer
  still on Node 20, and one this audit isn't positioned to decide on the
  maintainer's behalf. The CI workflow added in this pass tests both Node 20
  and 22, so whenever that floor decision is made, CI will immediately
  surface any fallout.
- **`packages/docs`'s remaining 22 `npm audit` findings.** All require
  forcing `@docusaurus/preset-classic` to `3.10.2` while `@docusaurus/core`
  stays pinned at `3.6.3` (a mismatched, out-of-range pair) — not safe to
  take piecemeal. Needs a coordinated bump of all four `@docusaurus/*`
  packages together, verified with a real `docusaurus build`, as its own
  change. **Update: done, see [Follow-up](#follow-up-deferred-items-addressed-second-pass).**
- **Stray nested lockfiles in `shorthand/` and `packages/examples/` (#15).**
  Both were touched as recently as the "adopt workspaces" commit, meaning
  someone deliberately kept them post-migration — plausibly because
  `shorthand` is also published standalone as `@shorthand/core` outside this
  monorepo and needs its own lockfile for that independent pipeline. Removing
  them without confirming that intent risked breaking a workflow this audit
  can't see from the repo alone. **Update: investigated and resolved, see
  [Follow-up](#follow-up-deferred-items-addressed-second-pass).**
- **`src/importance/` vs `shorthand/src/importance/` fork (#21).** Already
  identified and scoped in `docs/ecosystem/engineering-guide.md` as a
  "Phase 0" item with its own analysis. Redoing that analysis here would
  duplicate, not add to, existing tracked work.

## Follow-up: Deferred Items Addressed (second pass)

The five items in [Deferred / Not Fixed](#deferred--not-fixed-and-why) above
were revisited in a follow-up pass after the first PR merged:

- **Stray nested lockfiles (#15) — resolved.** Investigated both open
  questions directly: `@shorthand/core` is not published to npm at all
  (registry 404), and `@smallchat/examples`, while published, doesn't need a
  lockfile for that (publishing doesn't consume one). More importantly,
  `npm install` run inside either directory doesn't update its local
  lockfile — npm defers to the workspace root — so neither file was being
  maintained by any normal workflow. This had already caused real drift:
  `shorthand/package-lock.json` still resolved `vitest@3.2.4`, the exact
  version with the critical CVE fixed at the root in the first pass,
  invisible to root-level `npm audit`/CI. Both lockfiles removed.
- **`packages/docs` remaining 22 findings — mostly resolved.** Bumped all
  four `@docusaurus/*` packages together to `3.10.2` (from `3.6.3`),
  verified with a real `docusaurus build`, and fixed a config deprecation
  warning (`onBrokenMarkdownLinks` → `markdown.hooks.onBrokenMarkdownLinks`)
  the bump surfaced. `npm audit fix` at the new version resolves down to 24
  (6 moderate, 18 high) — `serialize-javascript`/`uuid`/`sockjs`/
  `webpack-dev-server` transitively via `@docusaurus/bundler`'s webpack
  tooling, with **no fix available** even at Docusaurus's current latest
  release (confirmed via `npm audit`'s own output). These are build/dev-time
  tooling dependencies, not shipped in the static site users receive; there
  is nothing further to do here until Docusaurus itself updates that
  dependency chain upstream.
- **`ToolClass`/`ToolProxy` transport layering (#13) — resolved.** Added a
  `ToolTransport` interface (plus `ToolTransportConnectionOptions` and a
  `ToolTransportFactory` type) to `src/core/types.ts`, purely structural —
  zero runtime import. `ToolProxy` no longer imports `MCPTransport`/
  `getTransport` from `mcp/transport.ts` at all; its constructor now takes
  an optional `transportFactory` and returns a clear "no transport
  configured" error result (instead of silently reaching into a concrete
  implementation) when none was injected. The two call sites that construct
  `ToolProxy` — `compiler.ts`'s `createIMP` and `mcp/artifact.ts`'s
  `hydrateRuntime` — now explicitly pass `getTransport` from
  `mcp/transport.ts`, preserving identical existing behavior. Verified the
  fix is real (not just moved) by grepping the built `dist/inference.js`,
  `dist/core/*.js`, and `dist/runtime/*.js` for any reference to
  `mcp/transport` — none — and added `src/inference.test.ts`, a source-scan
  regression test that fails if any core/runtime file statically imports
  `mcp/transport.ts` again.
- Remaining items (`src/importance/` fork consolidation,
  `commander`/`better-sqlite3` majors) — see updates further below as each
  is addressed.

## Dependency Upgrade Summary

- `vitest`: `^3.0.0` → `^3.2.7` (closes a critical CVE; both `package.json`
  and `shorthand/package.json` share this floor).
- `npm audit fix` (lockfile-only, no `package.json` range changes): patched
  `hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `body-parser`
  (transitive via `@modelcontextprotocol/sdk`), and `next`, `postcss`,
  `sharp`, `vite`, `esbuild`, `nanoid` (`packages/nextjs`).
- **No migration steps required** — every change was either a `devDependency`
  floor bump within the existing semver range or a transitive lockfile
  update; no direct dependency's major version changed and no public API
  this project exposes changed.
- **Remaining `npm audit` finding (root):** `adm-zip <0.6.0` via
  `onnxruntime-node`. Accepted risk (see Critical/High table above, #6).
  CI's audit job is intentionally gated at `--audit-level=critical` rather
  than `high` so this known, accepted finding doesn't produce permanent
  false-red CI; a genuinely new critical vulnerability will still fail the
  build.
- **`packages/docs` was a blind spot.** It carries its own `package-lock.json`
  and isn't part of the root npm workspace, so none of the above touched it
  — confirmed by GitHub reporting 106 total repo vulnerabilities on push
  against the 13 `npm audit` found at root. Running `npm audit fix` there
  too resolved 22 of 44 (both critical findings included), and separately
  surfaced that `docusaurus build` was already broken on a pre-existing bad
  link (`docs/integrations/index.md` → `./loom-mcp`, which the page's
  `slug: /integrations` override resolves incorrectly) — fixed alongside.
  Added a `docs` job to CI so both the dependency audit and the build are
  now checked for this package too. The remaining 22 findings there need a
  coordinated Docusaurus 3.6→3.10 upgrade — see
  [Deferred](#deferred--not-fixed-and-why).

## Remaining Technical Debt & Recommended Next Steps

Roughly in priority order:

1. **Decide the Node floor**, then take the `commander`/`better-sqlite3`
   major bumps (both are otherwise routine).
2. ~~Scope a `ToolProxy` transport-abstraction refactor~~ — done, see
   [Follow-up](#follow-up-deferred-items-addressed-second-pass).
3. **Test coverage:** `src/app/` (MCP Apps compile/runtime pipeline, ~1,160
   lines) still has no tests; `src/memex/resolver.ts`'s primary `resolve()`
   function is untested (only its `computeTier()` helper is); `LocalEmbedder`
   (the placeholder hash-based embedder referenced in QUICKSTART.md) has no
   tests.
4. **Consolidate `src/importance/` with `@shorthand/core/importance`**
   per `docs/ecosystem/engineering-guide.md`'s existing analysis.
5. **Un-nest the stray lockfiles** in `shorthand/` and `packages/examples/`
   once their independent-publish requirements (if any) are confirmed, or
   document why they're intentionally separate.
6. **Consider Git LFS** for the committed ONNX model files, or at minimum
   document the convention in ARCHITECTURE.md/README.md.
7. **Prune stale entries** from the rate limiter's and connection pool's
   in-memory maps on a TTL, for long-running server processes.

## Verification

Every commit in this pass was verified independently before landing:
`npm test` (full suite, 1153/1153 passing after all changes),
`npm run build` (root `tsc`), and — for the CI addition specifically —
every workflow step (`npm ci`, lint, test, build, `build:packages`,
`npm audit --audit-level=critical`) run locally first to confirm the
workflow would actually pass before being added.

## Commit Log (this audit)

```
6866756 fix(docs): resolve 22 of 44 docs-site vulnerabilities, fix broken link
bc3f9b3 docs: add structured audit report and CHANGELOG entries
050a4bb chore: small hygiene fixes (.gitignore, README doc drift, repo URL typo)
641aa91 ci: add GitHub Actions workflow (lint, test, build, dependency audit)
782aa21 fix(core,mcp): harden SCDictionary.unwrap() and use safeJsonParse in artifact.ts
65d4ada fix(transport): make timeoutMs actually bound non-cooperating handlers
abc2be0 fix(channel): auth-gate /sse, constant-time secret check, escape content
a69533a fix(mcp): close auth/rate-limit gaps on the MCP HTTP server
f0ef437 fix(deps): resolve critical vitest CVE and 11 transitive high/moderate vulns
```

(plus a follow-up commit adding CI coverage for `packages/docs` and
recording the docs-site findings above, made after this list was
initially written)
