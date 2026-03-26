import ArgumentParser
import Foundation
import SmallChat

struct CompileCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "compile",
        abstract: "Compile tool definitions from MCP server manifests"
    )

    @Option(name: .shortAndLong, help: "Source directory or manifest file")
    var source: String?

    @Option(name: .shortAndLong, help: "Output file path")
    var output: String = "tools.toolkit.json"

    @Flag(help: "Enable semantic overload generation")
    var semanticOverloads: Bool = false

    @Option(help: "Collision threshold (0.0–1.0)")
    var collisionThreshold: Double = 0.89

    @Option(help: "Deduplication threshold (0.0–1.0)")
    var deduplicationThreshold: Double = 0.95

    func run() async throws {
        let sourcePath = source ?? FileManager.default.currentDirectoryPath
        print("Compiling from \(sourcePath)...")

        // Find manifest files
        let manifests = try loadManifests(from: sourcePath)
        guard !manifests.isEmpty else {
            print("No valid manifests found.")
            throw ExitCode.failure
        }

        print("Found \(manifests.count) manifest(s)")

        // Set up embedder and index
        let embedder = LocalEmbedder()
        let vectorIndex = MemoryVectorIndex()

        let options = CompilerOptions(
            collisionThreshold: collisionThreshold,
            deduplicationThreshold: deduplicationThreshold,
            generateSemanticOverloads: semanticOverloads
        )

        let compiler = ToolCompiler(embedder: embedder, vectorIndex: vectorIndex, options: options)

        let toolCount = manifests.reduce(0) { $0 + $1.tools.count }
        print("\nEmbedding \(toolCount) tools...")
        print("  Model: hash-based (v0.0.1 placeholder)")

        let result = try await compiler.compile(manifests)

        print("  Selectors generated: \(result.toolCount)")
        print("  After dedup (threshold \(deduplicationThreshold)): \(result.uniqueSelectorCount) unique selectors")
        if result.mergedCount > 0 {
            print("  \(result.mergedCount) tools merged as semantically equivalent")
        }

        print("\nLinking...")
        print("  Dispatch tables: \(result.dispatchTables.count)")

        if !result.collisions.isEmpty {
            print("  Selector collisions: \(result.collisions.count)")
            for collision in result.collisions {
                print("    WARNING: \(collision.selectorA) and \(collision.selectorB) (cosine: \(String(format: "%.2f", collision.similarity)))")
                print("      \(collision.hint)")
            }
        }

        // Serialize output
        let artifact = serializeResult(result, manifests: manifests)
        let data = try JSONSerialization.data(withJSONObject: artifact, options: [.prettyPrinted, .sortedKeys])
        let outputURL = URL(fileURLWithPath: output)
        try data.write(to: outputURL)

        print("\nOutput: \(output)")
        print("  - \(result.uniqueSelectorCount) selectors")
        print("  - \(result.toolCount) tools")
        print("  - \(result.dispatchTables.count) providers")
    }

    private func loadManifests(from path: String) throws -> [ProviderManifest] {
        let fm = FileManager.default
        var isDir: ObjCBool = false

        guard fm.fileExists(atPath: path, isDirectory: &isDir) else {
            print("Path not found: \(path)")
            return []
        }

        if isDir.boolValue {
            // Scan directory for JSON files
            guard let enumerator = fm.enumerator(atPath: path) else { return [] }
            var manifests: [ProviderManifest] = []
            while let file = enumerator.nextObject() as? String {
                guard file.hasSuffix(".json") else { continue }
                let fullPath = (path as NSString).appendingPathComponent(file)
                if let manifest = try? loadManifest(from: fullPath) {
                    manifests.append(manifest)
                    print("  \(manifest.id): \(manifest.tools.count) tools")
                }
            }
            return manifests
        } else {
            // Single file
            if let manifest = try? loadManifest(from: path) {
                print("  \(manifest.id): \(manifest.tools.count) tools")
                return [manifest]
            }
            return []
        }
    }

    private func loadManifest(from path: String) throws -> ProviderManifest {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try JSONDecoder().decode(ProviderManifest.self, from: data)
    }

    private func serializeResult(_ result: CompilationResult, manifests: [ProviderManifest]) -> [String: Any] {
        var selectors: [String: Any] = [:]
        for (key, sel) in result.selectors {
            selectors[key] = [
                "canonical": sel.canonical,
                "parts": sel.parts,
                "arity": sel.arity,
                "vector": sel.vector,
            ] as [String: Any]
        }

        var dispatchTables: [String: Any] = [:]
        for (providerId, table) in result.dispatchTables {
            var methods: [String: Any] = [:]
            for (canonical, imp) in table {
                methods[canonical] = [
                    "providerId": imp.providerId,
                    "toolName": imp.toolName,
                    "transportType": imp.transportType.rawValue,
                ] as [String: Any]
            }
            dispatchTables[providerId] = methods
        }

        return [
            "version": "0.2.0",
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "embedding": [
                "model": "hash-based",
                "dimensions": 384,
                "embedderType": "local",
            ],
            "stats": [
                "toolCount": result.toolCount,
                "uniqueSelectorCount": result.uniqueSelectorCount,
                "mergedCount": result.mergedCount,
                "providerCount": result.dispatchTables.count,
                "collisionCount": result.collisions.count,
            ],
            "selectors": selectors,
            "dispatchTables": dispatchTables,
            "collisions": result.collisions.map { c in
                [
                    "selectorA": c.selectorA,
                    "selectorB": c.selectorB,
                    "similarity": c.similarity,
                    "hint": c.hint,
                ] as [String: Any]
            },
        ] as [String: Any]
    }
}
