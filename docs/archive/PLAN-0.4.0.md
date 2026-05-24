# smallchat 0.4.0 — "Tool Selection Errors: Solved"

> "An object that doesn't understand a message doesn't crash.
> It sends `doesNotUnderstand:` — and gets a second chance."
> — Smalltalk design principle

## The Thesis

smallchat 0.3.0 dispatches tools semantically and deterministically. It's
fast, it's typed, it's cached. But "solved" is a stronger claim than "usually
works." Today, when vector similarity alone can't decide, the runtime shrugs:
it returns a fallback stub and says "want me to search?" That's not solved.
That's a polite failure.

0.4.0 closes every remaining gap where the wrong tool gets picked, or no tool
gets picked when one should. The release has one north star:

**After 0.4.0, a smallchat-compiled toolkit should never silently dispatch the
wrong tool, and should never fail to dispatch when a correct tool exists.**

---

## Design Philosophy: The Self-Correcting Runtime

Objective-C doesn't crash on an unknown selector. It gives the object three
chances to handle it: `resolveInstanceMethod:`, `forwardingTargetForSelector:`,
and `forwardInvocation:`. Each step is more expensive but more powerful.

smallchat 0.3.0 has steps 1 and 2 (cache + vector search, forwarding chain).
But step 3 — the intelligent, expensive, "try everything" path — is a stub.
And there's no step 0: verifying the dispatch was correct *after* resolution.

0.4.0 adds both. The runtime becomes a closed loop:

```
  ┌─────────────────────────────────────────────────────┐
  │                  DISPATCH LOOP                      │
  │                                                     │
  │  intent ──► resolve ──► verify ──► execute          │
  │               │            │           │            │
  │               │            ▼           ▼            │
  │               │        mismatch?   observe result   │
  │               │            │           │            │
  │               │            ▼           ▼            │
  │               │       decompose    record signal    │
  │               │       or refine        │            │
  │               │            │           ▼            │
  │               ◄────────────┘      adapt thresholds  │
  └─────────────────────────────────────────────────────┘
```

---

## The Five Pillars

### Pillar 1: Confidence-Tiered Dispatch

**Problem:** Today, dispatch is binary — match or fallback. A tool at 0.76
similarity is treated identically to one at 0.94. The 0.76 match quietly
dispatches and might be wrong. The system has no vocabulary for uncertainty.

**Solution:** Every dispatch returns a confidence tier, and each tier triggers
different runtime behavior:

```
  EXACT    (≥ 0.95)  →  dispatch immediately, cache aggressively
  HIGH     (≥ 0.85)  →  dispatch, log for review
  MEDIUM   (≥ 0.75)  →  dispatch with verification (Pillar 2)
  LOW      (≥ 0.60)  →  trigger decomposition (Pillar 3)
  NONE     (< 0.60)  →  trigger refinement protocol (Pillar 4)
```

**Key design choice:** The tiers aren't just metadata — they change runtime
behavior. A MEDIUM dispatch runs a verification check before execution. A LOW
dispatch triggers intent decomposition. This makes confidence *actionable*.

**Implementation sketch:**

```typescript
interface DispatchResult<T = unknown> {
  tool: string;
  output: T;
  confidence: ConfidenceTier;
  proof: ResolutionProof;      // new: why this tool was chosen
  alternatives: Alternative[]; // new: what else was close
}

type ConfidenceTier = 'exact' | 'high' | 'medium' | 'low' | 'none';
```

**What changes:**
- `resolveToolIMP()` computes a tier from the similarity score
- `toolkit_dispatch()` branches on the tier
- Streaming events gain a `confidence` field
- The fluent API gains `.requireConfidence('high')` for callers who want to
  opt in to stricter matching

**Files touched:** `src/runtime/dispatch.ts`, `src/core/types.ts`

---

### Pillar 2: Pre-Flight Verification (`respondsToSelector:`)

**Problem:** A tool can match semantically but be structurally wrong. "Send
email" matches a `send_slack_message` tool at 0.78 similarity — close enough
to dispatch under the current threshold, but the args are wrong, the semantics
are wrong, and the user gets a confusing error from Slack's API.

**Solution:** Before executing a MEDIUM-confidence dispatch, run a fast
structural check: does this tool's input schema actually accept the provided
arguments? Does the tool's description overlap with the intent beyond just
vector proximity?

This is the `respondsToSelector:` check — a lightweight gate between
resolution and execution.

```typescript
interface VerificationResult {
  pass: boolean;
  schemaMatch: boolean;       // do the args fit the tool's input schema?
  descriptionOverlap: number; // keyword/entity overlap score
  reason?: string;            // why it failed
}
```

