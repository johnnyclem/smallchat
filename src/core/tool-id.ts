/**
 * Canonical tool id — the suite-wide identity of one upstream tool:
 * `<providerId>/<toolName>`. Used in artifacts, digests, proofs, logs and
 * policies. The provider id never contains '/', so the first '/' splits an
 * id unambiguously; the tool name is the upstream name verbatim.
 */
export function toolId(providerId: string, toolName: string): string {
  if (providerId.length === 0 || providerId.includes('/')) {
    throw new TypeError(`Invalid provider id "${providerId}": must be non-empty and must not contain "/"`);
  }
  if (toolName.length === 0) {
    throw new TypeError(`Invalid tool name for provider "${providerId}": must be non-empty`);
  }
  return `${providerId}/${toolName}`;
}

/**
 * Split a canonical tool id into its provider id and upstream tool name
 * (at the first '/'). Throws TypeError unless both parts are non-empty.
 * Golden vectors: spec/tool-id/vectors.json.
 */
export function parseToolId(id: string): { providerId: string; toolName: string } {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    throw new TypeError(`Invalid tool id "${id}": expected "<providerId>/<toolName>"`);
  }
  return { providerId: id.slice(0, slash), toolName: id.slice(slash + 1) };
}
