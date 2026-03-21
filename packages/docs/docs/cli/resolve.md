---
title: resolve
sidebar_label: resolve
---

# `resolve`

Tests dispatch resolution against a compiled artifact. Given a natural-language intent, prints the matched tool and confidence score. Useful for verifying that your tool descriptions produce the dispatch behaviour you expect.

## Usage

```bash
npx @smallchat/core resolve <file> "<intent>"
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<file>` | Path to a compiled artifact |
| `"<intent>"` | Natural-language intent string to resolve |

## Examples

### Successful match

```bash
npx @smallchat/core resolve tools.json "search for code"
```

Output:

```
Matched: github.search_code (confidence: 0.98)
```

### Lower-confidence match

```bash
npx @smallchat/core resolve tools.json "look up source files"
```

Output:

```
Matched: github.search_code (confidence: 0.81)
```

### Paraphrase test

```bash
npx @smallchat/core resolve tools.json "open a bug report"
```

Output:

```
Matched: github.create_issue (confidence: 0.87)
```

### No match

```bash
npx @smallchat/core resolve tools.json "send a rocket to the moon"
```

Output:

```
No match found. (best candidate: slack.send_message, confidence: 0.31)
```

The process exits with code 1 when no match is found above `minConfidence`.

## Testing dispatch systematically

Use `resolve` in CI to verify dispatch quality across a set of test intents:

```bash
#!/bin/bash
# test-dispatch.sh

ARTIFACT="tools.json"
PASS=0
FAIL=0

check() {
  local intent="$1"
  local expected="$2"
  local result=$(npx @smallchat/core resolve "$ARTIFACT" "$intent" 2>&1)
  if echo "$result" | grep -q "$expected"; then
    echo "  PASS: '$intent' → $expected"
    ((PASS++))
  else
    echo "  FAIL: '$intent' → expected $expected, got: $result"
    ((FAIL++))
  fi
}

check "search for code" "github.search_code"
check "find code in a repo" "github.search_code"
check "open a bug report" "github.create_issue"
check "send a slack message" "slack.send_message"
check "read a file" "filesystem.read_file"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
```

## Output format

The resolve command exits with:

- **Code 0** — a match was found above `minConfidence`
- **Code 1** — no match found, or error