**Three verification strategies (progressive cost):**

1. **Schema validation** (microseconds): JSON Schema `validate(args, tool.inputSchema)`.
   If the args don't fit, the tool is wrong. No LLM needed.

2. **Keyword overlap** (microseconds): Extract entities/keywords from intent
   and tool description. If "email" appears in the intent but not in the tool's
   name, description, or parameter names — flag it.

3. **LLM micro-check** (optional, ~100ms): For MEDIUM-confidence dispatches
   where schema and keywords pass, ask a fast model (Haiku-class): "Does
   the tool `{name}: {description}` match the intent `{intent}`? Yes/No."
   Single token response. Only triggered when the other two checks are
   inconclusive.

**Key insight:** Most wrong dispatches can be caught by schema validation
alone. The tool for "send Slack message" requires a `channel` parameter. If
the caller said "send email to bob@example.com" and passed `{to: "bob@..."}`,
the schema check fails immediately — no LLM needed.

**Files touched:** `src/runtime/dispatch.ts` (new `verify()` step),
new `src/runtime/verification.ts`

---

### Pillar 3: Intent Decomposition (`doesNotUnderstand:`)

**Problem:** Complex intents like "find all Python files that import requests
and check if they handle timeouts" are single messages that map to a *chain*
of tools, not a single tool. Vector similarity finds the closest single tool
and dispatches it, losing the multi-step nature of the request.

**Solution:** When confidence is LOW (0.60–0.75), instead of force-matching
a single tool, decompose the intent into sub-intents and dispatch each one.
This is the Smalltalk "message cascade" — one message becomes many.

```typescript
interface DecompositionResult {
  original: string;
  subIntents: SubIntent[];
  strategy: 'sequential' | 'parallel' | 'conditional';
}

interface SubIntent {
  intent: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];  // data flow between sub-intents
}
```

**How it works:**

1. The runtime detects a LOW-confidence match
2. It sends the intent + available tool descriptions to an LLM:
   "Break this intent into sub-steps using only these tools: [...]"
3. The LLM returns a plan: `[{intent: "find files", args: {pattern: "*.py"}},
   {intent: "search code", args: {query: "import requests"}, dependsOn: ["find files"]},
   ...]`
4. Each sub-intent is dispatched through the normal pipeline (which may itself
   be EXACT or HIGH confidence)
5. Results flow through the dependency graph

**Key design choice:** Decomposition is *recursive* — a sub-intent can itself
decompose. But there's a depth limit (default: 3) to prevent infinite chains.
And each sub-intent goes through the full dispatch pipeline including
verification, so wrong sub-dispatches get caught.

**The Smalltalk parallel:** `doesNotUnderstand:` doesn't just fail. It gives
the object a chance to *interpret* the message in a new way. Intent
decomposition is that reinterpretation.

**Files touched:** new `src/runtime/decomposition.ts`,
`src/runtime/dispatch.ts` (LOW-tier branch)

---

### Pillar 4: Refinement Protocol (`forwardInvocation:`)

**Problem:** When confidence is NONE (<0.60), the system has no good match.
Today it returns a fallback stub with suggestions. But those suggestions are
passive — the caller has to figure out what to do next. There's no
conversation.

**Solution:** A refinement protocol that turns dispatch into a dialogue. When
the runtime can't resolve, it asks a structured question back to the caller,
narrowing the intent until resolution succeeds.

```typescript
interface RefinementRequest {
  type: 'refinement_needed';
  originalIntent: string;
  question: string;           // natural language question
  options: RefinementOption[]; // structured choices
  narrowedIntents: string[];  // suggested rewrites
}

interface RefinementOption {
  label: string;
  intent: string;   // what to dispatch if chosen
  confidence: number;
}
```

**Example flow:**

```
Caller: "deploy the thing"

Runtime (NONE confidence):
{
  type: 'refinement_needed',
  originalIntent: 'deploy the thing',
  question: 'What would you like to deploy?',
  options: [
    { label: 'Deploy to staging', intent: 'deploy to staging', confidence: 0.82 },
    { label: 'Deploy to production', intent: 'deploy to production', confidence: 0.81 },
    { label: 'Deploy Docker container', intent: 'deploy container', confidence: 0.73 },
  ],
  narrowedIntents: ['deploy to staging', 'deploy to production', 'deploy container']
}
```

The caller picks an option (or rewrites the intent), and dispatch continues
with the refined intent — which should now be HIGH or EXACT confidence.

