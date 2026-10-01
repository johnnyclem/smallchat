# smallchat canonical call digest (`smallchat.call.v1`)

A call digest identifies one tool call: which tool, with which arguments.
It is what dispatch proofs, logs and policies record instead of raw
arguments, and it is shared by every suite implementation (TypeScript
`callDigest()` in `src/core/call-digest.ts`, smallchat-swift).

```
digest = sha256hex( UTF8("smallchat.call.v1") || 0x00 || UTF8(toolId) || 0x00 || UTF8(JCS(arguments)) )
```

- `toolId` is the canonical tool id `<providerId>/<toolName>`: a non-empty
  provider id that contains no `/`, then `/`, then the upstream tool name
  verbatim (UTF-8 encoded, no normalization).
- `arguments` is the JSON object passed to the tool (MCP `tools/call`
  `params.arguments`). It must be an object; an array, `null` or a scalar is
  an error.
- `JCS` is RFC 8785: object members sorted by the UTF-16 code units of their
  names, no insignificant whitespace, strings escaped as ECMAScript
  `JSON.stringify` does, numbers in ECMAScript shortest round-trip form
  (`1e21` → `1e+21`, `-0` → `0`, `2.0` → `2`).
- Numbers must be finite. `NaN`, `Infinity` and `-Infinity` have no JSON
  form and are an error, never silently mapped to `null`.
- `sha256hex` is lowercase hexadecimal.

Two calls that differ only in key order, whitespace or number spelling have
the same digest; the same arguments sent to a different tool do not.

## Golden vectors

`vectors.json` holds:

- `vectors[]`: `toolId`, `arguments` (as JSON text, including spellings
  such as `-0`, `1E30` and `4.50`), the expected `jcs` string, and the
  expected `digest`. An implementation parses `arguments` with its JSON
  parser, canonicalizes, and must reproduce both `jcs` and `digest`.
- `invalid[]`: inputs that must be rejected. `nonFinite` entries describe a
  single argument `key` whose value is `NaN`, `Infinity` or `-Infinity`
  (which JSON cannot express), to be constructed natively.

The vectors were generated with node:crypto from hand-derived JCS strings,
independently of the implementation they test.

## Scope

The digest is a fingerprint, not a signature: it proves two records name
the same call, not who made it. Arguments that are equal as JSON values but
were produced from different native values (for example a float that
rounds differently on two platforms before serialization) digest
differently; canonicalization starts from the JSON value.
