/**
 * SseBroker — per-session SSE connection registry with fan-out notifications.
 *
 * Wire format per event:
 *   event: <kind>
 *   data: <JSON envelope>
 *   id: <monotonic seq>
 *   <blank line>
 */

import type { ServerResponse } from 'node:http';
import type { SseEventKind, SseEnvelope } from './types.js';

export class SseBroker {
  private streams = new Map<string, Set<ServerResponse>>();
  private seqMap = new Map<string, number>();

  /**
   * Attach an SSE response to a session.
   * Returns a cleanup function that removes the connection.
   */
  connect(sessionId: string, res: ServerResponse): () => void {
    if (!this.streams.has(sessionId)) {
      this.streams.set(sessionId, new Set());
    }
    this.streams.get(sessionId)!.add(res);

    const cleanup = () => {
      this.streams.get(sessionId)?.delete(res);
      if (this.streams.get(sessionId)?.size === 0) {
        this.streams.delete(sessionId);
      }
    };

    res.on('close', cleanup);
    return cleanup;
  }

  /**
   * Emit a typed event to all SSE streams for the given session.
   */
  emit(sessionId: string, kind: SseEventKind, payload: Record<string, unknown>): void {
    const conns = this.streams.get(sessionId);
    if (!conns || conns.size === 0) return;

    const seq = (this.seqMap.get(sessionId) ?? 0) + 1;
    this.seqMap.set(sessionId, seq);

    const envelope: SseEnvelope = {
      sessionId,
      ts: new Date().toISOString(),
      seq,
      kind,
      payload,
    };

    const line = `event: ${kind}\ndata: ${JSON.stringify(envelope)}\nid: ${seq}\n\n`;

    for (const res of conns) {
      try {
        res.write(line);
      } catch {
        // Client disconnected mid-write; cleanup via 'close' event
      }
    }
  }

  /**
   * Close and remove all SSE streams for a session (on shutdown/expiry).
   */
  disconnectSession(sessionId: string): void {
    const conns = this.streams.get(sessionId);
    if (!conns) return;
    for (const res of conns) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.streams.delete(sessionId);
    this.seqMap.delete(sessionId);
  }

  /** Number of active connections for a session (useful for tests). */
  connectionCount(sessionId: string): number {
    return this.streams.get(sessionId)?.size ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Typed notification helpers
  // ---------------------------------------------------------------------------

  notifyToolsChanged(sessionId: string, snapshot: string): void {
    this.emit(sessionId, 'tools/list_changed', { snapshot });
  }

  notifyResourceChanged(sessionId: string, resourceId: string): void {
    this.emit(sessionId, 'resourceChanged', { resourceId });
  }

  notifyProgress(
    sessionId: string,
    invocationId: string,
    data: Record<string, unknown>,
  ): void {
    this.emit(sessionId, 'progress', { invocationId, ...data });
  }

  notifyStreamEvent(
    sessionId: string,
    invocationId: string,
    data: Record<string, unknown>,
  ): void {
    this.emit(sessionId, 'stream', { invocationId, ...data });
  }
}
