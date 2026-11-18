import type { SessionMessage } from "../types.js";
import { indexedToolParts, projectToolFailure } from "../digest/tool.js";
import { redactText } from "../redact.js";
import { isSyntheticMessage, isUserAuthored, nativeToolMessageRole } from "../session/filters.js";
import { sha16 } from "../util/text.js";

export interface UserEvidenceSpan {
  sessionID: string;
  messageID: string;
  role: "user";
  observedRole?: "user";
  text: string;
  start: number;
  end: number;
  canonicalHash: string;
  partsHash: string;
  spanHash: string;
  /** Native message creation time, used only for bounded retirement overflow. */
  observedAt?: number;
}

/**
 * A verified native failing-tool seed. `text` is the bounded redacted digest
 * that was shown to the model, never the raw tool output or arguments.
 */
export interface ToolEvidenceSpan {
  sessionID: string;
  messageID: string;
  /** Local evidence kind; not a native message role. */
  role: "tool";
  /** Actual native message role that carried this tool part. */
  observedRole: "assistant" | "tool";
  text: string;
  /** Projection-local offsets (0..text.length), never canonical message offsets. */
  start: number;
  end: number;
  offsetSpace: "tool-projection";
  canonicalHash: string;
  partsHash: string;
  spanHash: string;
  tool: string;
  toolCallID?: string;
  partIndex: number;
  /** Legacy bounded review digest content address. */
  digestHash: string;
  /** Secret-redacted hash of the complete native diagnostic set. */
  rawHash: string;
  ok: false;
  observedAt?: number;
}

export type EvidenceSpan = UserEvidenceSpan | ToolEvidenceSpan;

export interface EvidenceBundle {
  spans: EvidenceSpan[];
  hash: string;
  /** Stable, hash-only fingerprint of complete real user messages in the transcript. */
  materialHash: string;
  chars: number;
}

export interface LocatedQuote {
  span: EvidenceSpan;
  start: number;
  end: number;
}

type Range = { start: number; end: number };

