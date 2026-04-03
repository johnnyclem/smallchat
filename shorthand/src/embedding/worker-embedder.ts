/**
 * WorkerEmbedder — an Embedder proxy that runs ONNX inference
 * on a dedicated Worker Thread, keeping the main event loop free.
 *
 * Implements the same Embedder interface as ONNXEmbedder, so it is
 * a transparent drop-in replacement anywhere ONNXEmbedder is used.
 */
import { Worker } from 'node:worker_threads';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { Embedder } from './types.js';
import type { ONNXEmbedderOptions } from './onnx-embedder.js';
import type { WorkerRequest, WorkerResponse, WorkerInitData } from './embedding-worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the path to the compiled embedding-worker.js.
 * Handles both running from dist/ (production) and src/ (vitest with ts transform).
 */
function resolveWorkerPath(): string {
  // First try: same directory as this module (works when running from dist/)
  const sameDirPath = resolve(__dirname, 'embedding-worker.js');
  if (existsSync(sameDirPath)) return sameDirPath;

  // Second try: dist/ equivalent when running from src/ (e.g. vitest)
  const distPath = resolve(__dirname, '..', '..', 'dist', 'embedding', 'embedding-worker.js');
  if (existsSync(distPath)) return distPath;

  // Fallback: assume same directory (will throw a clear error from Worker constructor)
  return sameDirPath;
}

/**
 * Shared Worker Thread bridge — manages a single worker that hosts
 * both ONNXEmbedder and SqliteVectorIndex. Multiple proxy instances
 * can share the same bridge.
 */
export class EmbeddingWorkerBridge {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ready: Promise<void>;
  private terminated = false;

  constructor(initData?: WorkerInitData) {
    const workerPath = resolveWorkerPath();

    this.worker = new Worker(workerPath, {
      workerData: initData,
    });

    this.ready = new Promise<void>((res, rej) => {
      const onReady = (msg: WorkerResponse) => {
        if (msg.id === -1 && msg.data?.ready) {
          this.worker.off('message', onReady);
          this.worker.off('error', onError);
          res();
        }
      };
      const onError = (err: Error) => {
        this.worker.off('message', onReady);
        rej(err);
      };
      this.worker.on('message', onReady);
      this.worker.once('error', onError);
    });

    // Route all subsequent messages to pending callbacks
    this.worker.on('message', (msg: WorkerResponse) => {
      if (msg.id === -1) return; // ready signal, already handled
      const cb = this.pending.get(msg.id);
      if (!cb) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        cb.reject(new Error(msg.error));
      } else {
        cb.resolve(msg.data);
      }
    });

    this.worker.on('error', (err) => {
      // Reject all pending requests
      for (const [, cb] of this.pending) {
        cb.reject(err);
      }
      this.pending.clear();
    });
  }

  /** Send a request to the worker and return a promise for the response data. */
  async request(type: string, payload?: any): Promise<any> {
    if (this.terminated) {
      throw new Error('EmbeddingWorkerBridge has been terminated');
    }
    await this.ready;
    const id = this.nextId++;
    const msg: WorkerRequest = { id, type, payload };

    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      // Use structured clone (copies Float32Arrays). Transfer is unsafe here
      // because callers may reuse the buffer after sending.
      this.worker.postMessage(msg);
    });
  }

  /** Gracefully shut down the worker. */
  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    try {
      await this.request('shutdown');
    } catch {
      // Worker may already be dead
    }
    await this.worker.terminate();
  }
}

/**
 * WorkerEmbedder — drop-in replacement for ONNXEmbedder that offloads
 * inference to a Worker Thread.
 */
export class WorkerEmbedder implements Embedder {
  readonly dimensions: number = 384;
  private bridge: EmbeddingWorkerBridge;

  constructor(bridge: EmbeddingWorkerBridge) {
    this.bridge = bridge;
  }

  async embed(text: string): Promise<Float32Array> {
    const data = await this.bridge.request('embed', { text });
    return new Float32Array(data.vector);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const data = await this.bridge.request('embedBatch', { texts });
    return (data.vectors as ArrayBuffer[]).map((buf: ArrayBuffer) => new Float32Array(buf));
  }
}

/**
 * Convenience factory: creates an EmbeddingWorkerBridge, WorkerEmbedder,
 * and optionally a WorkerVectorIndex from a single call.
 */
export function createWorkerEmbedder(options?: {
  embedderOptions?: ONNXEmbedderOptions;
  vectorIndexDbPath?: string;
  vectorIndexDimensions?: number;
}): { bridge: EmbeddingWorkerBridge; embedder: WorkerEmbedder } {
  const bridge = new EmbeddingWorkerBridge({
    embedderOptions: options?.embedderOptions,
    vectorIndexDbPath: options?.vectorIndexDbPath,
    vectorIndexDimensions: options?.vectorIndexDimensions,
  });
  const embedder = new WorkerEmbedder(bridge);
  return { bridge, embedder };
}
