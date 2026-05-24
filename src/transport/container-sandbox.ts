/**
 * Container Sandbox — spawn MCP servers inside Docker containers.
 *
 * Provides a drop-in replacement for child_process.spawn() that optionally
 * wraps the command in `docker run` with security hardening:
 *   - --cap-drop=ALL: drop all Linux capabilities
 *   - --security-opt=no-new-privileges: prevent privilege escalation
 *   - --network=none: block all network access (default)
 *   - --memory / --cpus: resource limits
 *
 * The JSON-RPC stdio protocol works identically since Docker's `-i` flag
 * passes stdin/stdout through transparently.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ContainerSandboxConfig } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnMcpProcessOptions {
  /** Command to run (e.g. "node", "python") */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Working directory (ignored when containerized) */
  cwd?: string;
  /** Optional container sandbox configuration */
  containerSandbox?: ContainerSandboxConfig;
  /**
   * When true, forward the entire parent process environment to the
   * spawned MCP server. The default is to forward only a small safe
   * allowlist (PATH, HOME, USER, LANG, LC_*, TZ, TERM, NODE_ENV,
   * NODE_OPTIONS, SHELL) plus whatever is set in `env`. Use this only
   * for trusted MCP servers; arbitrary servers can otherwise read
   * tokens like ANTHROPIC_API_KEY, GITHUB_TOKEN, AWS_*, etc.
   */
  inheritEnv?: boolean;
}

/**
 * Names of environment variables forwarded to spawned MCP servers
 * even when `inheritEnv` is false. Keep this list short — anything
 * that looks like a secret (API_KEY, TOKEN, PASSWORD, SECRET) must
 * be opted into via the per-server `env` map or `inheritEnv`.
 */
export const SAFE_INHERITED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'TMPDIR',
  'SHELL',
  'NODE_ENV',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
];

function pickSafeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const v = source[key];
    if (typeof v === 'string') out[key] = v;
  }
  // Also forward LC_* locale variants beyond the explicit list above.
  for (const key of Object.keys(source)) {
    if (key.startsWith('LC_') && !(key in out)) {
      const v = source[key];
      if (typeof v === 'string') out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core spawn function
// ---------------------------------------------------------------------------

/**
 * Spawn an MCP server process, optionally inside a Docker container.
 *
 * When `containerSandbox` is absent or `enabled: false`, this is equivalent
 * to a direct `child_process.spawn()` call (backward-compatible).
 *
 * When `containerSandbox.enabled` is true, the command is wrapped in
 * `docker run -i --rm` with security hardening flags.
 */
export function spawnMcpProcess(options: SpawnMcpProcessOptions): ChildProcess {
  if (options.containerSandbox?.enabled) {
    return spawnContainerized(options);
  }

  const baseEnv = options.inheritEnv
    ? (process.env as Record<string, string>)
    : pickSafeEnv(process.env);

  return spawn(options.command, options.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...baseEnv, ...options.env },
    cwd: options.cwd,
  });
}

// ---------------------------------------------------------------------------
// Docker spawn
// ---------------------------------------------------------------------------

function spawnContainerized(options: SpawnMcpProcessOptions): ChildProcess {
  const dockerArgs = buildDockerArgs(options);
  return spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Build the `docker run` argument array from spawn options.
 *
 * Exported for testing — allows verifying the exact Docker invocation
 * without mocking spawn.
 */
export function buildDockerArgs(options: SpawnMcpProcessOptions): string[] {
  const sandbox = options.containerSandbox!;
  const args: string[] = [
    'run',
    '--rm',
    '-i',
  ];

  // Security hardening
  args.push('--cap-drop=ALL');
  args.push('--security-opt=no-new-privileges');

  // Network isolation (default: none)
  args.push(`--network=${sandbox.network ?? 'none'}`);

  // Resource limits
  if (sandbox.memoryLimit) {
    args.push(`--memory=${sandbox.memoryLimit}`);
  }
  if (sandbox.cpuLimit) {
    args.push(`--cpus=${sandbox.cpuLimit}`);
  }

  // Read-only mounts
  for (const mount of sandbox.readOnlyMounts ?? []) {
    args.push('-v', `${mount}:${mount}:ro`);
  }

  // Environment variables
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }

  // Extra args (escape hatch)
  if (sandbox.extraArgs) {
    args.push(...sandbox.extraArgs);
  }

  // Image + command + args
  args.push(sandbox.image);
  args.push(options.command);
  if (options.args?.length) {
    args.push(...options.args);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

/**
 * Check if Docker is available on the host.
 * Spawns `docker info` and checks the exit code.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const child = spawn('docker', ['info'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return new Promise<boolean>((resolve) => {
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  } catch {
    return false;
  }
}
