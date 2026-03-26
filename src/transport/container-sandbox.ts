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

  return spawn(options.command, options.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
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
