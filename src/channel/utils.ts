/**
 * Channel utilities — meta key filtering, permission reply parsing,
 * payload validation, and content sanitization.
 */

// ---------------------------------------------------------------------------
// Meta key filtering
// ---------------------------------------------------------------------------

/**
 * Valid meta key pattern: only letters, digits, and underscores.
 * Matches Claude Code behavior — invalid keys are silently dropped.
 */
const META_KEY_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Filter meta keys to only those containing letters, digits, and underscores.
 * Invalid keys are silently dropped (matching Claude Code behavior).
 * Also prevents prototype pollution by rejecting __proto__, constructor, prototype.
 */
export function filterMetaKeys(
  meta: Record<string, unknown> | undefined | null,
): Record<string, string> | undefined {
  if (!meta || typeof meta !== 'object') return undefined;

  const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const filtered: Record<string, string> = Object.create(null);
  let hasKeys = false;

  for (const key of Object.keys(meta)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (!META_KEY_PATTERN.test(key)) continue;

    const value = meta[key];
    if (typeof value === 'string') {
      filtered[key] = value;
      hasKeys = true;
    } else if (value !== undefined && value !== null) {
      filtered[key] = String(value);
      hasKeys = true;
    }
  }

  return hasKeys ? filtered : undefined;
}

/**
 * Check if a single meta key is valid.
 */
export function isValidMetaKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
  return META_KEY_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// Permission reply parsing
// ---------------------------------------------------------------------------

/**
 * Permission request ID pattern: 5 lowercase letters excluding 'l'.
 * Matches: [a-km-z]{5}
 */
const PERMISSION_ID_PATTERN = /^[a-km-z]{5}$/;

/**
 * Parse a permission reply message from a remote user.
 * Accepts: "yes <id>", "no <id>" (case-insensitive).
 *
 * Returns null if the message doesn't match the expected format.
 */
export function parsePermissionReply(
  message: string,
): { requestId: string; behavior: 'allow' | 'deny' } | null {
  if (!message || typeof message !== 'string') return null;

  const trimmed = message.trim();
  const match = trimmed.match(/^(yes|no)\s+([a-km-z]{5})$/i);
  if (!match) return null;

  const verdict = match[1].toLowerCase();
  const requestId = match[2].toLowerCase();

  if (!PERMISSION_ID_PATTERN.test(requestId)) return null;

  return {
    requestId,
    behavior: verdict === 'yes' ? 'allow' : 'deny',
  };
}

/**
 * Validate a permission request ID format.
 */
export function isValidPermissionId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  return PERMISSION_ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Payload size validation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB

/**
 * Check if a payload exceeds the size limit.
 */
export function validatePayloadSize(
  content: string,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): { valid: boolean; size: number; limit: number } {
  const size = Buffer.byteLength(content, 'utf-8');
  return { valid: size <= maxBytes, size, limit: maxBytes };
}

// ---------------------------------------------------------------------------
// Channel tag serialization (for prompt generation)
// ---------------------------------------------------------------------------

/**
 * Serialize a channel event into a <channel> XML tag for LLM prompt injection.
 * This is the format Claude Code uses to present channel events in context.
 */
export function serializeChannelTag(
  channel: string,
  content: string,
  meta?: Record<string, string>,
): string {
  const attrs = [`source="${escapeXmlAttr(channel)}"`];

  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (isValidMetaKey(key)) {
        attrs.push(`${key}="${escapeXmlAttr(value)}"`);
      }
    }
  }

  return `<channel ${attrs.join(' ')}>\n${content}\n</channel>`;
}

/**
 * Escape a string for use in an XML attribute value.
 */
function escapeXmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
