import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadRuntime, type LoadedRuntime } from '../../mcp/artifact.js';
import { formatExplanation } from '../../runtime/explain.js';
import { projectRuntimeOptions } from './project-policy.js';

/**
 * `smallchat explain <artifact> <intent>` — why the runtime would (or would
 * not) pick a tool for an intent: the candidate table with scores, tiers,
 * MCP annotations and the dispatch policy's verdict for each candidate,
 * the proof's steps, and the proof digest. Never executes anything.
 */
export const explainCommand = new Command('explain')
  .description('Explain how an intent resolves against a compiled artifact: candidates, tiers, policy verdicts, proof digest')
  .argument('<artifact>', 'Compiled artifact (.json or .db)')
  .argument('<intent>', 'Natural language intent')
  .option('--args <json>', 'Arguments the call would carry (used to choose among overloads and in verification)')
  .option('--principal <id>', 'Who is asking (scopes feedback and the rate limiter)')
  .option('--config <smallchat.json>', 'Take the dispatch policy from this file (default: the nearest smallchat.json, as serve does)')
  .option('--decision-log <path>', 'Also append this resolution to a decision log (hash-chained JSONL)')
  .option('--json', 'Print the explanation as JSON')
  .action(async (artifactArg: string, intent: string, options) => {
    const artifactPath = resolve(artifactArg);
    let args: Record<string, unknown> | undefined;
    if (options.args !== undefined) {
      try {
        args = JSON.parse(options.args) as Record<string, unknown>;
      } catch {
        console.error('--args is not valid JSON');
        process.exit(2);
      }
    }

    let loaded: LoadedRuntime;
    let policySource: string | null;
    try {
      const policy = projectRuntimeOptions(options.config);
      policySource = policy.source;
      loaded = await loadRuntime(artifactPath, {
        runtimeOptions: { ...policy.options, ...(options.decisionLog ? { decisionLog: resolve(options.decisionLog) } : {}) },
      });
    } catch (e) {
      console.error(`Could not load ${artifactPath}: ${(e as Error).message}`);
      process.exit(2);
    }

    const explanation = await loaded.runtime.explain(intent, {
      ...(args !== undefined ? { args } : {}),
      ...(options.principal !== undefined ? { principal: options.principal } : {}),
    });
    loaded.runtime.decisionLog?.close();

    if (options.json) {
      const { resolution: _resolution, ...rest } = explanation;
      console.log(JSON.stringify({ ...rest, policy: policySource, proof: explanation.resolution.proof }, null, 2));
    } else {
      console.log(formatExplanation(explanation));
      console.log(`Policy from: ${policySource ?? 'runtime defaults (no smallchat.json policy block)'}`);
    }
    process.exit(0);
  });
