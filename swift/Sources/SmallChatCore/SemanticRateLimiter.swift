import Foundation

public struct SemanticRateLimiterOptions: Sendable {
    public var windowMs: Int
    public var maxNovelIntents: Int
    public var similarityFloor: Float
    public var minSamplesForSimilarity: Int
    public var maxCanonicalLength: Int
    public var entropyFraction: Double

    public init(
        windowMs: Int = 60_000,
        maxNovelIntents: Int = 100,
        similarityFloor: Float = 0.3,
        minSamplesForSimilarity: Int = 10,
        maxCanonicalLength: Int = 200,
        entropyFraction: Double = 0.5
    ) {
        self.windowMs = windowMs
        self.maxNovelIntents = maxNovelIntents
        self.similarityFloor = similarityFloor
        self.minSamplesForSimilarity = minSamplesForSimilarity
        self.maxCanonicalLength = maxCanonicalLength
        self.entropyFraction = entropyFraction
    }
}

public struct FloodingMetrics: Sendable {
    public let novelCount: Int
    public let averageSimilarity: Float
    public let highEntropyFraction: Double
    public let throttled: Bool
    public let windowResetsIn: Int  // milliseconds

    public init(
        novelCount: Int,
        averageSimilarity: Float,
        highEntropyFraction: Double,
        throttled: Bool,
        windowResetsIn: Int
    ) {
        self.novelCount = novelCount
        self.averageSimilarity = averageSimilarity
        self.highEntropyFraction = highEntropyFraction
        self.throttled = throttled
        self.windowResetsIn = windowResetsIn
    }
}

/// Prevents "Vector Flooding" DoS attacks on the embedder.
///
/// Monitors the stream of intents flowing through the Resolution Cache.
/// When it detects a burst of high-entropy, low-similarity intents -- the
/// signature of an attacker probing random garbage to exhaust the embedder
/// -- it throttles further embedding requests.
public actor SemanticRateLimiter {
    private struct WindowEntry {
        let timestamp: Date
        let vector: [Float]
        let canonicalLength: Int
    }

    private let options: SemanticRateLimiterOptions
    private var window: [WindowEntry] = []
    private var pairwiseSimilaritySum: Float = 0
    private var pairwiseCount: Int = 0

    public init(options: SemanticRateLimiterOptions = .init()) {
        self.options = options
    }

    /// Pre-embedding check. Returns true if allowed, false if throttled.
    public func check(_ canonical: String) -> Bool {
        evictStale()

        // Hard volume cap -- too many novel intents regardless of similarity
        if window.count >= options.maxNovelIntents {
            return false
        }

        // Entropy check -- if too many recent intents look like gibberish, throttle
        if window.count >= options.minSamplesForSimilarity {
            let highEntropyCount = window.filter {
                $0.canonicalLength > options.maxCanonicalLength
            }.count
            let fraction = Double(highEntropyCount) / Double(window.count)
            if fraction >= options.entropyFraction {
                return false
            }
        }

        return true
    }

    /// Post-embedding record. Stores vector for similarity analysis.
    public func record(_ canonical: String, _ vector: [Float]) {
        evictStale()

        let entry = WindowEntry(
            timestamp: Date(),
            vector: vector,
            canonicalLength: canonical.count
        )

        // Update incremental pairwise similarity with all existing entries
        for existing in window {
            let sim = cosineSimilarity(vector, existing.vector)
            pairwiseSimilaritySum += sim
            pairwiseCount += 1
        }

        window.append(entry)
    }

    /// Post-embedding similarity check. Returns true if traffic looks healthy.
    public func checkSimilarity() -> Bool {
        if window.count < options.minSamplesForSimilarity {
            return true  // Not enough data to judge
        }

        let avgSimilarity: Float = pairwiseCount > 0
            ? pairwiseSimilaritySum / Float(pairwiseCount)
            : 1.0

        return avgSimilarity >= options.similarityFloor
    }

    /// Get current flooding metrics.
    public func getMetrics() -> FloodingMetrics {
        evictStale()

        let avgSimilarity: Float = pairwiseCount > 0
            ? pairwiseSimilaritySum / Float(pairwiseCount)
            : 1.0

        let highEntropyCount = window.filter {
            $0.canonicalLength > options.maxCanonicalLength
        }.count

        let now = Date()
        let oldestTimestamp = window.first?.timestamp ?? now
        let windowResetsIn = max(
            0,
            Int((oldestTimestamp.timeIntervalSince1970 + Double(options.windowMs) / 1000.0 - now.timeIntervalSince1970) * 1000)
        )

        let throttled = !checkAllowed() || !checkSimilarity()

        return FloodingMetrics(
            novelCount: window.count,
            averageSimilarity: avgSimilarity,
            highEntropyFraction: window.count > 0
                ? Double(highEntropyCount) / Double(window.count)
                : 0,
            throttled: throttled,
            windowResetsIn: windowResetsIn
        )
    }

    /// Reset all state.
    public func reset() {
        window = []
        pairwiseSimilaritySum = 0
        pairwiseCount = 0
    }

    /// Internal check for getMetrics to avoid side effects from check(_:) which calls evictStale.
    private func checkAllowed() -> Bool {
        if window.count >= options.maxNovelIntents {
            return false
        }

        if window.count >= options.minSamplesForSimilarity {
            let highEntropyCount = window.filter {
                $0.canonicalLength > options.maxCanonicalLength
            }.count
            let fraction = Double(highEntropyCount) / Double(window.count)
            if fraction >= options.entropyFraction {
                return false
            }
        }

        return true
    }

    /// Evict entries older than the sliding window.
    private func evictStale() {
        let cutoff = Date().addingTimeInterval(-Double(options.windowMs) / 1000.0)

        while !window.isEmpty && window[0].timestamp < cutoff {
            let removed = window.removeFirst()

            // Subtract pairwise similarities involving the evicted entry
            for remaining in window {
                let sim = cosineSimilarity(removed.vector, remaining.vector)
                pairwiseSimilaritySum -= sim
                pairwiseCount -= 1
            }
        }
    }
}
