/**
 * JevJudge — TypeSafe's System One model (Jev) as a shortlist judge
 * (core/judge.ts, RuntimeOptions.judge), on the System One wire that
 * system-one.ts implements. See that file for what is sent and when.
 *
 * Data egress: each request sends the intent text (after `redactIntent`),
 * the offered tools' ids and descriptions (at most 240 characters each)
 * and any context the runtime offers to `baseURL` (default
 * https://api.typesafe.ai). Arguments, the principal and the other tools
 * are never sent. This client has no dependency on the SDK.
 */

import { SystemOneJudge, envValue } from './system-one.js';
import type { SystemOneJudgeOptions } from './system-one.js';

/** API root, as the SDK's `baseURL` (TYPESAFE_BASE_URL). */
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
/** A pinned model version: an alias such as `jev-latest` moves when a release ships, and the accept threshold is tuned against one model. */
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';

export interface JevJudgeOptions extends SystemOneJudgeOptions {
  /** TypeSafe API key. Required; held in a private field, never logged, serialized or echoed. */
  apiKey: string;
  /** API root, as the SDK's `baseURL`; `/v1/systemone` is appended. https only (http for localhost, 127.0.0.1, [::1]). Default DEFAULT_JEV_BASE_URL. */
  baseURL?: string;
  /** Model to ask. Default DEFAULT_JEV_MODEL (pinned). */
  model?: string;
}

/**
 * The TypeSafe shortlist judge. Construct it on a server (it refuses a
 * browser unless told otherwise) and pass it as RuntimeOptions.judge.
 * Options are validated: a value out of range throws a TypeError.
 */
export class JevJudge extends SystemOneJudge {
  /**
   * A JevJudge configured from the environment, the way the SDK reads it:
   * TYPESAFE_API_KEY and TYPESAFE_BASE_URL (trimmed; blank counts as
   * unset). Options passed here take precedence. The constructor itself
   * never reads the environment.
   */
  static fromEnv(
    options: Partial<JevJudgeOptions> = {},
    env: Record<string, string | undefined> = globalThis.process?.env ?? {},
  ): JevJudge {
    const apiKey = options.apiKey ?? envValue(env, 'TYPESAFE_API_KEY');
    if (apiKey === undefined) throw new TypeError('JevJudge: no apiKey was passed and TYPESAFE_API_KEY is not set');
    const baseURL = options.baseURL ?? envValue(env, 'TYPESAFE_BASE_URL');
    return new JevJudge({ ...options, apiKey, ...(baseURL !== undefined ? { baseURL } : {}) });
  }

  constructor(options: JevJudgeOptions) {
    super(options, {
      name: 'jev',
      defaultBaseURL: DEFAULT_JEV_BASE_URL,
      defaultModel: DEFAULT_JEV_MODEL,
      requireApiKey: true,
      requestIdHeader: 'x-typesafe-request-id',
    });
  }
}
