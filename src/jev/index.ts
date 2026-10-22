/**
 * `@smallchat/core/jev` — shortlist judges over the System One wire, and
 * the context provider that reads stenographer.
 *
 *   import { JevJudge } from '@smallchat/core/jev';
 *   const runtime = new ToolRuntime(index, embedder, { judge: JevJudge.fromEnv() });
 *
 *   import { D1Judge, StenographerJudgeContext } from '@smallchat/core/jev';
 *   // `smallchat judge download && smallchat judge serve` first: the
 *   // open-weight d1-omni-600M decision model on this machine, no key.
 *   const local = new ToolRuntime(index, embedder, {
 *     judge: new D1Judge(),
 *     judgeContext: new StenographerJudgeContext({ token }),
 *   });
 *
 * @experimental Clients for a third-party API and a local model server:
 * their options, defaults and pinned models may change in any 1.x release,
 * and they are not covered by the 1.0 claims in the README. The judge
 * interface they implement (ShortlistJudge, JudgeContextProvider,
 * RuntimeOptions.judge and judgeContext, spec/judge) is part of the
 * inference core; these clients are not, and the root entry does not
 * export them.
 *
 * Data egress: when the runtime asks the judge (a below-HIGH winner, or a
 * HIGH winner with a runner-up within the margin), the intent text (after
 * `redactIntent`), the offered tools' ids and descriptions and, with a
 * context provider, the bounded truth entries and transcript lines are
 * sent to the judge's base URL: TypeSafe (https://api.typesafe.ai by
 * default) for JevJudge, a loopback llama-server for D1Judge. Replay and
 * explain never ask it. See system-one.ts.
 */

export {
  SystemOneJudge,
  SYSTEM_ONE_ABSTAIN,
  SYSTEM_ONE_PATH,
  SYSTEM_ONE_MAX_RESPONSE_BYTES,
  DEFAULT_SYSTEM_ONE_TIMEOUT_MS,
  DEFAULT_SYSTEM_ONE_MAX_RETRIES,
  parseSystemOneAnswer,
  systemOneState,
  isLoopbackHost,
} from './system-one.js';
export type { SystemOneJudgeOptions, SystemOneProfile, SystemOneFetch } from './system-one.js';
export { JevJudge, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from './jev-judge.js';
export type { JevJudgeOptions } from './jev-judge.js';
export { D1Judge, DEFAULT_D1_BASE_URL, DEFAULT_D1_MODEL } from './d1-judge.js';
export type { D1JudgeOptions } from './d1-judge.js';
export {
  D1_MODEL_REPO,
  D1_MODEL_LICENSE,
  D1_MODEL_VARIANTS,
  DEFAULT_D1_VARIANT,
  defaultModelsDir,
  d1Variant,
  d1ModelURL,
  d1ModelPath,
  d1ModelPresent,
  downloadD1Model,
  findLlamaServer,
  llamaServerArgs,
  startD1Server,
  d1ServerAnswers,
  d1ProbeRequest,
  d1Status,
} from './d1-model.js';
export type { D1ModelVariant, D1VariantName, DownloadD1Options, DownloadD1Result, LlamaServerOptions, D1ServerHandle, D1Status } from './d1-model.js';
export { StenographerJudgeContext, DEFAULT_STENOGRAPHER_BASE_URL, gradeLedgerEntry, transcriptLine } from './stenographer-context.js';
export type { StenographerJudgeContextOptions } from './stenographer-context.js';

// The names 1.0 shipped under: the System One wire's constants, as the TypeSafe client had them.
export {
  SYSTEM_ONE_ABSTAIN as JEV_ABSTAIN,
  SYSTEM_ONE_PATH as JEV_PATH,
  SYSTEM_ONE_MAX_RESPONSE_BYTES as JEV_MAX_RESPONSE_BYTES,
  DEFAULT_SYSTEM_ONE_TIMEOUT_MS as DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_SYSTEM_ONE_MAX_RETRIES as DEFAULT_JEV_MAX_RETRIES,
} from './system-one.js';
export type { SystemOneFetch as JevFetch } from './system-one.js';
