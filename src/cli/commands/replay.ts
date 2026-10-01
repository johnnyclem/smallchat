import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRuntime, type LoadedRuntime } from '../../mcp/artifact.js';
import { describeFingerprint } from '../../artifact/embedder.js';
import { SemanticMap } from '../../runtime/semantic-map.js';
import {
  formatDecisionLogReplay,
  formatReplayReport,
  replayPaths,
  REPLAY_EXIT,
  TraceFormatError,
  type ReplayRun,
} from '../../runtime/replay.js';
import { projectRuntimeOptions } from './project-policy.js';

/**
 * `smallchat replay <artifact> <traces…>` — run golden dispatch traces (and
 * decision logs) against a compiled artifact with learning, cache and
 * semantic map frozen. Exit 0 every case passed, 1 a mismatch, 2 could not
 * run. See runtime/replay.ts for the trace format.
 */
export const replayCommand = new Command('replay')
  .description('Check golden dispatch traces (or a decision log) against a compiled artifact; exit 0 pass, 1 mismatch, 2 could not run')
  .argument('<artifact>', 'Compiled artifact (.json or .db)')
  .argument('<traces...>', 'Trace files (.jsonl / .json), directories of them, or decision logs (verified, then replayed)')
  .option('--config <smallchat.json>', 'Take the dispatch policy from this file (default: the nearest smallchat.json, as serve does)')
  .option('--semantic-map <file>', 'Learned state to replay with (SemanticMap JSON); read, never written')
  .option('--json', 'Print the report as JSON')
  .action(async (artifactArg: string, traceArgs: string[], options) => {
    const artifactPath = resolve(artifactArg);
    const couldNotRun = (message: string): never => {
      if (options.json) console.log(JSON.stringify({ error: message, exitCode: REPLAY_EXIT.couldNotRun }, null, 2));
      else console.error(message);
      process.exit(REPLAY_EXIT.couldNotRun);
    };

    let loaded: LoadedRuntime;
    let policySource: string | null;
    try {
      const policy = projectRuntimeOptions(options.config);
      policySource = policy.source;
      const runtimeOptions = { ...policy.options };
      if (options.semanticMap) {
        runtimeOptions.semanticMap = SemanticMap.fromJSON(JSON.parse(readFileSync(resolve(options.semanticMap), 'utf-8')));
      }
      loaded = await loadRuntime(artifactPath, { runtimeOptions });
    } catch (e) {
      return couldNotRun(`Could not load ${artifactPath}: ${(e as Error).message}`);
    }
    const { runtime, artifact } = loaded;

    let run: ReplayRun;
    try {
      run = await replayPaths(runtime, traceArgs.map(p => resolve(p)));
    } catch (e) {
      if (e instanceof TraceFormatError) return couldNotRun(e.message);
      throw e;
    }

    if (options.json) {
      console.log(JSON.stringify({
        artifact: { path: artifactPath, contentHash: artifact.contentHash, embedder: artifact.embedder },
        policy: policySource,
        ...run,
      }, null, 2));
    } else {
      console.log(`Artifact: ${artifactPath}`);
      console.log(`  content hash ${artifact.contentHash}`);
      console.log(`  embedder ${describeFingerprint(artifact.embedder)}`);
      console.log(`  policy ${policySource ?? 'runtime defaults (no smallchat.json policy block)'}`);
      if (run.traces.total > 0) console.log(`\n${formatReplayReport(run.traces)}`);
      for (const log of run.decisionLogs) console.log(`\n${formatDecisionLogReplay(log)}`);
    }
    process.exit(run.exitCode);
  });
