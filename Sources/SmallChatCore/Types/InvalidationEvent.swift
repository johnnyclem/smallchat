public enum InvalidationEvent: Sendable {
    case flush
    case provider(providerId: String)
    case selector(ToolSelector)
    case stale(reason: StaleReason, key: String)

    public enum StaleReason: String, Sendable {
        case providerVersion = "provider-version"
        case modelVersion = "model-version"
        case schemaChange = "schema-change"
    }
}

public typealias InvalidationHook = @Sendable (InvalidationEvent) -> Void
