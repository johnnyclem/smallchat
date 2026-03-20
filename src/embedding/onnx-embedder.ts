import type { Embedder } from '../core/types.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Dynamic import for onnxruntime-node (ESM compatible)
type OrtModule = typeof import('onnxruntime-node');
type InferenceSession = import('onnxruntime-node').InferenceSession;
type OrtTensor = import('onnxruntime-node').Tensor;

/**
 * ONNXEmbedder — generates 384-dimensional semantic embeddings
 * using the all-MiniLM-L6-v2 model via ONNX Runtime.
 *
 * Replaces the hash-based LocalEmbedder with real semantic vectors.
 * Includes a built-in WordPiece tokenizer (parsed from tokenizer.json).
 */
export class ONNXEmbedder implements Embedder {
  readonly dimensions: number = 384;

  private session: InferenceSession | null = null;
  private ort: OrtModule | null = null;
  private tokenizer: WordPieceTokenizer | null = null;
  private modelPath: string;
  private tokenizerPath: string;
  private maxLength: number;
  private ready: Promise<void>;

  /** Simple LRU embedding cache */
  private cache: Map<string, Float32Array> = new Map();
  private cacheMaxSize: number;

  constructor(options?: ONNXEmbedderOptions) {
    const modelsDir = options?.modelsDir ?? resolveDefaultModelsDir();
    this.modelPath = options?.modelPath ?? resolve(modelsDir, 'model_quantized.onnx');
    this.tokenizerPath = options?.tokenizerPath ?? resolve(modelsDir, 'tokenizer.json');
    this.maxLength = options?.maxLength ?? 128;
    this.cacheMaxSize = options?.cacheSize ?? 2048;

    // Eagerly start loading (but don't block constructor)
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    // Validate model file exists
    if (!existsSync(this.modelPath)) {
      throw new Error(
        `ONNX model not found at ${this.modelPath}. ` +
        'Run "smallchat doctor" to diagnose, or download the model manually.',
      );
    }
    if (!existsSync(this.tokenizerPath)) {
      throw new Error(
        `Tokenizer not found at ${this.tokenizerPath}. ` +
        'Ensure tokenizer.json is in the models/ directory.',
      );
    }

    // Validate model integrity (SHA256)
    validateModelIntegrity(this.modelPath);

    // Load tokenizer synchronously (it's a JSON file)
    const tokenizerData = JSON.parse(readFileSync(this.tokenizerPath, 'utf-8'));
    this.tokenizer = new WordPieceTokenizer(tokenizerData, this.maxLength);

    // Load ONNX runtime and model
    this.ort = await import('onnxruntime-node');
    this.session = await this.ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
    });

    // Warm-up: run one dummy embedding to trigger JIT compilation
    await this.embedInternal('warmup');
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ready;

    // Check cache
    const cached = this.cache.get(text);
    if (cached) return cached;

    const result = await this.embedInternal(text);

    // Store in cache (evict oldest if full)
    if (this.cache.size >= this.cacheMaxSize) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(text, result);

    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ready;

    // Check which texts need embedding
    const results: (Float32Array | null)[] = texts.map(t => this.cache.get(t) ?? null);
    const uncachedIndices = results
      .map((r, i) => (r === null ? i : -1))
      .filter(i => i >= 0);

    if (uncachedIndices.length === 0) {
      return results as Float32Array[];
    }

    // Batch embed uncached texts
    const uncachedTexts = uncachedIndices.map(i => texts[i]);
    const embeddings = await this.embedBatchInternal(uncachedTexts);

    // Fill results and cache
    for (let j = 0; j < uncachedIndices.length; j++) {
      const idx = uncachedIndices[j];
      results[idx] = embeddings[j];

      if (this.cache.size >= this.cacheMaxSize) {
        const firstKey = this.cache.keys().next().value!;
        this.cache.delete(firstKey);
      }
      this.cache.set(texts[idx], embeddings[j]);
    }

    return results as Float32Array[];
  }

  /** Returns the number of cached embeddings */
  get cacheCount(): number {
    return this.cache.size;
  }

  /** Clear the embedding cache */
  clearCache(): void {
    this.cache.clear();
  }

  private async embedInternal(text: string): Promise<Float32Array> {
    const results = await this.embedBatchInternal([text]);
    return results[0];
  }

  private async embedBatchInternal(texts: string[]): Promise<Float32Array[]> {
    const session = this.session!;
    const ort = this.ort!;
    const tokenizer = this.tokenizer!;

    const batchSize = texts.length;
    const encoded = texts.map(t => tokenizer.encode(t));
    const seqLen = this.maxLength;

    // Create padded tensors
    const inputIds = new BigInt64Array(batchSize * seqLen);
    const attentionMask = new BigInt64Array(batchSize * seqLen);
    const tokenTypeIds = new BigInt64Array(batchSize * seqLen);

    for (let b = 0; b < batchSize; b++) {
      const { inputIds: ids, attentionMask: mask } = encoded[b];
      const offset = b * seqLen;
      for (let i = 0; i < ids.length; i++) {
        inputIds[offset + i] = BigInt(ids[i]);
        attentionMask[offset + i] = BigInt(mask[i]);
      }
      // tokenTypeIds stays 0 (single sentence)
      // Remaining positions stay 0 (padding)
    }

    const feeds: Record<string, OrtTensor> = {
      input_ids: new ort.Tensor('int64', inputIds, [batchSize, seqLen]),
      attention_mask: new ort.Tensor('int64', attentionMask, [batchSize, seqLen]),
      token_type_ids: new ort.Tensor('int64', tokenTypeIds, [batchSize, seqLen]),
    };

    const output = await session.run(feeds);
    const lastHiddenState = output['last_hidden_state'];
    const data = lastHiddenState.data as Float32Array;
    const hiddenSize = this.dimensions;

    // Mean pooling with attention mask
    const results: Float32Array[] = [];
    for (let b = 0; b < batchSize; b++) {
      const embedding = new Float32Array(hiddenSize);
      const { attentionMask: mask } = encoded[b];
      let tokenCount = 0;

      for (let t = 0; t < seqLen; t++) {
        if (mask[t] === 1) {
          tokenCount++;
          const baseIdx = (b * seqLen + t) * hiddenSize;
          for (let d = 0; d < hiddenSize; d++) {
            embedding[d] += data[baseIdx + d];
          }
        }
      }

      // Divide by token count
      if (tokenCount > 0) {
        for (let d = 0; d < hiddenSize; d++) {
          embedding[d] /= tokenCount;
        }
      }

      // L2 normalize
      let norm = 0;
      for (let d = 0; d < hiddenSize; d++) {
        norm += embedding[d] * embedding[d];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < hiddenSize; d++) {
          embedding[d] /= norm;
        }
      }

      results.push(embedding);
    }

    return results;
  }
}