**MCP protocol extension:** This surfaces as a new MCP result type:
`tool_refinement_needed`. MCP clients that understand it present the options
to the user. Clients that don't just see it as a regular result with
suggestions.

**The Smalltalk parallel:** `forwardInvocation:` is the last-resort handler.
The object can inspect the invocation, rewrite it, redirect it, or give up.
The refinement protocol is that inspection and rewrite.

**Files touched:** new `src/runtime/refinement.ts`,
`src/runtime/dispatch.ts` (NONE-tier branch),
`src/mcp/server.ts` (new result type)

---

### Pillar 5: Observation & Adaptation (`KVO`)

**Problem:** The runtime doesn't learn. Every session starts fresh. The dream
system reads logs after the fact, but the runtime itself doesn't adapt in
real-time. If a tool is dispatched and the caller immediately re-dispatches
with a different intent (a "correction signal"), the runtime doesn't notice.

**Solution:** An observation layer that watches dispatch patterns and adapts
in real-time. Three feedback signals, from cheapest to most expensive:

#### Signal 1: Correction Detection (zero cost)

If the same caller dispatches intent A, then immediately dispatches intent B
to a *different* tool within the same session, that's a correction signal.
Intent A was probably wrong for its tool.

```typescript
// The runtime tracks recent dispatches per session
const recentDispatches: DispatchRecord[] = [];

// After each dispatch, check if it looks like a correction
function detectCorrection(current: DispatchRecord): CorrectionSignal | null {
  const previous = recentDispatches[recentDispatches.length - 1];
  if (!previous) return null;
  if (current.tool === previous.tool) return null; // same tool = not a correction
  if (current.timestamp - previous.timestamp > 30_000) return null; // too old

  return {
    wrongTool: previous.tool,
    wrongIntent: previous.intent,
    rightTool: current.tool,
    rightIntent: current.intent,
  };
}
```

**What we do with corrections:**
- Store them as **negative examples** in the selector table
- Bump the similarity threshold for the wrong tool + intent pair
- Surface them in the dream system's next analysis

#### Signal 2: Schema Rejection Tracking (near-zero cost)

When a tool executes and returns a schema validation error, that's a signal
the dispatch was wrong. Track it.

```typescript
interface SchemaRejection {
  tool: string;
  intent: string;
  error: string;
  timestamp: number;
}
```

After N schema rejections for the same tool+intent pair, automatically boost
the threshold or add a negative example.

#### Signal 3: Adaptive Thresholds (session-scoped)

Instead of global hardcoded thresholds (0.75, 0.5), maintain per-tool-class
thresholds that adjust based on signals 1 and 2:

```typescript
interface AdaptiveThreshold {
  toolClass: string;
  baseThreshold: number;      // starts at 0.75
  currentThreshold: number;   // adjusted by signals
  corrections: number;        // total corrections observed
  lastAdjusted: number;
}
```

Tools that get corrected often → higher threshold (harder to match).
Tools that never get corrected → threshold stays or lowers slightly.

**The Smalltalk parallel:** KVO (Key-Value Observing) lets objects watch
properties and react to changes. The observation layer watches dispatch
outcomes and reacts by adjusting the dispatch table itself.

**Files touched:** new `src/runtime/observer.ts`,
`src/core/resolution-cache.ts` (negative examples),
`src/core/selector-table.ts` (adaptive thresholds)

---

## Bonus Features

### Resolution Proof

Every dispatch returns a `ResolutionProof` — a serializable trace of exactly
why this tool was chosen. Debugging tool selection becomes trivial.

```typescript
interface ResolutionProof {
  intent: string;
  steps: ProofStep[];
  elapsed: number;
  tier: ConfidenceTier;
}

interface ProofStep {
  stage: 'cache' | 'vector_search' | 'overload' | 'verification'
       | 'decomposition' | 'refinement' | 'fallback';
  input: unknown;
  output: unknown;
  elapsed: number;
  decision: string; // human-readable: "matched send_email at 0.92 similarity"
}
```

This is the `smallchat resolve` CLI on steroids — but available
programmatically at runtime, not just as a debug tool.

### Collision Firewall

Close the 0.75–0.89 gap between dispatch threshold and collision detection.
Today, tools at 0.80 similarity dispatch without any warning. After 0.4.0:

- **Compile-time:** The compiler warns when two tools are between 0.75–0.95
  similarity and suggests disambiguation (rename, merge, or pin)
- **Runtime:** Dispatches in the collision zone (0.75–0.89) are automatically
  elevated to MEDIUM confidence, triggering verification (Pillar 2)

### `--strict` Mode

