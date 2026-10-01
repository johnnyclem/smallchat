/**
 * `@smallchat/core/compaction` — conversation compaction, re-exported
 * unchanged from `@shorthand/core/compaction`.
 *
 * @deprecated Import from `@shorthand/core/compaction` instead (a
 * dependency of `@smallchat/core`, so it is already installed). This
 * subpath is kept for the 1.x line so 0.x imports have a one-line
 * migration, and will be removed in 2.0. The root entry
 * (`@smallchat/core`) no longer re-exports compaction. In
 * `@shorthand/core` 1.0, `CompactedState`, `CompactionLevel`, `Compactor`,
 * `Decision` and `VerificationResult` name the LSM pipeline's types; what
 * `DefaultCompactor` returns is `CompactedSnapshot` (see MIGRATION.md).
 */
export * from '@shorthand/core/compaction';
