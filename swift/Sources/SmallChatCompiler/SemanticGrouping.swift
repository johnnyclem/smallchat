import SmallChatCore

/// Internal representation of a semantic group during compilation
struct SemanticGroup {
    let tools: [ParsedTool]
    let similarities: [Double]  // similarity of tool[i] to tool[0] for i > 0
}

/// Find groups of semantically similar tools using Union-Find
func findSemanticGroups(
    tools: [ParsedTool],
    embeddings: [Int: [Float]],  // tool index -> embedding
    threshold: Double
) -> [SemanticGroup] {
    let n = tools.count
    guard n >= 2 else { return [] }

    // Union-Find
    var parent = Array(0..<n)
    var rank = [Int](repeating: 0, count: n)

    func find(_ x: Int) -> Int {
        var x = x
        while parent[x] != x {
            parent[x] = parent[parent[x]]  // path compression
            x = parent[x]
        }
        return x
    }

    func union(_ a: Int, _ b: Int) {
        let ra = find(a), rb = find(b)
        guard ra != rb else { return }
        if rank[ra] < rank[rb] { parent[ra] = rb }
        else if rank[ra] > rank[rb] { parent[rb] = ra }
        else { parent[rb] = ra; rank[ra] += 1 }
    }

    // Pairwise similarity check
    var similarities: [String: Double] = [:]
    for i in 0..<n {
        for j in (i + 1)..<n {
            guard let vecA = embeddings[i], let vecB = embeddings[j] else { continue }
            let sim = Double(cosineSimilarity(vecA, vecB))
            if sim >= threshold {
                union(i, j)
                similarities["\(i):\(j)"] = sim
            }
        }
    }

    // Collect groups (only groups with 2+ tools)
    var groupMap: [Int: [Int]] = [:]
    for i in 0..<n {
        let root = find(i)
        groupMap[root, default: []].append(i)
    }

    var groups: [SemanticGroup] = []
    for indices in groupMap.values {
        guard indices.count >= 2 else { continue }

        // Ensure different signatures
        let sigSet = Set(indices.map { i -> String in
            let slots = toolArgsToParameterSlots(tools[i])
            return createSignature(slots).signatureKey
        })
        guard sigSet.count >= 2 else { continue }

        let groupTools = indices.map { tools[$0] }
        let sims = indices.dropFirst().map { i -> Double in
            let key = "\(indices[0]):\(i)"
            let reverseKey = "\(i):\(indices[0])"
            return similarities[key] ?? similarities[reverseKey] ?? 0
        }

        groups.append(SemanticGroup(tools: groupTools, similarities: sims))
    }

    return groups
}

/// Convert a ParsedTool's arguments to SCParameterSlots
func toolArgsToParameterSlots(_ tool: ParsedTool) -> [SCParameterSlot] {
    tool.arguments.enumerated().map { index, arg in
        param(arg.name, index, jsonSchemaTypeToSCType(arg.type), required: arg.required, defaultValue: nil)
    }
}

/// Convert a JSONSchemaType to an SCTypeDescriptor
func jsonSchemaTypeToSCType(_ schema: JSONSchemaType) -> SCTypeDescriptor {
    switch schema.type {
    case "string": return .primitive(.string)
    case "number", "integer": return .primitive(.number)
    case "boolean": return .primitive(.boolean)
    case "null": return .primitive(.null)
    case "object": return .object(className: "SCData")
    case "array": return .object(className: "SCArray")
    default: return .any
    }
}
