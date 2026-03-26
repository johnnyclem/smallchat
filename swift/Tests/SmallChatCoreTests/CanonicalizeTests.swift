import Testing
@testable import SmallChatCore

@Suite("Canonicalize")
struct CanonicalizeTests {
    @Test("Converts intent to colon-separated form")
    func basicCanonicalization() {
        let result = canonicalize("find my recent documents")
        #expect(result == "find:recent:documents")
    }

    @Test("Filters stopwords")
    func filtersStopwords() {
        let result = canonicalize("search for the documents in a folder")
        #expect(result == "search:documents:folder")
    }

    @Test("Returns unknown for empty input")
    func emptyInput() {
        let result = canonicalize("the a an")
        #expect(result == "unknown")
    }

    @Test("Lowercases input")
    func lowercases() {
        let result = canonicalize("Search Documents")
        #expect(result == "search:documents")
    }

    @Test("Removes non-alphanumeric characters")
    func removesSpecialChars() {
        let result = canonicalize("search! for @docs #now")
        #expect(result == "search:docs:now")
    }
}
