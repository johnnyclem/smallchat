import { Command } from 'commander';
import { resolve } from 'node:path';
import {
  D1_MODEL_LICENSE,
  D1_MODEL_REPO,
  D1_MODEL_VARIANTS,
  D1Judge,
  DEFAULT_D1_BASE_URL,
  DEFAULT_D1_VARIANT,
  d1ModelPath,
  d1Status,
  d1Variant,
  defaultModelsDir,
  downloadD1Model,
  startD1Server,
} from '../../jev/index.js';
import { judgeFromSpec } from './judge-option.js';

/**
 * `smallchat judge` — the optional local decision model that breaks
 * near-ties in dispatch (the shortlist judge, spec/judge):
 *
 *   smallchat judge download          fetch d1-omni-600M (GGUF) into ~/.smallchat/models
 *   smallchat judge serve             run it with llama-server on 127.0.0.1:8080
 *   smallchat judge status            what is installed, and whether a server answers
 *   smallchat judge ask <intent> ...  ask a judge directly (--judge d1 by default)
 *
 * Then `smallchat resolve --judge d1`, `smallchat serve --judge d1`, or
 * `new D1Judge()` as RuntimeOptions.judge. Nothing is downloaded or
 * started unless asked.
 */
export const judgeCommand = new Command('judge')
  .description('Install, run and probe the optional local decision model (Liquid AI d1-omni-600M) that judges near-ties');

const variantNames = Object.keys(D1_MODEL_VARIANTS).join(' | ');

