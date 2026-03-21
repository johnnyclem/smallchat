/**
 * validator.ts — Strict configuration validator for smallchat.config.ts.
 *
 * Validates all configuration options with descriptive error messages,
 * similar to Zod but without the dependency. Validates:
 *   - Required fields are present
 *   - Types are correct
 *   - Values are within allowed ranges
 *   - File paths exist (when resolvePaths=true)
 *
 * Usage:
 *   const result = validateServerConfig(rawConfig);
 *   if (!result.valid) {
 *     for (const err of result.errors) console.error(err.message);
 *   }
 */

import { existsSync } from 'node:fs';
import type { MCPServerConfig } from '../mcp/server.js';

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  /** Config with defaults filled in */
  config?: MCPServerConfig;
}

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

class Validator {
  private errors: ValidationError[] = [];
  private warnings: ValidationError[] = [];

  error(field: string, message: string, value?: unknown): void {
    this.errors.push({ field, message, value });
  }

  warn(field: string, message: string, value?: unknown): void {
    this.warnings.push({ field, message, value });
  }

  result(): { errors: ValidationError[]; warnings: ValidationError[] } {
    return { errors: this.errors, warnings: this.warnings };
  }

  requireString(obj: Record<string, unknown>, field: string, label?: string): string | undefined {
    const val = obj[field];
    if (val === undefined || val === null || val === '') {
      this.error(field, `${label ?? field} is required and cannot be empty`);
      return undefined;
    }
    if (typeof val !== 'string') {
      this.error(field, `${label ?? field} must be a string, got ${typeof val}`, val);
      return undefined;
    }
    return val;
  }

  optionalString(obj: Record<string, unknown>, field: string, label?: string): string | undefined {
    const val = obj[field];
    if (val === undefined || val === null) return undefined;
    if (typeof val !== 'string') {
      this.error(field, `${label ?? field} must be a string if provided, got ${typeof val}`, val);
      return undefined;
    }
    return val;
  }

  requireInt(obj: Record<string, unknown>, field: string, min: number, max: number, label?: string): number | undefined {
    const val = obj[field];
    if (val === undefined || val === null) {
      this.error(field, `${label ?? field} is required`);
      return undefined;
    }
    const n = Number(val);
    if (!Number.isInteger(n)) {
      this.error(field, `${label ?? field} must be an integer, got ${val}`, val);
      return undefined;
    }
    if (n < min || n > max) {
      this.error(field, `${label ?? field} must be between ${min} and ${max}, got ${n}`, val);
      return undefined;
    }
    return n;
  }

  optionalInt(obj: Record<string, unknown>, field: string, min: number, max: number, label?: string): number | undefined {
    const val = obj[field];
    if (val === undefined || val === null) return undefined;
    const n = Number(val);
    if (!Number.isInteger(n)) {
      this.error(field, `${label ?? field} must be an integer if provided, got ${val}`, val);
      return undefined;
    }
    if (n < min || n > max) {
      this.error(field, `${label ?? field} must be between ${min} and ${max} if provided, got ${n}`, val);
      return undefined;
    }
    return n;
  }

  optionalBool(obj: Record<string, unknown>, field: string, label?: string): boolean | undefined {
    const val = obj[field];
    if (val === undefined || val === null) return undefined;
    if (typeof val !== 'boolean') {
      this.error(field, `${label ?? field} must be a boolean if provided, got ${typeof val}`, val);
      return undefined;
    }
    return val;
  }

