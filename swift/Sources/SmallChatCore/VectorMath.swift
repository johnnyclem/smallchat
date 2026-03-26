import Foundation
import Accelerate

public func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
    precondition(a.count == b.count, "Vector dimension mismatch: \(a.count) vs \(b.count)")
    guard !a.isEmpty else { return 0 }

    var dot: Float = 0
    var normA: Float = 0
    var normB: Float = 0

    vDSP_dotpr(a, 1, b, 1, &dot, vDSP_Length(a.count))
    vDSP_dotpr(a, 1, a, 1, &normA, vDSP_Length(a.count))
    vDSP_dotpr(b, 1, b, 1, &normB, vDSP_Length(b.count))

    let denom = sqrtf(normA) * sqrtf(normB)
    return denom == 0 ? 0 : dot / denom
}

public func l2Normalize(_ vector: inout [Float]) {
    var norm: Float = 0
    vDSP_dotpr(vector, 1, vector, 1, &norm, vDSP_Length(vector.count))
    norm = sqrtf(norm)
    guard norm > 0 else { return }
    var divisor = norm
    vDSP_vsdiv(vector, 1, &divisor, &vector, 1, vDSP_Length(vector.count))
}
