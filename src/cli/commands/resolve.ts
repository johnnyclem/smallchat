import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadRuntime, type LoadedRuntime } from '../../mcp/artifact.js';
import { buildToolTable } from '../../mcp/tool-names.js';
import { toCallToolResult } from '../../mcp/results.js';
import { parseEmbedderKind } from '../../artifact/embedder.js';
import { readArtifact } from '../../artifact/io.js';
import type { Resolution } from '../../runtime/dispatch.js';
import { projectRuntimeOptions } from './project-policy.js';

/** Tiers at which `resolve --execute` runs the chosen tool without --force. */
const EXECUTABLE_TIERS = new Set(['exact', 'high']);

/**
 * Whether `resolve --execute` may run a tool for this resolution, and which.
 *
 * Without --force only a resolution that settled on one tool at EXACT or
 * HIGH tier runs. With --force the chosen tool (or, when nothing was
 * chosen, the top-ranked eligible candidate) runs regardless of tier.
 */
export function executionGate(
  resolution: Pick<Resolution, 'outcome' | 'tier' | 'chosen' | 'candidates'>,
  options: { force?: boolean } = {},
): { run: true; toolId: string; forced: boolean } | { run: false; reason: string } {
  const confident = resolution.outcome === 'resolved' && resolution.chosen !== undefined && EXECUTABLE_TIERS.has(resolution.tier);
  if (confident) return { run: true, toolId: resolution.chosen!, forced: false };

  const why = resolution.outcome === 'resolved'
    ? `the match is ${resolution.tier.toUpperCase()} tier; --execute needs HIGH or EXACT`
    : `resolution is ${resolution.outcome}`;
  if (!options.force) return { run: false, reason: `${why}. Nothing was executed; pass --force to run it anyway.` };

  const toolId = resolution.chosen ?? resolution.candidates[0]?.toolId;
  if (!toolId) return { run: false, reason: `${why}, and there is no candidate to force. Nothing was executed.` };
  return { run: true, toolId, forced: true };
}

export const resolveCommand = new Command('resolve')
  .description('Show which tool the runtime would pick for an intent, and why (resolve never executes unless --execute)')
  .argument('<file>', 'Path to the compiled toolkit file')
  .argument('<intent>', 'Natural language intent to resolve')
  .option('-e, --embedder <type>', 'Expected embedder (onnx or hash); refuses if the artifact was compiled with another')
  .option('-x, --execute', 'Run the chosen tool on its upstream server (needs a HIGH or EXACT match, or --force)')
  .option('--force', 'With --execute: run the chosen (or top-ranked) tool even below HIGH tier')
  .option('--args <json>', 'JSON arguments for the call (also used to choose among overloads)', '{}')
  .option('--timeout <ms>', 'Upstream call timeout in milliseconds', '30000')
  .option('--json', 'Print the resolution (and result) as JSON')
  .option('--decision-log <path>', 'Append this resolution (and, with --execute, the call) to a hash-chained JSONL decision log')
  .action(async (file, intent, options) => {
    const filePath = resolve(file);

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(options.args) as Record<string, unknown>;
    } catch {
      console.error('Failed to parse --args as JSON');
      process.exit(1);
    }

    // The artifact's embedder fingerprint decides; --embedder can only confirm it.
    let loaded: LoadedRuntime;
    try {
      if (options.embedder !== undefined) {
        const artifact = await readArtifact(filePath);
        if (parseEmbedderKind(options.embedder) !== artifact.embedder.kind) {
          throw new Error(
            `--embedder ${options.embedder} does not match ${filePath}, which was compiled with the ` +
            `${artifact.embedder.kind} embedder (${artifact.embedder.model})`,
          );
        }
      }
      // Same dispatch policy as `serve`: the nearest smallchat.json "policy" block.
      const runtimeOptions = projectRuntimeOptions().options;
      if (options.decisionLog) runtimeOptions.decisionLog = resolve(options.decisionLog);
      loaded = await loadRuntime(filePath, {
        runtimeOptions,
        upstream: { requestTimeoutMs: parseInt(options.timeout, 10) },
      });
    } catch (e) {
      console.error(`Failed to load ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }
    const { runtime, artifact, upstreams } = loaded;
    const names = buildToolTable(artifact).byToolId;
    const close = async () => {
      runtime.decisionLog?.close();
      await upstreams.close();
    };

    // The same resolution serve's smallchat_resolve and runtime.dispatch use.
    const resolution = await runtime.resolve(intent, { args });

    if (!options.json) {
      console.log(`Intent: "${intent}"`);
      console.log(`Outcome: ${resolution.outcome} (tier ${resolution.tier.toUpperCase()}, decision ${resolution.proof.decision})`);
      if (resolution.chosen) {
        const name = names.get(resolution.chosen)?.name;
        console.log(`Chosen: ${resolution.chosen}${name ? `  (serve name: ${name})` : ''}`);
      }
      if (resolution.reason) console.log(`Reason: ${resolution.reason}`);
      console.log('');
      if (resolution.proof.candidates.length === 0) {
        console.log('No candidates.');
      } else {
        console.log('Candidates:');
        for (const c of resolution.proof.candidates) {
          const excluded = c.excluded ? `  excluded: ${c.excluded}` : '';
          console.log(`  ${c.toolId}  score ${c.score.toFixed(3)}  ${c.tier.toUpperCase()}  via ${c.source}${excluded}`);
        }
      }
      console.log(`\nProof digest: ${resolution.proof.proofDigest}  (smallchat explain shows the full table)`);
    }

    if (!options.execute) {
      if (options.json) console.log(JSON.stringify({ resolution }, null, 2));
      await close();
      return;
    }

    const gate = executionGate(resolution, { force: options.force === true });
    if (!gate.run) {
      if (options.json) console.log(JSON.stringify({ resolution, executed: false, reason: gate.reason }, null, 2));
      else console.error(`\nNot executing: ${gate.reason}`);
      await close();
      process.exit(1);
    }

    if (gate.forced && !options.json) console.log(`\n--force: running ${gate.toolId} below HIGH tier`);
    if (!options.json) console.log(`\nExecuting ${gate.toolId}...`);
    try {
      const result = await runtime.dispatchById(gate.toolId, args, { resolutionDigest: resolution.proof.proofDigest });
      const callResult = toCallToolResult(result);
      if (options.json) {
        console.log(JSON.stringify({ resolution, executed: true, toolId: gate.toolId, result: callResult }, null, 2));
      } else {
        console.log(`\nResult (isError: ${callResult.isError === true}):`);
        console.log(JSON.stringify(callResult, null, 2));
      }
      await close();
      if (callResult.isError) process.exit(1);
    } catch (err) {
      console.error(`\nExecution failed: ${(err as Error).message}`);
      await close();
      process.exit(1);
    }
  });
