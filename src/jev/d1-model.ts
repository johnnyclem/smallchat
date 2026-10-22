/**
 * The local d1 decision model: where its weights live, how they are
 * fetched, and how llama-server runs them (`smallchat judge download`,
 * `smallchat judge serve`, `smallchat judge status`).
 *
 * Weights come from Hugging Face (LiquidAI/d1-omni-600M-GGUF, LFM Open
 * License v1.0) over https, one file per variant, written to
 * `<dir>/<file>.part` and renamed when the byte count matches the
 * catalog, so a half-written file is never taken for a model. llama.cpp
 * is not bundled: `llama-server` is found on the PATH (brew install
 * llama.cpp, or a release from github.com/ggml-org/llama.cpp) or named
 * with --llama-server. The server is started with the batch sizes the
 * model card asks for (a question is read in one batch).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_D1_BASE_URL } from './d1-judge.js';
import { SYSTEM_ONE_PATH } from './system-one.js';

/** The Hugging Face repository the weights come from. */
export const D1_MODEL_REPO = 'LiquidAI/d1-omni-600M-GGUF';
/** The license the weights are under (read it before you ship them). */
export const D1_MODEL_LICENSE = 'LFM Open License v1.0 (https://huggingface.co/LiquidAI/d1-omni-600M-GGUF/blob/main/LICENSE)';

/** A quantization of the model: its file in the repository and its size, which the download checks. */
export interface D1ModelVariant {
  /** 'q8', 'f16' or 'bf16' */
  name: D1VariantName;
  file: string;
  bytes: number;
  note: string;
}

export type D1VariantName = 'q8' | 'f16' | 'bf16';

/** The variants `smallchat judge download` knows, by name. Sizes are the repository's as of 2026-10-17. */
export const D1_MODEL_VARIANTS: Readonly<Record<D1VariantName, D1ModelVariant>> = {
  q8: { name: 'q8', file: 'd1-omni-600M-Q8_0.gguf', bytes: 407_207_584, note: '8-bit, 0.41 GB: the default; same top answer as fp32 on the model card\'s checks' },
  f16: { name: 'f16', file: 'd1-omni-600M-F16.gguf', bytes: 764_049_056, note: 'half precision, 0.76 GB' },
  bf16: { name: 'bf16', file: 'd1-omni-600M-BF16.gguf', bytes: 764_049_056, note: 'bfloat16, 0.76 GB (the model card advises against it for text)' },
};

export const DEFAULT_D1_VARIANT: D1VariantName = 'q8';

/** Where weights are kept: SMALLCHAT_MODELS_DIR, else ~/.smallchat/models. */
export function defaultModelsDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.SMALLCHAT_MODELS_DIR?.trim();
  return resolvePath(configured || join(homedir(), '.smallchat', 'models'));
}

/** The variant named, or a TypeError listing the choices. */
export function d1Variant(name: string | undefined): D1ModelVariant {
  const variant = D1_MODEL_VARIANTS[(name ?? DEFAULT_D1_VARIANT) as D1VariantName];
  if (!variant) throw new TypeError(`unknown d1 variant "${name}"; choose one of ${Object.keys(D1_MODEL_VARIANTS).join(', ')}`);
  return variant;
}

/** The https URL a variant's file is fetched from. */
export function d1ModelURL(variant: D1ModelVariant): string {
  return `https://huggingface.co/${D1_MODEL_REPO}/resolve/main/${variant.file}`;
}

/** Where a variant's file lives under `dir`. */
export function d1ModelPath(dir: string, variant: D1ModelVariant): string {
  return join(dir, variant.file);
}

/** Whether a variant is present under `dir` with the catalog's byte count. */
export function d1ModelPresent(dir: string, variant: D1ModelVariant): boolean {
  const path = d1ModelPath(dir, variant);
  try {
    return statSync(path).size === variant.bytes;
  } catch {
    return false;
  }
}

export interface DownloadD1Options {
  dir?: string;
  variant?: D1VariantName;
  /** fetch implementation (tests). Default: the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called as bytes arrive. */
  onProgress?: (received: number, total: number) => void;
  /** Re-download a file that is already present. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface DownloadD1Result {
  path: string;
  variant: D1ModelVariant;
  /** False when the file was already there with the right size. */
  downloaded: boolean;
  bytes: number;
}

/**
 * Fetch a variant's weights into `dir` (created if missing). The body is
 * streamed to `<file>.part` and renamed only when its size is the
 * catalog's; a short or long file is removed and reported, so a partial
 * download never passes for a model. An existing file of the right size
 * is kept unless `force`.
 */
export async function downloadD1Model(options: DownloadD1Options = {}): Promise<DownloadD1Result> {
  const dir = resolvePath(options.dir ?? defaultModelsDir());
  const variant = d1Variant(options.variant);
  const path = d1ModelPath(dir, variant);
  if (!options.force && d1ModelPresent(dir, variant)) return { path, variant, downloaded: false, bytes: variant.bytes };

  mkdirSync(dir, { recursive: true });
  const part = `${path}.part`;
  const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const response = await fetchFn(d1ModelURL(variant), { redirect: 'follow', signal: options.signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`download of ${variant.file} failed: HTTP ${response.status}`);
  }
  let received = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      options.onProgress?.(received, variant.bytes);
      controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counted) as import('node:stream/web').ReadableStream), createWriteStream(part, { mode: 0o644 }), { signal: options.signal });
  } catch (err) {
    try { unlinkSync(part); } catch { /* nothing to remove */ }
    throw err;
  }
  const size = statSync(part).size;
  if (size !== variant.bytes) {
    unlinkSync(part);
    throw new Error(`download of ${variant.file} is ${size} bytes, expected ${variant.bytes}; the repository may have changed, or the transfer was cut short`);
  }
  renameSync(part, path);
  return { path, variant, downloaded: true, bytes: size };
}

