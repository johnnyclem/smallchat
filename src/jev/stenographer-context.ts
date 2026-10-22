/**
 * StenographerJudgeContext — a JudgeContextProvider (core/judge.ts,
 * RuntimeOptions.judgeContext) that reads a running stenographer's REST
 * API, so the judge decides with the session's tombstones and transcript
 * in front of it: the TBs that bear on the intent (by stenographer's
 * relevance ranking when it serves `/truth/search`, else the current
 * ledger) and the newest lines of the session.
 *
 * Reads only: `GET /truth/search?q=…&k=…` (falling back to `GET /truth`
 * and `GET /tombstones`) and `GET /messages?n=…`, with the bearer token
 * stenographer's REST API wants. A stenographer that is down, slow or
 * refuses answers no context: the judge is then asked with the intent
 * alone, and nothing fails. The base URL must be loopback unless
 * `allowRemote` is set, since transcripts travel back.
 */

import type { JudgeContext, JudgeContextProvider, JudgeTranscriptLine, JudgeTruthEntry } from '../core/judge.js';
import { DEFAULT_JUDGE_CONTEXT_LIMITS, boundJudgeContext } from '../core/judge.js';
import { isLoopbackHost } from './system-one.js';

/** Where stenographer's daemon mode serves REST by default. */
export const DEFAULT_STENOGRAPHER_BASE_URL = 'http://127.0.0.1:8787';

export interface StenographerJudgeContextOptions {
  /** stenographer's REST root. Default DEFAULT_STENOGRAPHER_BASE_URL. */
  baseURL?: string;
  /** The REST bearer token (stenographer's `rest-token` file), unless it runs with --rest-insecure. */
  token?: string;
  /** Label for the work product, passed through as `subject`. */
  subject?: string;
  /** Most truth entries asked for (default 24) */
  maxTruth?: number;
  /** Most transcript lines asked for (default 12) */
  maxTranscript?: number;
  /** Longest text kept per entry or line (default 480) */
  maxTextChars?: number;
  /** Budget for both reads together, in milliseconds (default 1500). */
  timeoutMs?: number;
  /** Allow a non-loopback base URL. Default false. */
  allowRemote?: boolean;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** A truth entry as stenographer's REST API returns it (the fields read here). */
interface LedgerEntry {
  id?: unknown;
  type?: unknown;
  author?: unknown;
  body?: { status?: unknown; claim?: unknown; assertion?: unknown; evidence?: Array<{ kind?: unknown }>; literals?: unknown };
}

/** A message as `GET /messages` returns it (the fields read here). */
interface LedgerMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
}

const SETTLING = new Set(['command', 'test']);

/**
 * The grade stenographer's handoff assigns an entry: a TB with
 * reproducible evidence is verified, one signed on judgment asserted, a
 * backfilled one migration; an open UV is advisory. Anything else (a
 * refuted UV, an overridden TB, an unknown status) is left out.
 */
export function gradeLedgerEntry(entry: LedgerEntry): JudgeTruthEntry | null {
  const body = entry.body;
  if (!body || typeof entry.id !== 'string' || typeof body.status !== 'string') return null;
  if (entry.type === 'UV') {
    if (body.status !== 'open' || typeof body.assertion !== 'string') return null;
    return { id: entry.id, type: 'UV', status: body.status, text: body.assertion, grade: 'advisory' };
  }
  if (entry.type !== 'TB' || typeof body.claim !== 'string') return null;
  if (body.status !== 'active' && body.status !== 'contested') return null;
  const evidence = Array.isArray(body.evidence) ? body.evidence : [];
  const grade = evidence.some(e => typeof e?.kind === 'string' && SETTLING.has(e.kind)) ? 'verified' : entry.author === 'migration' ? 'migration' : 'asserted';
  const literals = Array.isArray(body.literals)
    ? (body.literals as Array<{ subject?: unknown; dead?: unknown; current?: unknown }>)
      .filter(l => l && typeof l.dead === 'string')
      .map(l => ({
        ...(typeof l.subject === 'string' ? { subject: l.subject } : {}),
        dead: l.dead as string,
        ...(typeof l.current === 'string' ? { current: l.current } : {}),
      }))
    : [];
  return { id: entry.id, type: 'TB', status: body.status, text: body.claim, ...(literals.length > 0 ? { literals } : {}), grade };
}

