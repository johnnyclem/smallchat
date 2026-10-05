/**
 * Shortlist judge — an optional tie-breaker for the dispatch pipeline
 * (RuntimeOptions.judge; normative rules in spec/judge/README.md).
 *
 * A judge is never an authority. The runtime decides when to ask it,
 * what to offer it and what its answer may do; a judge only says which
 * offered tool fits the intent. With the judge unset, dispatch is what
 * it is without one; with it unreachable or failing, the decision is too,
 * but the call waits up to the judge's `timeoutMs`, its proof records the
 * attempt (so its digest differs) and it is not cached.
 *
 *   D1 When: never for an EXACT or NONE winner. A HIGH winner only when a
 *      runner-up is within `margin` ('ambiguous'); a MEDIUM/LOW winner
 *      always ('low-confidence', or 'ambiguous' with a runner-up within
 *      the margin). Tiers are the runtime's configured thresholds.
 *   D2 What: candidates within `margin` of the winner that the judge
 *      could choose and then run: the dispatch policy would run them, and
 *      the deterministic verification an approval still gets would pass
 *      (required parameters when the arguments are known; keyword overlap
 *      wherever the candidate's tier is verified). At most
 *      `maxCandidates`, best-ranked first, presented sorted by tool id. A
 *      winner the policy refuses, or whose schema cannot be loaded, is not
 *      judged at all: a judge breaks ties, it does not overrule a refusal.
 *   D3 Answers: approved (an offered id at probability >= acceptThreshold)
 *      chooses it, and the deterministic checks still run; declined
 *      (abstain, an id not offered, a low probability) is
 *      needs-disambiguation; unavailable (no usable answer, or none
 *      within `timeoutMs` or before the caller's signal) decides as
 *      without a judge.
 *   D4 Records: decision codes judge-approved / judge-declined;
 *      ResolutionProof.judge (a JudgeRecord), of which the proof digest
 *      covers only name, model, verdict and toolId; replay answers from
 *      the record and never calls a judge; nothing a judge took part in,
 *      or that a per-call override kept from the runtime's judge, is
 *      cached.
 *
 * The TypeSafe client is `@smallchat/core/jev` (experimental). A judge
 * sends the intent and the offered tools' descriptions to wherever it
 * runs; see the judge's own documentation.
 */

import type { ConfidenceTier } from './confidence.js';

/** Default `margin`: how close a runner-up must be to the winner to count as a near-tie. */
export const DEFAULT_JUDGE_MARGIN = 0.05;
/** Default `acceptThreshold`: the probability an approval needs on the chosen id. */
export const DEFAULT_JUDGE_ACCEPT = 0.7;
/** Default `maxCandidates`: how many near-ties a judge is offered at most. */
export const DEFAULT_JUDGE_MAX_CANDIDATES = 8;
/** Default `timeoutMs`: how long the runtime waits for a judge's answer. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 4000;
/** Largest `timeoutMs` (the platform timer limit). */
export const MAX_JUDGE_TIMEOUT_MS = 2_147_483_647;
/** A tool description offered to a judge is cut to this many UTF-16 code units. */
export const JUDGE_DESCRIPTION_CHARS = 240;

/** Why the judge was asked. */
export type JudgeTrigger = 'low-confidence' | 'ambiguous';

/** One offered tool. The description is tool-server text: untrusted. */
export interface JudgeCandidate {
  toolId: string;
  description: string;
}

/** What the runtime asks a judge. */
export interface JudgeRequest {
  intent: string;
  trigger: JudgeTrigger;
  /** The offered tools, sorted by tool id (never in rank order) */
  candidates: JudgeCandidate[];
  /**
   * Fires when the caller aborts or `timeoutMs` passes. The runtime has
   * then already decided without the judge ('ABORTED' or 'TIMEOUT'), so
   * a judge should stop its work.
   */
  signal?: AbortSignal;
}

/**
 * Why a judge gave no usable answer: AUTH (401/403), RATE_LIMITED (429),
 * HTTP_<status> (any other non-2xx), TIMEOUT, NETWORK, MALFORMED (a
 * response outside the contract), ABORTED (the caller's signal).
 */
export type JudgeErrorCode = 'AUTH' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK' | 'MALFORMED' | 'ABORTED' | `HTTP_${number}`;

