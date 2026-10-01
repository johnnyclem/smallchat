/**
 * RtkTransport — ITransport wrapper that compresses tool outputs through RTK.
 *
 * RTK (Rust Token Killer) is a CLI proxy that reduces LLM token consumption by
 * 60–90% by filtering/compressing shell command outputs. This transport wraps any
 * existing ITransport and applies RTK compression to large results before they
 * are returned to the LLM client.
 *
 * Two compression modes operate simultaneously:
 *
 *   prefix mode  — when input.args contains a "command" string, rewrites it as
 *                  "rtk <command>" so RTK processes it at the source.
 *
 *   filter mode  — after the inner transport returns, if the content is a string
 *                  above the threshold, pipes it through "rtk filter" (stdin→stdout).
 *
 * Fallback: if the RTK binary is missing or fails (non-zero exit, timeout, an
 * early exit that never reads its input, empty output), the original output
 * is returned unchanged with metadata.rtk.enabled = false. Never throws due to
 * RTK failure.
 *
 * See: https://github.com/johnnyclem-rdc/rtk
 */

import { spawn } from 'node:child_process';
import { which } from './rtk-which.js';
import type { ITransport, TransportInput, TransportOutput, TransportKind, RtkTransportConfig } from './types.js';

let rtkTransportCounter = 0;

export class RtkTransport implements ITransport {
  readonly id: string;
  readonly type: TransportKind;

  private inner: ITransport;
  private binaryPath: string | null = null;
  private filterThresholdBytes: number;
  private filterLevel: 'default' | 'aggressive';
  private timeoutMs: number;
  private enabled: boolean;

  constructor(config: RtkTransportConfig) {
    this.id = `rtk-${++rtkTransportCounter}`;
    this.type = config.inner.type;
    this.inner = config.inner;
    this.binaryPath = config.binaryPath ?? null;
    this.filterThresholdBytes = config.filterThresholdBytes ?? 512;
    this.filterLevel = config.filterLevel ?? 'default';
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.enabled = config.enabled ?? true;
  }

  async execute(input: TransportInput): Promise<TransportOutput> {
    if (!this.enabled) {
      return this.inner.execute(input);
    }

    const binary = await this.resolveBinary();
    if (!binary) {
      const result = await this.inner.execute(input);
      return this.attachNoopMetadata(result);
    }

    const rewrittenInput = this.applyPrefixMode(input, binary);
    const raw = await this.inner.execute(rewrittenInput);
    return this.applyFilterMode(raw, binary, rewrittenInput !== input);
  }

  async *executeStream(input: TransportInput): AsyncGenerator<TransportOutput> {
    if (!this.enabled) {
      yield* this.inner.executeStream?.(input) ?? this.fallbackStream(input);
      return;
    }

    const binary = await this.resolveBinary();
    if (!binary) {
      const gen = this.inner.executeStream?.(input) ?? this.fallbackStream(input);
      for await (const chunk of gen) {
        yield this.attachNoopMetadata(chunk);
      }
      return;
    }

    const rewrittenInput = this.applyPrefixMode(input, binary);
    const chunks: TransportOutput[] = [];

    const gen = this.inner.executeStream?.(rewrittenInput) ?? this.fallbackStream(rewrittenInput);
    for await (const chunk of gen) {
      chunks.push(chunk);
      if (!chunk.metadata?.streaming) {
        yield chunk;
      }
    }

    const last = chunks[chunks.length - 1];
    if (last && typeof last.content === 'string' && last.content.length >= this.filterThresholdBytes) {
      const compressed = await this.applyFilterMode(last, binary, rewrittenInput !== input);
      yield compressed;
    } else if (last) {
      yield this.attachNoopMetadata(last);
    }
  }

  async dispose(): Promise<void> {
    return this.inner.dispose?.();
  }

  // ---------------------------------------------------------------------------
  // Prefix mode — rewrite "git status" → "rtk git status" in command args
  // ---------------------------------------------------------------------------

  private applyPrefixMode(input: TransportInput, binary: string): TransportInput {
    const command = input.args['command'];
    if (typeof command !== 'string') return input;

    const trimmed = command.trimStart();
    if (trimmed.startsWith('rtk ') || trimmed.startsWith(binary + ' ')) return input;

    if (!isRtkEligibleCommand(trimmed)) return input;

    return {
      ...input,
      args: { ...input.args, command: `rtk ${trimmed}` },
    };
  }

  // ---------------------------------------------------------------------------
  // Filter mode — pipe content through "rtk filter" after execute
  // ---------------------------------------------------------------------------

  private async applyFilterMode(
    output: TransportOutput,
    binary: string,
    prefixApplied: boolean,
  ): Promise<TransportOutput> {
    if (output.isError) return this.attachNoopMetadata(output);

    const content = typeof output.content === 'string' ? output.content : JSON.stringify(output.content);
    const inputBytes = Buffer.byteLength(content, 'utf8');

    if (inputBytes < this.filterThresholdBytes) {
      return this.attachNoopMetadata(output);
    }

    try {
      const compressed = await this.runRtkFilter(binary, content);
      const outputBytes = Buffer.byteLength(compressed, 'utf8');
      const savedPct = inputBytes > 0 ? Math.round(((inputBytes - outputBytes) / inputBytes) * 100) : 0;

      return {
        ...output,
        content: compressed,
        metadata: {
          ...output.metadata,
          rtk: {
            enabled: true,
            inputBytes,
            outputBytes,
            savedPct,
            mode: prefixApplied ? 'prefix' : 'filter',
          },
        },
      };
    } catch {
      return this.attachNoopMetadata(output);
    }
  }

