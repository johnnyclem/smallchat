import Foundation
import SmallChatCore

/// Generates HTTP transport configurations and tool definitions from OpenAPI 3.x specs.
///
/// Mirrors the TypeScript `openapi-generator.ts` module.
public enum OpenAPIImporter {

    // MARK: - OpenAPI Types

    /// A parsed OpenAPI specification.
    public struct OpenAPISpec: Codable, Sendable {
        public let openapi: String
        public let info: Info
        public let servers: [Server]?
        public let paths: [String: PathItem]?
        public let components: Components?

        public struct Info: Codable, Sendable {
            public let title: String
            public let version: String
            public let description: String?
        }

        public struct Server: Codable, Sendable {
            public let url: String
            public let description: String?
        }

        public struct Components: Codable, Sendable {
            public let schemas: [String: SchemaObject]?
            public let securitySchemes: [String: SecurityScheme]?
        }

        public struct SecurityScheme: Codable, Sendable {
            public let type: String
            public let scheme: String?
            public let bearerFormat: String?
            public let name: String?
            public let `in`: String?
            public let flows: OAuthFlows?

            public struct OAuthFlows: Codable, Sendable {
                public let clientCredentials: ClientCredentialsFlow?

                public struct ClientCredentialsFlow: Codable, Sendable {
                    public let tokenUrl: String
                    public let scopes: [String: String]?
                }
            }
        }
    }

    public struct PathItem: Codable, Sendable {
        public let get: Operation?
        public let post: Operation?
        public let put: Operation?
        public let delete: Operation?
        public let patch: Operation?
        public let head: Operation?
        public let options: Operation?
        public let parameters: [Parameter]?
    }

    public struct Operation: Codable, Sendable {
        public let operationId: String?
        public let summary: String?
        public let description: String?
        public let parameters: [Parameter]?
        public let requestBody: RequestBody?
        public let tags: [String]?
    }

    public struct Parameter: Codable, Sendable {
        public let name: String
        public let `in`: String
        public let description: String?
        public let required: Bool?
        public let schema: SchemaObject?
    }

    public struct RequestBody: Codable, Sendable {
        public let content: [String: MediaType]?
        public let required: Bool?

        public struct MediaType: Codable, Sendable {
            public let schema: SchemaObject?
        }
    }

    public struct SchemaObject: Codable, Sendable {
        public let type: String?
        public let description: String?
        public let properties: [String: SchemaObject]?
        public let required: [String]?
        public let items: SchemaObject?
        public let `enum`: [String]?
        public let `default`: String?
        public let format: String?
        public let ref: String?

        enum CodingKeys: String, CodingKey {
            case type, description, properties, required, items
            case `enum`, `default`, format
            case ref = "$ref"
        }
    }

    // MARK: - Generated Config

    /// Generated HTTP transport configuration from an OpenAPI spec.
    public struct GeneratedConfig: Sendable {
        public let baseURL: String
        public let routes: [HTTPTransportRoute]
        public let auth: (any AuthStrategy)?
    }

    // MARK: - Generation Options

    public struct GenerationOptions: Sendable {
        public let baseURL: String?
        public let bearerToken: String?
        public let filterTags: [String]?
        public let filterOperationIds: [String]?

        public init(
            baseURL: String? = nil,
            bearerToken: String? = nil,
            filterTags: [String]? = nil,
            filterOperationIds: [String]? = nil
        ) {
            self.baseURL = baseURL
            self.bearerToken = bearerToken
            self.filterTags = filterTags
            self.filterOperationIds = filterOperationIds
        }
    }

    // MARK: - Generate Config

    /// Generate HTTP transport configuration from an OpenAPI spec.
    public static func generateConfig(
        from spec: OpenAPISpec,
        options: GenerationOptions = GenerationOptions()
    ) -> GeneratedConfig {
        let baseURL = options.baseURL ?? spec.servers?.first?.url ?? "http://localhost"
        var routes: [HTTPTransportRoute] = []
        var auth: (any AuthStrategy)?

        if let token = options.bearerToken {
            auth = BearerTokenAuth(token: token)
        }

        let methods: [(String, KeyPath<PathItem, Operation?>)] = [
            ("GET", \.get), ("POST", \.post), ("PUT", \.put),
            ("DELETE", \.delete), ("PATCH", \.patch),
            ("HEAD", \.head), ("OPTIONS", \.options),
        ]

        for (path, pathItem) in spec.paths ?? [:] {
            let pathParams = pathItem.parameters ?? []

            for (methodStr, keyPath) in methods {
                guard let operation = pathItem[keyPath: keyPath] else { continue }

                // Apply tag filter
                if let filterTags = options.filterTags, !filterTags.isEmpty {
                    let tags = operation.tags ?? []
                    if !tags.contains(where: { filterTags.contains($0) }) { continue }
                }

                // Apply operation ID filter
                if let filterIds = options.filterOperationIds, !filterIds.isEmpty {
                    guard let opId = operation.operationId, filterIds.contains(opId) else { continue }
                }

                let toolName = operation.operationId ?? generateToolName(method: methodStr, path: path)
                let allParams = pathParams + (operation.parameters ?? [])
                let pathParamNames = allParams.filter { $0.in == "path" }.map(\.name)
                let queryParamNames = allParams.filter { $0.in == "query" }.map(\.name)
                let bodyParams = extractBodyParams(requestBody: operation.requestBody, spec: spec)

                guard let httpMethod = HTTPMethod(rawValue: methodStr) else { continue }

                routes.append(HTTPTransportRoute(
                    toolName: toolName,
                    method: httpMethod,
                    path: path,
                    queryParams: queryParamNames.isEmpty ? nil : queryParamNames,
                    pathParams: pathParamNames.isEmpty ? nil : pathParamNames,
                    bodyParams: bodyParams.isEmpty ? nil : bodyParams,
                    headers: nil
                ))
            }
        }

        return GeneratedConfig(baseURL: baseURL, routes: routes, auth: auth)
    }

