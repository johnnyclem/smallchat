import Foundation
import SmallChatCore

/// Converts Postman Collection v2.1 format to HTTP transport configurations and tool definitions.
///
/// Mirrors the TypeScript `postman-importer.ts` module.
public enum PostmanImporter {

    // MARK: - Postman Types

    public struct PostmanCollection: Codable, Sendable {
        public let info: Info
        public let item: [PostmanItem]
        public let auth: PostmanAuth?
        public let variable: [PostmanVariable]?

        public struct Info: Codable, Sendable {
            public let name: String
            public let schema: String
        }
    }

    public struct PostmanItem: Codable, Sendable {
        public let name: String
        public let request: PostmanRequest?
        public let item: [PostmanItem]?
    }

    public struct PostmanRequest: Codable, Sendable {
        public let method: String?
        public let header: [PostmanHeader]?
        public let url: PostmanURL
        public let body: PostmanBody?
        public let auth: PostmanAuth?
    }

    public struct PostmanURL: Codable, Sendable {
        public let raw: String?
        public let `protocol`: String?
        public let host: [String]?
        public let path: [String]?
        public let query: [PostmanQueryParam]?
    }

    public struct PostmanHeader: Codable, Sendable {
        public let key: String
        public let value: String
    }

    public struct PostmanBody: Codable, Sendable {
        public let mode: String
        public let raw: String?
        public let formdata: [PostmanFormField]?
    }

    public struct PostmanFormField: Codable, Sendable {
        public let key: String
        public let value: String
        public let type: String
    }

    public struct PostmanAuth: Codable, Sendable {
        public let type: String
        public let bearer: [PostmanKeyValue]?
        public let oauth2: [PostmanKeyValue]?
    }

    public struct PostmanKeyValue: Codable, Sendable {
        public let key: String
        public let value: String
    }

    public struct PostmanVariable: Codable, Sendable {
        public let key: String
        public let value: String
    }

    public struct PostmanQueryParam: Codable, Sendable {
        public let key: String
        public let value: String
    }

    // MARK: - Import Options

    public struct ImportOptions: Sendable {
        public let baseURL: String?
        public let auth: (any AuthStrategy)?

        public init(baseURL: String? = nil, auth: (any AuthStrategy)? = nil) {
            self.baseURL = baseURL
            self.auth = auth
        }
    }

    // MARK: - Import Config

    /// Import a Postman Collection and generate HTTP transport configuration.
    public static func importCollection(
        _ collection: PostmanCollection,
        options: ImportOptions = ImportOptions()
    ) -> OpenAPIImporter.GeneratedConfig {
        let variables = buildVariableMap(collection.variable)
        let baseURL = options.baseURL ?? resolveBaseURL(collection: collection, variables: variables)
        let auth = options.auth ?? resolveAuth(collection.auth)

        let items = flattenItems(collection.item)
        var routes: [HTTPTransportRoute] = []

        for item in items {
            guard let request = item.request else { continue }
            if let route = requestToRoute(name: item.name, request: request, variables: variables, baseURL: baseURL) {
                routes.append(route)
            }
        }

        return OpenAPIImporter.GeneratedConfig(baseURL: baseURL, routes: routes, auth: auth)
    }

    // MARK: - Tool Definitions

    /// Import a Postman Collection as `ToolDefinition` array.
    public static func toToolDefinitions(
        from collection: PostmanCollection,
        providerId: String? = nil
    ) -> [ToolDefinition] {
        let id = providerId ?? collection.info.name
        let variables = buildVariableMap(collection.variable)
        let items = flattenItems(collection.item)
        var tools: [ToolDefinition] = []

        for item in items {
            guard let request = item.request else { continue }
            let toolName = sanitizeToolName(item.name)
            let method = request.method?.uppercased() ?? "GET"
            let url = resolveURL(request.url, variables: variables)
            let inputSchema = buildInputSchemaFromRequest(request, variables: variables)

            tools.append(ToolDefinition(
                name: toolName,
                description: "\(method) \(url)",
                inputSchema: inputSchema,
                providerId: id,
                transportType: .rest
            ))
        }

        return tools
    }

    // MARK: - Parsing

    /// Parse a Postman Collection from JSON string.
    public static func parse(_ json: String) throws -> PostmanCollection {
        guard let data = json.data(using: .utf8) else {
            throw TransportError.invalidResponse(message: "Invalid UTF-8 in Postman collection")
        }
        let collection = try JSONDecoder().decode(PostmanCollection.self, from: data)

        guard collection.info.schema.contains("postman") else {
            throw TransportError.invalidResponse(message: "Invalid Postman Collection format")
        }

        return collection
    }

    // MARK: - Helpers

    private static func flattenItems(_ items: [PostmanItem], prefix: String = "") -> [PostmanItem] {
        var flat: [PostmanItem] = []
        for item in items {
            if let subItems = item.item {
                let folderPrefix = prefix.isEmpty ? item.name : "\(prefix)/\(item.name)"
                flat.append(contentsOf: flattenItems(subItems, prefix: folderPrefix))
            } else {
                let name = prefix.isEmpty ? item.name : "\(prefix)/\(item.name)"
                flat.append(PostmanItem(name: name, request: item.request, item: nil))
            }
        }
        return flat
    }