/** What a judge answered, before the runtime accepts or declines it. */
export type JudgeAnswer =
  | {
    status: 'answered';
    /** The tool id it chose, or null when it abstained */
    choice: string | null;
    /** Its probability for `choice`, in [0, 1] */
    probability: number | null;
    /** Its reported confidence, in [0, 1] */
    confidence: number | null;
    /** The model that answered, when the judge reports one */
    model?: string;
    /** The provider's request id, for its logs (never digested) */
    requestId?: string;
  }
  | {
    status: 'unavailable';
    error: JudgeErrorCode;
    /** Server-requested delay, when it sent one */
    retryAfterMs?: number;
    model?: string;
    requestId?: string;
  };

/**
 * A shortlist judge. `name` and `model` are recorded in every proof the
 * judge takes part in; the other settings default to DEFAULT_JUDGE_*.
 * `judge()` should not throw (a throw counts as unavailable). The runtime
 * holds every judge to its `timeoutMs` and to the caller's signal,
 * whether or not the judge honours `request.signal`.
 */
export interface ShortlistJudge {
  /** Short stable name, e.g. 'jev' */
  readonly name: string;
  /** The model asked (recorded when an answer does not name its own) */
  readonly model: string;
  /** Near-tie margin, in [0, 1). Default DEFAULT_JUDGE_MARGIN. */
  readonly margin?: number;
  /** Most tools offered, an integer >= 1. Default DEFAULT_JUDGE_MAX_CANDIDATES. */
  readonly maxCandidates?: number;
  /** Probability an approval needs, in (0, 1]. Default DEFAULT_JUDGE_ACCEPT. */
  readonly acceptThreshold?: number;
  /** Milliseconds the runtime waits for an answer, in (0, MAX_JUDGE_TIMEOUT_MS]. Default DEFAULT_JUDGE_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  judge(request: JudgeRequest): Promise<JudgeAnswer>;
}

/** A judge's settings, validated (judgeSettings). */
export interface JudgeSettings {
  margin: number;
  maxCandidates: number;
  acceptThreshold: number;
  timeoutMs: number;
}

export type JudgeVerdictKind = 'approved' | 'declined' | 'unavailable';
export type JudgeDeclineReason = 'abstained' | 'outside-shortlist' | 'below-threshold';
/** 'approved', why it declined, or why it was unavailable. */
export type JudgeReason = 'approved' | JudgeDeclineReason | JudgeErrorCode;

/** An answer, accepted or not (acceptJudgeAnswer). */
export interface JudgeVerdict {
  verdict: JudgeVerdictKind;
  /** The offered tool it approved; null unless approved */
  toolId: string | null;
  probability: number | null;
  confidence: number | null;
  /** The model that answered, else the configured one */
  model: string;
  /** Null only for a replayed record that carried no reason (none is invented) */
  reason: JudgeReason | null;
  /** The provider's request id, when it sent a plain one */
  requestId?: string;
}

/**
 * What a proof records about a judge it consulted (ResolutionProof.judge)
 * and a decision-log line carries. The proof digest covers name, model,
 * verdict and toolId only: never the floats, the reason or the settings,
 * so one decision has one digest however the judge's numbers move.
 */
export interface JudgeRecord {
  name: string;
  model: string;
  verdict: JudgeVerdictKind;
  toolId: string | null;
  probability: number | null;
  confidence: number | null;
  /** Why (see JudgeReason); null only when replaying a record that carried none */
  reason: JudgeReason | null;
  /** The settings the shortlist was built with (replay rebuilds it with them) */
  margin: number;
  maxCandidates: number;
  /** The provider's request id, to find the call in its logs */
  requestId?: string;
}

/**
 * A recorded verdict that answers in a judge's place (ResolveOptions.judge,
 * a trace case's `judge`, a decision-log line's `judge`). Only `verdict` is
 * required; `toolId` is required to approve. What it leaves out is never
 * borrowed from the runtime's judge: the proof records name 'recorded',
 * model 'unknown' and a null reason (spec/judge D4).
 */
export interface RecordedJudgeVerdict {
  verdict: JudgeVerdictKind;
  toolId?: string | null;
  name?: string;
  model?: string;
  probability?: number | null;
  confidence?: number | null;
  reason?: JudgeReason | null;
  margin?: number;
  maxCandidates?: number;
  requestId?: string;
}

const ERROR_CODE = /^(?:AUTH|RATE_LIMITED|TIMEOUT|NETWORK|MALFORMED|ABORTED|HTTP_[1-9]\d{2})$/;
const DECLINE_REASONS: readonly string[] = ['abstained', 'outside-shortlist', 'below-threshold'];
/**
 * A plain model name: an ASCII letter or digit, then up to 99 of
 * [A-Za-z0-9._:/@-]. A reported model is recorded (and digested) only in
 * this shape; anything else is replaced by the configured model.
 */
export const JUDGE_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
/** A provider request id is recorded only in this shape (never digested). */
export const JUDGE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');
const SURROGATE_PAIR = /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/;

/** Whether a value is a JudgeErrorCode. */
export function isJudgeErrorCode(value: unknown): value is JudgeErrorCode {
  return typeof value === 'string' && ERROR_CODE.test(value);
}

/** Whether `score` is within `margin` of `best`, compared at the score quantum (1e-4). */
export function withinJudgeMargin(best: number, score: number, margin: number): boolean {
  return Math.round((best - score) * 1e4) <= Math.round(margin * 1e4);
}

/**
 * D1: whether to ask the judge, and why. `tier` is the winner's tier under
 * the runtime's thresholds; `runnerUpScore` is the second-ranked
 * candidate's score (null when there is none).
 */
export function judgeTrigger(input: {
  tier: ConfidenceTier;
  bestScore: number;
  runnerUpScore: number | null;
  margin: number;
}): JudgeTrigger | null {
  if (input.tier === 'exact' || input.tier === 'none') return null;
  const nearTie = input.runnerUpScore !== null && withinJudgeMargin(input.bestScore, input.runnerUpScore, input.margin);
  if (input.tier === 'high') return nearTie ? 'ambiguous' : null;
  return nearTie ? 'ambiguous' : 'low-confidence';
}

/**
 * A tool description as offered to a judge: control characters and line
 * breaks folded to one space, cut to JUDGE_DESCRIPTION_CHARS. A cut never
 * splits a surrogate pair (the description is then one unit shorter).
 */
export function judgeDescription(text: string): string {
  const folded = text.replace(CONTROL_CHARS, ' ');
  const split = SURROGATE_PAIR.test(folded.slice(JUDGE_DESCRIPTION_CHARS - 1, JUDGE_DESCRIPTION_CHARS + 1));
  return folded.slice(0, split ? JUDGE_DESCRIPTION_CHARS - 1 : JUDGE_DESCRIPTION_CHARS);
}

/** Tool ids in UTF-16 code unit order (the order candidates are presented in). */
export function compareToolIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A judge's settings, defaulted and validated. Throws TypeError on a value out of range. */
export function judgeSettings(judge: Pick<ShortlistJudge, 'margin' | 'maxCandidates' | 'acceptThreshold' | 'timeoutMs'>): JudgeSettings {
  const margin = judge.margin ?? DEFAULT_JUDGE_MARGIN;
  const maxCandidates = judge.maxCandidates ?? DEFAULT_JUDGE_MAX_CANDIDATES;
  const acceptThreshold = judge.acceptThreshold ?? DEFAULT_JUDGE_ACCEPT;
  const timeoutMs = judge.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  if (!(Number.isFinite(margin) && margin >= 0 && margin < 1)) {
    throw new TypeError(`judge margin must be a number in [0, 1), got ${String(margin)}`);
  }
  if (!(Number.isInteger(maxCandidates) && maxCandidates >= 1)) {
    throw new TypeError(`judge maxCandidates must be an integer >= 1, got ${String(maxCandidates)}`);
  }
  if (!(Number.isFinite(acceptThreshold) && acceptThreshold > 0 && acceptThreshold <= 1)) {
    throw new TypeError(`judge acceptThreshold must be a number in (0, 1], got ${String(acceptThreshold)}`);
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_JUDGE_TIMEOUT_MS)) {
    throw new TypeError(`judge timeoutMs must be a positive number of milliseconds up to ${MAX_JUDGE_TIMEOUT_MS}, got ${String(timeoutMs)}`);
  }
  return { margin, maxCandidates, acceptThreshold, timeoutMs };
}