/** A conversation message as a transcript line, or null for one the judge should not see. */
export function transcriptLine(message: LedgerMessage): JudgeTranscriptLine | null {
  const role = message.role === 'user' || message.role === 'assistant' || message.role === 'tool' || message.role === 'system' ? message.role : null;
  if (!role || typeof message.content !== 'string' || message.content.trim() === '') return null;
  return { role, text: message.content, ...(typeof message.id === 'string' ? { id: message.id } : {}) };
}

function parseURL(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export class StenographerJudgeContext implements JudgeContextProvider {
  readonly name = 'stenographer';
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxTruth: number;
  readonly maxTranscript: number;
  readonly maxTextChars: number;
  readonly #token: string | null;
  readonly #subject: string | undefined;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(options: StenographerJudgeContextOptions = {}) {
    const invalid = (message: string): never => { throw new TypeError(`StenographerJudgeContext: ${message}`); };
    const url = parseURL(options.baseURL ?? DEFAULT_STENOGRAPHER_BASE_URL) ?? invalid('baseURL is not a valid URL');
    if (url.username || url.password) invalid('baseURL must not carry credentials');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid('baseURL must be http or https');
    if (!isLoopbackHost(url.hostname) && options.allowRemote !== true) invalid('baseURL must be a loopback host unless allowRemote is set (transcripts travel back)');
    this.baseURL = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    if (options.token !== undefined && (typeof options.token !== 'string' || /[^\x21-\x7e]/.test(options.token))) invalid('token must be a plain ASCII string');
    this.#token = options.token ?? null;
    this.#subject = options.subject;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.maxTruth = options.maxTruth ?? DEFAULT_JUDGE_CONTEXT_LIMITS.maxTruth;
    this.maxTranscript = options.maxTranscript ?? DEFAULT_JUDGE_CONTEXT_LIMITS.maxTranscript;
    this.maxTextChars = options.maxTextChars ?? DEFAULT_JUDGE_CONTEXT_LIMITS.maxTextChars;
    for (const [name, value] of [['timeoutMs', this.timeoutMs], ['maxTruth', this.maxTruth], ['maxTranscript', this.maxTranscript], ['maxTextChars', this.maxTextChars]] as const) {
      if (!(Number.isInteger(value) && value > 0)) invalid(`${name} must be a positive integer`);
    }
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** The context for an intent, or null when stenographer gave none in time. */
  async context(input: { intent: string; principal?: string; signal?: AbortSignal }): Promise<JudgeContext | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const forward = (): void => controller.abort();
    input.signal?.addEventListener('abort', forward, { once: true });
    try {
      const [truth, transcript] = await Promise.all([this.#truth(input.intent, controller.signal), this.#transcript(controller.signal)]);
      return boundJudgeContext({ subject: this.#subject, truth, transcript }, {
        maxTruth: this.maxTruth,
        maxTranscript: this.maxTranscript,
        maxTextChars: this.maxTextChars,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', forward);
    }
  }

  async #get(path: string, signal: AbortSignal): Promise<unknown | null> {
    try {
      const response = await this.#fetch(`${this.baseURL}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      return await response.json();
    } catch {
      return null;
    }
  }

  async #truth(intent: string, signal: AbortSignal): Promise<JudgeTruthEntry[]> {
    const q = encodeURIComponent(intent.slice(0, 500));
    const searched = await this.#get(`/truth/search?q=${q}&k=${this.maxTruth}`, signal);
    const entries = Array.isArray(searched) ? searched : await this.#get('/truth', signal);
    const list = Array.isArray(entries) ? entries : [];
    return list.map(e => gradeLedgerEntry(e as LedgerEntry)).filter((e): e is JudgeTruthEntry => e !== null);
  }

  async #transcript(signal: AbortSignal): Promise<JudgeTranscriptLine[]> {
    const messages = await this.#get(`/messages?n=${this.maxTranscript}`, signal);
    const list = Array.isArray(messages) ? messages : [];
    // stenographer returns newest first; the judge reads oldest first
    return list.map(m => transcriptLine(m as LedgerMessage)).filter((l): l is JudgeTranscriptLine => l !== null).reverse();
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, baseURL: this.baseURL, timeoutMs: this.timeoutMs, maxTruth: this.maxTruth, maxTranscript: this.maxTranscript, token: this.#token ? '[redacted]' : null };
  }
}
