/// Match quality from overload resolution, ordered best to worst.
public enum MatchQuality: Int, Sendable, Comparable, Equatable {
    case none = 0
    case any = 1
    case union = 2
    case superclass = 3
    case exact = 4

    public static func < (lhs: MatchQuality, rhs: MatchQuality) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}
