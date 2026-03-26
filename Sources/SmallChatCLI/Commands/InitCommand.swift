import ArgumentParser
import Foundation
import SmallChat

struct InitCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "init",
        abstract: "Scaffold a new smallchat project"
    )

    @Argument(help: "Directory to initialize (defaults to current directory)")
    var directory: String?

    @Option(name: .shortAndLong, help: "Project template: basic, mcp-server, agent")
    var template: String = "basic"

    func run() async throws {
        let projectDir = directory ?? FileManager.default.currentDirectoryPath
        let projectName = URL(fileURLWithPath: projectDir).lastPathComponent

        print("\nInitializing smallchat project in \(projectDir)...\n")

        let fm = FileManager.default

        // Create directories
        let dirs = ["", "tools", "manifests", "Sources"]
        for dir in dirs {
            let fullPath = (projectDir as NSString).appendingPathComponent(dir)
            if !fm.fileExists(atPath: fullPath) {
                try fm.createDirectory(atPath: fullPath, withIntermediateDirectories: true)
                print("  Created \(dir.isEmpty ? "." : dir)/")
            }
        }

        // Write sample manifest
        let manifest: [String: Any] = [
            "id": projectName,
            "name": projectName,
            "transportType": "local",
            "tools": [
                [
                    "name": "greet",
                    "description": "Greet a user by name",
                    "providerId": projectName,
                    "transportType": "local",
                    "inputSchema": [
                        "type": "object",
                        "properties": [
                            "name": ["type": "string", "description": "Name to greet"],
                        ],
                        "required": ["name"],
                    ],
                ],
                [
                    "name": "echo",
                    "description": "Echo back the provided message",
                    "providerId": projectName,
                    "transportType": "local",
                    "inputSchema": [
                        "type": "object",
                        "properties": [
                            "message": ["type": "string", "description": "Message to echo"],
                        ],
                        "required": ["message"],
                    ],
                ],
            ],
        ]

        let manifestPath = (projectDir as NSString).appendingPathComponent("manifests/\(projectName)-manifest.json")
        if !fm.fileExists(atPath: manifestPath) {
            let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: manifestPath))
            print("  Created \(projectName)-manifest.json")
        }

        // Write config
        let config: [String: Any] = [
            "version": "0.2.0",
            "embedder": "local",
            "manifests": ["./manifests"],
            "output": "tools.toolkit.json",
            "template": template,
        ]

        let configPath = (projectDir as NSString).appendingPathComponent("smallchat.config.json")
        if !fm.fileExists(atPath: configPath) {
            let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: configPath))
            print("  Created smallchat.config.json")
        }

        print("\nProject scaffolded successfully!\n")
        print("Next steps:")
        print("  cd \(directory ?? ".")")
        print("  smallchat compile")
        print("  smallchat resolve tools.toolkit.json \"hello world\"")
        print("")
        print("Template: \(template)")
        print("Run \"smallchat doctor\" to verify your setup.\n")
    }
}
