import { normalizeForFingerprint } from "../fingerprint.js";
import { newId, type Store } from "../store.js";
import { sha16 } from "../util/text.js";
import type { Item, SourceRef, Suppression } from "../types.js";

/** Same window as version restore; expiry only stops re-learning, not undo. */
export const SUPPRESSION_DAYS = 90;

export function suppressionTextHash(text: string): string {
  return sha16(normalizeForFingerprint(text));
}

/** Existing per-turn hook key: `session|message|textHash`. */
export function turnHookKey(source: SourceRef, text: string): string | undefined {
  if (!source.sessionID || !source.messageID) return undefined;
  return `${source.sessionID}|${source.messageID}|${suppressionTextHash(text)}`;
}

/** Existing review hook key: `review|session|message|textHash`. */
export function reviewHookKey(source: SourceRef, text: string): string | undefined {
  if (!source.sessionID || !source.messageID) return undefined;
  return `review|${source.sessionID}|${source.messageID}|${suppressionTextHash(text)}`;
}

/**
 * Both lanes of one real source. The turn capture and the session review of
 * the same message must suppress each other, so both existing key formats are
 * derived here instead of relying on a review-generated id.
 */
export function hookKeysFor(source: SourceRef, text: string): string[] {
  return [turnHookKey(source, text), reviewHookKey(source, text)].filter(
    (key): key is string => typeof key === "string",
  );
}

/**
 * Suppress re-learning of this item from its own sources. One row per hook
 * key: same message + same text. A new message has a different key and is not
 * suppressed, so an explicit correction can still be learned.
 */
export async function suppressSource(
  store: Store,
  item: Item,
  reason: "reverted" | "deactivated",
): Promise<Suppression[]> {
  const sources = [item.source, ...(item.sources ?? [])].filter(
    (source): source is SourceRef => Boolean(source) && typeof source === "object",
  );
  const texts = [item.text, ...(item.aliases ?? [])].filter(
    (text): text is string => typeof text === "string" && text.length > 0,
  );
  const existing = new Set((await store.listSuppressions()).map((row) => row.hookKey));
  const at = new Date().toISOString();
  const until = new Date(Date.now() + SUPPRESSION_DAYS * 86_400_000).toISOString();
  const written: Suppression[] = [];
  for (const source of sources) {
    for (const text of texts) {
      for (const hookKey of hookKeysFor(source, text)) {
        if (existing.has(hookKey)) continue;
        const record: Suppression = {
          id: newId("supp"),
          at,
          hookKey,
          textHash: suppressionTextHash(text),
          itemID: item.id,
          reason,
          until,
        };
        await store.appendSuppression(record);
        existing.add(hookKey);
        written.push(record);
      }
    }
  }
  return written;
}

export async function isSuppressed(
  store: Store,
  hookKey: string,
  textHash: string,
): Promise<boolean> {
  const now = Date.now();
  return (await store.listSuppressions()).some(
    (row) =>
      row.hookKey === hookKey &&
      row.textHash === textHash &&
      (!row.until || Date.parse(row.until) > now),
  );
}

/** Drop every suppression owned by one item (restore/reactivate re-allows it). */
export async function clearSuppression(store: Store, itemID: string): Promise<number> {
  const rows = await store.listSuppressions();
  const kept = rows.filter((row) => row.itemID !== itemID);
  if (kept.length === rows.length) return 0;
  await store.writeSuppressions(kept);
  return rows.length - kept.length;
}