A compile flag that raises all thresholds, enables verification on every
dispatch (not just MEDIUM), and treats ambiguity as an error instead of a
warning. For production deployments where wrong dispatch is unacceptable.

```bash
smallchat compile --source ./manifests --strict
```

### Enhanced `smallchat doctor`

The `doctor` command gains new checks:
- **Collision report:** Lists all tool pairs in the 0.75–0.95 similarity zone
- **Threshold recommendation:** Suggests per-tool-class thresholds based on
  the tool set's semantic density
- **Coverage gaps:** Identifies common intents that no tool matches well

---

## Implementation Order

The pillars build on each other. This is the dependency-aware order:

```
Phase 1: Foundation (no LLM dependency)
├── 1a. Confidence tiers (Pillar 1)               — types + dispatch branching
├── 1b. Resolution proof                           — tracing infrastructure
├── 1c. Collision firewall                         — compiler + runtime threshold fix
└── 1d. Schema-based verification (Pillar 2a-2b)   — structural checks only

Phase 2: Intelligence (LLM-powered)
├── 2a. LLM micro-check (Pillar 2c)                — fast model verification
├── 2b. Intent decomposition (Pillar 3)            — multi-step resolution
└── 2c. Refinement protocol (Pillar 4)             — dialogue-based disambiguation

Phase 3: Learning (closed-loop)
├── 3a. Correction detection (Pillar 5, Signal 1)  — session-scoped learning
├── 3b. Schema rejection tracking (Signal 2)       — error-driven adaptation
├── 3c. Adaptive thresholds (Signal 3)             — per-tool-class tuning
└── 3d. Dream system integration                   — persist learnings across sessions

Phase 4: Polish
├── 4a. --strict mode
├── 4b. Enhanced doctor command
├── 4c. Migration guide (0.3.0 → 0.4.0)
└── 4d. Test suite expansion
```

Phase 1 has zero external dependencies — it's pure TypeScript, pure logic,
and can ship even if the LLM integration takes longer. Phase 2 introduces
the LLM dependency but keeps it optional (the system degrades gracefully
without it). Phase 3 makes the system learn from itself.

---

## What "Solved" Means

After 0.4.0, every dispatch falls into one of these outcomes:

| Outcome | What happens | User experience |
|---------|-------------|-----------------|
| **Correct dispatch** | Tool matches intent, args valid, execution succeeds | Seamless |
| **Caught wrong dispatch** | Verification detects mismatch before execution | "I found `send_slack` but your intent says email. Did you mean `send_email`?" |
| **Decomposed complex intent** | Multi-step intent broken into sub-dispatches | "I'll search for Python files, then check each for timeout handling." |
| **Refined ambiguous intent** | Clarifying question narrows to correct tool | "Did you mean deploy to staging or production?" |
| **Learned from correction** | User's correction improves future dispatches | Next time, the right tool matches immediately |
| **Graceful unknown** | No tool exists for this intent | "No tool handles this intent. Here's what's available." |

The gap that 0.3.0 has — **silently wrong dispatch** — is eliminated. Every
dispatch is either correct, caught, decomposed, refined, or explicitly unknown.
There is no silent failure mode.

---

## Non-Goals

- **Replacing the LLM's tool selection entirely.** smallchat augments the LLM,
  it doesn't replace it. The LLM still decides *when* to use tools; smallchat
  decides *which* tool to use.
- **100% accuracy without any LLM calls.** Pure vector similarity can't solve
  every case. The LLM micro-check and decomposition features exist because
  some problems genuinely require language understanding.
- **Real-time model fine-tuning.** Adaptive thresholds are statistical
  adjustments, not model updates. We're adjusting dispatch parameters, not
  retraining embeddings.

---

## Open Questions

1. **Decomposition depth limit:** Default 3 levels deep. Is this enough? Too
   much? Should it be configurable per-tool-class?

2. **LLM provider for micro-checks:** Should we use the caller's configured
   model, or always use a specific fast model (Haiku)? Cost vs. latency
   trade-off.

3. **Refinement protocol in MCP:** Should `tool_refinement_needed` be a
   standard MCP result type, or a smallchat extension? Proposing it as a
   spec extension is more impactful but slower.

4. **Correction signal window:** 30 seconds between dispatches to count as a
   correction — is this the right window? Should it be configurable?

5. **Persistence of adaptive thresholds:** Should learned thresholds persist
   across sessions (via the dream system) or reset each time? Persistence
   risks overfitting to one user's patterns; resetting loses hard-won
   learnings.

---

*"The best error message is the one you never see — because the system
corrected itself before you noticed."*