const SYNTHETIC_TAG = /<(context|skill_content|subagent)\b[^>]*>/gi;
const MAX_GOVERNING_SEED_CHARS = 500;
const GOVERNING_CONTEXT =
  /(?:不要|别|不应|不可|未|并非|不是|如果|假如|除非|否则|条件是|同事.{0,16}说|有人说|听说|据说|我不同意|不同意|不接受|转述|引用|do not|don't|if |unless |someone said|colleague said|\b(?:eval|exec|install|exfiltrat)\b|外传|提权|绕过|任意(?:命令|代码|脚本))/i;
const OPEN_LEAD_IN = /(?:建议|要求|偏好|主张|认为|坚持|规定|说明|通知|提出|强调|推荐|指出|决定|希望|倾向|赞成|反对|使用|采用|依赖|支持|基于|因为|如果|当|对于|关于|根据|如下|例如|包括|suggests?|requires?|prefers?|states?|says?|because|if|when|about|according to)\s*[:：,，、-]?\s*$/i;

/** Build exact, hash-only evidence pointers from complete normalized messages. */
export function collectUserEvidence(
  sessionID: string,
  messages: SessionMessage[],
): EvidenceBundle {
  const spans: UserEvidenceSpan[] = [];
  const material = messages.flatMap((message) => {
    if (!message.id || !isUserAuthored(message)) return [];
    return [[
      message.id,
      message.role ?? message.type ?? "user",
      sha16(message.text ?? ""),
    ]];
  });
  for (const message of messages) {
    if (!message.id || !isUserAuthored(message) || typeof message.text !== "string") continue;
    const canonical = message.text;
    // Paths are ordinary evidence, not secrets. Drop a whole message only on
    // secret redaction so capture and admission use the same sensitive-data gate.
    if (redactText(canonical, { paths: false }).hits > 0) continue;
    const ranges = eligibleRanges(canonical).flatMap((range) =>
      governingSeedRanges(canonical, range),
    );
    for (const range of ranges) {
      const source = canonical.slice(range.start, range.end);
      const text = source.trim();
      if (!text) continue;
      const leading = source.length - source.trimStart().length;
      const start = range.start + leading;
      const end = start + text.length;
      const partsHash = sha16(JSON.stringify(
        (message.parts ?? []).map((part) => [part.type, part.text ?? ""]),
      ));
      spans.push({
        sessionID,
        messageID: message.id,
        role: "user",
        text,
        start,
        end,
        canonicalHash: sha16(canonical),
        partsHash,
        spanHash: sha16(text),
        ...(Number.isFinite(message.time?.created) ? { observedAt: message.time?.created } : {}),
      });
    }
  }
  const chars = spans.reduce((total, span) => total + span.text.length, 0);
  const hash = sha16(JSON.stringify(spans.map((span) => [
    span.sessionID,
    span.messageID,
    span.start,
    span.end,
    span.canonicalHash,
    span.partsHash,
    span.spanHash,
  ])));
  return {
    spans,
    hash,
    materialHash: sha16(JSON.stringify(material)),
    chars,
  };
}

/**
 * Collect only failing native tool parts. The native message role must be
 * assistant/tool and non-synthetic; a user/system part merely shaped like a
 * tool part never becomes evidence. The body is a complete bounded failure
 * projection from state.error/content/output, not command text.
 */
export function collectFailedToolEvidence(
  sessionID: string,
  messages: SessionMessage[],
  maxChars = 200,
): { spans: ToolEvidenceSpan[]; materialHash: string; rejected: string[] } {
  const spans: ToolEvidenceSpan[] = [];
  const material: unknown[] = [];
  const rejected: string[] = [];
  for (const message of messages) {
    if (!message.id) continue;
    const parts = indexedToolParts(message);
    if (parts.length === 0) continue;
    const observedRole = nativeToolMessageRole(message);
    if (isSyntheticMessage(message)) {
      rejected.push("synthetic-message");
      continue;
    }
    if (!observedRole) {
      rejected.push("unsupported-native-role");
      continue;
    }
    for (const { part, index } of parts) {
      const projection = projectToolFailure(part, maxChars);
      if (!projection.ok) {
        if (projection.reason !== "not-failing") {
          rejected.push(projection.reason);
        }
        continue;
      }
      const text = projection.text;
      const toolCallID = typeof part.callID === "string" ? part.callID : undefined;
      const observedAt = message.time?.created ?? message.time?.completed;
      spans.push({
        sessionID,
        messageID: message.id,
        role: "tool",
        observedRole,
        text,
        start: 0,
        end: text.length,
        offsetSpace: "tool-projection",
        canonicalHash: sha16(text),
        partsHash: sha16(JSON.stringify([
          observedRole,
          projection.tool,
          projection.digestHash,
          projection.rawHash,
          toolCallID ?? "",
          index,
          false,
        ])),
        spanHash: sha16(text),
        tool: projection.tool,
        ...(toolCallID ? { toolCallID } : {}),
        partIndex: index,
        digestHash: projection.digestHash,
        rawHash: projection.rawHash,
        ok: false,
        ...(Number.isFinite(observedAt) ? { observedAt } : {}),
      });
      material.push([
        message.id,
        observedRole,
        index,
        toolCallID ?? "",
        projection.tool,
        projection.digestHash,
        projection.rawHash,
        false,
        sha16(text),
      ]);
    }
  }
  return { spans, materialHash: sha16(JSON.stringify(material)), rejected };
}

/** Split on explicit sentence punctuation; line breaks remain in the governing seed. */
function governingSeedRanges(text: string, range: Range): Range[] {
  const source = text.slice(range.start, range.end);
  const sentences = sentenceRanges(source, range.start);
  const seeds: Range[] = [];
  for (let index = 0; index < sentences.length;) {
    let seed = { ...sentences[index] };
    let previousText = text.slice(seed.start, seed.end);
    let next = index + 1;
    while (next < sentences.length) {
      const nextText = text.slice(sentences[next].start, sentences[next].end);
      if (
        !GOVERNING_CONTEXT.test(previousText) &&
        !GOVERNING_CONTEXT.test(nextText) &&
        !isIncompleteLeadIn(previousText)
      ) break;
      seed.end = sentences[next].end;
      previousText = nextText;
      next += 1;
    }
    if (seed.end - seed.start <= MAX_GOVERNING_SEED_CHARS) seeds.push(seed);
    // An overlong complete sentence/context group is skipped as a whole.
    index = next;
  }
  return seeds;
}

function isIncompleteLeadIn(value: string): boolean {
  const line = value.trim();
  if (!line) return false;
  if (/(?:[:：,，、—-]|\b(?:and|or|with|because|if|when|about|for|of|to))$/i.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) && /[:：,，、—-]$/.test(line)) return true;
  return OPEN_LEAD_IN.test(line);
}