    private static func requestToRoute(
        name: String,
        request: PostmanRequest,
        variables: [String: String],
        baseURL: String
    ) -> HTTPTransportRoute? {
        let methodStr = request.method?.uppercased() ?? "GET"
        guard let httpMethod = HTTPMethod(rawValue: methodStr) else { return nil }

        let fullURL = resolveURL(request.url, variables: variables)

        // Extract path relative to base URL
        var path: String
        if let url = URL(string: fullURL) {
            path = url.path
            if let query = url.query {
                path += "?\(query)"
            }
        } else if fullURL.hasPrefix(baseURL) {
            path = String(fullURL.dropFirst(baseURL.count))
        } else {
            path = fullURL
        }

        // Extract query params
        let queryParams = request.url.query?.map(\.key) ?? []

        // Convert :param to {param} and collect path params
        var pathParams: [String] = []
        let paramPattern = try! NSRegularExpression(pattern: ":([a-zA-Z_][a-zA-Z0-9_]*)")
        let nsPath = path as NSString
        let matches = paramPattern.matches(in: path, range: NSRange(location: 0, length: nsPath.length))
        for match in matches.reversed() {
            let paramName = nsPath.substring(with: match.range(at: 1))
            pathParams.append(paramName)
            path = nsPath.replacingCharacters(in: match.range, with: "{\(paramName)}")
        }
        pathParams.reverse()

        // Extract body params
        var bodyParams: [String] = []
        if request.body?.mode == "raw", let raw = request.body?.raw {
            let resolved = resolveVariables(raw, variables: variables)
            if let data = resolved.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                bodyParams = Array(json.keys)
            }
        } else if request.body?.mode == "formdata" {
            bodyParams = request.body?.formdata?.map(\.key) ?? []
        }

        // Extract custom headers
        var headers: [String: String] = [:]
        for header in request.header ?? [] {
            let lower = header.key.lowercased()
            if lower != "content-type" && lower != "authorization" {
                headers[header.key] = resolveVariables(header.value, variables: variables)
            }
        }

        return HTTPTransportRoute(
            toolName: sanitizeToolName(name),
            method: httpMethod,
            path: path,
            queryParams: queryParams.isEmpty ? nil : queryParams,
            pathParams: pathParams.isEmpty ? nil : pathParams,
            bodyParams: bodyParams.isEmpty ? nil : bodyParams,
            headers: headers.isEmpty ? nil : headers
        )
    }

    private static func buildInputSchemaFromRequest(
        _ request: PostmanRequest,
        variables: [String: String]
    ) -> JSONSchemaType {
        var properties: [String: JSONSchemaType] = [:]

        for q in request.url.query ?? [] {
            properties[q.key] = JSONSchemaType(type: "string", description: q.key)
        }

        if request.body?.mode == "raw", let raw = request.body?.raw {
            let resolved = resolveVariables(raw, variables: variables)
            if let data = resolved.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                for (key, value) in json {
                    properties[key] = JSONSchemaType(type: inferJsonType(value), description: key)
                }
            }
        }

        return JSONSchemaType(
            type: "object",
            properties: properties.isEmpty ? nil : properties
        )
    }

    private static func buildVariableMap(_ variables: [PostmanVariable]?) -> [String: String] {
        var map: [String: String] = [:]
        for v in variables ?? [] {
            map[v.key] = v.value
        }
        return map
    }

    private static func resolveVariables(_ text: String, variables: [String: String]) -> String {
        var result = text
        let pattern = try! NSRegularExpression(pattern: "\\{\\{([^}]+)\\}\\}")
        let nsText = result as NSString
        let matches = pattern.matches(in: result, range: NSRange(location: 0, length: nsText.length))

        for match in matches.reversed() {
            let key = nsText.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let replacement = variables[key] ?? "{{\(key)}}"
            result = (result as NSString).replacingCharacters(in: match.range, with: replacement)
        }
        return result
    }

    private static func resolveURL(_ url: PostmanURL, variables: [String: String]) -> String {
        if let raw = url.raw {
            return resolveVariables(raw, variables: variables)
        }

        let proto = url.protocol ?? "https"
        let host = url.host?.joined(separator: ".") ?? "localhost"
        let path = url.path?.joined(separator: "/") ?? ""
        return resolveVariables("\(proto)://\(host)/\(path)", variables: variables)
    }

    private static func resolveBaseURL(collection: PostmanCollection, variables: [String: String]) -> String {
        let items = flattenItems(collection.item)
        for item in items {
            guard let request = item.request else { continue }
            let url = resolveURL(request.url, variables: variables)
            if let parsed = URL(string: url), let scheme = parsed.scheme, let host = parsed.host {
                if let port = parsed.port {
                    return "\(scheme)://\(host):\(port)"
                }
                return "\(scheme)://\(host)"
            }
        }
        return "http://localhost"
    }

    private static func resolveAuth(_ auth: PostmanAuth?) -> (any AuthStrategy)? {
        guard let auth else { return nil }

        if auth.type == "bearer", let bearer = auth.bearer {
            if let tokenEntry = bearer.first(where: { $0.key == "token" }) {
                return BearerTokenAuth(token: tokenEntry.value)
            }
        }

        return nil
    }

    private static func sanitizeToolName(_ name: String) -> String {
        var result = name
            .replacingOccurrences(of: "[^a-zA-Z0-9_\\s-]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[\\s-]+", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "_+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
            .lowercased()
        if result.isEmpty { result = "unnamed" }
        return result
    }

    private static func inferJsonType(_ value: Any) -> String {
        switch value {
        case is String: return "string"
        case is Int, is Double, is Float: return "number"
        case is Bool: return "boolean"
        case is [Any]: return "array"
        case is NSNull: return "string"
        default: return "object"
        }
    }
}
