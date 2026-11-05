import type { SessionMessage } from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Best-effort id for a raw server message, without normalizing its body. */
export function rawMessageID(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const info = isRecord(entry.info) ? entry.info : entry;
  if (typeof info.id === "string") return info.id;
  if (typeof entry.id === "string") return entry.id;
  return undefined;
}

function readMessageTime(
  value: Record<string, unknown>,
): { created?: number; completed?: number } | undefined {
  const raw = isRecord(value.time) ? value.time : undefined;
  if (!raw) return undefined;
  const created = typeof raw.created === "number" ? raw.created : undefined;
  const completed = typeof raw.completed === "number" ? raw.completed : undefined;
  if (created === undefined && completed === undefined) return undefined;
  return { created, completed };
}

function readParts(entry: Record<string, unknown>, info: Record<string, unknown>): unknown[] {
  if (Array.isArray(entry.parts)) return entry.parts;
  if (Array.isArray(info.parts)) return info.parts;
  if (Array.isArray(entry.content)) return entry.content;
  if (Array.isArray(info.content)) return info.content;
  return [];
}

/**
 * Normalize one server session message. Tool parts keep `tool` and `state` so
 * downstream digests can inspect the call without re-reading the transcript.
 */
export function normalizeSessionMessage(entry: unknown): SessionMessage | undefined {
  if (!isRecord(entry)) return undefined;
  const info = isRecord(entry.info) ? entry.info : entry;
  const parts = readParts(entry, info);
  const text = parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  const role =
    typeof info.role === "string"
      ? info.role
      : typeof entry.role === "string"
        ? entry.role
        : info.type === "user"
          ? "user"
          : info.type === "assistant"
            ? "assistant"
            : undefined;
  const id =
    typeof info.id === "string" ? info.id : typeof entry.id === "string" ? entry.id : undefined;
  const time = readMessageTime(info) ?? readMessageTime(entry);
  const rawType =
    typeof info.type === "string"
      ? info.type
      : typeof entry.type === "string"
        ? entry.type
        : undefined;
  const type = rawType ?? role;
  const metadata = isRecord(info.metadata)
    ? info.metadata
    : isRecord(entry.metadata)
      ? entry.metadata
      : undefined;

  if (text.length > 0) {
    return {
      id,
      role,
      type,
      text,
      time,
      metadata,
      parts: parts.filter(isRecord).map((part) => ({
        type: typeof part.type === "string" ? part.type : "text",
        text: typeof part.text === "string" ? part.text : undefined,
        tool: typeof part.tool === "string" ? part.tool : undefined,
        state: isRecord(part.state) ? part.state : undefined,
      })),
    };
  }
  if (typeof entry.text === "string" && entry.text.length > 0) {
    return { id, role, type, text: entry.text, time, metadata };
  }
  // Tool-only messages have no text but still carry evidence for review.
  if (parts.length > 0) {
    return {
      id,
      role,
      type,
      text: "",
      time,
      metadata,
      parts: parts.filter(isRecord).map((part) => ({
        type: typeof part.type === "string" ? part.type : "text",
        text: typeof part.text === "string" ? part.text : undefined,
        tool: typeof part.tool === "string" ? part.tool : undefined,
        state: isRecord(part.state) ? part.state : undefined,
      })),
    };
  }
  return undefined;
}

export function normalizeSessionMessages(raw: unknown): SessionMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: SessionMessage[] = [];
  for (const entry of raw) {
    const message = normalizeSessionMessage(entry);
    if (message) messages.push(message);
  }
  return messages;
}