  // ---------------------------------------------------------------------------
  // RTK subprocess — pipe content through "rtk filter"
  // ---------------------------------------------------------------------------

  private runRtkFilter(binary: string, content: string): Promise<string> {
    return runFilter(binary, content, this.filterLevel, this.timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Binary resolution — cached after first resolution
  // ---------------------------------------------------------------------------

  private resolvedBinary: string | null | undefined = undefined;

  private async resolveBinary(): Promise<string | null> {
    if (this.resolvedBinary !== undefined) return this.resolvedBinary;

    if (this.binaryPath) {
      this.resolvedBinary = this.binaryPath;
      return this.resolvedBinary;
    }

    this.resolvedBinary = await which('rtk');
    return this.resolvedBinary;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private attachNoopMetadata(output: TransportOutput): TransportOutput {
    const content = typeof output.content === 'string' ? output.content : JSON.stringify(output.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      ...output,
      metadata: {
        ...output.metadata,
        rtk: { enabled: false, inputBytes: bytes, outputBytes: bytes, savedPct: 0, mode: 'none' },
      },
    };
  }

  private async *fallbackStream(input: TransportInput): AsyncGenerator<TransportOutput> {
    const result = await this.inner.execute(input);
    yield result;
  }
}

// ---------------------------------------------------------------------------
// RTK-eligible command detector
// ---------------------------------------------------------------------------

const RTK_PREFIXES = [
  'git ', 'cargo ', 'npm ', 'npx ', 'pnpm ', 'yarn ',
  'pytest', 'python -m pytest',
  'go test', 'go build',
  'grep ', 'rg ', 'find ', 'ls ', 'cat ',
  'eslint', 'tsc ', 'tsc\n', 'tsc',
  'docker ', 'kubectl ', 'aws ',
  'ruff ', 'golangci-lint',
];

function isRtkEligibleCommand(cmd: string): boolean {
  return RTK_PREFIXES.some((p) => cmd.startsWith(p) || cmd === p.trim());
}

/**
 * Wrap any ITransport with RTK output compression.
 *
 * @example
 * const transport = withRtk(new McpStdioTransport(config), { filterLevel: 'aggressive' });
 */
export function withRtk(inner: ITransport, config?: Omit<RtkTransportConfig, 'inner'>): RtkTransport {
  return new RtkTransport({ ...config, inner });
}

// ---------------------------------------------------------------------------
// Standalone filter — apply RTK compression to arbitrary content
// ---------------------------------------------------------------------------

/**
 * Filter arbitrary string content through RTK without a full transport wrapper.
 *
 * Used by the MCP server to post-process dispatch results when rtkConfig is set.
 * Returns the original content unchanged if RTK is unavailable or fails.
 */
export async function filterContentWithRtk(
  content: string,
  config: import('./types.js').RtkConfig,
): Promise<{ compressed: string; savedPct: number; enabled: boolean }> {
  if (config.enabled === false) {
    return { compressed: content, savedPct: 0, enabled: false };
  }

  const threshold = config.filterThresholdBytes ?? 512;
  const inputBytes = Buffer.byteLength(content, 'utf8');

  if (inputBytes < threshold) {
    return { compressed: content, savedPct: 0, enabled: false };
  }

  const binaryPath = config.binaryPath ?? (await which('rtk'));
  if (!binaryPath) {
    return { compressed: content, savedPct: 0, enabled: false };
  }

  try {
    const compressed = await runFilter(binaryPath, content, config.filterLevel ?? 'default', config.timeoutMs ?? 5000);
    const outputBytes = Buffer.byteLength(compressed, 'utf8');
    const savedPct = Math.round(((inputBytes - outputBytes) / inputBytes) * 100);
    return { compressed, savedPct, enabled: true };
  } catch {
    return { compressed: content, savedPct: 0, enabled: false };
  }
}

/**
 * Pipe `content` through `rtk filter` and resolve with its output. Rejects
 * — so callers fall back to the original content — when rtk cannot be
 * started, exits non-zero, times out, stops reading its input (EPIPE), or
 * prints nothing for non-empty input.
 */
function runFilter(binary: string, content: string, level: 'default' | 'aggressive', timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['filter'];
    if (level === 'aggressive') args.push('--aggressive');

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      reject(err);
    };

    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    const timer = setTimeout(() => fail(new Error('RTK timeout')), timeoutMs);

    // Resolve only once rtk has both consumed all of its input and exited 0:
    // an rtk that exits early (unknown subcommand, crash) must not pass off
    // a truncated or empty output as the filtered result.
    let inputWritten = false;
    let exitOutput: string | null = null;
    const maybeResolve = () => {
      if (settled || !inputWritten || exitOutput === null) return;
      if (exitOutput.length === 0 && content.length > 0) {
        fail(new Error('RTK produced no output'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(exitOutput);
    };

    proc.on('close', (code) => {
      if (code === 0) {
        exitOutput = Buffer.concat(outChunks).toString('utf8');
        maybeResolve();
      } else {
        fail(new Error(`RTK exited ${code}: ${Buffer.concat(errChunks).toString('utf8')}`));
      }
    });

    proc.on('error', fail);
    // Without this listener an EPIPE (rtk exited before reading) is an
    // uncaught exception that kills the whole process.
    proc.stdin.on('error', fail);

    proc.stdin.end(content, 'utf8', () => {
      inputWritten = true;
      maybeResolve();
    });
  });
}
