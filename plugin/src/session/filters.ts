import type { SessionMessage } from "../types.js";

/**
 * OpenChamber/OpenCode keep-alive requests are synthetic: they must never be
 * captured as user memory, quoted as evidence, or counted as review material.
 */
const KEEP_ALIVE_RE =
  /(?:keep[- ]alive|do not perform any work|reply with exactly\s*:?\s*ok)/i;

export function isKeepAliveText(text: string | undefined): boolean {
  return typeof text === "string" && KEEP_ALIVE_RE.test(text);
}

export function isSyntheticMessage(message: SessionMessage): boolean {
  if (message.type === "synthetic") return true;
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const record = metadata as Record<string, unknown>;
  return record.synthetic === true || record.warming === true;
}

/** A message the user actually wrote: not synthetic, not a keep-alive ping. */
export function isUserAuthored(message: SessionMessage): boolean {
  if (isSyntheticMessage(message)) return false;
  const isUser = message.type === "user" || message.role === "user";
  if (!isUser) return false;
  return !isKeepAliveText(message.text);
}
