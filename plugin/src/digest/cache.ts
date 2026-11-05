import type { Store } from "../store.js";
import type { ToolDigest } from "./tool.js";

export interface DigestCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

interface CacheFile {
  version: 1;
  entries: ToolDigest[];
}

const DEFAULTS: Required<DigestCacheOptions> = {
  maxEntries: 2000,
  maxBytes: 2 * 1024 * 1024,
};

/**
 * Content-addressed LRU for tool digests. Digests are pure functions of the
 * redacted tool output, so an id can never go stale and no TTL is needed.
 * Writes are batched: callers flush once after building a review input.
 */
export class DigestCache {
  private readonly options: Required<DigestCacheOptions>;
  private entries = new Map<string, ToolDigest>();
  private dirty = false;
  private loading?: Promise<void>;

  constructor(
    private readonly store: Store,
    options: DigestCacheOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async load(): Promise<void> {
    if (!this.loading) this.loading = this.read();
    await this.loading;
  }

  get(id: string): ToolDigest | undefined {
    const hit = this.entries.get(id);
    if (hit) {
      this.entries.delete(id);
      this.entries.set(id, hit);
    }
    return hit;
  }

  set(digest: ToolDigest): boolean {
    if (this.entries.has(digest.id)) return false;
    this.entries.set(digest.id, digest);
    this.dirty = true;
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  /** Look up first, compute only on a miss; returns whether it was reused. */
  remember(digest: ToolDigest, hit: boolean): void {
    if (!hit) this.set(digest);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.store.transaction(async () => {
    const stored = await this.store.readCacheFile<CacheFile>(this.store.digestCachePath, { version: 1, entries: [] });
    const merged = new Map((Array.isArray(stored.entries) ? stored.entries : []).map((entry) => [entry.id, entry]));
    for (const [id, entry] of this.entries) merged.set(id, entry);
    const entries = [...merged.values()].slice(-this.options.maxEntries);
    while (entries.length > 0 && JSON.stringify(entries).length > this.options.maxBytes) {
      entries.shift();
    }
    const file: CacheFile = { version: 1, entries };
    await this.store.writeCacheFile(this.store.digestCachePath, file);
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.dirty = false;
    });
  }

  stats(): { entries: number; bytes: number } {
    const entries = [...this.entries.values()];
    return { entries: entries.length, bytes: JSON.stringify(entries).length };
  }

  private async read(): Promise<void> {
    const file = await this.store.readCacheFile<CacheFile>(this.store.digestCachePath, {
      version: 1,
      entries: [],
    });
    if (!file || !Array.isArray(file.entries)) return;
    for (const entry of file.entries) {
      if (!entry || typeof entry.id !== "string" || typeof entry.summary !== "string") continue;
      this.entries.set(entry.id, entry);
    }
  }
}
