/**
 * secrets.ts — Secrets management via dotenv and environment variable expansion.
 *
 * Loads .env files and performs ${VAR} / $VAR expansion throughout
 * config values. This means you can write:
 *
 *   # .env
 *   DB_PASSWORD=super-secret
 *   ANTHROPIC_API_KEY=sk-ant-...
 *
 *   # smallchat.config.ts
 *   dbPath: "${DB_PATH:-smallchat.db}"    // with default
 *   apiKey: "${ANTHROPIC_API_KEY}"        // required
 *
 * The module purposefully avoids the 'dotenv' npm package to stay
 * dependency-free, but the format is compatible so you can swap it in.
 *
 * Security:
 *   - Never logs secret values (only key names)
 *   - Redacts secrets in audit logs (replace with "***")
 *   - Supports .env.local (gitignored) for developer overrides
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootLogger } from '../observability/logger.js';

const log = rootLogger.child({ component: 'secrets' });

// ---------------------------------------------------------------------------
// .env parser
// ---------------------------------------------------------------------------

/**
 * Parse a .env file into a key/value map.
 * Supports:
 *   - KEY=value (unquoted)
 *   - KEY="quoted value"
 *   - KEY='single quoted'
 *   - # comments
 *   - Multi-line values (not supported — use JSON)
 *   - export KEY=value
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) continue;

    // Strip optional "export " prefix
    const stripped = line.startsWith('export ') ? line.slice(7) : line;

    const eqIdx = stripped.indexOf('=');
    if (eqIdx < 1) continue;

    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle escape sequences in double-quoted strings
    if (rawLine.includes('"')) {
      value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    }

    result[key] = value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Environment variable expansion
// ---------------------------------------------------------------------------

/**
 * Expand ${VAR}, ${VAR:-default}, and $VAR patterns in a string.
 *
 * Supported forms:
 *   ${VAR}           — required; throws if VAR is not set
 *   ${VAR:-default}  — optional with default value
 *   $VAR             — bare variable reference (no default)
 */
export function expandEnvVars(input: string, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): string {
  // ${VAR:-default} and ${VAR}
  let result = input.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const colonDash = expr.indexOf(':-');
    if (colonDash >= 0) {
      const varName = expr.slice(0, colonDash);
      const defaultVal = expr.slice(colonDash + 2);
      return env[varName] ?? defaultVal;
    }

    const value = env[expr];
    if (value === undefined) {
      throw new Error(`Required environment variable "${expr}" is not set`);
    }
    return value;
  });

  // $VAR (bare, not inside braces) — only match word characters
  result = result.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_match, varName: string) => {
    return env[varName] ?? _match;
  });

  return result;
}

/**
 * Recursively expand environment variables in all string values of an object.
 * Useful for expanding entire config objects at once.
 */
export function expandObject<T>(obj: T, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): T {
  if (typeof obj === 'string') {
    return expandEnvVars(obj, env) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => expandObject(item, env)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandObject(value, env);
    }
    return result as T;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

export interface LoadEnvOptions {
  /** Directory to search for .env files (default: process.cwd()) */
  cwd?: string;
  /** Load .env.<NODE_ENV> file if it exists (default: true) */
  loadEnvMode?: boolean;
  /** Load .env.local for developer overrides (default: true) */
  loadLocal?: boolean;
  /** Override existing process.env values (default: false) */
  override?: boolean;
}

/**
 * Load .env files and merge into process.env.
 *
 * Load order (later files override earlier):
 *   1. .env
 *   2. .env.<NODE_ENV>  (e.g. .env.production)
 *   3. .env.local       (gitignored developer overrides)
 *
 * Returns the merged key/value map of newly loaded variables.
 */
export function loadEnv(options: LoadEnvOptions = {}): Record<string, string> {
  const cwd = options.cwd ?? process.cwd();
  const mode = process.env['NODE_ENV'] ?? 'development';
  const loadLocal = options.loadLocal ?? true;
  const loadEnvMode = options.loadEnvMode ?? true;
  const override = options.override ?? false;

  const filesToLoad: string[] = ['.env'];
  if (loadEnvMode && mode) filesToLoad.push(`.env.${mode}`);
  if (loadLocal) filesToLoad.push('.env.local');

  const loaded: Record<string, string> = {};

  for (const filename of filesToLoad) {
    const filepath = resolve(cwd, filename);
    if (!existsSync(filepath)) continue;

    try {
      const content = readFileSync(filepath, 'utf-8');
      const parsed = parseDotenv(content);

      for (const [key, value] of Object.entries(parsed)) {
        if (override || !(key in process.env)) {
          process.env[key] = value;
          loaded[key] = value;
        }
      }

      log.debug({ file: filepath, keys: Object.keys(parsed).length }, 'Loaded env file');
    } catch (err) {
      log.warn({ err, file: filepath }, 'Failed to load env file');
    }
  }

  // Log what was loaded (key names only, never values)
  if (Object.keys(loaded).length > 0) {
    log.info({ keys: Object.keys(loaded) }, 'Environment variables loaded');
  }

  return loaded;
}

// ---------------------------------------------------------------------------
// Secret redaction (for audit logs / error messages)
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERNS = [
  /key/i, /token/i, /secret/i, /password/i, /passwd/i, /pass/i, /credential/i,
  /auth/i, /api[_-]?key/i, /private/i, /cert/i,
];

/**
 * Returns true if a key name looks like it contains a secret.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some(p => p.test(key));
}

/**
 * Redact secret values from a record (shallow, for logging).
 * Returns a new object with sensitive values replaced by "***".
 */
export function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key)) {
      result[key] = typeof value === 'string' && value.length > 0 ? '***' : value;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSecrets(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
