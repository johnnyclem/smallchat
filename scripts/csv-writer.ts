/**
 * CSV spreadsheet writer for e2e benchmark results.
 */

import { writeFileSync } from 'node:fs';

export interface RunResult {
  model: string;
  contextWindow: string;
  jobName: string;
  jobMode: string;
  inputTokens: number;
  outputTokens: number;
  inputCostUSD: number;
  outputCostUSD: number;
  totalCostUSD: number;
  inferenceTimeMs: number;
  reasoningTimeMs: number;
  errors: string[];
  toolMisfires: string[];
  anomalies: string[];
  exitCode: number;
}

const CSV_HEADERS = [
  'Model',
  'Context Window',
  'Job Name',
  'Job Mode',
  'Input Tokens',
  'Output Tokens',
  'Total Tokens',
  'Input Cost (USD)',
  'Output Cost (USD)',
  'Total Cost (USD)',
  'Inference Time (s)',
  'Reasoning Time (s)',
  'Exit Code',
  'Error Count',
  'Tool Misfire Count',
  'Errors',
  'Tool Misfires',
  'Anomalies',
];

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function writeCSV(results: RunResult[], outputPath: string): void {
  const rows = [CSV_HEADERS.join(',')];

  for (const r of results) {
    rows.push(
      [
        escapeCSV(r.model),
        escapeCSV(r.contextWindow),
        escapeCSV(r.jobName),
        escapeCSV(r.jobMode),
        r.inputTokens.toString(),
        r.outputTokens.toString(),
        (r.inputTokens + r.outputTokens).toString(),
        r.inputCostUSD.toFixed(6),
        r.outputCostUSD.toFixed(6),
        r.totalCostUSD.toFixed(6),
        (r.inferenceTimeMs / 1000).toFixed(2),
        (r.reasoningTimeMs / 1000).toFixed(2),
        r.exitCode.toString(),
        r.errors.length.toString(),
        r.toolMisfires.length.toString(),
        escapeCSV(r.errors.join(' | ')),
        escapeCSV(r.toolMisfires.join(' | ')),
        escapeCSV(r.anomalies.join(' | ')),
      ].join(','),
    );
  }

  writeFileSync(outputPath, rows.join('\n') + '\n');
}

/**
 * Write a summary report (human-readable) alongside the CSV.
 */
export function writeSummaryReport(results: RunResult[], outputPath: string): void {
  const lines: string[] = [];
  lines.push('=' .repeat(80));
  lines.push('SMALLCHAT MCP E2E BENCHMARK REPORT');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('=' .repeat(80));
  lines.push('');

  // Group by model
  const byModel = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = `${r.model} (${r.contextWindow})`;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(r);
  }

  for (const [modelKey, runs] of byModel) {
    lines.push(`\n${'─'.repeat(60)}`);
    lines.push(`MODEL: ${modelKey}`);
    lines.push('─'.repeat(60));

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let totalTime = 0;
    let totalErrors = 0;
    let totalMisfires = 0;

    for (const r of runs) {
      lines.push(`  ${r.jobName} [${r.jobMode}]`);
      lines.push(`    Tokens:  ${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out`);
      lines.push(`    Cost:    $${r.totalCostUSD.toFixed(4)} ($${r.inputCostUSD.toFixed(4)} in + $${r.outputCostUSD.toFixed(4)} out)`);
      lines.push(`    Time:    ${(r.inferenceTimeMs / 1000).toFixed(1)}s inference, ${(r.reasoningTimeMs / 1000).toFixed(1)}s reasoning`);
      if (r.errors.length > 0) {
        lines.push(`    ERRORS:  ${r.errors.join('; ')}`);
      }
      if (r.toolMisfires.length > 0) {
        lines.push(`    MISFIRES: ${r.toolMisfires.join('; ')}`);
      }
      if (r.anomalies.length > 0) {
        lines.push(`    ANOMALIES: ${r.anomalies.join('; ')}`);
      }
      lines.push('');

      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      totalCost += r.totalCostUSD;
      totalTime += r.inferenceTimeMs;
      totalErrors += r.errors.length;
      totalMisfires += r.toolMisfires.length;
    }

    lines.push(`  SUBTOTAL for ${modelKey}:`);
    lines.push(`    Tokens:  ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`);
    lines.push(`    Cost:    $${totalCost.toFixed(4)}`);
    lines.push(`    Time:    ${(totalTime / 1000).toFixed(1)}s total`);
    lines.push(`    Errors:  ${totalErrors}  |  Misfires: ${totalMisfires}`);
  }

  // Grand totals
  const grandInput = results.reduce((s, r) => s + r.inputTokens, 0);
  const grandOutput = results.reduce((s, r) => s + r.outputTokens, 0);
  const grandCost = results.reduce((s, r) => s + r.totalCostUSD, 0);
  const grandTime = results.reduce((s, r) => s + r.inferenceTimeMs, 0);

  lines.push(`\n${'═'.repeat(80)}`);
  lines.push('GRAND TOTALS');
  lines.push(`  Total runs:    ${results.length}`);
  lines.push(`  Total tokens:  ${grandInput.toLocaleString()} in / ${grandOutput.toLocaleString()} out`);
  lines.push(`  Total cost:    $${grandCost.toFixed(4)}`);
  lines.push(`  Total time:    ${(grandTime / 1000).toFixed(1)}s`);
  lines.push('═'.repeat(80));

  writeFileSync(outputPath, lines.join('\n') + '\n');
}