  pathExists(field: string, p: string, label?: string): boolean {
    if (!existsSync(p)) {
      this.error(field, `${label ?? field} path does not exist: "${p}"`);
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// MCPServerConfig validator
// ---------------------------------------------------------------------------

export function validateServerConfig(
  raw: unknown,
  options: { resolvePaths?: boolean } = {},
): ValidationResult {
  const v = new Validator();

  if (typeof raw !== 'object' || raw === null) {
    return {
      valid: false,
      errors: [{ field: '<root>', message: 'Configuration must be an object' }],
      warnings: [],
    };
  }

  const obj = raw as Record<string, unknown>;

  // --- Required fields ---
  const port = v.requireInt(obj, 'port', 1, 65535, 'port');
  const host = v.requireString(obj, 'host', 'host');
  const sourcePath = v.requireString(obj, 'sourcePath', 'sourcePath');

  // Verify sourcePath exists
  if (sourcePath && options.resolvePaths !== false) {
    v.pathExists('sourcePath', sourcePath, 'sourcePath');
  }

  // --- Optional fields ---
  const dbPath = v.optionalString(obj, 'dbPath', 'dbPath');
  const enableAuth = v.optionalBool(obj, 'enableAuth', 'enableAuth');
  const enableRateLimit = v.optionalBool(obj, 'enableRateLimit', 'enableRateLimit');
  const rateLimitRPM = v.optionalInt(obj, 'rateLimitRPM', 1, 100000, 'rateLimitRPM');
  const enableAudit = v.optionalBool(obj, 'enableAudit', 'enableAudit');
  const sessionTTLMs = v.optionalInt(obj, 'sessionTTLMs', 60000, 7 * 24 * 60 * 60 * 1000, 'sessionTTLMs');
  const maxConcurrentExecutions = v.optionalInt(obj, 'maxConcurrentExecutions', 0, 10000, 'maxConcurrentExecutions');
  const maxQueueDepth = v.optionalInt(obj, 'maxQueueDepth', 0, 100000, 'maxQueueDepth');
  const enableHotReload = v.optionalBool(obj, 'enableHotReload', 'enableHotReload');
  const hotReloadDebounceMs = v.optionalInt(obj, 'hotReloadDebounceMs', 50, 60000, 'hotReloadDebounceMs');
  const enableMetrics = v.optionalBool(obj, 'enableMetrics', 'enableMetrics');
  const gracefulShutdownTimeoutMs = v.optionalInt(obj, 'gracefulShutdownTimeoutMs', 1000, 300000, 'gracefulShutdownTimeoutMs');

  // --- toolRateLimits validation ---
  let toolRateLimits: Record<string, number> | undefined;
  if (obj['toolRateLimits'] !== undefined) {
    if (typeof obj['toolRateLimits'] !== 'object' || obj['toolRateLimits'] === null) {
      v.error('toolRateLimits', 'toolRateLimits must be an object mapping tool names to RPM values');
    } else {
      toolRateLimits = {};
      for (const [tool, rpm] of Object.entries(obj['toolRateLimits'] as Record<string, unknown>)) {
        const n = Number(rpm);
        if (!Number.isInteger(n) || n < 1 || n > 100000) {
          v.error(`toolRateLimits.${tool}`, `Rate limit for tool "${tool}" must be an integer between 1 and 100000`, rpm);
        } else {
          toolRateLimits[tool] = n;
        }
      }
    }
  }

  // --- Warnings for recommended settings ---
  if (port === 80 || port === 443) {
    v.warn('port', `Using privileged port ${port} requires elevated permissions`);
  }
  if (host === '0.0.0.0') {
    v.warn('host', 'Binding to 0.0.0.0 exposes the server on all interfaces — ensure firewall rules are in place');
  }
  if (!enableAuth) {
    v.warn('enableAuth', 'OAuth authentication is disabled — consider enabling it in production');
  }
  if (!enableRateLimit) {
    v.warn('enableRateLimit', 'Rate limiting is disabled — consider enabling it to protect against abuse');
  }

  const { errors, warnings } = v.result();

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  return {
    valid: true,
    errors: [],
    warnings,
    config: {
      port: port!,
      host: host!,
      sourcePath: sourcePath!,
      dbPath,
      enableAuth: enableAuth ?? false,
      enableRateLimit: enableRateLimit ?? false,
      rateLimitRPM: rateLimitRPM ?? 600,
      enableAudit: enableAudit ?? false,
      sessionTTLMs: sessionTTLMs ?? 24 * 60 * 60 * 1000,
      maxConcurrentExecutions: maxConcurrentExecutions ?? 0,
      maxQueueDepth: maxQueueDepth ?? 0,
      toolRateLimits,
      enableHotReload: enableHotReload ?? false,
      hotReloadDebounceMs: hotReloadDebounceMs ?? 500,
      enableMetrics: enableMetrics ?? false,
      gracefulShutdownTimeoutMs: gracefulShutdownTimeoutMs ?? 30000,
    },
  };
}

/**
 * Format validation errors into a human-readable string for CLI output.
 */
export function formatValidationErrors(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.errors.length > 0) {
    lines.push('Configuration errors:');
    for (const err of result.errors) {
      lines.push(`  ✗ [${err.field}] ${err.message}`);
      if (err.value !== undefined) lines.push(`    Got: ${JSON.stringify(err.value)}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('Configuration warnings:');
    for (const warn of result.warnings) {
      lines.push(`  ⚠ [${warn.field}] ${warn.message}`);
    }
  }

  return lines.join('\n');
}
