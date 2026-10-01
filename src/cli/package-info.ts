/**
 * Facts about the installed @smallchat/core package, for commands that
 * write configs or scaffold projects referring back to it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The npm package that ships the `smallchat` bin. Never the unscoped `smallchat` name. */
export const PACKAGE_NAME = '@smallchat/core';

/** This package's version (from its package.json), or '0.0.0' if unreadable. */
export function packageVersion(): string {
  try {
    // src/cli/ or dist/cli/ → package root
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Absolute path of the compiled CLI entry point (dist/cli/index.js), or
 * null when running from TypeScript sources.
 */
export function localCliPath(): string | null {
  const path = fileURLToPath(new URL('./index.js', import.meta.url));
  return existsSync(path) ? path : null;
}
