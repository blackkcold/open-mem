import type { AutoMemConfig, SessionMessage } from "../types.js";
import type { Store } from "../store.js";
import { digestToolPart, toolParts } from "../digest/tool.js";
import type { DigestCache } from "../digest/cache.js";
import { redactText } from "../redact.js";
import { isUserAuthored } from "../session/filters.js";
import { sha16 } from "../util/text.js";

export interface ReviewInputItem {
  id: string;
  role: "user" | "tool";
  kind: "text" | "tool";
  text: string;
  time?: number;
  tool?: string;
  ok?: boolean;
}

export interface ReviewSource {
  user?: string;
  tools: Array<{ text: string; ok: boolean; tool: string }>;
}

export interface ReviewInput {
  sessionID: string;
  fromMessageID?: string;
  /** Last message in the window, used as the next cursor. */
  toMessageID?: string;
  items: ReviewInputItem[];
  chars: number;
  hash: string;
  truncated: boolean;
  userCount: number;
  toolCount: number;
  /** Raw bytes before digesting, for the review report. */
  rawToolChars: number;
  /** Message id → text that was actually sent; evidence quotes must be substrings. */
  sources: Record<string, ReviewSource>;
  /** Existing queue/memory titles; a prompt hint, never part of the input hash. */
  knownTitles?: string[];
}

export interface ReviewInputBuilderDeps {
  config: AutoMemConfig;
  digestCache: DigestCache;
}

/**
 * Builds the only thing the review model is allowed to see: user text plus
 * deterministic tool digests, capped by a character budget. Assistant prose is
 * never included (consolidate.ts already documents why: it would let the model
 * reinforce its own wording).
 */
export class ReviewInputBuilder {
  constructor(private readonly deps: ReviewInputBuilderDeps) {}

  build(
    sessionID: string,
    messages: SessionMessage[],
    fromMessageID?: string,
    knownTitles: string[] = [],
  ): ReviewInput {
    const config = this.deps.config.review;
    const userBudget = Math.floor(
      config.maxInputChars * (config.transcript === "user" ? 1 : 0.66),
    );
    const toolBudget = Math.max(0, config.maxInputChars - userBudget);

    const sources: Record<string, ReviewSource> = {};
    const collected: Array<{ item: ReviewInputItem; order: number }> = [];
    let userChars = 0;
    let toolChars = 0;
    let rawToolChars = 0;
    let truncated = false;
    let userCount = 0;
    let toolCount = 0;
    let toMessageID: string | undefined;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.id) continue;
      if (toMessageID === undefined) toMessageID = message.id;
      const order = index;
      const isUser = isUserAuthored(message);

      if (isUser && typeof message.text === "string" && message.text.trim().length >= 8) {
        const redacted = config.redact ? redactText(message.text).text : message.text;
        const fitted = fit(redacted, config.maxUserCharsPerMessage, userBudget - userChars);
        if (fitted.text.length > 0) {
          userChars += fitted.text.length;
          userCount += 1;
          collected.push({
            order,
            item: {
              id: message.id,
              role: "user",
              kind: "text",
              text: fitted.text,
              time: message.time?.created ?? message.time?.completed,
            },
          });
          sources[message.id] = { user: fitted.text, tools: [] };
        }
        if (fitted.clipped) truncated = true;
      }

      if (config.transcript === "user+tools") {
        for (const part of toolParts(message)) {
          const digest = digestToolPart(part, {
            maxChars: this.deps.config.digest.maxChars,
          });
          if (!digest) continue;
          rawToolChars += digest.chars;
          if (toolChars + digest.summary.length > toolBudget) {
            truncated = true;
            break;
          }
          toolChars += digest.summary.length;
          toolCount += 1;
          this.deps.digestCache.set(digest);
          collected.push({
            order: order + 0.5,
            item: {
              id: message.id,
              role: "tool",
              kind: "tool",
              text: digest.summary,
              time: message.time?.created ?? message.time?.completed,
              tool: digest.tool,
              ok: digest.ok,
            },
          });
          const source = (sources[message.id] ??= { tools: [] });
          source.tools.push({ text: digest.summary, ok: digest.ok, tool: digest.tool });
        }
      }
    }

    collected.sort((left, right) => left.order - right.order);
    const items = collected.map((entry) => entry.item);
    const chars = items.reduce((total, item) => total + item.text.length, 0);
    const hash = sha16(
      JSON.stringify({
        from: fromMessageID ?? "",
        items: items.map((item) => [item.id, item.role, item.text]),
      }),
    );

    return {
      sessionID,
      fromMessageID,
      toMessageID,
      items,
      chars,
      hash,
      truncated,
      userCount,
      toolCount,
      rawToolChars,
      sources,
      knownTitles,
    };
  }
}

/**
 * Compact, redacted titles already known to the store. Kept out of the input
 * hash on purpose: changing the queue must not invalidate a transcript review.
 */
export async function collectReviewKnownTitles(
  store: Store,
  limit = 30,
  projectKey?: string,
): Promise<string[]> {
  const [queue, items] = await Promise.all([
    store.listQueue(),
    store.listItems(),
  ]);
  const titles = [
    ...queue.filter((item) => item.scope === "global" || item.scope === "project" && projectKey !== undefined && item.projectKey === projectKey).map((item) => item.title),
    ...items
      .filter((item) => item.status !== "archived" && (item.scope === "global" || item.scope === "project" && projectKey !== undefined && item.projectKey === projectKey))
      .map((item) => item.title),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const title of titles) {
    const clean = redactText(title.replace(/\s+/g, " ").trim()).text.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean.slice(0, 30));
    if (result.length >= limit) break;
  }
  return result;
}

function fit(
  value: string,
  perMessage: number,
  remaining: number,
): { text: string; clipped: boolean } {
  if (remaining <= 0) return { text: "", clipped: true };
  const limit = Math.min(perMessage, remaining);
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return { text, clipped: false };
  return { text: `${text.slice(0, Math.max(0, limit - 1))}…`, clipped: true };
}

export function reviewEvidenceQuotes(input: ReviewInput): {
  user: Map<string, string>;
  tools: Map<string, Array<{ text: string; ok: boolean; tool: string }>>;
} {
  const user = new Map<string, string>();
  const tools = new Map<string, Array<{ text: string; ok: boolean; tool: string }>>();
  for (const [id, source] of Object.entries(input.sources)) {
    if (source.user) user.set(id, source.user);
    if (source.tools.length > 0) tools.set(id, source.tools);
  }
  return { user, tools };
}
