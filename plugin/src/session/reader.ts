import type { SessionMessage } from "../types.js";
import { normalizeSessionMessage, rawMessageID } from "./normalize.js";
import { isUserAuthored } from "./filters.js";
import { clipMiddle, truncate } from "../util/text.js";

export interface SessionReaderOptions {
  /** Cached sessions before the least recently used one is evicted. */
  maxSessions?: number;
  /** Cached messages per session (oldest are dropped). */
  maxMessages?: number;
  /** Per-message text kept in memory; extraction only needs short spans. */
  maxTextChars?: number;
  /** Tool output kept in memory per part; digests only read both ends. */
  maxToolOutputChars?: number;
}

export interface SessionReaderStats {
  sessions: number;
  cachedMessages: number;
  normalized: number;
  reused: number;
}

interface CacheEntry {
  messages: SessionMessage[];
  byID: Map<string, SessionMessage>;
  rawCount: number;
  firstID?: string;
  touchedAt: number;
}

const DEFAULTS: Required<SessionReaderOptions> = {
  maxSessions: 8,
  maxMessages: 400,
  maxTextChars: 4000,
  maxToolOutputChars: 4000,
};

/**
 * Caches normalized session messages and re-normalizes only new entries.
 * Today's plugin re-reads and re-normalizes the whole transcript on every turn,
 * so this turns per-turn work from O(all messages) into O(new messages).
 */
export class SessionReader {
  private readonly options: Required<SessionReaderOptions>;
  private readonly cache = new Map<string, CacheEntry>();
  private normalized = 0;
  private reused = 0;

  constructor(
    private readonly load: (sessionID: string) => Promise<unknown>,
    options: SessionReaderOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async read(sessionID: string): Promise<SessionMessage[]> {
    const raw = await this.load(sessionID);
    const entries = Array.isArray(raw) ? raw : [];
    if (entries.length === 0) {
      this.cache.delete(sessionID);
      return [];
    }

    const firstID = rawMessageID(entries[0]);
    let entry = this.cache.get(sessionID);
    const truncated =
      entry !== undefined &&
      (entries.length < entry.rawCount ||
        (entry.firstID !== undefined && firstID !== undefined && entry.firstID !== firstID));
    if (truncated) entry = undefined;
    if (!entry) {
      entry = {
        messages: [],
        byID: new Map(),
        rawCount: 0,
        firstID,
        touchedAt: 0,
      };
      this.cache.set(sessionID, entry);
    }

    const byID = entry.byID;
    const out: SessionMessage[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const item = entries[index];
      const id = rawMessageID(item);
      // The tail may still be streaming, so always re-normalize it.
      const isTail = index === entries.length - 1;
      let message = id !== undefined && !isTail ? byID.get(id) : undefined;
      if (message) {
        this.reused += 1;
      } else {
        message = normalizeSessionMessage(item);
        this.normalized += 1;
        if (message) {
          message = this.slim(message);
          if (id !== undefined && !isTail) byID.set(id, message);
        }
      }
      if (message) out.push(message);
    }

    entry.rawCount = entries.length;
    entry.firstID = firstID;
    entry.touchedAt = Date.now();
    entry.messages = out.slice(-this.options.maxMessages);
    this.evictSessions();
    return entry.messages;
  }

  async delta(sessionID: string, afterMessageID?: string): Promise<SessionMessage[]> {
    const messages = await this.read(sessionID);
    if (!afterMessageID) return messages;
    const index = messages.findIndex((message) => message.id === afterMessageID);
    // A cursor trimmed out of the cache means we cannot prove what was seen;
    // returning everything is safe because hook keys dedupe the overlap.
    if (index === -1) return messages;
    return messages.slice(index + 1);
  }

  async lastUser(
    sessionID: string,
  ): Promise<{ id: string; time?: number } | undefined> {
    const messages = await this.read(sessionID);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isUser(message) || !message.id) continue;
      return { id: message.id, time: message.time?.created ?? message.time?.completed };
    }
    return undefined;
  }

  invalidate(sessionID?: string): void {
    if (sessionID === undefined) this.cache.clear();
    else this.cache.delete(sessionID);
  }

  stats(): SessionReaderStats {
    let cachedMessages = 0;
    for (const entry of this.cache.values()) cachedMessages += entry.messages.length;
    return {
      sessions: this.cache.size,
      cachedMessages,
      normalized: this.normalized,
      reused: this.reused,
    };
  }

  private slim(message: SessionMessage): SessionMessage {
    const text = message.text ?? "";
    const clippedText =
      text.length > this.options.maxTextChars
        ? `${text.slice(0, this.options.maxTextChars)}\n…`
        : text;
    const parts = message.parts?.map((part) => {
      if (!part.state) return part;
      return { ...part, state: slimState(part.state, this.options.maxToolOutputChars) };
    });
    return { ...message, text: clippedText, parts };
  }

  private evictSessions(): void {
    while (this.cache.size > this.options.maxSessions) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (entry.touchedAt < oldest) {
          oldest = entry.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }
}

function isUser(message: SessionMessage): boolean {
  return isUserAuthored(message);
}

function slimState(state: unknown, maxOutputChars: number): unknown {
  if (typeof state !== "object" || state === null) return state;
  const record = state as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  if (typeof record.output === "string") {
    next.output = clipMiddle(record.output, maxOutputChars);
  }
  if (typeof record.metadata === "object" && record.metadata !== null) {
    const metadata = record.metadata as Record<string, unknown>;
    const slim: Record<string, unknown> = { ...metadata };
    if (typeof metadata.output === "string") {
      slim.output = clipMiddle(metadata.output, maxOutputChars);
    }
    next.metadata = slim;
  }
  if (typeof record.error === "string") next.error = truncate(record.error, 400);
  return next;
}

export function createSessionReader(
  load: (sessionID: string) => Promise<unknown>,
  options?: SessionReaderOptions,
): SessionReader {
  return new SessionReader(load, options);
}