function sentenceRanges(text: string, offset: number): Range[] {
  const out: Range[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    // A dot inside a filename, URL, or decimal is not a sentence boundary.
    if (text[index] === "." && index + 1 < text.length && !/\s/.test(text[index + 1])) continue;
    if (!/[。！？.!?]/.test(text[index])) continue;
    let end = index + 1;
    while (end < text.length && /[。！？.!?\s\"'”’）)\]】]/.test(text[end])) end += 1;
    if (text.slice(start, end).trim()) out.push({ start: offset + start, end: offset + end });
    start = end;
    index = end - 1;
  }
  if (start < text.length && text.slice(start).trim()) {
    out.push({ start: offset + start, end: offset + text.length });
  }
  return out;
}

/** A quote must occur exactly once in all eligible user spans. */
export function locateUniqueQuote(
  quote: string,
  spans: EvidenceSpan[],
): LocatedQuote | undefined {
  if (!quote || quote !== quote.trim()) return undefined;
  let found: LocatedQuote | undefined;
  for (const span of spans) {
    let from = 0;
    while (from <= span.text.length - quote.length) {
      const index = span.text.indexOf(quote, from);
      if (index === -1) break;
      if (found) return undefined;
      found = {
        span,
        start: span.start + index,
        end: span.start + index + quote.length,
      };
      from = index + 1;
    }
  }
  return found;
}

function eligibleRanges(text: string): Range[] {
  if (isTaskEnvelope(text)) return [];
  const excluded: Range[] = [...syntheticRanges(text)];
  const lines = lineRanges(text);

  let inFence = false;
  for (const line of lines) {
    const value = text.slice(line.start, line.end);
    const trimmed = value.trimStart();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      excluded.push(line);
      continue;
    }
    if (inFence || /^\s*\[Session task state\b/i.test(value)) {
      excluded.push(line);
    }
  }

  for (let index = 0; index < lines.length;) {
    if (!isPipeRow(text.slice(lines[index].start, lines[index].end))) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && isPipeRow(text.slice(lines[end].start, lines[end].end))) end += 1;
    const group = lines.slice(index, end);
    if (group.length >= 2 && group.some((line) => /^\s*\|?\s*:?-{3,}/.test(text.slice(line.start, line.end)))) {
      excluded.push({ start: group[0].start, end: group[group.length - 1].end });
    }
    index = end;
  }

  const merged = mergeRanges(excluded, text.length);
  const allowed: Range[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) allowed.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) allowed.push({ start: cursor, end: text.length });
  return allowed;
}

function syntheticRanges(text: string): Range[] {
  const out: Range[] = [];
  SYNTHETIC_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SYNTHETIC_TAG.exec(text)) !== null) {
    const tag = match[1]?.toLowerCase();
    if (!tag) continue;
    const close = `</${tag}>`;
    const closeAt = text.toLowerCase().indexOf(close, SYNTHETIC_TAG.lastIndex);
    if (closeAt === -1) {
      out.push({ start: match.index, end: text.length });
      break;
    }
    out.push({ start: match.index, end: closeAt + close.length });
    SYNTHETIC_TAG.lastIndex = closeAt + close.length;
  }
  SYNTHETIC_TAG.lastIndex = 0;
  return out;
}

function isTaskEnvelope(text: string): boolean {
  return /\bTASK\s*:/i.test(text) &&
    /\bMUST\s+DO\b/i.test(text) &&
    /\bMUST\s+NOT\s+DO\b/i.test(text) &&
    /\bCONTEXT\s*:/i.test(text);
}

function lineRanges(text: string): Range[] {
  const lines: Range[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ start, end });
    start = end;
  }
  return lines;
}

function isPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|");
}

function mergeRanges(ranges: Range[], length: number): Range[] {
  const sorted = ranges
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(length, start)),
      end: Math.max(0, Math.min(length, end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) merged.push(range);
    else previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}
