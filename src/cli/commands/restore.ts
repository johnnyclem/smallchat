/**
 * restore.ts — CLI command to import runtime state from a backup.
 *
 * Restores:
 *   - Session database (SQLite)
 *   - Compiled artifact (.json)
 *   - Flight recorder log
 *
 * Usage:
 *   smallchat restore --input ./smallchat-backup/backup-2026-03-21
 *   smallchat restore --input ./backup --db-path ./smallchat.db --dry-run
 */

import { Command } from 'commander';
import {
  existsSync,
  readFileSync,
  copyFileSync,
  statSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { FlightRecorder } from '../../observability/flight-recorder.js';

// ---------------------------------------------------------------------------
// restore command
// ---------------------------------------------------------------------------

export const restoreCommand = new Command('restore')
  .description('Restore runtime state from a backup')
  .requiredOption('-i, --input <path>', 'Backup directory to restore from')
  .option('--db-path <path>', 'Target SQLite sessions database path', 'smallchat.db')
  .option('--artifact-output <path>', 'Target path for compiled artifact', 'artifact.json')
  .option('--flight-output <path>', 'Target path for flight recorder log', 'smallchat-flight.ndjson')
  .option('--dry-run', 'Preview what would be restored without making changes', false)
  .option('--force', 'Overwrite existing files without prompting', false)
  .action(async (options) => {
    const inputDir = resolve(options.input);

    if (!existsSync(inputDir)) {
      console.error(`Error: Backup directory not found: ${inputDir}`);
      process.exit(1);
    }

    // Read manifest
    const manifestPath = join(inputDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      console.error(`Error: No manifest.json found in ${inputDir}`);
      console.error('This may not be a valid smallchat backup.');
      process.exit(1);
    }

    let manifest: {
      version: string;
      createdAt: string;
      files: Array<{ name: string; path: string; type: string; sizeBytes: number }>;
      metadata: Record<string, unknown>;
    };

    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      console.error(`Error: Failed to parse manifest: ${(err as Error).message}`);
      process.exit(1);
    }

    console.log(`Backup created: ${manifest.createdAt}`);
    console.log(`Files in backup: ${manifest.files.length}`);

    if (options.dryRun) {
      console.log('\n[DRY RUN] Would restore:');
    } else {
      console.log('\nRestoring:');
    }

    let restored = 0;
    let skipped = 0;

    for (const file of manifest.files) {
      const srcPath = join(inputDir, file.name);

      if (!existsSync(srcPath)) {
        console.log(`  ⚠ Skipping ${file.name}: not found in backup`);
        skipped++;
        continue;
      }

      let destPath: string;
      switch (file.type) {
        case 'sqlite':
          destPath = resolve(options.dbPath);
          break;
        case 'artifact':
          destPath = resolve(options.artifactOutput);
          break;
        case 'flight-recorder':
          destPath = resolve(options.flightOutput);
          break;
        case 'metrics':
          // Metrics are informational — restore to a temp file only
          destPath = resolve('metrics-restored.json');
          break;
        default:
          console.log(`  ⚠ Unknown file type: ${file.type} (${file.name})`);
          skipped++;
          continue;
      }

      // Check for existing file
      if (existsSync(destPath) && !options.force) {
        if (!options.dryRun) {
          const stat = statSync(destPath);
          console.log(`  ⚠ Skipping ${file.name}: ${destPath} already exists (${stat.size} bytes) — use --force to overwrite`);
          skipped++;
          continue;
        }
      }

      if (options.dryRun) {
        console.log(`  → ${file.name} (${file.sizeBytes} bytes) → ${destPath}`);
      } else {
        copyFileSync(srcPath, destPath);
        console.log(`  ✓ ${file.name} (${file.sizeBytes} bytes) → ${destPath}`);
        restored++;
      }
    }

    // Show flight recorder analysis if restored
    const flightSrc = join(inputDir, 'flight.ndjson');
    if (existsSync(flightSrc) && !options.dryRun) {
      const records = FlightRecorder.load(flightSrc);
      if (records.length > 0) {
        const analysis = FlightRecorder.analyze(records);
        console.log('\nFlight recorder analysis:');
        console.log(`  Total dispatches : ${analysis.total}`);
        console.log(`  Successes        : ${analysis.successes}`);
        console.log(`  Failures         : ${analysis.failures}`);
        console.log(`  Cache hits       : ${analysis.cacheHits}`);
        console.log(`  Fallbacks        : ${analysis.fallbacks}`);
        console.log(`  Avg latency      : ${analysis.avgDurationMs.toFixed(1)}ms`);
        if (analysis.topIntents.length > 0) {
          console.log('  Top intents:');
          for (const { intent, count } of analysis.topIntents.slice(0, 5)) {
            console.log(`    ${count}x "${intent}"`);
          }
        }
      }
    }

    if (!options.dryRun) {
      console.log(`\nRestore complete: ${restored} restored, ${skipped} skipped`);
    } else {
      console.log('\n[DRY RUN] No files were modified');
    }
  });
