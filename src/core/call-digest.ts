/**
 * Canonical call digest — the suite-wide identity of one tool call.
 *
 *   sha256hex(UTF8("smallchat.call.v1") || 0x00 || UTF8(toolId) || 0x00 || UTF8(JCS(arguments)))
 *
 * `toolId` is the canonical `<providerId>/<toolName>` and JCS is RFC 8785.
 * Two calls with the same digest named the same tool with the same
 * arguments, whatever the key order, whitespace or number spelling of the
 * JSON they arrived in. Golden vectors: spec/call-digest/vectors.json.
 */

import { canonicalJson } from './jcs.js';
import { parseToolId } from './tool-id.js';
import { domainDigest } from './sha256.js';

/** Domain-separation prefix of the call digest. */
export const CALL_DIGEST_DOMAIN = 'smallchat.call.v1';

/**
 * Digest of a call to `toolId` with `args`. Throws TypeError when the id
 * is not `<providerId>/<toolName>` or contains U+0000 (the separator) or
 * a lone UTF-16 surrogate, when `args` is not a JSON object, or when it
 * holds a value JSON cannot represent exactly (NaN, ±Infinity, bigint,
 * undefined array elements, typed arrays, non-plain objects).
 */
export function callDigest(toolId: string, args: Record<string, unknown>): string {
  parseToolId(toolId);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('callDigest: arguments must be a JSON object');
  }
  return domainDigest(CALL_DIGEST_DOMAIN, toolId, canonicalJson(args));
}