/** The `llama-server` executable on the PATH, or null. */
export function findLlamaServer(env: Record<string, string | undefined> = process.env): string | null {
  const names = process.platform === 'win32' ? ['llama-server.exe', 'llama-server'] : ['llama-server'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface LlamaServerOptions {
  modelPath: string;
  host?: string;
  port?: number;
  /** Batch sizes; the model card asks for 4096 (a question is read in one batch). */
  batch?: number;
  /** Threads (llama-server's default when unset). */
  threads?: number;
  /** Extra arguments passed through verbatim. */
  extraArgs?: string[];
}

/** The arguments `smallchat judge serve` starts llama-server with. */
export function llamaServerArgs(options: LlamaServerOptions): string[] {
  const batch = options.batch ?? 4096;
  if (!(Number.isInteger(batch) && batch >= 512 && batch <= 16384)) throw new TypeError('batch must be an integer in [512, 16384]');
  const port = options.port ?? Number(new URL(DEFAULT_D1_BASE_URL).port);
  if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new TypeError('port must be an integer in [1, 65535]');
  const args = ['-m', options.modelPath, '--host', options.host ?? '127.0.0.1', '--port', String(port), '-b', String(batch), '-ub', String(batch)];
  if (options.threads !== undefined) args.push('-t', String(options.threads));
  return args.concat(options.extraArgs ?? []);
}

export interface D1ServerHandle {
  process: ChildProcess;
  baseURL: string;
  /** Stop the server (SIGTERM; SIGKILL after `graceMs`). */
  stop(graceMs?: number): Promise<void>;
}

/**
 * Start llama-server on the model and wait until it answers a System One
 * request (or `readyTimeoutMs` passes, when the process is stopped and the
 * error says what it printed last).
 */
export async function startD1Server(options: LlamaServerOptions & {
  llamaServer?: string;
  readyTimeoutMs?: number;
  /** Where the server's output goes (default: inherited stderr). */
  log?: (line: string) => void;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<D1ServerHandle> {
  const executable = options.llamaServer ?? findLlamaServer();
  if (!executable) {
    throw new Error('llama-server was not found on the PATH; install llama.cpp (brew install llama.cpp, or a release from https://github.com/ggml-org/llama.cpp/releases) or pass --llama-server <path>');
  }
  if (!existsSync(options.modelPath)) throw new Error(`model file not found: ${options.modelPath} (run smallchat judge download)`);
  const args = llamaServerArgs(options);
  const host = options.host ?? '127.0.0.1';
  const port = args[args.indexOf('--port') + 1];
  const baseURL = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const recent: string[] = [];
  const onOutput = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      recent.push(line);
      if (recent.length > 20) recent.shift();
      options.log?.(line);
    }
  };
  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', onOutput);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const stop = async (graceMs = 5000): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolveStop => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, graceMs);
      child.once('exit', () => { clearTimeout(timer); resolveStop(); });
    });
  };

  const fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (exited) {
      const why = exited as { code: number | null; signal: NodeJS.Signals | null };
      throw new Error(`llama-server exited (code ${why.code ?? 'null'}, signal ${why.signal ?? 'none'}) before it was ready:\n${recent.join('\n')}`);
    }
    if (await d1ServerAnswers(baseURL, fetchFn)) return { process: child, baseURL, stop };
    await new Promise(r => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`llama-server did not answer at ${baseURL}${SYSTEM_ONE_PATH} within ${options.readyTimeoutMs ?? 120_000} ms:\n${recent.join('\n')}`);
}

/** The probe request `judge status` and the readiness wait send: one tool, one abstain option. */
export function d1ProbeRequest(): Record<string, unknown> {
  return {
    state: 'probe',
    questions: { tool: { type: 'choice', instructions: 'Probe.', criteria: { 'probe/ok': 'The probe tool', __none__: 'None' } } },
  };
}

/** Whether a System One server at `baseURL` answers the probe with a choice. */
export async function d1ServerAnswers(
  baseURL: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => globalThis.fetch(input, init),
  timeoutMs = 3000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${baseURL}${SYSTEM_ONE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(d1ProbeRequest()),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const body = await response.json() as { answers?: { tool?: { type?: unknown } } };
    return body?.answers?.tool?.type === 'choice';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** What `smallchat judge status` reports. */
export interface D1Status {
  dir: string;
  variants: Array<{ name: D1VariantName; file: string; present: boolean; path: string }>;
  llamaServer: string | null;
  baseURL: string;
  /** Whether a server at baseURL answers the probe */
  serving: boolean;
}

export async function d1Status(options: { dir?: string; baseURL?: string; fetch?: (input: string, init?: RequestInit) => Promise<Response>; env?: Record<string, string | undefined> } = {}): Promise<D1Status> {
  const env = options.env ?? process.env;
  const dir = resolvePath(options.dir ?? defaultModelsDir(env));
  const baseURL = (options.baseURL ?? (env.SMALLCHAT_D1_URL?.trim() || DEFAULT_D1_BASE_URL)).replace(/\/+$/, '');
  return {
    dir,
    variants: (Object.values(D1_MODEL_VARIANTS)).map(v => ({ name: v.name, file: v.file, present: d1ModelPresent(dir, v), path: d1ModelPath(dir, v) })),
    llamaServer: findLlamaServer(env),
    baseURL,
    serving: await d1ServerAnswers(baseURL, options.fetch),
  };
}
