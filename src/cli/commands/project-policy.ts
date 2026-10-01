import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SmallChatManifest } from '../../core/manifest.js';
import { safeJsonParse } from '../../core/safe-json.js';
import { runtimeOptionsFromPolicy, type RuntimeOptions } from '../../runtime/runtime.js';
import { findSmallChatManifest } from './compile.js';

/**
 * The dispatch policy `replay` and `explain` decide with: the "policy"
 * block of `configPath` when given, else of the nearest smallchat.json
 * upward from the cwd — the same file `serve` reads — so a replay or an
 * explanation sees the decisions serve would make.
 */
export function projectRuntimeOptions(configPath?: string): { options: RuntimeOptions; source: string | null } {
  if (configPath) {
    const path = resolve(configPath);
    const manifest = safeJsonParse(readFileSync(path, 'utf-8')) as SmallChatManifest;
    return { options: manifest.policy ? runtimeOptionsFromPolicy(manifest.policy) : {}, source: path };
  }
  const project = findSmallChatManifest(process.cwd());
  if (!project?.manifest.policy) return { options: {}, source: null };
  return { options: runtimeOptionsFromPolicy(project.manifest.policy), source: project.path };
}
