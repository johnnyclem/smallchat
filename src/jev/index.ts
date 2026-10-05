/**
 * `@smallchat/core/jev` — TypeSafe's Jev model as the shortlist judge.
 *
 *   import { JevJudge } from '@smallchat/core/jev';
 *   const runtime = new ToolRuntime(index, embedder, { judge: JevJudge.fromEnv() });
 *
 * @experimental A client for a third-party API: its options, defaults and
 * pinned model may change in any 1.x release, and it is not covered by the
 * 1.0 claims in the README. The judge interface it implements
 * (ShortlistJudge, RuntimeOptions.judge, spec/judge) is part of the
 * inference core; this client is not, and the root entry does not export it.
 *
 * Data egress: when the runtime asks the judge (a below-HIGH winner, or a
 * HIGH winner with a runner-up within the margin), the intent text (after
 * `redactIntent`) and the offered tools' ids and descriptions are sent to
 * TypeSafe (https://api.typesafe.ai by default). Replay and explain never
 * ask it. See jev-judge.ts.
 */

export {
  JevJudge,
  JEV_ABSTAIN,
  JEV_PATH,
  JEV_MAX_RESPONSE_BYTES,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_JEV_MAX_RETRIES,
} from './jev-judge.js';
export type { JevJudgeOptions, JevFetch } from './jev-judge.js';
