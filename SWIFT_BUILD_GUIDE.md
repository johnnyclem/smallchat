# Swift Build Guide: Compiler Hints & `smallchat.json`

This guide covers the remaining work to bring the Swift implementation of smallchat
to full parity with the TypeScript implementation of compiler hints, pre-compiled
vendor packages, and the `smallchat.json` project manifest.

---

## What's Already Done (This PR)

The following Swift files have been **created or modified** and are ready to build:

### New File
| File | What it adds |
|------|-------------|
| `Sources/SmallChatCore/Types/CompilerHint.swift` | `CompilerHint`, `ProviderCompilerHints`, `AnyCodable` types |

### Modified Files
| File | What changed |
|------|-------------|
| `Sources/SmallChatCore/Types/ToolDefinition.swift` | Added `compilerHints: CompilerHint?` property |
| `Sources/SmallChatCore/Types/ProviderManifest.swift` | Added `compilerHints: ProviderCompilerHints?` property |
| `Sources/SmallChatCompiler/Parser.swift` | `ParsedTool` gains `compilerHints`/`providerHints`; added `mergeCompilerHints()` |
| `Sources/SmallChatCompiler/ToolCompiler.swift` | Embed phase uses `selectorHint`, `pinSelector`, `aliases`, `exclude` |

### No Changes Needed
| File | Why |
|------|-----|
| `Package.swift` | No new targets or dependencies required |
| `Sources/SmallChatCore/Types/CompilationResult.swift` | Result struct unchanged — hints are consumed during compile, not emitted in result |
| `Sources/SmallChatCompiler/CompilerOptions.swift` | Options struct unchanged — hints come from manifests, not compiler options |
| `Sources/SmallChatCompiler/SemanticGrouping.swift` | Grouping logic unchanged — operates on embeddings after hints are applied |

---

## Remaining Work

The following items bring the Swift implementation to **full feature parity** with
the TypeScript side. They are listed in dependency order — build bottom-up.

---

### Step 1: `AnyCodable` Refinement

**File:** `Sources/SmallChatCore/Types/CompilerHint.swift`

The current `AnyCodable` uses `NSNull` (Foundation) and raw `Any`. For pure-Swift
platforms (Linux, embedded), consider:

```swift
// Replace NSNull with a sentinel or make value Optional
public struct AnyCodable: Sendable, Codable, Equatable {
    public enum Value: Sendable, Equatable {
        case string(String)
        case int(Int)
        case double(Double)
        case bool(Bool)
        case array([AnyCodable])
        case dictionary([String: AnyCodable])
        case null
    }

    public let value: Value
    // ... Codable conformance based on Value enum
}
```

