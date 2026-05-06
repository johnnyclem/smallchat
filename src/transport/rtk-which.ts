/**
 * Minimal cross-platform `which` implementation for resolving binary paths.
 * Returns the full path to the binary if found on PATH, or null.
 */

import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

export async function which(binary: string): Promise<string | null> {
  const pathEnv = process.env['PATH'] ?? '';
  const dirs = pathEnv.split(':').filter(Boolean);

  for (const dir of dirs) {
    const candidate = join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not found here, try next
    }
  }

  return null;
}
