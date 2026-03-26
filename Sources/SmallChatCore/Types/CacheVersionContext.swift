public struct CacheVersionContext: Sendable {
    public var providerVersions: [String: String]
    public var modelVersion: String
    public var schemaFingerprints: [String: String]

    public init(
        providerVersions: [String: String] = [:],
        modelVersion: String = "",
        schemaFingerprints: [String: String] = [:]
    ) {
        self.providerVersions = providerVersions
        self.modelVersion = modelVersion
        self.schemaFingerprints = schemaFingerprints
    }
}
