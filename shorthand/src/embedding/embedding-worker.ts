/**
 * embedding-worker.ts — Worker Thread hosting ONNXEmbedder + SqliteVectorIndex.
 *
 * Runs ONNX inference and sqlite-vec queries off the main event loop,
 * preventing CPU-bound embedding work from blocking concurrent requests.
 *
 * Protocol: receives typed request messages, replies with { id, data } or { id, error }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { ONNXEmbedder } from './onnx-embedder.js';
import type { ONNXEmbedderOptions } from './onnx-embedder.js';
import { SqliteVectorIndex } from './sqlite-vector-index.js';

// Pre-load native addons via require() to avoid ESM worker thread issues
// with native .node bindings that don't self-register under ESM workers.
const require = createRequire(import.meta.url);
try { require('onnxruntime-node'); } catch { /* will be loaded by ONNXEmbedder */ }
try { require('better-sqlite3'); } catch { /* will be loaded by SqliteVectorIndex */ }

if (!parentPort) {
  throw new Error('embedding-worker.ts must be run as a Worker Thread');
}

// ---------------------------------------------------------------------------
// Message types (shared with proxy classes)
// ---------------------------------------------------------------------------

export interface WorkerRequest {
  id: number;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
}

export interface WorkerResponse {
  id: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  error?: string;
}

export interface WorkerInitData {
  embedderOptions?: ONNXEmbedderOptions;
  vectorIndexDbPath?: string;
  vectorIndexDimensions?: number;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

const initData = workerData as WorkerInitData | undefined;

let embedder: ONNXEmbedder | null = null;
let vectorIndex: SqliteVectorIndex | null = null;

function getEmbedder(): ONNXEmbedder {
  if (!embedder) {
    embedder = new ONNXEmbedder(initData?.embedderOptions);
  }
  return embedder;
}

function getVectorIndex(): SqliteVectorIndex {
  if (!vectorIndex) {
    vectorIndex = new SqliteVectorIndex(
      initData?.vectorIndexDbPath ?? ':memory:',
      initData?.vectorIndexDimensions ?? 384,
    );
  }
  return vectorIndex;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(msg: WorkerRequest): Promise<WorkerResponse> {
  const { id, type, payload } = msg;

  try {
    switch (type) {
      // --- Embedder operations ---
      case 'embed': {
        const emb = getEmbedder();
        const vector = await emb.embed(payload.text as string);
        // Transfer the underlying ArrayBuffer for zero-copy
        return { id, data: { vector } };
      }

      case 'embedBatch': {
        const emb = getEmbedder();
        const vectors = await emb.embedBatch(payload.texts as string[]);
        return { id, data: { vectors } };
      }

      case 'embedDimensions': {
        const emb = getEmbedder();
        return { id, data: { dimensions: emb.dimensions } };
      }

      // --- VectorIndex operations ---
      case 'vectorInsert': {
        const idx = getVectorIndex();
        const vector = new Float32Array(payload.vector);
        idx.insert(payload.id as string, vector);
        return { id, data: {} };
      }

      case 'vectorSearch': {
        const idx = getVectorIndex();
        const query = new Float32Array(payload.query);
        const results = idx.search(query, payload.topK as number, payload.threshold as number);
        return { id, data: { results } };
      }

      case 'vectorRemove': {
        const idx = getVectorIndex();
        idx.remove(payload.id as string);
        return { id, data: {} };
      }

      case 'vectorSize': {
        const idx = getVectorIndex();
        return { id, data: { size: idx.size() } };
      }

      case 'vectorInsertBatch': {
        const idx = getVectorIndex();
        const entries = (payload.entries as Array<{ id: string; vector: ArrayBuffer }>).map(e => ({
          id: e.id,
          vector: new Float32Array(e.vector),
        }));
        idx.insertBatch(entries);
        return { id, data: {} };
      }

      case 'vectorStats': {
        const idx = getVectorIndex();
        return { id, data: idx.stats() };
      }

      case 'vectorCompact': {
        const idx = getVectorIndex();
        idx.compact();
        return { id, data: {} };
      }

      case 'vectorClose': {
        if (vectorIndex) {
          vectorIndex.close();
          vectorIndex = null;
        }
        return { id, data: {} };
      }

      case 'shutdown': {
        if (vectorIndex) {
          vectorIndex.close();
          vectorIndex = null;
        }
        embedder = null;
        return { id, data: {} };
      }

      default:
        return { id, error: `Unknown message type: ${type}` };
    }
  } catch (err) {
    return { id, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

parentPort.on('message', async (msg: WorkerRequest) => {
  const response = await handleRequest(msg);
  parentPort!.postMessage(response);
});

// Signal ready
parentPort.postMessage({ id: -1, data: { ready: true } });
