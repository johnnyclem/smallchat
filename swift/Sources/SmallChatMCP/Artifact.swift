// MARK: - Artifact — Compiled tool artifact serialization

import Foundation
import SmallChatCore

// MARK: - Serialized Artifact

/// A compiled tool artifact that can be saved to and loaded from disk.
///
/// Contains the full state needed to hydrate a ToolRuntime:
/// selectors with their embedding vectors and dispatch tables
/// mapping providers to tool implementations.
public struct SerializedArtifact: Sendable, Codable {
    public let version: String
    public let stats: ArtifactStats
    public let selectors: [String: SelectorData]
    public let dispatchTables: [String: [String: DispatchEntry]]

    public init(
        version: String = "0.1.0",
        stats: ArtifactStats,
        selectors: [String: SelectorData],
        dispatchTables: [String: [String: DispatchEntry]]
    ) {
        self.version = version
        self.stats = stats
        self.selectors = selectors
        self.dispatchTables = dispatchTables
    }
}

/// Summary statistics for a compiled artifact.
public struct ArtifactStats: Sendable, Codable {
    public let toolCount: Int
    public let uniqueSelectorCount: Int
    public let providerCount: Int
    public let collisionCount: Int

    public init(
        toolCount: Int,
        uniqueSelectorCount: Int,
        providerCount: Int,
        collisionCount: Int
    ) {
        self.toolCount = toolCount
        self.uniqueSelectorCount = uniqueSelectorCount
        self.providerCount = providerCount
        self.collisionCount = collisionCount
    }
}

/// Serialized selector with its embedding vector and metadata.
public struct SelectorData: Sendable, Codable {
    public let canonical: String
    public let parts: [String]
    public let arity: Int
    public let vector: [Float]

    public init(canonical: String, parts: [String], arity: Int, vector: [Float]) {
        self.canonical = canonical
        self.parts = parts
        self.arity = arity
        self.vector = vector
    }
}

/// A single entry in a dispatch table mapping a selector to a tool implementation.
public struct DispatchEntry: Sendable, Codable {
    public let providerId: String
    public let toolName: String
    public let transportType: String
    public let inputSchema: [String: AnyCodableValue]?

    public init(
        providerId: String,
        toolName: String,
        transportType: String,
        inputSchema: [String: AnyCodableValue]? = nil
    ) {
        self.providerId = providerId
        self.toolName = toolName
        self.transportType = transportType
        self.inputSchema = inputSchema
    }
}

// MARK: - Artifact Persistence

/// Save and load compiled artifacts from disk.
public enum ArtifactIO {

    /// Save an artifact to a JSON file.
    public static func save(_ artifact: SerializedArtifact, to path: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(artifact)
        let url = URL(fileURLWithPath: path)
        try data.write(to: url)
    }

    /// Load an artifact from a JSON file.
    public static func load(from path: String) throws -> SerializedArtifact {
        let url = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(SerializedArtifact.self, from: data)
    }
}

// MARK: - Tool List Builder

/// Build a flat tool list from a serialized artifact (for MCP tools/list).
public func buildToolList(_ artifact: SerializedArtifact) -> [[String: AnyCodableValue]] {
    var tools: [[String: AnyCodableValue]] = []

    for (_, methods) in artifact.dispatchTables {
        for (canonical, entry) in methods {
            let inputSchema: AnyCodableValue
            if let schema = entry.inputSchema {
                inputSchema = .dict(schema)
            } else {
                inputSchema = .dict([
                    "type": .string("object"),
                    "properties": .dict([:]),
                ])
            }

            tools.append([
                "name": .string(entry.toolName),
                "description": .string("\(canonical) [\(entry.providerId)]"),
                "inputSchema": inputSchema,
            ])
        }
    }

    return tools
}

/// Format a ToolResult's content for MCP response format.
public func formatContent(_ result: ToolResult) -> [[String: AnyCodableValue]] {
    let text: String
    if let content = result.content as? String {
        text = content
    } else if let content = result.content {
        // Attempt to serialize to JSON
        text = String(describing: content)
    } else {
        text = ""
    }
    return [["type": .string("text"), "text": .string(text)]]
}

// MARK: - Artifact Builder

/// Build a SerializedArtifact from a CompilationResult and manifests.
public func buildArtifact(
    result: CompilationResult,
    manifests: [ProviderManifest]
) -> SerializedArtifact {
    // Build schema index from manifests
    var schemaIndex: [String: [String: AnyCodableValue]] = [:]
    for manifest in manifests {
        for tool in manifest.tools {
            // Convert JSONSchemaType to AnyCodableValue dict
            if let data = try? JSONEncoder().encode(tool.inputSchema),
               let dict = try? JSONDecoder().decode([String: AnyCodableValue].self, from: data) {
                schemaIndex[tool.name] = dict
            }
        }
    }

    // Build selectors
    var selectors: [String: SelectorData] = [:]
    for (key, sel) in result.selectors {
        selectors[key] = SelectorData(
            canonical: sel.canonical,
            parts: sel.parts,
            arity: sel.arity,
            vector: Array(sel.vector)
        )
    }

    // Build dispatch tables
    var dispatchTables: [String: [String: DispatchEntry]] = [:]
    for (providerId, table) in result.dispatchTables {
        var methods: [String: DispatchEntry] = [:]
        for (canonical, imp) in table {
            methods[canonical] = DispatchEntry(
                providerId: imp.providerId,
                toolName: imp.toolName,
                transportType: imp.transportType.rawValue,
                inputSchema: schemaIndex[imp.toolName]
            )
        }
        dispatchTables[providerId] = methods
    }

    return SerializedArtifact(
        version: "0.1.0",
        stats: ArtifactStats(
            toolCount: result.toolCount,
            uniqueSelectorCount: result.uniqueSelectorCount,
            providerCount: result.dispatchTables.count,
            collisionCount: result.collisions.count
        ),
        selectors: selectors,
        dispatchTables: dispatchTables
    )
}
