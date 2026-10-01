/**
 * Facts about the installed @smallchat/core package, for commands that
 * write configs or scaffold projects referring back to it.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from '../core/version.js';

/** The npm package that ships the `smallchat` bin. Never the unscoped `smallchat` name. */
export const PACKAGE_NAME = '@smallchat/core';

/** This package's version (PACKAGE_VERSION, kept equal to package.json's). */
export function packageVersion(): string {
  return PACKAGE_VERSION;
}

/**
 * Absolute path of the compiled CLI entry point (dist/cli/index.js), or
 * null when running from TypeScript sources.
 */
export function localCliPath(): string | null {
  const path = fileURLToPath(new URL('./index.js', import.meta.url));
  return existsSync(path) ? path : null;
}
