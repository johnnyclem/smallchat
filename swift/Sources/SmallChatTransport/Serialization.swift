import Foundation

/// JSON serialization and deserialization helpers for the transport layer.
///
/// Mirrors the TypeScript `serialization.ts` module.
public enum TransportSerialization {

    // MARK: - JSON Encode

    /// Encode a value as JSON `Data`.
    public static func encode<T: Encodable>(_ value: T, pretty: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        if pretty {
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        }
        return try encoder.encode(value)
    }

    /// Encode a dictionary of `AnySendable` values as JSON `Data`.
    public static func encodeArgs(_ args: [String: AnySendable]) throws -> Data {
        var dict: [String: Any] = [:]
        for (key, value) in args {
            dict[key] = value.value
        }
        return try JSONSerialization.data(withJSONObject: dict)
    }

    // MARK: - JSON Decode

    /// Decode JSON `Data` into the given `Decodable` type.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    /// Decode JSON `Data` into a dictionary.
    public static func decodeDictionary(from data: Data) throws -> [String: Any] {
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TransportError.invalidResponse(message: "Expected JSON dictionary")
        }
        return dict
    }

    // MARK: - Query Parameter Serialization

    /// Serialize a value for use as a URL query parameter.
    public static func serializeQueryValue(_ value: Any) -> String {
        switch value {
        case let s as String: return s
        case let n as Int: return String(n)
        case let d as Double: return String(d)
        case let b as Bool: return String(b)
        case let arr as [Any]: return arr.map { String(describing: $0) }.joined(separator: ",")
        default:
            if let data = try? JSONSerialization.data(withJSONObject: value),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return String(describing: value)
        }
    }

    // MARK: - Input Serialization

    /// Serialized HTTP request components.
    public struct SerializedRequest: Sendable {
        public let url: String
        public let method: HTTPMethod
        public let headers: [String: String]
        public let body: Data?
    }

    /// Serialize tool arguments into HTTP request components based on a route.
    ///
    /// - Path params are interpolated into the URL path.
    /// - Query params are appended as URL search params.
    /// - Body params are serialized as JSON body (POST/PUT/PATCH).
    public static func serializeInput(
        baseURL: String,
        args: [String: AnySendable],
        route: HTTPTransportRoute
    ) -> SerializedRequest {
        let method = route.method
        var headers = route.headers ?? [:]

        // Build the URL path with interpolated path params
        var path = route.path
        let pathParams = Set(route.pathParams ?? [])
        for param in pathParams {
            if let value = args[param] {
                path = path.replacingOccurrences(
                    of: "{\(param)}",
                    with: serializeQueryValue(value.value)
                        .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
                )
            }
        }

        // Build query parameters
        let queryParams = Set(route.queryParams ?? [])
        var components = URLComponents()
        var queryItems: [URLQueryItem] = []

        for param in queryParams {
            if let value = args[param] {
                queryItems.append(URLQueryItem(name: param, value: serializeQueryValue(value.value)))
            }
        }

        // Build full URL
        let base = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var fullURL = cleanPath.isEmpty ? base : "\(base)/\(cleanPath)"

        if !queryItems.isEmpty {
            components.queryItems = queryItems
            if let query = components.query {
                fullURL += "?\(query)"
            }
        }

        // Build body
        var body: Data?
        if method != .GET && method != .HEAD {
            let bodyParams = Set(route.bodyParams ?? [])
            var bodyDict: [String: Any] = [:]

            if !bodyParams.isEmpty {
                for param in bodyParams {
                    if let value = args[param] {
                        bodyDict[param] = value.value
                    }
                }
            } else {
                // Exclude path and query params, send the rest as body
                for (key, value) in args {
                    if !pathParams.contains(key) && !queryParams.contains(key) {
                        bodyDict[key] = value.value
                    }
                }
            }

            if !bodyDict.isEmpty {
                body = try? JSONSerialization.data(withJSONObject: bodyDict)
                if headers["Content-Type"] == nil {
                    headers["Content-Type"] = "application/json"
                }
            }
        }

        return SerializedRequest(url: fullURL, method: method, headers: headers, body: body)
    }

    // MARK: - Output Parsing

    /// Parse an HTTP response into a `TransportOutput`.
    ///
    /// Content-Type routing:
    ///   - `application/json` → parsed JSON
    ///   - `text/*` → UTF-8 string
    ///   - binary types → base64-encoded
    ///   - 204 No Content → nil body
    public static func parseHTTPResponse(
        statusCode: Int,
        headers: [String: String],
        data: Data?
    ) -> TransportOutput {
        if statusCode == 204 || (data?.isEmpty ?? true) {
            return TransportOutput(
                statusCode: statusCode,
                headers: headers,
                body: nil,
                metadata: [:]
            )
        }

        return TransportOutput(
            statusCode: statusCode,
            headers: headers,
            body: data,
            metadata: [:]
        )
    }

    /// Check if a content type represents binary data.
    public static func isBinaryContentType(_ contentType: String) -> Bool {
        let binary = [
            "application/octet-stream", "image/", "audio/",
            "video/", "application/pdf", "application/zip",
        ]
        return binary.contains(where: { contentType.contains($0) })
    }
}
