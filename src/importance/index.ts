/**
 * `@smallchat/core/importance` — domain-agnostic importance scoring
 * (state delta, reference frequency, trajectory discontinuity),
 * re-exported unchanged from `@shorthand/core/importance`. There is one
 * copy of this logic, in the short-hand repository.
 *
 * @deprecated Import from `@shorthand/core/importance` instead (a
 * dependency of `@smallchat/core`, so it is already installed). This
 * subpath is kept for the 1.x line so 0.x imports keep working, and will be
 * removed in 2.0.
 */
export * from '@shorthand/core/importance';
