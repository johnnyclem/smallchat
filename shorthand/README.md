# shorthand/ — mirror of `@shorthand/core`

This directory is an exact copy of `@shorthand/core` 1.0.0 from the
[short-hand](https://github.com/johnnyclem/short-hand) repository
(commit `052c835cf2a40c9dfa8e800c7404500b996c4af9`), written by
`scripts/sync-shorthand.mjs`. It is not a fork: do not edit it. Change
short-hand, then run `SHORTHAND_DIR=../short-hand npm run sync:shorthand`.
`npm run check:shorthand` (and `src/shorthand-mirror.test.ts`, in CI) fails
when anything here differs from what `SOURCE` records.

`@smallchat/core` depends on `"@shorthand/core": "^1.0.0"` from the npm
registry. This mirror is the npm workspace that satisfies that range during
development, so the repository builds and tests offline against the exact
release it depends on. It is `private`; an installed `@smallchat/core`
never sees it (`npm run test:pack` checks the packed tarball).

The ONNX embedding module is not part of `@shorthand/core`: smallchat's
`src/embedding` is its only copy.

Documentation, CHANGELOG and MIGRATION live in the short-hand repository.
