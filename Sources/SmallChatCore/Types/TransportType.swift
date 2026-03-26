public enum TransportType: String, Sendable, Codable, CaseIterable {
    case mcp
    case rest
    case local
    case grpc
}