This eliminates the `Any` type (which can't be `Sendable` in strict concurrency)
and removes the Foundation dependency. The existing implementation works on Darwin
platforms but will produce a Swift 6 strict concurrency warning for `Any`.

**Effort:** ~30 min

---

### Step 2: `SmallChatManifest` Type (the `smallchat.json` Model)

**New file:** `Sources/SmallChatCore/Types/SmallChatManifest.swift`

Port the TypeScript `SmallChatManifest` from `src/core/manifest.ts`:

```swift
import Foundation

/// The project-level manifest (`smallchat.json`).
/// Analogous to `Package.swift` for SPM or `package.json` for Node.
public struct SmallChatManifest: Sendable, Codable {
    public let name: String
    public let version: String
    public let description: String?

    /// Vendor tool package dependencies.
    /// Keys: package names. Values: semver ranges or local file paths.
    public let dependencies: [String: String]?

    /// Local manifest directories/files to include.
    public let manifests: [String]?

    /// Compiler configuration overrides.
    public let compiler: ManifestCompilerConfig?

    /// Output configuration.
    public let output: ManifestOutputConfig?

    /// Provider-level hint overrides, keyed by provider ID.
    public let providerHints: [String: ProviderCompilerHints]?

    /// Tool-level hint overrides, keyed by "providerId.toolName".
    public let toolHints: [String: CompilerHint]?
}

public struct ManifestCompilerConfig: Sendable, Codable {
    public let embedder: String?
    public let deduplicationThreshold: Double?
    public let collisionThreshold: Double?
    public let generateSemanticOverloads: Bool?
    public let semanticOverloadThreshold: Double?
}

public struct ManifestOutputConfig: Sendable, Codable {
    public let path: String?
    public let format: String?   // "json" | "sqlite"
    public let dbPath: String?
}
```

**Where it's used:** The `ToolCompiler.compile()` method should accept an optional
`SmallChatManifest` parameter, matching the TS signature:

```swift
public func compile(
    _ manifests: [ProviderManifest],
    projectManifest: SmallChatManifest? = nil
) async throws -> CompilationResult
```

**Effort:** ~1 hour

---

### Step 3: `applyManifestOverrides()` in Parser

**File:** `Sources/SmallChatCompiler/Parser.swift`

Port the `applyManifestOverrides()` function from the TypeScript parser. This
applies project-level hint overrides from `smallchat.json` onto parsed tools
before compilation:

```swift
/// Apply project-level hint overrides from smallchat.json onto parsed tools.
public func applyManifestOverrides(
    tools: [ParsedTool],
    providerHints: [String: ProviderCompilerHints]?,
    toolHints: [String: CompilerHint]?
) -> [ParsedTool] {
    guard providerHints != nil || toolHints != nil else { return tools }

    return tools.map { tool in
        let providerOverride = providerHints?[tool.providerId]
        let toolKey = "\(tool.providerId).\(tool.name)"
        let toolOverride = toolHints?[toolKey]

        guard providerOverride != nil || toolOverride != nil else { return tool }

        // Re-merge: existing hints + provider override + tool override
        let baseHints = mergeCompilerHints(provider: providerOverride, tool: tool.compilerHints)
        let finalHints: CompilerHint?
        if let toolOverride = toolOverride {
            // Merge base + tool override (tool override wins)
            finalHints = CompilerHint(
                selectorHint: toolOverride.selectorHint ?? baseHints?.selectorHint,
                pinSelector: toolOverride.pinSelector ?? baseHints?.pinSelector,
                aliases: toolOverride.aliases ?? baseHints?.aliases,
                priority: toolOverride.priority ?? baseHints?.priority,
                preferred: toolOverride.preferred ?? baseHints?.preferred,
                exclude: toolOverride.exclude ?? baseHints?.exclude,
                vendorMeta: toolOverride.vendorMeta ?? baseHints?.vendorMeta
            )
        } else {
            finalHints = baseHints
        }

        return ParsedTool(
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            providerId: tool.providerId,
            transportType: tool.transportType,
            arguments: tool.arguments,
            compilerHints: finalHints,
            providerHints: tool.providerHints
        )
    }
}
```

**Effort:** ~30 min

---

### Step 4: Wire `SmallChatManifest` into `ToolCompiler`

**File:** `Sources/SmallChatCompiler/ToolCompiler.swift`

Update `compile()` to accept and apply the project manifest:

```swift
public func compile(
    _ manifests: [ProviderManifest],
    projectManifest: SmallChatManifest? = nil
) async throws -> CompilationResult {
    // Phase 1: PARSE
    var allTools: [ParsedTool] = []
    for manifest in manifests {
        allTools.append(contentsOf: parseMCPManifest(manifest))
    }

    // Apply project-level overrides from smallchat.json
    if let pm = projectManifest {
        allTools = applyManifestOverrides(
            tools: allTools,
            providerHints: pm.providerHints,
            toolHints: pm.toolHints
        )
    }

    // Filter excluded tools (already implemented)
    allTools = allTools.filter { $0.compilerHints?.exclude != true }

    // ... rest of existing compile logic (already updated in this PR)
}
```

**Effort:** ~15 min

---

### Step 5: `SmallChatPackage` Type (Pre-compiled Vendor Format)

**New file:** `Sources/SmallChatCore/Types/SmallChatPackage.swift`

Port from `src/core/manifest.ts`:

```swift
/// A pre-compiled vendor tool package.
/// What gets published to the registry — the vendor has already done
/// the embedding, and the consumer just links it in.
public struct SmallChatPackage: Sendable, Codable {
    public let name: String
    public let version: String
    public let description: String?
    public let author: String?
    public let license: String?
    public let providers: [PreCompiledProvider]

    /// Pre-computed embeddings, keyed by "providerId.toolName".
    public let embeddings: [String: [Float]]?
    public let embeddingModel: String?
    public let embeddingDimensions: Int?
    public let metadata: [String: AnyCodable]?
}

public struct PreCompiledProvider: Sendable, Codable {
    public let id: String
    public let name: String
    public let transportType: TransportType
    public let endpoint: String?
    public let version: String?
    public let compilerHints: ProviderCompilerHints?
    public let tools: [PreCompiledTool]
}

public struct PreCompiledTool: Sendable, Codable {
    public let name: String
    public let description: String
    public let inputSchema: JSONSchemaType
    public let compilerHints: CompilerHint?
}
```

**Effort:** ~30 min

---

### Step 6: `smallchat.json` File Loading

**New file:** `Sources/SmallChatCompiler/ManifestLoader.swift`

Provides discovery and loading of `smallchat.json` and package dependencies:

```swift
import Foundation
import SmallChatCore

/// Find smallchat.json by searching upward from startDir.
public func findSmallChatManifest(from startDir: URL) throws -> (SmallChatManifest, URL)? {
    var dir = startDir.standardized
    let root = URL(fileURLWithPath: "/")

    while dir.path != root.path {
        let candidate = dir.appendingPathComponent("smallchat.json")
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data = try Data(contentsOf: candidate)
            let manifest = try JSONDecoder().decode(SmallChatManifest.self, from: data)
            return (manifest, candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    return nil
}

/// Resolve manifests from smallchat.json dependencies.
public func resolvePackageDependencies(
    manifest: SmallChatManifest,
    baseDir: URL
) throws -> [ProviderManifest] {
    var result: [ProviderManifest] = []

    // Resolve "manifests" array (local directories/files)
    if let paths = manifest.manifests {
        for path in paths {
            let resolved = baseDir.appendingPathComponent(path)
            // Load manifests from directory or file...
            result.append(contentsOf: try loadManifests(from: resolved))
        }
    }

    // Resolve "dependencies" (local file paths for now)
    if let deps = manifest.dependencies {
        for (_, specifier) in deps {
            guard specifier.hasPrefix("./") || specifier.hasPrefix("../") else {
                continue // Registry resolution is future work
            }
            let resolved = baseDir.appendingPathComponent(specifier)
            let data = try Data(contentsOf: resolved)
            // Try as ProviderManifest first, then as SmallChatPackage
            if let manifest = try? JSONDecoder().decode(ProviderManifest.self, from: data) {
                result.append(manifest)
            } else if let pkg = try? JSONDecoder().decode(SmallChatPackage.self, from: data) {
                result.append(contentsOf: pkg.providers.map { provider in
                    ProviderManifest(
                        id: provider.id,
                        name: provider.name,
                        tools: provider.tools.map { tool in
                            ToolDefinition(
                                name: tool.name,
                                description: tool.description,
                                inputSchema: tool.inputSchema,
                                providerId: provider.id,
                                transportType: provider.transportType,
                                compilerHints: tool.compilerHints
                            )
                        },
                        transportType: provider.transportType,
                        endpoint: provider.endpoint,
                        version: provider.version,
                        compilerHints: provider.compilerHints
                    )
                })
            }
        }
    }

    return result
}

/// Load all JSON manifests from a directory (recursive) or single file.
private func loadManifests(from url: URL) throws -> [ProviderManifest] {
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else {
        return []
    }

    if isDir.boolValue {
        let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil)
        var manifests: [ProviderManifest] = []
        while let fileURL = enumerator?.nextObject() as? URL {
            guard fileURL.pathExtension == "json" else { continue }
            if let m = try? JSONDecoder().decode(ProviderManifest.self, from: Data(contentsOf: fileURL)),
               !m.tools.isEmpty {
                manifests.append(m)
            }
        }
        return manifests
    } else {
        let data = try Data(contentsOf: url)
        let manifest = try JSONDecoder().decode(ProviderManifest.self, from: data)
        return [manifest]
    }
}
```

**Effort:** ~1 hour

---

### Step 7: Collision Detection with `preferred` Hints

**File:** `Sources/SmallChatCompiler/ToolCompiler.swift`

The TypeScript compiler generates improved collision hints when a tool is marked
`preferred`. The Swift compiler's collision detection loop (around line 124) should
be updated to match:

```swift
// Inside the collision detection loop:
let aPreferred = isPreferredTool(a.canonical, tools: allTools, selectors: toolSelectors)
let bPreferred = isPreferredTool(b.canonical, tools: allTools, selectors: toolSelectors)

let hint: String
if aPreferred && bPreferred {
    hint = "Warning: both \"\(a.canonical)\" and \"\(b.canonical)\" are marked preferred — only one should be."
} else if aPreferred {
    hint = "\"\(a.canonical)\" is preferred (compiler hint) over \"\(b.canonical)\" (\(String(format: "%.1f", similarity * 100))% similar)."
} else if bPreferred {
    hint = "\"\(b.canonical)\" is preferred (compiler hint) over \"\(a.canonical)\" (\(String(format: "%.1f", similarity * 100))% similar)."
} else {
    hint = "Disambiguation needed: \"\(a.canonical)\" and \"\(b.canonical)\" are similar (\(String(format: "%.1f", similarity * 100))%)."
}
```

Add the helper:

```swift
private func isPreferredTool(
    _ canonical: String,
    tools: [ParsedTool],
    selectors: [Int: ToolSelector]
) -> Bool {
    for (i, tool) in tools.enumerated() {
        if selectors[i]?.canonical == canonical && tool.compilerHints?.preferred == true {
            return true
        }
    }
    return false
}
```

Also skip alias canonicals in collision detection (matching TS behavior):

```swift
// Build alias canonical set before the collision loop
let aliasCanonicals = Set(aliasSelectors.values.flatMap { $0.map(\.canonical) })

// Inside the loop, add:
if aliasCanonicals.contains(a.canonical) || aliasCanonicals.contains(b.canonical) {
    continue
}
```

**Effort:** ~30 min

---

### Step 8: Serialized Artifact with Hints

**New file:** `Sources/SmallChatMCP/SerializedArtifact.swift` (or update existing if present)

The artifact serialization should include compiler hints so they survive
round-tripping through the compiled `.json` or `.db` format:

```swift
public struct SerializedArtifact: Sendable, Codable {
    public let version: String
    public let stats: ArtifactStats
    public let selectors: [String: SerializedSelector]
    public let dispatchTables: [String: [String: SerializedIMP]]
    public let providerHints: [String: ProviderCompilerHints]?
}

public struct SerializedIMP: Sendable, Codable {
    public let providerId: String
    public let toolName: String
    public let transportType: String
    public let inputSchema: JSONSchemaType?
    public let compilerHints: CompilerHint?
}
```

**Effort:** ~1 hour

---

### Step 9: CLI Integration

**New file:** `Sources/SmallChatCLI/CompileCommand.swift`

The CLI executable target doesn't have implementation files yet. When building
out the CLI, the `compile` command should:

1. Auto-discover `smallchat.json` in the working directory
2. Use `ManifestCompilerConfig` to set compiler options
3. Use `ManifestOutputConfig` to set output path/format
4. Resolve dependencies via `resolvePackageDependencies()`
5. Pass the manifest to `compiler.compile(manifests, projectManifest:)`

```swift
import ArgumentParser
import SmallChat

struct CompileCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "compile",
        abstract: "Compile tool manifests into a dispatch artifact"
    )

    @Option(name: .shortAndLong, help: "Source directory or MCP config file")
    var source: String?

    @Option(name: .shortAndLong, help: "Output file path")
    var output: String = "tools.toolkit.json"

    func run() async throws {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

        // Find smallchat.json
        let projectResult = try findSmallChatManifest(from: cwd)
        let projectManifest = projectResult?.0

        // Apply config overrides from smallchat.json
        let embedder = LocalEmbedder()
        let vectorIndex = MemoryVectorIndex()
        let compiler = ToolCompiler(embedder: embedder, vectorIndex: vectorIndex)

        // Resolve manifests
        var manifests: [ProviderManifest] = []
        // ... source resolution logic ...

        if let pm = projectManifest, let pmURL = projectResult?.1 {
            let baseDir = pmURL.deletingLastPathComponent()
            manifests += try resolvePackageDependencies(manifest: pm, baseDir: baseDir)
        }

        let result = try await compiler.compile(manifests, projectManifest: projectManifest)
        // ... serialize and write output ...
    }
}
```

**Effort:** ~2 hours (full CLI scaffolding)

---

### Step 10: Tests

**New file:** `Tests/SmallChatCompilerTests/CompilerHintTests.swift`

```swift
import XCTest
@testable import SmallChatCore
@testable import SmallChatCompiler
@testable import SmallChatEmbedding

final class CompilerHintTests: XCTestCase {

    // MARK: - Hint Merging

    func testToolHintOverridesProviderHint() {
        let provider = ProviderCompilerHints(priority: 0.5, selectorHint: "provider context")
        let tool = CompilerHint(priority: 1.5)

        let merged = mergeCompilerHints(provider: provider, tool: tool)

        XCTAssertEqual(merged?.priority, 1.5)           // tool wins
        XCTAssertEqual(merged?.selectorHint, "provider context") // inherited
    }

    func testProviderHintPromotedWhenNoToolHint() {
        let provider = ProviderCompilerHints(priority: 0.8, selectorHint: "context")
        let merged = mergeCompilerHints(provider: provider, tool: nil)

        XCTAssertEqual(merged?.priority, 0.8)
        XCTAssertEqual(merged?.selectorHint, "context")
    }

    func testBothNilReturnsNil() {
        XCTAssertNil(mergeCompilerHints(provider: nil, tool: nil))
    }

    // MARK: - Exclusion

    func testExcludedToolsFilteredDuringCompile() async throws {
        let manifest = ProviderManifest(
            id: "test",
            name: "Test",
            tools: [
                ToolDefinition(
                    name: "active_tool",
                    description: "An active tool",
                    inputSchema: JSONSchemaType(type: "object"),
                    providerId: "test",
                    transportType: .local
                ),
                ToolDefinition(
                    name: "excluded_tool",
                    description: "A deprecated tool",
                    inputSchema: JSONSchemaType(type: "object"),
                    providerId: "test",
                    transportType: .local,
                    compilerHints: CompilerHint(exclude: true)
                ),
            ],
            transportType: .local
        )

        let embedder = LocalEmbedder()
        let index = MemoryVectorIndex()
        let compiler = ToolCompiler(embedder: embedder, vectorIndex: index)
        let result = try await compiler.compile([manifest])

        XCTAssertEqual(result.toolCount, 1)
    }

    // MARK: - Selector Hint Steering

    func testSelectorHintAppendsToEmbeddingText() {
        let manifest = ProviderManifest(
            id: "test",
            name: "Test",
            tools: [
                ToolDefinition(
                    name: "search",
                    description: "Search things",
                    inputSchema: JSONSchemaType(type: "object"),
                    providerId: "test",
                    transportType: .local,
                    compilerHints: CompilerHint(
                        selectorHint: "This searches files not databases"
                    )
                ),
            ],
            transportType: .local
        )

        let parsed = parseMCPManifest(manifest)
        XCTAssertEqual(parsed[0].compilerHints?.selectorHint, "This searches files not databases")
    }

    // MARK: - Namespace

    func testProviderNamespacePrefixesCanonical() {
        let manifest = ProviderManifest(
            id: "github",
            name: "GitHub",
            tools: [
                ToolDefinition(
                    name: "search_code",
                    description: "Search code",
                    inputSchema: JSONSchemaType(type: "object"),
                    providerId: "github",
                    transportType: .mcp
                ),
            ],
            transportType: .mcp,
            compilerHints: ProviderCompilerHints(namespace: "vcs.github")
        )

        let parsed = parseMCPManifest(manifest)
        XCTAssertNotNil(parsed[0].providerHints?.namespace)
        XCTAssertEqual(parsed[0].providerHints?.namespace, "vcs.github")
    }

    // MARK: - Aliases

    func testAliasesCreateAdditionalSelectors() async throws {
        let manifest = ProviderManifest(
            id: "test",
            name: "Test",
            tools: [
                ToolDefinition(
                    name: "greet",
                    description: "Greet a user",
                    inputSchema: JSONSchemaType(type: "object"),
                    providerId: "test",
                    transportType: .local,
                    compilerHints: CompilerHint(
                        aliases: ["say hello", "welcome"]
                    )
                ),
            ],
            transportType: .local
        )

        let embedder = LocalEmbedder()
        let index = MemoryVectorIndex()
        let compiler = ToolCompiler(embedder: embedder, vectorIndex: index)
        let result = try await compiler.compile([manifest])

        // 1 tool + 2 aliases = 3 selectors
        XCTAssertEqual(result.uniqueSelectorCount, 3)
        // But only 1 actual tool
        XCTAssertEqual(result.toolCount, 1)
    }

    // MARK: - Pin Selector

    func testPinSelectorForcesCanonical() async throws {
        let manifest = ProviderManifest(
            id: "test",
            name: "Test",
            tools: [
                ToolDefinition(
                    name: "my_tool",
                    description: "A tool",
                    inputSchema: JSONSchemaType(type: "object"),
                    providerId: "test",
                    transportType: .local,
                    compilerHints: CompilerHint(pinSelector: "custom.pinned_name")
                ),
            ],
            transportType: .local
        )

        let embedder = LocalEmbedder()
        let index = MemoryVectorIndex()
        let compiler = ToolCompiler(embedder: embedder, vectorIndex: index)
        let result = try await compiler.compile([manifest])

        XCTAssertTrue(result.selectors.keys.contains("custom.pinned_name"))
        XCTAssertFalse(result.selectors.keys.contains("test.my_tool"))
    }

    // MARK: - Codable Round-Trip

    func testCompilerHintCodableRoundTrip() throws {
        let hint = CompilerHint(
            selectorHint: "file I/O",
            pinSelector: "fs.read",
            aliases: ["read file", "open file"],
            priority: 1.5,
            preferred: true,
            exclude: false
        )

        let data = try JSONEncoder().encode(hint)
        let decoded = try JSONDecoder().decode(CompilerHint.self, from: data)

        XCTAssertEqual(hint, decoded)
    }

    func testProviderHintsCodableRoundTrip() throws {
        let hints = ProviderCompilerHints(
            priority: 1.1,
            namespace: "vcs.github",
            selectorHint: "GitHub tools"
        )

        let data = try JSONEncoder().encode(hints)
        let decoded = try JSONDecoder().decode(ProviderCompilerHints.self, from: data)

        XCTAssertEqual(hints, decoded)
    }

    // MARK: - SmallChatManifest Loading

    func testSmallChatManifestDecoding() throws {
        let json = """
        {
            "name": "my-agent",
            "version": "1.0.0",
            "manifests": ["./manifests"],
            "compiler": {
                "embedder": "onnx",
                "deduplicationThreshold": 0.95
            },
            "providerHints": {
                "github": {
                    "namespace": "vcs.github",
                    "priority": 1.1
                }
            },
            "toolHints": {
                "github.search_code": {
                    "aliases": ["find code"],
                    "preferred": true
                }
            }
        }
        """.data(using: .utf8)!

        let manifest = try JSONDecoder().decode(SmallChatManifest.self, from: json)

        XCTAssertEqual(manifest.name, "my-agent")
        XCTAssertEqual(manifest.providerHints?["github"]?.namespace, "vcs.github")
        XCTAssertEqual(manifest.toolHints?["github.search_code"]?.preferred, true)
    }
}
```

**Effort:** ~1.5 hours

---

## Build & Test Commands

```bash
# Build the entire package
swift build

# Build only the targets affected by this feature
swift build --target SmallChatCore
swift build --target SmallChatCompiler

# Run all tests
swift test

# Run only compiler hint tests
swift test --filter CompilerHintTests

# Build for release
swift build -c release
```

---

## Module Dependency Graph (for this feature)

```
SmallChatCore
  ├── CompilerHint.swift          ← NEW (this PR)
  ├── ToolDefinition.swift        ← MODIFIED (this PR)
  ├── ProviderManifest.swift      ← MODIFIED (this PR)
  ├── SmallChatManifest.swift     ← TODO (Step 2)
  └── SmallChatPackage.swift      ← TODO (Step 5)

SmallChatCompiler (depends on SmallChatCore)
  ├── Parser.swift                ← MODIFIED (this PR) + Step 3
  ├── ToolCompiler.swift          ← MODIFIED (this PR) + Steps 4, 7
  ├── ManifestLoader.swift        ← TODO (Step 6)
  ├── CompilerOptions.swift       (no changes)
  └── SemanticGrouping.swift      (no changes)

SmallChatMCP (depends on SmallChatCore, SmallChatRuntime, SmallChatTransport)
  └── SerializedArtifact.swift    ← TODO (Step 8)

SmallChatCLI (depends on SmallChat umbrella)
  └── CompileCommand.swift        ← TODO (Step 9)

Tests/SmallChatCompilerTests
  └── CompilerHintTests.swift     ← TODO (Step 10)
```

---

## Summary of Effort

| Step | Description | Effort | Priority |
|------|-------------|--------|----------|
| 1 | `AnyCodable` refinement (strict concurrency) | 30 min | Medium |
| 2 | `SmallChatManifest` type | 1 hr | **High** |
| 3 | `applyManifestOverrides()` in Parser | 30 min | **High** |
| 4 | Wire manifest into `ToolCompiler.compile()` | 15 min | **High** |
| 5 | `SmallChatPackage` type | 30 min | Medium |
| 6 | `ManifestLoader` (file discovery) | 1 hr | **High** |
| 7 | Collision detection with `preferred` | 30 min | Medium |
| 8 | Serialized artifact with hints | 1 hr | Medium |
| 9 | CLI `compile` command | 2 hr | Low (CLI not scaffolded yet) |
| 10 | Tests | 1.5 hr | **High** |

**Total estimated:** ~8.5 hours

**Critical path (must-do for feature to work):** Steps 2 → 3 → 4 → 6 → 10 (~4.25 hours)
