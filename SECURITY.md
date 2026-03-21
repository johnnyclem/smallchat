# Security Audit — smallchat v0.1.0

**Date:** 2026-03-21
**Scope:** API key handling, user data in logs, secrets management, transport security

---

## Executive Summary

The audit identified **3 critical**, **4 medium**, and **5 low** findings. All critical findings have been
addressed in the current implementation. Medium and low findings have mitigations in place or are
tracked for resolution in subsequent releases.

---

## Findings

### CRITICAL

#### SEC-001 — API Keys Logged in Plain Text (RESOLVED)
**Severity:** Critical
**Status:** Resolved
**Description:** Prior to this release, tool arguments (which may contain API keys and secrets) were
passed directly to `console.log()` calls in the dispatch path and audit logger. This caused API keys
such as `ANTHROPIC_API_KEY` to appear in system logs.

**Resolution:** Implemented `redactSecrets()` in `src/config/secrets.ts`. All audit log entries now
pass through secret redaction before storage. The flight recorder strips known secret keys. Log
statements in dispatch.ts only log intent/selector/tool names, never argument values.

**Test:** Check that `ANTHROPIC_API_KEY` does not appear in log output when a tool is called with
that argument.

---

#### SEC-002 — SQLite Session Database World-Readable (RESOLVED)
**Severity:** Critical
**Status:** Resolved
**Description:** The SQLite database (`smallchat.db`) stored OAuth tokens and session metadata with
no file permission restrictions, making it readable by any process running as the same OS user.

**Resolution:** The Dockerfile creates the `/data` directory owned by the `smallchat` non-root user
(UID 1000). The CLI `serve` command now accepts `--db-path` allowing operators to place the DB in a
restricted directory. Documented in `.env.example` with `SC_DB_PATH`.

---

#### SEC-003 — Bearer Tokens in URL Parameters (RESOLVED)
**Severity:** Critical
**Status:** Resolved
**Description:** Some test clients were passing OAuth bearer tokens as URL query parameters
(`?token=...`), causing them to be logged by access loggers and appear in browser history.

**Resolution:** The OAuth middleware in `src/mcp/oauth.ts` only accepts tokens in the
`Authorization: Bearer <token>` HTTP header. URL parameter tokens are rejected with HTTP 401.
Added documentation warning against URL token usage.

---

### MEDIUM

#### SEC-004 — No HTTPS in Built-in Server
**Severity:** Medium
**Status:** Accepted (with mitigation)
**Description:** The built-in HTTP server (`MCPServer`) serves all traffic over plain HTTP, including
OAuth token exchange. This exposes bearer tokens to network interception in non-localhost deployments.

**Mitigation:**
- The server binds to `127.0.0.1` by default (not `0.0.0.0`)
- The Dockerfile and Helm chart expose the service via `ClusterIP` only
- Production deployments should terminate TLS at an ingress (nginx, Traefik, AWS ALB)
- Documented in `values.yaml` under the `ingress` section

**Recommendation:** Add optional TLS configuration with `node:tls` in a future release.

---

#### SEC-005 — Rate Limiting Bypass via Session ID Spoofing
**Severity:** Medium
**Status:** Accepted (design limitation)
**Description:** The client-side rate limiter keys on `Mcp-Session-Id` header or `remoteAddress`. A
client could bypass per-client rate limits by cycling session IDs or spoofing IP addresses behind
NAT/proxy.

**Mitigation:** The Helm chart configures a network-level ingress rate limit. The per-tool rate
limiter (`toolRateLimits` config) provides a secondary layer that cannot be bypassed by session
spoofing.

---

#### SEC-006 — Tool Argument Injection
**Severity:** Medium
**Status:** Accepted (design limitation)
**Description:** Tool arguments are passed directly to `ToolIMP.execute()` without sanitization.
For tools that execute shell commands or database queries, malicious arguments could enable injection.

**Mitigation:** This is a design concern for tool *implementors*, not the smallchat runtime. The
dispatch system validates argument schemas via `ArgumentConstraints`. Tool implementors **must**
sanitize inputs and use parameterized queries/command arrays, never string interpolation.

**Documentation:** Added to the Tool Implementation Guide (see `ARCHITECTURE.md`).

---

#### SEC-007 — CORS Wildcard (`*`)
**Severity:** Medium
**Status:** Accepted for local dev
**Description:** The server sets `Access-Control-Allow-Origin: *`, allowing any origin to make
credentialed requests. In combination with an unprotected endpoint, this could enable CSRF.

**Mitigation:** The `/oauth/token` endpoint requires `client_id`/`client_secret`, making CSRF
impractical. For production, the `Access-Control-Allow-Origin` header should be restricted to known
origins via a `corsOrigins` config option (tracked as a follow-up task).

---

### LOW

#### SEC-008 — Flight Recorder Contains Sensitive Arguments
**Severity:** Low
**Status:** Resolved
**Description:** The flight recorder saves `args` (tool arguments) to disk. If a tool is called
with an API key as an argument, it would be persisted.

**Resolution:** The flight recorder calls `redactSecrets()` on the `args` field before writing.
The on-disk file is also now excluded from Docker image via `.dockerignore`.

---

#### SEC-009 — Dependency Supply Chain
**Severity:** Low
**Status:** Accepted
**Description:** The project depends on `better-sqlite3`, `onnxruntime-node`, and `sqlite-vec`
native addons that execute compiled C++ code. These are not audited at the source level.

**Mitigation:** Lock exact versions in `package-lock.json`. Enable `npm audit` in CI. Consider
using `--ignore-scripts` where possible.

---

#### SEC-010 — No Request Size Limits
**Severity:** Low
**Status:** Accepted
**Description:** The HTTP server reads the entire request body with no size limit, enabling
memory exhaustion via large payloads.

**Mitigation:** `readBody()` should enforce a configurable max body size (default 1MB). Tracked
as a follow-up task.

---

#### SEC-011 — Error Messages Leak Internal Details
**Severity:** Low
**Status:** Accepted
**Description:** Error responses from the JSON-RPC handler include raw exception messages, which
may reveal internal file paths, stack traces, or implementation details to attackers.

**Mitigation:** In production, consider enabling `obscureErrors: true` config option (tracked as
follow-up) to replace internal error messages with opaque error codes in responses while logging
full details internally.

---

#### SEC-012 — Session Tokens Not Invalidated on Timeout
**Severity:** Low
**Status:** Accepted
**Description:** Session TTL pruning runs only at startup (`server.start()`). Long-running servers
accumulate expired sessions that are never pruned until restart.

**Mitigation:** The `SessionStore.prune()` call should run on a periodic timer (e.g. every hour).
Tracked as follow-up.

---

## Recommendations for Production Deployments

1. **Always run behind TLS** — use nginx/Traefik ingress with cert-manager
2. **Enable OAuth authentication** — set `enableAuth: true`
3. **Enable rate limiting** — set `enableRateLimit: true` with appropriate RPM
4. **Restrict CORS** — configure `corsOrigins` to your domain
5. **Use secrets management** — inject API keys via Kubernetes Secrets, never in configmaps
6. **Enable audit logging** — set `enableAudit: true` for compliance
7. **Run as non-root** — already enforced in the Dockerfile and Helm chart
8. **Scan dependencies** — run `npm audit` in CI/CD
9. **Restrict network access** — use Kubernetes NetworkPolicy to limit pod-to-pod communication
10. **Rotate tokens regularly** — set short `expiresIn` for OAuth tokens

---

## Responsible Disclosure

Security vulnerabilities can be reported to: security@smallchat.dev
We follow a 90-day disclosure policy.
