import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { JudgeContextProvider, ShortlistJudge } from '../../core/judge.js';
import { D1Judge, JevJudge, StenographerJudgeContext, SystemOneJudge } from '../../jev/index.js';

/**
 * The opt-in `--judge` and `--judge-context` options `resolve`, `repl` and
 * `serve` share. Nothing is configured unless they are given (or
 * SMALLCHAT_JUDGE is set), so a command never sends an intent anywhere on
 * its own; `replay` and `explain` never consult a judge whatever is set.
 *
 *   --judge d1             the local d1 model (smallchat judge serve), no key
 *   --judge jev            TypeSafe's Jev (TYPESAFE_API_KEY)
 *   --judge <url>          any System One endpoint (SMALLCHAT_JUDGE_API_KEY,
 *                          SMALLCHAT_JUDGE_MODEL); https unless loopback
 *   --judge-context <url>  a running stenographer's REST root, whose
 *                          tombstones and transcript the judge reads
 *                          (STENOGRAPHER_REST_TOKEN, or --judge-context-token-file)
 */
export interface JudgeCliOptions {
  judge?: string;
  judgeContext?: string;
  judgeContextTokenFile?: string;
}

export function addJudgeOptions(command: Command): Command {
  return command
    .option('--judge <spec>', 'Shortlist judge for near-ties: d1 (local llama-server), jev (TypeSafe, TYPESAFE_API_KEY) or a System One endpoint URL (default: SMALLCHAT_JUDGE, else none)')
    .option('--judge-context <url>', "A running stenographer's REST root (e.g. http://127.0.0.1:8787): its tombstones and transcript are offered to the judge")
    .option('--judge-context-token-file <path>', "File holding stenographer's REST bearer token (default: STENOGRAPHER_REST_TOKEN, else ./rest-token when present)");
}

/** The judge a `--judge` spec names, or null for none. Throws a TypeError on a spec it cannot build. */
export function judgeFromSpec(spec: string | undefined, env: Record<string, string | undefined> = process.env): ShortlistJudge | null {
  const value = (spec ?? env.SMALLCHAT_JUDGE)?.trim();
  if (!value) return null;
  if (value === 'd1') return D1Judge.fromEnv({}, env);
  if (value === 'jev') return JevJudge.fromEnv({}, env);
  if (value === 'none' || value === 'off') return null;
  if (/^https?:\/\//.test(value)) {
    const apiKey = env.SMALLCHAT_JUDGE_API_KEY?.trim() || undefined;
    const model = env.SMALLCHAT_JUDGE_MODEL?.trim() || 'system-one';
    return new SystemOneJudge(
      { baseURL: value, model, ...(apiKey !== undefined ? { apiKey } : {}) },
      { name: 'endpoint', defaultBaseURL: value, defaultModel: model, requireApiKey: false },
    );
  }
  throw new TypeError(`--judge takes d1, jev or a System One endpoint URL, not "${value}"`);
}

/** The context provider `--judge-context` names, or null. */
export function judgeContextFromOptions(options: JudgeCliOptions, env: Record<string, string | undefined> = process.env): JudgeContextProvider | null {
  const url = options.judgeContext?.trim() || env.SMALLCHAT_JUDGE_CONTEXT?.trim();
  if (!url) return null;
  let token = env.STENOGRAPHER_REST_TOKEN?.trim() || undefined;
  const file = options.judgeContextTokenFile ?? (token === undefined ? './rest-token' : undefined);
  if (token === undefined && file !== undefined) {
    try {
      token = readFileSync(file, 'utf8').trim() || undefined;
    } catch (err) {
      if (options.judgeContextTokenFile !== undefined) throw new TypeError(`--judge-context-token-file: ${(err as Error).message}`);
    }
  }
  return new StenographerJudgeContext({ baseURL: url, ...(token !== undefined ? { token } : {}) });
}

/** RuntimeOptions fields for the judge options given, logged as they are applied. */
export function judgeRuntimeOptions(options: JudgeCliOptions, log: (line: string) => void): { judge?: ShortlistJudge; judgeContext?: JudgeContextProvider } {
  const judge = judgeFromSpec(options.judge);
  if (!judge) return {};
  const judgeContext = judgeContextFromOptions(options);
  log(`  Shortlist judge: ${judge.name} (${judge.model})${judgeContext ? `, context from ${judgeContext.name}` : ''}`);
  return { judge, ...(judgeContext ? { judgeContext } : {}) };
}
