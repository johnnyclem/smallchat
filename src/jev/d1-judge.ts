/**
 * D1Judge — Liquid AI's open-weight d1 decision model (d1-omni-600M by
 * default), served locally by llama.cpp's llama-server, as a shortlist
 * judge (core/judge.ts, RuntimeOptions.judge).
 *
 * llama-server serves the System One endpoint for d1 GGUF models
 * (`POST /v1/systemone`, the model card's example), with the same request
 * and answer shape the TypeSafe client uses, so this judge is the System
 * One wire (system-one.ts) pointed at a loopback server with no API key.
 * The model answers with zero generated tokens: every answer is read from
 * its distribution over the offered options, so an answer is always one
 * of the tool ids or the abstain option.
 *
 * Nothing leaves the machine unless `allowRemote` is set: the base URL
 * must be a loopback host. `smallchat judge download` fetches the weights
 * and `smallchat judge serve` starts llama-server (d1-model.ts).
 */

import { SystemOneJudge, envValue } from './system-one.js';
import type { SystemOneJudgeOptions } from './system-one.js';

/** Where `smallchat judge serve` listens by default. */
export const DEFAULT_D1_BASE_URL = 'http://127.0.0.1:8080';
/** The model name recorded in proofs; llama-server serves one model and ignores the field. */
export const DEFAULT_D1_MODEL = 'd1-omni-600M';

export interface D1JudgeOptions extends SystemOneJudgeOptions {
  /** llama-server's root; `/v1/systemone` is appended. Default DEFAULT_D1_BASE_URL. */
  baseURL?: string;
  /** Model name recorded in proofs. Default DEFAULT_D1_MODEL. */
  model?: string;
  /** API key, for a server started with `--api-key`. Optional. */
  apiKey?: string;
  /** Allow a non-loopback base URL (https). Default false: the model runs on this machine. */
  allowRemote?: boolean;
}

/**
 * The local d1 shortlist judge. Options are validated: a value out of
 * range throws a TypeError.
 */
export class D1Judge extends SystemOneJudge {
  /**
   * A D1Judge configured from the environment: SMALLCHAT_D1_URL (the
   * server root), SMALLCHAT_D1_MODEL and SMALLCHAT_D1_API_KEY (trimmed;
   * blank counts as unset). Options passed here take precedence; the
   * defaults apply when nothing is set, so `D1Judge.fromEnv()` is a judge
   * for `smallchat judge serve` on its default port.
   */
  static fromEnv(
    options: Partial<D1JudgeOptions> = {},
    env: Record<string, string | undefined> = globalThis.process?.env ?? {},
  ): D1Judge {
    const baseURL = options.baseURL ?? envValue(env, 'SMALLCHAT_D1_URL');
    const model = options.model ?? envValue(env, 'SMALLCHAT_D1_MODEL');
    const apiKey = options.apiKey ?? envValue(env, 'SMALLCHAT_D1_API_KEY');
    return new D1Judge({
      ...options,
      ...(baseURL !== undefined ? { baseURL } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  constructor(options: D1JudgeOptions = {}) {
    super(options, {
      name: 'd1',
      defaultBaseURL: DEFAULT_D1_BASE_URL,
      defaultModel: DEFAULT_D1_MODEL,
      requireApiKey: false,
      allowRemote: options?.allowRemote === true,
    });
  }
}
