/**
 * Jev judge — TypeSafe System One model as the verifier for a thin shortlist.
 *
 * smallchat still retrieves. Jev is asked only when the runtime itself would
 * not trust the rank: the best candidate is below HIGH, or more than one
 * candidate remains and the winner is at or under AMBIGUOUS_CONFIDENCE (the
 * same 0.90 the dispatch path uses to mark a result ambiguous). It may only
 * return an id from the shortlist it was shown. A miss, a low probability, a
 * network error, or the abstain option all decline. Decline never authorizes
 * a dispatch.
 *
 * Request and response match @typesafe-ai/sdk 0.6.0: POST {base}/v1/systemone,
 * body { model, state, questions }, answer at answers.<name> with
 * { type: "choice", choice, confidence, probabilities }.
 */

export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_ACCEPT = 0.7;
/**
 * Same cutoff dispatch uses when it stamps metadata.ambiguous: more than one
 * candidate and a winner at or under this score. Not a tier threshold.
 */
export const AMBIGUOUS_CONFIDENCE = 0.9;
export const DEFAULT_JEV_MAX_CANDIDATES = 8;
/** Criteria key Jev may pick to refuse the whole shortlist. Never a tool id. */
export const JEV_ABSTAIN = "__none__";

export type JevTrigger = "low-confidence" | "ambiguous";

export interface JevCandidate {
  toolId: string;
  description: string;
  score: number;
}

export interface JevJudgeOptions {
  /** Bearer token. Required to call the API. Never logged. */
  apiKey: string;
  endpoint?: string;
  model?: string;
  /** Minimum probability on the chosen id. Default 0.7. */
  acceptThreshold?: number;
  /** Shortlist cap sent as choice criteria, plus the abstain option. Default 8. */
  maxCandidates?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface JevJudgeRequest {
  intent: string;
  candidates: JevCandidate[];
  trigger: JevTrigger;
}

export interface JevVerdict {
  /** An id from the shortlist, or null when the judge declines. */
  toolId: string | null;
  probability: number;
  confidence: number | null;
  trigger: JevTrigger;
  reason: string;
}

interface ChoiceAnswer {
  type?: string;
  choice?: unknown;
  confidence?: unknown;
  probabilities?: Record<string, unknown>;
}

export function jevTrigger(
  bestTier: string,
  bestScore: number,
  candidateCount: number,
): JevTrigger | null {
  if (candidateCount > 1 && bestScore <= AMBIGUOUS_CONFIDENCE) return "ambiguous";
  if (bestTier === "medium" || bestTier === "low") return "low-confidence";
  return null;
}

export class JevJudge {
  readonly endpoint: string;
  readonly model: string;
  readonly acceptThreshold: number;
  readonly maxCandidates: number;
  readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevJudgeOptions) {
    if (!options.apiKey) throw new Error("JevJudge requires an apiKey");
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_JEV_ENDPOINT;
    this.model = options.model ?? DEFAULT_JEV_MODEL;
    this.acceptThreshold = options.acceptThreshold ?? DEFAULT_JEV_ACCEPT;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_JEV_MAX_CANDIDATES;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async judge(request: JevJudgeRequest): Promise<JevVerdict> {
    const shortlist = request.candidates.slice(0, this.maxCandidates);
    const allowed = new Set(shortlist.map(c => c.toolId));
    if (shortlist.length === 0) {
      return decline(request.trigger, "Jev was not asked: the shortlist was empty");
    }

    const criteria: Record<string, string> = {};
    for (const c of shortlist) {
      criteria[c.toolId] = c.description.slice(0, 240);
    }
    criteria[JEV_ABSTAIN] = "None of these tools fit the intent";

    let answer: ChoiceAnswer;
    try {
      answer = await this.ask(request.intent, criteria);
    } catch (err) {
      const message = err instanceof Error ? err.message : "request failed";
      return decline(request.trigger, `Jev declined: ${message}`);
    }

    const choice = typeof answer.choice === "string" ? answer.choice : "";
    const probability = probabilityOf(answer, choice);
    const confidence = typeof answer.confidence === "number" ? answer.confidence : null;

    if (choice === JEV_ABSTAIN || choice === "") {
      return decline(request.trigger, "Jev abstained: no shortlisted tool fit the intent", probability, confidence);
    }
    if (!allowed.has(choice)) {
      return decline(request.trigger, `Jev declined: "${choice}" is not in the shortlist`, probability, confidence);
    }
    if (probability < this.acceptThreshold) {
      return decline(
        request.trigger,
        `Jev declined ${choice}: probability ${probability.toFixed(3)} is below ${this.acceptThreshold}`,
        probability,
        confidence,
      );
    }

    return {
      toolId: choice,
      probability,
      confidence,
      trigger: request.trigger,
      reason: `Jev approved ${choice} at ${probability.toFixed(3)} (${request.trigger})`,
    };
  }

  private async ask(intent: string, criteria: Record<string, string>): Promise<ChoiceAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          state: intent,
          questions: {
            tool: {
              type: "choice",
              instructions: "Which registered tool should handle this intent? Pick __none__ if none fit.",
              criteria,
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json() as { answers?: { tool?: ChoiceAnswer } };
      const answer = body.answers?.tool;
      if (!answer || answer.type !== "choice") {
        throw new Error("response had no choice answer");
      }
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }
}

function probabilityOf(answer: ChoiceAnswer, choice: string): number {
  const raw = answer.probabilities?.[choice];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function decline(trigger: JevTrigger, reason: string, probability = 0, confidence: number | null = null): JevVerdict {
  return { toolId: null, probability, confidence, trigger, reason };
}
