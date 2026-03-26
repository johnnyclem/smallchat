import Foundation

/// Circuit breaker — stops calling failing transports.
///
/// Implements the three-state circuit breaker pattern:
///   - `closed`   — normal operation, failures are counted
///   - `open`     — all calls rejected immediately
///   - `halfOpen` — one probe call allowed to test recovery
///
/// Transitions:
///   - `closed → open`      when failures reach threshold
///   - `open → halfOpen`    after resetTimeout elapses
///   - `halfOpen → closed`  when successThreshold probe calls succeed
///   - `halfOpen → open`    when a probe call fails
///
/// Actor-isolated for thread safety.
public actor CircuitBreaker {

    /// The three possible circuit states.
    public enum State: String, Sendable {
        case closed
        case open
        case halfOpen = "half-open"
    }

    private let transportId: String
    private let config: CircuitBreakerConfig

    private var state: State = .closed
    private var failureCount: Int = 0
    private var successCount: Int = 0
    private var lastFailureTime: Date = .distantPast

    public init(transportId: String, config: CircuitBreakerConfig = CircuitBreakerConfig()) {
        self.transportId = transportId
        self.config = config
    }

    /// Execute an operation through the circuit breaker.
    ///
    /// Throws `TransportError.circuitOpen` if the circuit is open.
    public func execute<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async throws -> T {
        guard canExecute() else {
            throw TransportError.circuitOpen(transportId: transportId)
        }

        do {
            let result = try await operation()
            onSuccess()
            return result
        } catch {
            onFailure()
            throw error
        }
    }

    /// Get the current circuit state, auto-transitioning from open to halfOpen if needed.
    public func getState() -> State {
        if state == .open {
            let elapsed = Date().timeIntervalSince(lastFailureTime)
            if elapsed >= config.resetTimeout {
                state = .halfOpen
                successCount = 0
            }
        }
        return state
    }

    /// Force reset the circuit to closed state.
    public func reset() {
        state = .closed
        failureCount = 0
        successCount = 0
        lastFailureTime = .distantPast
    }

    /// Get the current failure count.
    public func getFailureCount() -> Int {
        failureCount
    }

    // MARK: - Private

    private func canExecute() -> Bool {
        switch state {
        case .closed:
            return true

        case .open:
            let elapsed = Date().timeIntervalSince(lastFailureTime)
            if elapsed >= config.resetTimeout {
                state = .halfOpen
                successCount = 0
                return true
            }
            return false

        case .halfOpen:
            return true
        }
    }

    private func onSuccess() {
        switch state {
        case .halfOpen:
            successCount += 1
            if successCount >= config.successThreshold {
                state = .closed
                failureCount = 0
                successCount = 0
            }

        case .closed:
            failureCount = 0

        case .open:
            break
        }
    }

    private func onFailure() {
        lastFailureTime = Date()

        switch state {
        case .closed:
            failureCount += 1
            if failureCount >= config.failureThreshold {
                state = .open
            }

        case .halfOpen:
            state = .open
            successCount = 0

        case .open:
            break
        }
    }
}
