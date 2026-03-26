public struct ValidationError: Sendable, Codable, Equatable {
    public let path: String
    public let message: String
    public let expected: String?
    public let received: String?

    public init(
        path: String,
        message: String,
        expected: String? = nil,
        received: String? = nil
    ) {
        self.path = path
        self.message = message
        self.expected = expected
        self.received = received
    }
}

public struct ValidationResult: Sendable, Equatable {
    public let valid: Bool
    public let errors: [ValidationError]

    public init(valid: Bool, errors: [ValidationError] = []) {
        self.valid = valid
        self.errors = errors
    }
}
