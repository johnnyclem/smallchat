/**
 * TraceView — visualizes the semantic distance between an intent
 * and the top N candidate tools.
 *
 * Shows:
 *  - A horizontal bar chart of confidence scores (1 - semantic distance)
 *  - Color coding: green (>0.9), yellow (0.7-0.9), red (<0.7)
 *  - The resolved tool highlighted
 *  - Whether cache was hit or fallback chain was used
 */

import React from 'react';
import type { DispatchRecord } from './types';

const styles = {
  container: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  } as React.CSSProperties,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  } as React.CSSProperties,
  intent: {
    fontSize: 14,
    fontWeight: 600,
    color: '#79c0ff',
    maxWidth: '60%',
    wordBreak: 'break-word' as const,
  } as React.CSSProperties,
  badges: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const,
    justifyContent: 'flex-end',
  } as React.CSSProperties,
  badge: (color: string): React.CSSProperties => ({
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 500,
    background: color,
    color: '#fff',
  }),
  candidateRow: {
    marginBottom: 8,
  } as React.CSSProperties,
  candidateLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 3,
    fontSize: 12,
  } as React.CSSProperties,
  toolName: (isResolved: boolean): React.CSSProperties => ({
    color: isResolved ? '#56d364' : '#c9d1d9',
    fontWeight: isResolved ? 600 : 400,
  }),
  barTrack: {
    background: '#21262d',
    borderRadius: 4,
    height: 8,
    overflow: 'hidden',
  } as React.CSSProperties,
  bar: (confidence: number, isResolved: boolean): React.CSSProperties => ({
    height: '100%',
    width: `${confidence * 100}%`,
    borderRadius: 4,
    background: isResolved
      ? '#238636'
      : confidence > 0.9
        ? '#1f6feb'
        : confidence > 0.7
          ? '#9e6a03'
          : '#da3633',
    transition: 'width 0.3s ease',
  }),
  meta: {
    display: 'flex',
    gap: 16,
    marginTop: 10,
    fontSize: 11,
    color: '#8b949e',
  } as React.CSSProperties,
  noCandidates: {
    color: '#8b949e',
    fontSize: 12,
    fontStyle: 'italic',
  } as React.CSSProperties,
};

interface TraceViewProps {
  record: DispatchRecord;
}

export function TraceView({ record }: TraceViewProps): React.ReactElement {
  const candidates = record.candidateTools ?? [];
  const resolvedTool = record.resolvedTool;

  // Build sorted candidates list (always show at least top 3)
  const displayCandidates = [...candidates]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  // If resolved tool isn't in candidates, add it with full confidence
  if (resolvedTool && !displayCandidates.find(c => c.tool === resolvedTool)) {
    displayCandidates.unshift({ tool: resolvedTool, confidence: 1.0 });
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.intent}>"{record.intent}"</div>
        <div style={styles.badges}>
          {record.success
            ? <span style={styles.badge('#1f6feb')}>✓ success</span>
            : <span style={styles.badge('#da3633')}>✗ error</span>
          }
          {record.cacheHit && <span style={styles.badge('#1a7f37')}>⚡ cache hit</span>}
          {record.usedFallback && <span style={styles.badge('#9e6a03')}>↩ fallback</span>}
          {record.durationMs != null && (
            <span style={styles.badge('#21262d')}>{record.durationMs}ms</span>
          )}
        </div>
      </div>

      {displayCandidates.length > 0 ? (
        <>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>
            Semantic distance to top {displayCandidates.length} candidates
          </div>
          {displayCandidates.map((candidate) => {
            const isResolved = candidate.tool === resolvedTool;
            const semanticDistance = 1 - candidate.confidence;
            return (
              <div key={candidate.tool} style={styles.candidateRow}>
                <div style={styles.candidateLabel}>
                  <span style={styles.toolName(isResolved)}>
                    {isResolved ? '→ ' : '   '}{candidate.tool}
                  </span>
                  <span style={{ color: '#8b949e' }}>
                    {(candidate.confidence * 100).toFixed(1)}%
                    <span style={{ marginLeft: 8, opacity: 0.7 }}>
                      (d={semanticDistance.toFixed(3)})
                    </span>
                  </span>
                </div>
                <div style={styles.barTrack}>
                  <div style={styles.bar(candidate.confidence, isResolved)} />
                </div>
              </div>
            );
          })}
        </>
      ) : resolvedTool ? (
        <div style={{ fontSize: 12, color: '#8b949e' }}>
          → Resolved to: <span style={{ color: '#56d364' }}>{resolvedTool}</span>
          {record.cacheHit && ' (from cache)'}
        </div>
      ) : (
        <div style={styles.noCandidates}>
          {record.error ? `Error: ${record.error}` : 'No tool resolved'}
        </div>
      )}

      {record.fallbackSteps && record.fallbackSteps.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11, color: '#8b949e', cursor: 'pointer' }}>
            Fallback chain ({record.fallbackSteps.length} steps)
          </summary>
          <div style={{ marginTop: 6 }}>
            {record.fallbackSteps.map((step, i) => (
              <div key={i} style={{ fontSize: 11, color: step.result === 'hit' ? '#56d364' : '#8b949e', padding: '2px 0' }}>
                {step.result === 'hit' ? '✓' : '✗'} [{step.strategy}] {step.tried}
              </div>
            ))}
          </div>
        </details>
      )}

      <div style={styles.meta}>
        <span>{new Date(record.timestamp).toLocaleTimeString()}</span>
        {record.selector && <span>sel: {record.selector.slice(0, 12)}…</span>}
      </div>
    </div>
  );
}
