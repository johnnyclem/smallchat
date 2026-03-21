/**
 * backup.ts — CLI command to export runtime state.
 *
 * Exports:
 *   - Compiled artifact (.json)
 *   - Session database (SQLite)
 *   - Flight recorder log
 *   - Metrics snapshot
 *
 * Usage:
 *   smallchat backup --output ./backups/backup-2026-03-21.tar
 *   smallchat backup --source smallchat.db --output ./backup.json --format json
 */

import { Command } from 'commander';
import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { FlightRecorder } from '../../observability/flight-recorder.js';
import { metricsRegistry } from '../../observability/metrics.js';
import { rootLogger } from '../../observability/logger.js';

const log = rootLogger.child({ component: 'backup' });

// ---------------------------------------------------------------------------
// Backup manifest
// ---------------------------------------------------------------------------

interface BackupManifest {
  version: string;
  createdAt: string;
  files: Array<{ name: string; path: string; type: string; sizeBytes: number }>;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// backup command
// ---------------------------------------------------------------------------

export const backupCommand = new Command('backup')
  .description('Export runtime state to a backup archive')
  .option('-s, --source <path>', 'Source directory to backup', '.')
  .option('-o, --output <path>', 'Output directory or file path', './smallchat-backup')
  .option('--db-path <path>', 'SQLite sessions database path', 'smallchat.db')
  .option('--artifact <path>', 'Compiled artifact .json path')
  .option('--flight-recorder <path>', 'Flight recorder log path', 'smallchat-flight.ndjson')
  .option('--include-metrics', 'Include metrics snapshot in backup', false)
  .option('--format <format>', 'Output format: json|directory', 'directory')
  .action(async (options) => {
    const outputPath = resolve(options.output);
    const dbPath = resolve(options.dbPath);
    const flightPath = resolve(options.flightRecorder);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = options.format === 'json'
      ? dirname(outputPath)
      : join(outputPath, `backup-${timestamp}`);

    // Ensure output directory exists
    mkdirSync(backupDir, { recursive: true });

    const manifest: BackupManifest = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      files: [],
      metadata: {
        nodeVersion: process.version,
        platform: process.platform,
      },
    };

    console.log(`Creating backup in: ${backupDir}`);

    // 1. Copy SQLite session database
    if (existsSync(dbPath)) {
      const destPath = join(backupDir, 'sessions.db');
      copyFileSync(dbPath, destPath);
      const stat = statSync(destPath);
      manifest.files.push({ name: 'sessions.db', path: destPath, type: 'sqlite', sizeBytes: stat.size });
      console.log(`  ✓ Sessions database: ${stat.size} bytes`);
    } else {
      console.log(`  ⚠ Sessions database not found: ${dbPath}`);
    }

    // 2. Copy compiled artifact if specified or auto-detected
    const artifactPath = options.artifact
      ? resolve(options.artifact)
      : findArtifact(resolve(options.source));

    if (artifactPath && existsSync(artifactPath)) {
      const destPath = join(backupDir, 'artifact.json');
      copyFileSync(artifactPath, destPath);
      const stat = statSync(destPath);
      manifest.files.push({ name: 'artifact.json', path: destPath, type: 'artifact', sizeBytes: stat.size });
      console.log(`  ✓ Compiled artifact: ${stat.size} bytes`);
    } else {
      console.log(`  ⚠ No compiled artifact found (run 'smallchat compile' first)`);
    }

    // 3. Copy flight recorder log
    if (existsSync(flightPath)) {
      const destPath = join(backupDir, 'flight.ndjson');
      copyFileSync(flightPath, destPath);
      const stat = statSync(destPath);
      const records = FlightRecorder.load(flightPath);
      const analysis = FlightRecorder.analyze(records);
      manifest.files.push({ name: 'flight.ndjson', path: destPath, type: 'flight-recorder', sizeBytes: stat.size });
      manifest.metadata['flightRecorder'] = analysis;
      console.log(`  ✓ Flight recorder: ${records.length} entries, ${stat.size} bytes`);
    } else {
      console.log(`  ⚠ Flight recorder log not found: ${flightPath}`);
    }

    // 4. Metrics snapshot (optional)
    if (options.includeMetrics) {
      const metricsData = metricsRegistry.toJSON();
      const destPath = join(backupDir, 'metrics.json');
      writeFileSync(destPath, JSON.stringify(metricsData, null, 2), 'utf-8');
      const stat = statSync(destPath);
      manifest.files.push({ name: 'metrics.json', path: destPath, type: 'metrics', sizeBytes: stat.size });
      console.log(`  ✓ Metrics snapshot: ${stat.size} bytes`);
    }

    // Write manifest
    const manifestPath = join(backupDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`  ✓ Manifest written: ${manifestPath}`);

    // Summary
    const totalBytes = manifest.files.reduce((acc, f) => acc + f.sizeBytes, 0);
    console.log(`\nBackup complete: ${manifest.files.length} files, ${(totalBytes / 1024).toFixed(1)} KB`);
    console.log(`Location: ${backupDir}`);
  });

function findArtifact(dir: string): string | null {
  if (!existsSync(dir)) return null;

  // Look for .json files in the root first
  for (const name of ['artifact.json', 'smallchat-artifact.json', 'compiled.json']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }

  // Walk one level deep
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isFile() && entry.endsWith('.json')) {
        try {
          const data = JSON.parse(readFileSync(p, 'utf-8'));
          if (data.version && data.stats && data.dispatchTables) return p;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return null;
}