/** A probability or confidence: a finite number in [0, 1], or null when absent. */
function unit(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** The recorded model: the judge's own report when it is a plain model name, else the configured one. */
function modelOf(reported: unknown, configured: string): string {
  return typeof reported === 'string' && JUDGE_MODEL_NAME.test(reported) ? reported : configured;
}

/**
 * D3: accept or decline what a judge answered. Approved only for an
 * `offered` id whose probability is at least `acceptThreshold` (a
 * threshold that is not a number in (0, 1] approves nothing); an answer outside the
 * contract (not an object, an unknown status, a number outside [0, 1]) is
 * unavailable ('MALFORMED').
 */
export function acceptJudgeAnswer(
  answer: unknown,
  offered: readonly string[],
  acceptThreshold: number,
  configuredModel: string,
): JudgeVerdict {
  const a = (answer !== null && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  const model = modelOf(a.model, configuredModel);
  const ids = typeof a.requestId === 'string' && JUDGE_REQUEST_ID.test(a.requestId) ? { requestId: a.requestId } : {};
  const unavailable = (reason: JudgeErrorCode): JudgeVerdict =>
    ({ verdict: 'unavailable', toolId: null, probability: null, confidence: null, model, reason, ...ids });

  if (a.status === 'unavailable') return unavailable(isJudgeErrorCode(a.error) ? a.error : 'MALFORMED');
  if (a.status !== 'answered') return unavailable('MALFORMED');
  const probability = unit(a.probability);
  const confidence = unit(a.confidence);
  if (probability === undefined || confidence === undefined) return unavailable('MALFORMED');
  if (a.choice !== null && typeof a.choice !== 'string') return unavailable('MALFORMED');

  const declined = (reason: JudgeDeclineReason): JudgeVerdict =>
    ({ verdict: 'declined', toolId: null, probability, confidence, model, reason, ...ids });
  if (a.choice === null) return declined('abstained');
  if (!offered.includes(a.choice)) return declined('outside-shortlist');
  // Fail closed: a threshold outside (0, 1], or not a number at all, approves nothing.
  const threshold = typeof acceptThreshold === 'number' && acceptThreshold > 0 && acceptThreshold <= 1 ? acceptThreshold : Number.NaN;
  if (probability === null || !(probability >= threshold)) return declined('below-threshold');
  return { verdict: 'approved', toolId: a.choice, probability, confidence, model, reason: 'approved', ...ids };
}

/**
 * A recorded verdict replayed against the shortlist rebuilt now. An
 * approval of an id that is no longer offered is declined
 * ('outside-shortlist'), so replay reports the difference; an approval is
 * not checked against a threshold again. A decline or an unavailable
 * record without a valid reason replays with none (null).
 */
export function replayJudgeVerdict(recorded: RecordedJudgeVerdict, offered: readonly string[], model: string): JudgeVerdict {
  const probability = unit(recorded.probability) ?? null;
  const confidence = unit(recorded.confidence) ?? null;
  const base = { probability, confidence, model };
  if (recorded.verdict === 'approved') {
    return typeof recorded.toolId === 'string' && offered.includes(recorded.toolId)
      ? { ...base, verdict: 'approved', toolId: recorded.toolId, reason: 'approved' }
      : { ...base, verdict: 'declined', toolId: null, reason: 'outside-shortlist' };
  }
  if (recorded.verdict === 'declined') {
    const reason = DECLINE_REASONS.includes(recorded.reason as string) ? recorded.reason as JudgeDeclineReason : null;
    return { ...base, verdict: 'declined', toolId: null, reason };
  }
  return { ...base, verdict: 'unavailable', toolId: null, reason: isJudgeErrorCode(recorded.reason) ? recorded.reason : null };
}

/** Whether a value has the shape of a RecordedJudgeVerdict (trace and decision-log input). */
export function isRecordedJudgeVerdict(value: unknown): value is RecordedJudgeVerdict {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.verdict !== 'approved' && v.verdict !== 'declined' && v.verdict !== 'unavailable') return false;
  if (v.toolId !== undefined && v.toolId !== null && typeof v.toolId !== 'string') return false;
  if (v.verdict === 'approved' && typeof v.toolId !== 'string') return false;
  for (const key of ['name', 'model', 'requestId'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return false;
  }
  if (v.reason !== undefined && v.reason !== null && typeof v.reason !== 'string') return false;
  for (const key of ['probability', 'confidence', 'margin', 'maxCandidates'] as const) {
    if (v[key] !== undefined && v[key] !== null && typeof v[key] !== 'number') return false;
  }
  return true;
}