export interface ONNXEmbedderOptions {
  /** Directory containing model_quantized.onnx and tokenizer.json */
  modelsDir?: string;
  /** Direct path to the ONNX model file */
  modelPath?: string;
  /** Direct path to tokenizer.json */
  tokenizerPath?: string;
  /** Maximum sequence length (default: 128) */
  maxLength?: number;
  /** Embedding cache size (default: 2048) */
  cacheSize?: number;
}

// ---------------------------------------------------------------------------
// Built-in WordPiece tokenizer (BERT-style)
// ---------------------------------------------------------------------------

interface TokenizerConfig {
  model: {
    type: string;
    vocab: Record<string, number>;
    unk_token: string;
    continuing_subword_prefix: string;
    max_input_chars_per_word: number;
  };
  normalizer?: {
    type: string;
    lowercase?: boolean;
    strip_accents?: boolean | null;
    clean_text?: boolean;
    handle_chinese_chars?: boolean;
  };
  truncation?: {
    max_length: number;
  };
}

interface EncodedInput {
  inputIds: number[];
  attentionMask: number[];
}

class WordPieceTokenizer {
  private vocab: Map<string, number>;
  private unkTokenId: number;
  private clsTokenId: number;
  private sepTokenId: number;
  private subwordPrefix: string;
  private maxInputCharsPerWord: number;
  private maxLength: number;
  private lowercase: boolean;

