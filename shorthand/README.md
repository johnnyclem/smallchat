# shorthand/ — development stand-in for `@shorthand/core`

`@smallchat/core` depends on **`@shorthand/core` ^1.0.0 from the npm
registry**. That package is developed and published from the
[short-hand](https://github.com/johnnyclem/short-hand) repository, which
merged this directory's code and implements the suite's Truth Format v2
(TRANSITION lines, `prevHash`/`hash`, `sinceSeq`, the suite PROPOSAL
envelope) and runs stenographer's `spec/truth-format` fixtures.

This directory is the npm workspace that satisfies that range while
@shorthand/core 1.0.0 is not yet on the registry, so the repository builds
and tests offline. It is `private` (npm will not publish it) and is the
pre-1.0 vendored copy: its truth module reads and writes v1 lines only and
still emits the retired bare PROPOSAL envelope. Do not build on it.
Installed `@smallchat/core` never sees it (`npm run test:pack` checks the
packed tarball).

Release step: once `@shorthand/core@1.0.0` is published, delete this
directory and its `workspaces` entry; `npm install` then resolves the
registry package.
