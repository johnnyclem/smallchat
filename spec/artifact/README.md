# smallchat artifact format 1.0

`smallchat compile` writes a toolkit artifact. This directory holds its
normative definition:

- `artifact.v1.schema.json` — JSON Schema (draft 2020-12). Every loader
  validates against it.
- `fixtures/minimal.manifest.json` → `fixtures/minimal.v1.json` — a golden
  pair: compiling the manifest with the hash embedder at 16 dimensions
  (`new HashEmbedder(16)`) must reproduce the artifact byte for byte, and
  every implementation must accept the artifact and recompute its
  `contentHash`.
- `fixtures/invalid/` — negative fixtures every implementation must refuse.
  `index.json` lists each artifact with the rule below it breaks (and the
  message smallchat reports), plus `embedderMismatches`: fingerprints that
  each differ from `minimal.v1.json`'s embedder in exactly one of the seven
  fields and must not be accepted for it (rule 5).

## Rules a loader must enforce

1. `formatVersion` is exactly `"1.0"`. A file without `formatVersion` (0.x
   files have `version` / `dispatchTables`) is refused with a message to
   recompile with smallchat 1.0. There is no partial or best-effort load.
2. The document matches the schema.
3. It is internally consistent: map keys equal the ids they hold; a tool id
   is `<providerId>/<name>`; every tool's `selector` is a `kind: "tool"`
   selector pointing back at it; every selector points at an existing tool;
   every vector has `embedder.dims` entries; `stats` match the contents.
4. `contentHash` matches:

   ```
   sha256hex( UTF8("smallchat.artifact.v1") || 0x00 || UTF8(JCS(artifact without "contentHash")) )
   ```

   where JCS is RFC 8785 (keys sorted by UTF-16 code units, ECMAScript
   number serialization, no whitespace).
5. The embedder used to resolve intents has a fingerprint equal to
   `embedder` in all seven fields (`kind`, `model`, `modelSha256`, `dims`,
   `maxLength`, `pooling`, `normalize`). Vectors from different embedders
   are not comparable, so a mismatch is an error, never a warning. An
   artifact with `kind: "custom"` can only be loaded with an explicitly
   supplied embedder that declares the same fingerprint.

## Identity

- Canonical tool id: `<providerId>/<toolName>`. Provider ids never contain
  `/`; the tool name is the upstream name verbatim.
- Selectors are dispatch keys (the tool's primary selector plus any alias
  selectors). A selector belongs to exactly one tool; the compiler never
  merges tools, and two tools whose embeddings are ≥ 0.95 cosine-similar are
  a compile error unless compiled with `--allow-duplicates`, in which case
  both are kept and the pair is listed under `duplicates`.

## Secrets

Provider `launch` specs record stdio `command`, `args`, and the *names* of
environment variables the server expects. Environment variable values are
never written. Command-line arguments are recorded verbatim, so do not pass
secrets as arguments in the MCP config you compile.

## Scope of the guarantees

`contentHash` detects modification of an artifact after compilation; it is
not a signature and does not authenticate who compiled it. The embedder
check compares declared fingerprints: for the built-in ONNX embedder the
model file is verified against `modelSha256` before any vector is produced;
a custom embedder is trusted to declare its fingerprint truthfully.
