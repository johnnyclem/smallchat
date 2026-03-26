import Foundation

/// Configuration for running MCP servers inside Docker containers.
///
/// Provides process isolation via `docker run` with security hardening:
///   - `--cap-drop=ALL`: drop all Linux capabilities
///   - `--security-opt=no-new-privileges`: prevent privilege escalation
///   - `--network=none`: block all network access (default)
///   - `--memory` / `--cpus`: resource limits
///
/// Mirrors the TypeScript `ContainerSandboxConfig` interface and `container-sandbox.ts` module.
public struct ContainerSandboxConfig: Sendable {

    /// Enable container isolation.
    public var enabled: Bool

    /// Docker image to use (must have the MCP server's runtime installed).
    public var image: String

    /// Memory limit in Docker format, e.g. "256m".
    public var memoryLimit: String?

    /// CPU quota, e.g. "0.5" for half a core.
    public var cpuLimit: String?

    /// Network mode: "none" (default, fully isolated), "host", or a custom network name.
    public var network: String?

    /// Filesystem paths to bind-mount as read-only.
    public var readOnlyMounts: [String]?

    /// Additional docker run flags (escape hatch).
    public var extraArgs: [String]?

    public init(
        enabled: Bool = true,
        image: String,
        memoryLimit: String? = nil,
        cpuLimit: String? = nil,
        network: String? = nil,
        readOnlyMounts: [String]? = nil,
        extraArgs: [String]? = nil
    ) {
        self.enabled = enabled
        self.image = image
        self.memoryLimit = memoryLimit
        self.cpuLimit = cpuLimit
        self.network = network
        self.readOnlyMounts = readOnlyMounts
        self.extraArgs = extraArgs
    }
}

// MARK: - Docker Argument Builder

public enum ContainerSandbox {

    /// Build the `docker run` argument array from configuration.
    ///
    /// Exported for testing — allows verifying the exact Docker invocation
    /// without spawning a process.
    public static func buildDockerArgs(
        command: String,
        args: [String] = [],
        env: [String: String] = [:],
        sandbox: ContainerSandboxConfig
    ) -> [String] {
        var dockerArgs: [String] = ["run", "--rm", "-i"]

        // Security hardening
        dockerArgs.append("--cap-drop=ALL")
        dockerArgs.append("--security-opt=no-new-privileges")

        // Network isolation
        dockerArgs.append("--network=\(sandbox.network ?? "none")")

        // Resource limits
        if let mem = sandbox.memoryLimit {
            dockerArgs.append("--memory=\(mem)")
        }
        if let cpu = sandbox.cpuLimit {
            dockerArgs.append("--cpus=\(cpu)")
        }

        // Read-only mounts
        for mount in sandbox.readOnlyMounts ?? [] {
            dockerArgs.append(contentsOf: ["-v", "\(mount):\(mount):ro"])
        }

        // Environment variables
        for (key, value) in env {
            dockerArgs.append(contentsOf: ["-e", "\(key)=\(value)"])
        }

        // Extra args (escape hatch)
        if let extra = sandbox.extraArgs {
            dockerArgs.append(contentsOf: extra)
        }

        // Image + command + args
        dockerArgs.append(sandbox.image)
        dockerArgs.append(command)
        dockerArgs.append(contentsOf: args)

        return dockerArgs
    }

    /// Check if Docker is available on the host.
    ///
    /// Spawns `docker info` and checks the exit code.
    public static func isDockerAvailable() async -> Bool {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["docker", "info"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            process.terminationHandler = { proc in
                continuation.resume(returning: proc.terminationStatus == 0)
            }

            do {
                try process.run()
            } catch {
                continuation.resume(returning: false)
            }
        }
    }

    /// Spawn an MCP server process, optionally inside a Docker container.
    ///
    /// When `sandbox` is nil or `sandbox.enabled` is false, this spawns the
    /// command directly. When enabled, the command is wrapped in `docker run -i --rm`
    /// with security hardening flags.
    public static func spawnProcess(
        command: String,
        args: [String] = [],
        env: [String: String] = [:],
        cwd: String? = nil,
        sandbox: ContainerSandboxConfig? = nil
    ) throws -> Process {
        let process = Process()

        if let sandbox, sandbox.enabled {
            let dockerArgs = buildDockerArgs(
                command: command,
                args: args,
                env: env,
                sandbox: sandbox
            )
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["docker"] + dockerArgs
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [command] + args

            if let cwd {
                process.currentDirectoryURL = URL(fileURLWithPath: cwd)
            }

            var processEnv = ProcessInfo.processInfo.environment
            for (key, value) in env {
                processEnv[key] = value
            }
            process.environment = processEnv
        }

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()
        return process
    }
}