    // MARK: - Generate Tool Definitions

    /// Generate `ToolDefinition` array from an OpenAPI spec.
    public static func toToolDefinitions(
        from spec: OpenAPISpec,
        providerId: String? = nil
    ) -> [ToolDefinition] {
        let id = providerId ?? spec.info.title
        var tools: [ToolDefinition] = []

        let methods: [(String, KeyPath<PathItem, Operation?>)] = [
            ("GET", \.get), ("POST", \.post), ("PUT", \.put),
            ("DELETE", \.delete), ("PATCH", \.patch),
        ]

        for (path, pathItem) in spec.paths ?? [:] {
            let pathParams = pathItem.parameters ?? []

            for (methodStr, keyPath) in methods {
                guard let operation = pathItem[keyPath: keyPath] else { continue }

                let toolName = operation.operationId ?? generateToolName(method: methodStr, path: path)
                let description = operation.summary ?? operation.description ?? "\(methodStr) \(path)"
                let allParams = pathParams + (operation.parameters ?? [])
                let inputSchema = buildInputSchema(parameters: allParams, requestBody: operation.requestBody, spec: spec)

                tools.append(ToolDefinition(
                    name: toolName,
                    description: description,
                    inputSchema: inputSchema,
                    providerId: id,
                    transportType: .rest
                ))
            }
        }

        return tools
    }

    // MARK: - Fetch Spec

    /// Fetch and parse an OpenAPI spec from a URL.
    public static func fetchSpec(from url: URL) async throws -> OpenAPISpec {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw TransportError.connectionFailed(message: "Failed to fetch OpenAPI spec from \(url)")
        }
        return try JSONDecoder().decode(OpenAPISpec.self, from: data)
    }

    // MARK: - Helpers

    private static func generateToolName(method: String, path: String) -> String {
        let cleaned = path
            .replacingOccurrences(of: "\\{([^}]+)\\}", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[^a-zA-Z0-9]", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "_+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return "\(method.lowercased())_\(cleaned)"
    }

    private static func extractBodyParams(requestBody: RequestBody?, spec: OpenAPISpec) -> [String] {
        guard let jsonContent = requestBody?.content?["application/json"],
              let schema = jsonContent.schema else {
            return []
        }

        let resolved = resolveRef(schema: schema, spec: spec)
        return resolved.properties.map { Array($0.keys) } ?? []
    }

    private static func buildInputSchema(
        parameters: [Parameter],
        requestBody: RequestBody?,
        spec: OpenAPISpec
    ) -> JSONSchemaType {
        var properties: [String: JSONSchemaType] = [:]
        var required: [String] = []

        for param in parameters {
            let type = param.schema.flatMap { resolveRef(schema: $0, spec: spec).type } ?? "string"
            properties[param.name] = JSONSchemaType(
                type: type,
                description: param.description ?? param.name
            )
            if param.required == true {
                required.append(param.name)
            }
        }

        if let jsonContent = requestBody?.content?["application/json"],
           let schema = jsonContent.schema {
            let bodySchema = resolveRef(schema: schema, spec: spec)
            if let props = bodySchema.properties {
                for (name, propSchema) in props {
                    let resolved = resolveRef(schema: propSchema, spec: spec)
                    properties[name] = JSONSchemaType(
                        type: resolved.type ?? "string",
                        description: resolved.description ?? name
                    )
                }
                if let bodyRequired = bodySchema.required {
                    required.append(contentsOf: bodyRequired)
                }
            }
        }

        return JSONSchemaType(
            type: "object",
            properties: properties.isEmpty ? nil : properties,
            required: required.isEmpty ? nil : required
        )
    }

    private static func resolveRef(schema: SchemaObject, spec: OpenAPISpec) -> SchemaObject {
        guard let ref = schema.ref else { return schema }

        let components = ref.replacingOccurrences(of: "#/", with: "").split(separator: "/")
        guard components.count >= 3,
              components[0] == "components",
              components[1] == "schemas",
              let resolved = spec.components?.schemas?[String(components[2])] else {
            return schema
        }
        return resolved
    }
}
