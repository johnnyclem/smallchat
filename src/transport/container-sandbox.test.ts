import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { ContainerSandboxConfig } from './types.js';

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import after mocking
import { spawnMcpProcess, buildDockerArgs, isDockerAvailable } from './container-sandbox.js';

function makeFakeProcess(exitCode = 0): ChildProcess {
  const handlers: Record<string, Function[]> = {};
  const fakeProcess = {
    stdin: { write: vi.fn(), end: vi.fn(), writable: true },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
      // Fire exit immediately for isDockerAvailable tests
      if (event === 'exit') {
        setTimeout(() => cb(exitCode), 0);
      }
      return fakeProcess;
    }),
    kill: vi.fn(),
    pid: 12345,
  };
  return fakeProcess as unknown as ChildProcess;
}

describe('container-sandbox', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(makeFakeProcess());
  });

  // -------------------------------------------------------------------------
  // spawnMcpProcess — no sandbox
  // -------------------------------------------------------------------------

  describe('spawnMcpProcess without sandbox', () => {
    it('spawns the command directly', () => {
      spawnMcpProcess({ command: 'node', args: ['server.js'] });

      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        ['server.js'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('passes environment variables to direct spawn', () => {
      spawnMcpProcess({
        command: 'python',
        args: ['-m', 'server'],
        env: { API_KEY: 'secret' },
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'python',
        ['-m', 'server'],
        expect.objectContaining({
          env: expect.objectContaining({ API_KEY: 'secret' }),
        }),
      );
    });

    it('passes cwd to direct spawn', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        cwd: '/some/dir',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        ['server.js'],
        expect.objectContaining({ cwd: '/some/dir' }),
      );
    });

    it('defaults to empty args when none provided', () => {
      spawnMcpProcess({ command: 'node' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        [],
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // spawnMcpProcess — sandbox disabled
  // -------------------------------------------------------------------------

  describe('spawnMcpProcess with sandbox disabled', () => {
    it('spawns directly when enabled is false', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: { enabled: false, image: 'node:20-slim' },
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        ['server.js'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // spawnMcpProcess — sandbox enabled
  // -------------------------------------------------------------------------

  describe('spawnMcpProcess with sandbox enabled', () => {
    it('spawns via docker with security defaults', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: { enabled: true, image: 'node:20-slim' },
      });

      expect(mockSpawn).toHaveBeenCalledOnce();
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'run', '--rm', '-i',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--network=none',
          'node:20-slim',
          'node', 'server.js',
        ]),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    });

    it('includes memory limit when configured', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: { enabled: true, image: 'node:20-slim', memoryLimit: '256m' },
      });

      const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(dockerArgs).toContain('--memory=256m');
    });

    it('includes cpu limit when configured', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: { enabled: true, image: 'node:20-slim', cpuLimit: '0.5' },
      });

      const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(dockerArgs).toContain('--cpus=0.5');
    });

    it('uses custom network when specified', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: { enabled: true, image: 'node:20-slim', network: 'my-network' },
      });

      const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(dockerArgs).toContain('--network=my-network');
      expect(dockerArgs).not.toContain('--network=none');
    });

    it('passes environment variables via -e flags', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: 'secret', DB_HOST: 'localhost' },
        containerSandbox: { enabled: true, image: 'node:20-slim' },
      });

      const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
      const eFlags: string[] = [];
      for (let i = 0; i < dockerArgs.length; i++) {
        if (dockerArgs[i] === '-e') eFlags.push(dockerArgs[i + 1]);
      }
      expect(eFlags).toContain('API_KEY=secret');
      expect(eFlags).toContain('DB_HOST=localhost');
    });

    it('adds read-only volume mounts', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: {
          enabled: true,
          image: 'node:20-slim',
          readOnlyMounts: ['/data/models', '/config'],
        },
      });

      const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
      const vFlags: string[] = [];
      for (let i = 0; i < dockerArgs.length; i++) {
        if (dockerArgs[i] === '-v') vFlags.push(dockerArgs[i + 1]);
      }
      expect(vFlags).toContain('/data/models:/data/models:ro');
      expect(vFlags).toContain('/config:/config:ro');
    });

    it('passes extra args through', () => {
      spawnMcpProcess({
        command: 'node',
        args: ['server.js'],
        containerSandbox: {
          enabled: true,
          image: 'node:20-slim',
          extraArgs: ['-w', '/app', '--read-only'],
        },
      });

      const dockerArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(dockerArgs).toContain('-w');
      expect(dockerArgs).toContain('/app');
      expect(dockerArgs).toContain('--read-only');
    });
  });

  // -------------------------------------------------------------------------
  // buildDockerArgs — pure function tests
  // -------------------------------------------------------------------------

  describe('buildDockerArgs', () => {
    it('builds minimal args with defaults', () => {
      const args = buildDockerArgs({
        command: 'python',
        args: ['main.py'],
        containerSandbox: { enabled: true, image: 'python:3.12-slim' },
      });

      expect(args).toEqual([
        'run', '--rm', '-i',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--network=none',
        'python:3.12-slim',
        'python', 'main.py',
      ]);
    });

    it('builds args with all options set', () => {
      const args = buildDockerArgs({
        command: 'node',
        args: ['index.js'],
        env: { TOKEN: 'abc' },
        containerSandbox: {
          enabled: true,
          image: 'node:20-slim',
          memoryLimit: '512m',
          cpuLimit: '2',
          network: 'bridge',
          readOnlyMounts: ['/data'],
          extraArgs: ['--read-only'],
        },
      });

      expect(args).toEqual([
        'run', '--rm', '-i',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--network=bridge',
        '--memory=512m',
        '--cpus=2',
        '-v', '/data:/data:ro',
        '-e', 'TOKEN=abc',
        '--read-only',
        'node:20-slim',
        'node', 'index.js',
      ]);
    });

    it('handles command with no args', () => {
      const args = buildDockerArgs({
        command: 'my-server',
        containerSandbox: { enabled: true, image: 'alpine:latest' },
      });

      expect(args[args.length - 1]).toBe('my-server');
    });
  });

  // -------------------------------------------------------------------------
  // isDockerAvailable
  // -------------------------------------------------------------------------

  describe('isDockerAvailable', () => {
    it('returns true when docker info exits with 0', async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(0));
      const result = await isDockerAvailable();
      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('docker', ['info'], expect.any(Object));
    });

    it('returns false when docker info exits with non-zero', async () => {
      mockSpawn.mockReturnValue(makeFakeProcess(1));
      const result = await isDockerAvailable();
      expect(result).toBe(false);
    });

    it('returns false when spawn throws', async () => {
      mockSpawn.mockImplementation(() => { throw new Error('not found'); });
      const result = await isDockerAvailable();
      expect(result).toBe(false);
    });
  });
});