judgeCommand
  .command('download')
  .description(`Fetch the d1-omni-600M weights (${D1_MODEL_REPO}) into the models directory`)
  .option('--variant <name>', `Quantization: ${variantNames}`, DEFAULT_D1_VARIANT)
  .option('--dir <path>', 'Models directory (default: SMALLCHAT_MODELS_DIR or ~/.smallchat/models)')
  .option('--force', 'Download again even if the file is present')
  .action(async (options) => {
    let variant;
    try {
      variant = d1Variant(options.variant);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
    const dir = resolve(options.dir ?? defaultModelsDir());
    console.log(`Model: ${D1_MODEL_REPO} ${variant.file} (${variant.note})`);
    console.log(`License: ${D1_MODEL_LICENSE}`);
    console.log(`Into: ${d1ModelPath(dir, variant)}`);
    let lastShown = -1;
    try {
      const result = await downloadD1Model({
        dir,
        variant: variant.name,
        force: options.force === true,
        onProgress: (received, total) => {
          const percent = Math.floor((received / total) * 100);
          if (percent !== lastShown && percent % 5 === 0) {
            lastShown = percent;
            process.stdout.write(`\r  ${percent}% (${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
          }
        },
      });
      if (result.downloaded) process.stdout.write('\n');
      console.log(result.downloaded ? `Downloaded ${result.bytes} bytes.` : 'Already present with the expected size; nothing downloaded (--force to fetch again).');
      console.log('Next: smallchat judge serve');
    } catch (e) {
      process.stdout.write('\n');
      console.error(`Download failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

judgeCommand
  .command('serve')
  .description('Run the downloaded model with llama-server (System One endpoint at /v1/systemone) until stopped')
  .option('--variant <name>', `Quantization to serve: ${variantNames}`, DEFAULT_D1_VARIANT)
  .option('--dir <path>', 'Models directory (default: SMALLCHAT_MODELS_DIR or ~/.smallchat/models)')
  .option('--host <address>', 'Address to bind', '127.0.0.1')
  .option('-p, --port <number>', 'Port to listen on', String(new URL(DEFAULT_D1_BASE_URL).port))
  .option('--batch <tokens>', 'Batch size (-b and -ub); a question is read in one batch', '4096')
  .option('--threads <n>', 'CPU threads for llama-server')
  .option('--llama-server <path>', 'The llama-server executable (default: found on the PATH)')
  .option('--ready-timeout <ms>', 'How long to wait for the server to answer', '120000')
  .option('--quiet', "Don't echo llama-server's output")
  .action(async (options) => {
    let variant;
    try {
      variant = d1Variant(options.variant);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
    const dir = resolve(options.dir ?? defaultModelsDir());
    const modelPath = d1ModelPath(dir, variant);
    console.error(`Starting llama-server on ${modelPath}...`);
    let handle;
    try {
      handle = await startD1Server({
        modelPath,
        host: options.host,
        port: parseInt(options.port, 10),
        batch: parseInt(options.batch, 10),
        ...(options.threads !== undefined ? { threads: parseInt(options.threads, 10) } : {}),
        llamaServer: options.llamaServer,
        readyTimeoutMs: parseInt(options.readyTimeout, 10),
        log: options.quiet ? undefined : line => process.stderr.write(`  ${line}\n`),
      });
    } catch (e) {
      console.error(`Could not start the judge: ${(e as Error).message}`);
      process.exit(1);
    }
    console.error(`\nd1 judge ready at ${handle.baseURL}/v1/systemone`);
    console.error('  Use it: smallchat resolve <artifact> "<intent>" --judge d1, smallchat serve --source <artifact> --judge d1,');
    console.error('  or new D1Judge() from @smallchat/core/jev as RuntimeOptions.judge. Ctrl-C stops it.');
    const stop = async (): Promise<void> => {
      await handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => { void stop(); });
    process.on('SIGTERM', () => { void stop(); });
    handle.process.on('exit', (code) => {
      console.error(`llama-server exited (code ${code ?? 'null'})`);
      process.exit(code ?? 1);
    });
  });

judgeCommand
  .command('status')
  .description('Report the downloaded variants, whether llama-server is installed, and whether a judge answers')
  .option('--dir <path>', 'Models directory (default: SMALLCHAT_MODELS_DIR or ~/.smallchat/models)')
  .option('--url <base>', `Server root to probe (default: SMALLCHAT_D1_URL or ${DEFAULT_D1_BASE_URL})`)
  .option('--json', 'Print as JSON')
  .action(async (options) => {
    const status = await d1Status({ dir: options.dir, baseURL: options.url });
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Models directory: ${status.dir}`);
    for (const v of status.variants) console.log(`  ${v.present ? '✓' : '·'} ${v.name.padEnd(5)} ${v.file}${v.present ? '' : '  (smallchat judge download --variant ' + v.name + ')'}`);
    console.log(`llama-server: ${status.llamaServer ?? 'not found on the PATH (brew install llama.cpp, or https://github.com/ggml-org/llama.cpp/releases)'}`);
    console.log(`Judge at ${status.baseURL}: ${status.serving ? 'answering' : 'not answering (smallchat judge serve)'}`);
  });

judgeCommand
  .command('ask')
  .description('Ask a judge which of some tools fits an intent, directly (a probe; no artifact needed)')
  .argument('<intent>', 'The intent')
  .argument('<tools...>', 'Tools as id=description, e.g. "mail/send=Send an email"')
  .option('--judge <spec>', 'd1 (default), jev, or a System One endpoint URL', 'd1')
  .option('--json', 'Print the answer as JSON')
  .action(async (intent: string, tools: string[], options) => {
    let judge;
    try {
      judge = judgeFromSpec(options.judge);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
    if (!judge) {
      console.error('No judge: pass --judge d1, jev or a URL');
      process.exit(2);
    }
    const candidates = tools.map(spec => {
      const eq = spec.indexOf('=');
      return eq === -1 ? { toolId: spec, description: spec } : { toolId: spec.slice(0, eq), description: spec.slice(eq + 1) };
    });
    const answer = await judge.judge({ intent, trigger: 'ambiguous', candidates });
    if (options.json) {
      console.log(JSON.stringify({ judge: judge.name, model: judge.model, answer }, null, 2));
    } else if (answer.status === 'answered') {
      console.log(`${judge.name} (${answer.model ?? judge.model}): ${answer.choice ?? 'none of these'}${answer.probability !== null ? ` p=${answer.probability.toFixed(3)}` : ''}${answer.confidence !== null ? ` confidence=${answer.confidence.toFixed(3)}` : ''}`);
    } else {
      console.log(`${judge.name}: unavailable (${answer.error})${judge instanceof D1Judge ? ' — is smallchat judge serve running?' : ''}`);
      process.exit(1);
    }
  });