  constructor(config: TokenizerConfig, maxLength: number) {
    this.vocab = new Map(Object.entries(config.model.vocab));
    this.unkTokenId = this.vocab.get(config.model.unk_token) ?? 100;
    this.clsTokenId = this.vocab.get('[CLS]') ?? 101;
    this.sepTokenId = this.vocab.get('[SEP]') ?? 102;
    this.subwordPrefix = config.model.continuing_subword_prefix ?? '##';
    this.maxInputCharsPerWord = config.model.max_input_chars_per_word ?? 100;
    this.maxLength = maxLength;
    this.lowercase = config.normalizer?.lowercase ?? true;
  }

  encode(text: string): EncodedInput {
    // Normalize
    let normalized = text;
    if (this.lowercase) {
      normalized = normalized.toLowerCase();
    }
    // Clean text: replace control chars with space
    normalized = normalized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
    // Strip accents
    normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // BERT pre-tokenization: split on whitespace and punctuation
    const words = this.preTokenize(normalized);

    // WordPiece tokenization
    const tokenIds: number[] = [this.clsTokenId];

    for (const word of words) {
      if (tokenIds.length >= this.maxLength - 1) break;

      const subTokenIds = this.wordPieceTokenize(word);
      for (const id of subTokenIds) {
        if (tokenIds.length >= this.maxLength - 1) break;
        tokenIds.push(id);
      }
    }

    tokenIds.push(this.sepTokenId);

    // Build attention mask
    const attentionMask = new Array(tokenIds.length).fill(1);

    return { inputIds: tokenIds, attentionMask };
  }

  private preTokenize(text: string): string[] {
    // BERT pre-tokenization: split on whitespace, add spaces around punctuation
    // and CJK characters
    const tokens: string[] = [];
    let current = '';

    for (const char of text) {
      if (this.isWhitespace(char)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else if (this.isPunctuation(char)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        tokens.push(char);
      } else if (this.isCjk(char)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        tokens.push(char);
      } else {
        current += char;
      }
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  private wordPieceTokenize(word: string): number[] {
    if (word.length > this.maxInputCharsPerWord) {
      return [this.unkTokenId];
    }

    const tokens: number[] = [];
    let start = 0;

    while (start < word.length) {
      let end = word.length;
      let foundId: number | null = null;

      while (start < end) {
        const substr = start === 0
          ? word.slice(start, end)
          : this.subwordPrefix + word.slice(start, end);

        const id = this.vocab.get(substr);
        if (id !== undefined) {
          foundId = id;
          break;
        }
        end--;
      }

      if (foundId === null) {
        tokens.push(this.unkTokenId);
        break;
      }

      tokens.push(foundId);
      start = end;
    }

    return tokens;
  }

  private isWhitespace(char: string): boolean {
    const code = char.charCodeAt(0);
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || code === 0x00a0;
  }

  private isPunctuation(char: string): boolean {
    const code = char.charCodeAt(0);
    // ASCII punctuation ranges
    if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
        (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) {
      return true;
    }
    // Unicode general punctuation
    if (code >= 0x2000 && code <= 0x206F) return true;
    return false;
  }

  private isCjk(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||
      (code >= 0x2A700 && code <= 0x2B73F) ||
      (code >= 0x2B740 && code <= 0x2B81F) ||
      (code >= 0x2B820 && code <= 0x2CEAF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x2F800 && code <= 0x2FA1F)
    );
  }
}

// Known SHA256 hash of the official quantized all-MiniLM-L6-v2 model
const EXPECTED_MODEL_SHA256 = 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1';

/** Validate model file integrity via SHA256 */
function validateModelIntegrity(modelPath: string): void {
  const data = readFileSync(modelPath);
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== EXPECTED_MODEL_SHA256) {
    throw new Error(
      `Model integrity check failed.\n` +
      `  Expected SHA256: ${EXPECTED_MODEL_SHA256}\n` +
      `  Got:             ${hash}\n` +
      `  The model file at ${modelPath} may be corrupted or tampered with.\n` +
      `  Re-download from the official source.`,
    );
  }
}

/** Resolve the default models directory relative to the package root */
function resolveDefaultModelsDir(): string {
  // When running from source: project_root/models/
  // When running from dist: project_root/models/
  // Use __dirname equivalent for ESM
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // src/embedding/ -> project root -> models/
    return resolve(thisDir, '..', '..', 'models');
  } catch {
    // Fallback: cwd-relative
    return resolve(process.cwd(), 'models');
  }
}
