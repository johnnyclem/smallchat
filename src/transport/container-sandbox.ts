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
   * spawned MCP server. The default is to forward only the platform's
   * safe allowlist (safeInheritedEnv) plus whatever is set in `env`. Use
   * this only for trusted MCP servers; arbitrary servers can otherwise
   * read tokens like ANTHROPIC_API_KEY, GITHUB_TOKEN, AWS_*, etc.
   */
  inheritEnv?: boolean;
  /**
   * Also forward proxy and CA-bundle settings (HTTP(S)_PROXY, NO_PROXY,
   * NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...), for servers that reach the
   * network through a corporate proxy. Default: off, unless the parent
   * environment sets SMALLCHAT_FORWARD_PROXY_ENV=1. Proxy URLs can carry
   * credentials, so this is opt-in.
   */
  forwardProxyEnv?: boolean;
}

/**
 * Names of environment variables forwarded to spawned MCP servers on
 * POSIX even when `inheritEnv` is false (plus every LC_* variable).
 * Keep this list short — anything that looks like a secret (API_KEY,
 * TOKEN, PASSWORD, SECRET) must be opted into via the per-server `env`
 * map or `inheritEnv`.
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

/**
 * The Windows allowlist: what spawning `npx`/`.cmd` shims, Node and
 * Python needs (the MCP SDK's default list plus PATHEXT, ComSpec, TMP,
 * WINDIR and the ProgramFiles/ProgramData variants). Matched
 * case-insensitively, as Windows environment names are.
 */
export const SAFE_INHERITED_ENV_KEYS_WIN32: readonly string[] = [
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'USERPROFILE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'NODE_ENV',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
];

/** Proxy and CA settings, forwarded only with `forwardProxyEnv`. */
export const PROXY_ENV_KEYS: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

/** What the docker CLI itself needs to reach the daemon (never passed into the container). */
const DOCKER_CLIENT_ENV_KEYS: readonly string[] = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

/**
 * The environment an MCP server inherits by default: the platform's
 * allowlist, every LC_* locale variable on POSIX, and — with
 * `forwardProxyEnv` or SMALLCHAT_FORWARD_PROXY_ENV=1 — proxy/CA settings.
 * Values that look like exported shell functions (`() {...`) are skipped.
 */
export function safeInheritedEnv(options: {
  source?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  forwardProxyEnv?: boolean;
} = {}): Record<string, string> {
  const source = options.source ?? process.env;
  const platform = options.platform ?? process.platform;
  const forwardProxy = options.forwardProxyEnv ?? source.SMALLCHAT_FORWARD_PROXY_ENV === '1';
  const out: Record<string, string> = {};
  const take = (key: string) => {
    const value = source[key];
    if (typeof value === 'string' && !value.startsWith('()')) out[key] = value;
  };

  if (platform === 'win32') {
    const wanted = new Set(SAFE_INHERITED_ENV_KEYS_WIN32);
    for (const key of Object.keys(source)) {
      if (wanted.has(key.toUpperCase())) take(key);
    }
  } else {
    for (const key of SAFE_INHERITED_ENV_KEYS) take(key);
    // Also forward LC_* locale variants beyond the explicit list above.
    for (const key of Object.keys(source)) {
      if (key.startsWith('LC_')) take(key);
    }
  }
  if (forwardProxy) {
    for (const key of PROXY_ENV_KEYS) take(key);
  }
  return out;
}

/**
 * How to start an MCP server process: the command, its arguments and the
 * complete environment to give it. Shared by spawnMcpProcess and the SDK
 * stdio client (which spawns through cross-spawn, so `npx` and other
 * `.cmd` shims resolve on Windows).
 *
 * In a container sandbox the command is `docker run …`; variables from
 * `env` are named on the command line (`-e NAME`) and their values are
 * handed to the docker client through its environment, so no value ever
 * appears in the process list.
 */
export interface McpSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export function buildMcpSpawnSpec(options: SpawnMcpProcessOptions): McpSpawnSpec {
  if (options.containerSandbox?.enabled) {
    const dockerEnv: Record<string, string> = safeInheritedEnv({ forwardProxyEnv: options.forwardProxyEnv });
    for (const key of DOCKER_CLIENT_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) dockerEnv[key] = value;
    }
    return {
      command: 'docker',
      args: buildDockerArgs(options),
      env: { ...dockerEnv, ...options.env },
    };
  }

  const baseEnv = options.inheritEnv
    ? definedOnly(process.env)
    : safeInheritedEnv({ forwardProxyEnv: options.forwardProxyEnv });
  return {
    command: options.command,
    args: options.args ?? [],
    env: { ...baseEnv, ...options.env },
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}

function definedOnly(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core spawn function
// ---------------------------------------------------------------------------

/**
 * Spawn an MCP server process, optionally inside a Docker container.
 *
 * When `containerSandbox` is absent or `enabled: false`, this is a direct
 * `child_process.spawn()` with the safe environment (see
 * buildMcpSpawnSpec). When `containerSandbox.enabled` is true, the
 * command is wrapped in `docker run -i --rm` with security hardening flags.
 *
 * Prefer the SDK-based clients (McpStdioTransport, introspection, serve's
 * UpstreamPool), which drain stderr and resolve `.cmd` shims on Windows;
 * this returns a raw ChildProcess whose stdout and stderr the caller must
 * both consume.
 */
export function spawnMcpProcess(options: SpawnMcpProcessOptions): ChildProcess {
  const spec = buildMcpSpawnSpec(options);
  return spawn(spec.command, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spec.env,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  });
}

// ---------------------------------------------------------------------------
// Docker spawn
// ---------------------------------------------------------------------------

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

  // Environment variables, by name only: `-e NAME` makes docker read the
  // value from its own environment (see buildMcpSpawnSpec), so values never
  // appear on the command line.
  for (const key of Object.keys(options.env ?? {})) {
    args.push('-e', key);
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
