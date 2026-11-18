import type { AutoMemConfig, Item, Scope, SessionMessage } from "./types.js";
import type { Store } from "./store.js";
import { itemContentVersion } from "./fingerprint.js";
import { isKeepAliveText, isSyntheticMessage } from "./session/filters.js";
import { applyOwnedContextDetailed } from "./plugin.js";

/**
 * P04 bounded recall.
 *
 * The score below is a deterministic feature sum used only for ordering. It is
 * not a probability, confidence or correctness estimate and must never be
 * rendered as a percentage.
 */

export interface RecallTokens {
  cjkBigrams: string[];
  identifiers: string[];
  numbers: string[];
  /** Plain ASCII command/word tokens, matched at word boundaries. */
  words?: string[];
  /** Negation parity only: equal parity can match, different parity excludes. */
  negations: number;
}

export interface RecallHit {
  id: string;
  version: string;
  title: string;
  text: string;
  scope: Scope;
  kind: Item["kind"];
  /** Ordering feature sum, not a probability. */
  score: number;
  /** Stable feature names such as `cjk:复盘` or `identifier:plugin.ts`. */
  reasons: string[];
  numericConflict?: boolean;
  negationMismatch?: boolean;
}

export interface RecallResult {
  hits: RecallHit[];
  /** Conservative estimate, not billing. */
  tokens: number;
  degraded?: { reason: "empty_query" | "store_error" | "budget" | "unlocated" };
}

export interface RecallSystemPart {
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RecallSearchOptions {
  projectKey?: string;
  limit?: number;
  tokenBudget?: number;
  now?: number;
  /**
   * Full normalized texts already present in the stable pinned prefix. Applied
   * before limit/budget selection so excluded top hits do not consume slots.
   */
  excludeTexts?: ReadonlyArray<string>;
}

export const RECALL_HEADER = "## RELEVANT MEMORY (this request)";
const RECALL_SENTINEL = "<!-- openmem-recall-block -->";
const RECALL_METADATA_KEY = "openmem";
const MAX_QUERY_CHARS = 400;
const DEFAULT_LIMIT = 5;
const DEFAULT_TOKEN_BUDGET = 600;
const SAFETY_TOKENS = 16;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const ASCII_ALNUM = /[A-Za-z0-9]/;
const ASCII_SEPARATOR = /[_.\/:-]/;

const NEGATION = /无需|不用|不准|不得|不要|禁止|避免|别|不/g;
const NEGATION_EN = /\b(?:not|no|never|don'?t|avoid|without)\b/gi;
const NEGATION_NON_NEGATION_SUFFIX = new Set(["错", "仅", "但", "过", "少", "久", "断", "同", "凡"]);
const NEGATION_NOT_PREFIX = new Set(["特", "分", "级", "类", "性", "个", "差", "告"]);

/** English function words add noise without carrying recall features. */
const WORD_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so",
  "to", "of", "in", "on", "at", "by", "for", "with", "without", "from",
  "into", "over", "under", "about", "as", "is", "are", "was", "were",
  "be", "been", "being", "am", "do", "does", "did", "done", "can",
  "could", "should", "would", "will", "shall", "may", "might", "must",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its",
  "they", "them", "their", "this", "that", "these", "those", "there",
  "here", "what", "when", "where", "which", "who", "why", "how",
  "not", "no", "never", "please", "just", "like", "want", "need",
  "use", "using", "used", "make", "made", "get", "got", "let", "have",
  "has", "had", "also", "very", "too", "only", "all", "any", "some",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Normalize numbers for exact comparison: thousands separators and units. */
function normalizeNumber(raw: string): string {
  let value = raw.replace(/[,\s]/g, "");
  const suffix = /^(.*?)(万|千|[kK])$/.exec(value);
  if (suffix && /^\d+(?:\.\d+)?$/.test(suffix[1])) {
    const base = Number(suffix[1]);
    const factor = suffix[2] === "万" ? 10_000 : 1_000;
    value = String(base * factor);
  }
  value = value.replace(/(次|个|元|秒|分钟|小时|ms)$/i, "");
  return value.replace(/^0+(?=\d)/, "");
}

function extractNumbers(text: string): string[] {
  const found: string[] = [];
  const pattern = /\d[\d,]*(?:\.\d+)?\s*(?:万|千|[kK])?(?:次|个|元|秒|分钟|小时|ms)?/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0].trim();
    if (!raw) continue;
    found.push(normalizeNumber(raw));
  }
  return found;
}

function countNegations(text: string): number {
  let count = 0;
  for (const match of text.matchAll(NEGATION)) {
    const term = match[0];
    const at = match.index ?? 0;
    if (term === "不") {
      const next = text.slice(at + 1, at + 2);
      if (NEGATION_NON_NEGATION_SUFFIX.has(next)) continue;
    }
    if (term === "别") {
      const previous = text.slice(Math.max(0, at - 1), at);
      if (NEGATION_NOT_PREFIX.has(previous)) continue;
    }
    count += 1;
  }
  count += [...text.matchAll(NEGATION_EN)].length;
  return count;
}

/**
 * Identifiers are extracted before any other tokenization so `plugin.ts` is
 * never split into `plugin` and `ts`; case is preserved.
 */
function extractIdentifiers(text: string): { identifiers: string[]; rest: string } {
  const identifiers: string[] = [];
  let rest = text;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const body = match[1].trim();
    if (!body) continue;
    // A multi-word command or a structural token is safe to match as an exact
    // phrase/identifier. A plain word is routed to bounded word matching so
    // `npm` never matches inside `pnpm`.
    const bodyIsStructural = /[._\/:@-]/.test(body) || /\s/.test(body);
    if (bodyIsStructural) identifiers.push(body);
    for (const token of body.split(/\s+/)) {
      if (token.length < 2) continue;
      if (/[._\/:@-]/.test(token)) {
        identifiers.push(token);
      } else {
        rest = `${rest} ${token}`;
      }
    }
    rest = rest.split(match[0]).join(" ");
  }
  const bare =
    /(?:[A-Za-z0-9_@-]+(?:[._\/:-][A-Za-z0-9_@-]+)+|\/[A-Za-z0-9_@.\/-]+)/g;
  for (const match of rest.matchAll(bare)) {
    identifiers.push(match[0]);
  }
  rest = rest.replace(bare, " ");
  return { identifiers: unique(identifiers.filter((value) => value.length > 0)), rest };
}

export function tokenizeRecallQuery(text: string): RecallTokens {
  const query = text.slice(0, MAX_QUERY_CHARS);
  const { identifiers, rest } = extractIdentifiers(query);
  const cjkBigrams: string[] = [];
  for (const match of rest.matchAll(
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g,
  )) {
    const run = match[0];
    if (run.length === 1) {
      cjkBigrams.push(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      cjkBigrams.push(run.slice(index, index + 2));
    }
  }
  return {
    cjkBigrams,
    identifiers,
    numbers: unique(extractNumbers(rest)),
    words: unique(
      [...rest.matchAll(/[A-Za-z][A-Za-z0-9]*/g)]
        .map((match) => match[0].toLowerCase())
        .filter((word) => word.length >= 2 && !WORD_STOPWORDS.has(word)),
    ),
    negations: countNegations(query),
  };
}

/**
 * Compare one item against the query features. Conflicts are reported on the
 * hit (for diagnostics) and filtered out by `recallMemory`.
 */
export function scoreRecall(item: Item, tokens: RecallTokens): RecallHit | undefined {
  const haystack = `${item.title}\n${item.text}`;
  const reasons: string[] = [];
  let score = 0;

  let matchedIdentifiers = 0;
  for (const identifier of tokens.identifiers) {
    if (!haystack.includes(identifier)) continue;
    matchedIdentifiers += 1;
    score += 4;
    if (reasons.length < 5) reasons.push(`identifier:${identifier}`);
    if (matchedIdentifiers >= 4) break;
  }

  const seenCjk = unique(tokens.cjkBigrams);
  let matchedCjk = 0;
  for (const bigram of seenCjk) {
    if (!haystack.includes(bigram)) continue;
    matchedCjk += 1;
    score += 2;
    if (reasons.length < 8) reasons.push(`cjk:${bigram}`);
    if (matchedCjk >= 12) break;
  }

  const itemNumbers = unique(extractNumbers(haystack));
  const itemWords = new Set(
    haystack
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0),
  );
  let matchedWords = 0;
  for (const word of tokens.words ?? []) {
    if (!itemWords.has(word)) continue;
    matchedWords += 1;
    score += 1;
    if (reasons.length < 10) reasons.push(`word:${word}`);
    if (matchedWords >= 6) break;
  }

  let matchedNumbers = 0;
  if (tokens.numbers.length > 0 && itemNumbers.length > 0) {
    for (const number of tokens.numbers) {
      if (!itemNumbers.includes(number)) continue;
      matchedNumbers += 1;
      score += 4;
      if (reasons.length < 10) reasons.push(`number:${number}`);
      if (matchedNumbers >= 3) break;
    }
  }

  if (score === 0) return undefined;

  const numericConflict =
    tokens.numbers.length > 0 &&
    itemNumbers.length > 0 &&
    matchedNumbers === 0 &&
    (matchedCjk > 0 || matchedIdentifiers > 0 || matchedWords > 0);
  const negationMismatch = tokens.negations % 2 !== countNegations(haystack) % 2;

  return {
    id: item.id,
    version: itemContentVersion(item),
    title: item.title,
    text: item.text,
    scope: item.scope,
    kind: item.kind,
    score,
    reasons,
    ...(numericConflict ? { numericConflict: true } : {}),
    ...(negationMismatch ? { negationMismatch: true } : {}),
  };
}

/**
 * Conservative token estimate for budgeting only.
 * CJK/kana/hangul: 1 per char. ASCII alphanumeric runs: ceil(len/3), split by
 * `_ . / : -`. Other non-space punctuation: 0.5. Whitespace: 0.25. Ceil + 16.
 */
export function estimateTokens(text: string): number {
  let quarters = 0;
  let asciiRun = 0;
  const flush = (): void => {
    if (asciiRun > 0) {
      quarters += Math.ceil(asciiRun / 3) * 4;
      asciiRun = 0;
    }
  };
  for (const char of text) {
    if (CJK.test(char)) {
      flush();
      quarters += 4;
    } else if (ASCII_ALNUM.test(char)) {
      asciiRun += 1;
    } else if (/\s/.test(char)) {
      flush();
      quarters += 1;
    } else if (ASCII_SEPARATOR.test(char)) {
      flush();
      quarters += 2;
    } else {
      flush();
      quarters += 2;
    }
  }
  flush();
  return Math.ceil(quarters / 4) + SAFETY_TOKENS;
}

/** Normalized text used only for dedupe, never for scoring. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A memory body must never forge or close the host's keyed context wrapper. */
function escapeContextMarkers(value: string): string {
  return value
    .replace(/<\/context/gi, "&lt;/context")
    .replace(/<context/gi, "&lt;context");
}

/** Render one dynamic block. Empty hits render nothing. */
export function renderRecallBlock(hits: RecallHit[], maxChars: number): string {
  if (hits.length === 0) return "";
  let output = RECALL_HEADER;
  for (const hit of hits) {
    const line = `\n- [${hit.scope}/${hit.kind}] ${escapeContextMarkers(hit.text)}`;
    if (maxChars > 0 && output.length + line.length + RECALL_SENTINEL.length + 1 > maxChars) {
      continue;
    }
    output += line;
  }
  if (output === RECALL_HEADER) return "";
  return `${output}\n${RECALL_SENTINEL}`;
}

const TAGS = [
  "system-update",
  "context",
  "skill_content",
  "task",
  "template",
  "synthetic",
];

function cleanInjectedBlocks(text: string): string {
  let value = text;
  for (const tag of TAGS) {
    const paired = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
    value = value.replace(paired, " ");
    const unpaired = new RegExp(`<\\/?${tag}(?:\\s[^>]*)?>`, "gi");
    value = value.replace(unpaired, " ");
  }
  return value.replace(/Session task state/gi, " ").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Reuse the session filter's synthetic definition, plus native direct flags
 * that the host may put on a message or a text part. A synthetic text part is
 * never used as a recall query, even inside an otherwise real user message.
 */
function syntheticRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const candidate: SessionMessage = {
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  };
  if (isSyntheticMessage(candidate)) return true;
  if (value.synthetic === true || value.source === "synthetic" || value.warming === true) {
    return true;
  }
  const metadata = value.metadata;
  if (isRecord(metadata)) {
    if (
      metadata.synthetic === true ||
      metadata.source === "synthetic" ||
      metadata.warming === true
    ) {
      return true;
    }
  }
  return false;
}

function textOfMessage(message: unknown): string | undefined {
  if (!isRecord(message) || syntheticRecord(message)) return undefined;
  const direct = typeof message.text === "string" ? message.text : undefined;
  if (direct !== undefined) return direct;
  if (typeof message.content === "string") return message.content;
  const parts = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.parts)
      ? message.parts
      : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (syntheticRecord(part)) continue;
    texts.push(part.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function roleOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.role === "string") return message.role;
  if (typeof message.type === "string") return message.type;
  return undefined;
}

/**
 * Select a real user prompt. Only the trailing run of user messages is
 * considered; any assistant/tool boundary stops the walk so tool loops and
 * synthetic helper requests never become recall queries.
 */
export function selectRecallQuery(messages: ReadonlyArray<unknown>): string | undefined {
  if (messages.length === 0) return undefined;
  const last = messages[messages.length - 1];
  if (roleOf(last) !== "user") return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (roleOf(message) !== "user") break;
    if (syntheticRecord(message)) continue;
    const raw = textOfMessage(message);
    if (raw === undefined) continue;
    const cleaned = cleanInjectedBlocks(raw);
    if (cleaned.length === 0) continue;
    if (isKeepAliveText(cleaned)) continue;
    // A remaining injection marker means the whole message is synthetic; do
    // not let a tool/user quote dressed as a prompt drive recall.
    if (/<\/?(?:system-update|context|skill_content|task|template|synthetic)\b/i.test(cleaned)) continue;
    const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(cleaned);
    if (slash) {
      const args = (slash[2] ?? "").trim();
      if (args.length < 4) continue;
    }
    if (cleaned.length < 4) continue;
    return cleaned.slice(0, MAX_QUERY_CHARS);
  }
  return undefined;
}

function compareHits(left: SortableHit, right: SortableHit): number {
  if (right.score !== left.score) return right.score - left.score;
  const byUpdated = right.updatedAtForSort.localeCompare(left.updatedAtForSort);
  if (byUpdated !== 0) return byUpdated;
  return left.id.localeCompare(right.id);
}

// Sort keys are attached during recall and stripped before returning.
interface SortableHit extends RecallHit {
  updatedAtForSort: string;
  textKey: string;
}

function stripSortKey(hit: SortableHit): RecallHit {
  const { updatedAtForSort: _updatedAtForSort, textKey: _textKey, ...rest } = hit;
  return rest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Bounded, deterministic local recall. Never throws: storage errors become an
 * empty result with a single degraded reason.
 */
export async function recallMemory(
  store: Store,
  config: AutoMemConfig,
  query: string,
  opts: RecallSearchOptions = {},
): Promise<RecallResult> {
  const text = query.trim().slice(0, MAX_QUERY_CHARS);
  if (text.length === 0) {
    return { hits: [], tokens: 0, degraded: { reason: "empty_query" } };
  }
  const now = opts.now ?? Date.now();
  const limit = clamp(opts.limit ?? config.recall?.limit ?? DEFAULT_LIMIT, 1, 50);
  const tokenBudget = clamp(
    opts.tokenBudget ?? config.recall?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    50,
    20_000,
  );

  let items: Item[];
  try {
    items = await store.listItems();
  } catch {
    return { hits: [], tokens: 0, degraded: { reason: "store_error" } };
  }

  const tokens = tokenizeRecallQuery(text);
  const excluded = new Set(
    (opts.excludeTexts ?? [])
      .map((value) => normalizeText(escapeContextMarkers(value)))
      .filter((value) => value.length > 0),
  );
  const scored: SortableHit[] = [];
  for (const item of items) {
    if (item.status !== "auto" && item.status !== "promoted") continue;
    if (item.invalidatedBy) continue;
    if (item.expiresAt && Date.parse(item.expiresAt) <= now) continue;
    if (item.scope === "session") continue;
    if (item.scope === "project") {
      if (opts.projectKey === undefined || item.projectKey !== opts.projectKey) continue;
    } else if (item.scope !== "global") {
      continue;
    }
    const hit = scoreRecall(item, tokens);
    if (!hit) continue;
    const key = normalizeText(escapeContextMarkers(hit.text));
    if (!key || excluded.has(key)) continue;
    scored.push({ ...hit, updatedAtForSort: item.updatedAt, textKey: key });
  }

  scored.sort(compareHits);
  const seen = new Set<string>();
  const eligible: RecallHit[] = [];
  for (const hit of scored) {
    if (hit.numericConflict || hit.negationMismatch) continue;
    if (seen.has(hit.textKey)) continue;
    seen.add(hit.textKey);
    eligible.push(stripSortKey(hit));
  }

  const selected: RecallHit[] = [];
  let budgetBlocked = false;
  for (const hit of eligible) {
    if (selected.length >= limit) break;
    const trial = [...selected, hit];
    if (estimateTokens(renderRecallBlock(trial, 0)) > tokenBudget) {
      budgetBlocked = true;
      continue;
    }
    selected.push(hit);
  }

  if (selected.length === 0) {
    return {
      hits: [],
      tokens: 0,
      ...(budgetBlocked && eligible.length > 0 ? { degraded: { reason: "budget" } } : {}),
    };
  }
  const rendered = renderRecallBlock(selected, 0);
  return { hits: selected, tokens: estimateTokens(rendered) };
}

export type RecallParentState = "root" | "child" | "unknown";

/**
 * Dynamic block metadata marker. It is local to this plugin and never written
 * to `entry`, the session store or the user transcript.
 */
function dynamicPart(block: string): RecallSystemPart {
  return {
    type: "text",
    text: block,
    metadata: { [RECALL_METADATA_KEY]: { block: "recall", version: 1 } },
  };
}

function isRecallPart(part: RecallSystemPart): boolean {
  if (typeof part.text !== "string") return false;
  if (part.metadata && isRecord(part.metadata[RECALL_METADATA_KEY])) {
    const marker = part.metadata[RECALL_METADATA_KEY];
    if (isRecord(marker) && marker.block === "recall") return true;
  }
  // Exact own rendering only: header at the start and our sentinel at the end.
  return part.text.startsWith(RECALL_HEADER) && part.text.trimEnd().endsWith(RECALL_SENTINEL);
}

/** Remove only this plugin's dynamic recall parts. Returns true if any were. */
export function stripRecallBlock(system: RecallSystemPart[]): boolean {
  let removed = false;
  for (let index = system.length - 1; index >= 0; index -= 1) {
    if (!isRecallPart(system[index])) continue;
    system.splice(index, 1);
    removed = true;
  }
  return removed;
}

export interface RecallAttachInput {
  sessionID: string;
  projectKey?: string;
  messages: ReadonlyArray<unknown>;
  system: RecallSystemPart[];
  parentSessionID?: string;
  /**
   * Fresh per-request parent proof from the host. Absent means `unknown`, and
   * unknown fails closed. `parentSessionID` alone is treated as child.
   */
  parentState?: RecallParentState;
  /** Normalized prefix text to avoid spending the dynamic budget twice. */
  excludeTexts?: ReadonlyArray<string>;
}

/**
 * V2 context-hook adapter. Removes a stale dynamic part, then appends at most
 * one bounded block. It never touches `messages`, `contextBlock` or `entry`.
 */
export async function attachRecallBlock(
  input: RecallAttachInput,
  deps: { store: Store; config: AutoMemConfig; now?: () => number },
): Promise<void> {
  try {
    stripRecallBlock(input.system);
    if (!(deps.config.recall?.enabled ?? deps.config.automation?.enabled ?? false)) return;
    if (input.parentSessionID) return;
    const parentState: RecallParentState = input.parentState ?? "unknown";
    if (parentState !== "root") return;
    const query = selectRecallQuery(input.messages);
    if (!query) return;
    const result = await recallMemory(deps.store, deps.config, query, {
      ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}),
      limit: deps.config.recall?.limit ?? DEFAULT_LIMIT,
      tokenBudget: deps.config.recall?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      now: deps.now ? deps.now() : Date.now(),
      ...(input.excludeTexts ? { excludeTexts: input.excludeTexts } : {}),
    });
    if (result.hits.length === 0) return;
    const block = renderRecallBlock(result.hits, 0);
    if (!block) return;
    input.system.push(dynamicPart(block));
  } catch {
    // Recall is nonblocking: any failure leaves the request untouched and logs
    // no query or item text.
  }
}

export interface RecallPrefixResult {
  parts: RecallSystemPart[];
  mode:
    | "none"
    | "metadataKey"
    | "contextWrapper"
    | "knownText"
    | "sentinel"
    | "appended"
    | "unlocated";
  residual: boolean;
  /** Indexes of parts whose owned boundary could not be proven. */
  ambiguous: number[];
}

/**
 * Replace only this plugin's owned prefix inside `event.system`, reusing the
 * P01 helper so there is exactly one replacement implementation. Revoked text
 * is checked only inside owned parts: host parts, user messages and other
 * plugins' content with the same fact stay untouched.
 */
export function rewriteManagedPrefix(input: {
  system: RecallSystemPart[];
  freshText: string;
  revokedTexts: ReadonlyArray<string>;
  entryKey?: string;
  /** Exact previous/fresh full renderings accepted as markerless own evidence. */
  knownTexts?: ReadonlyArray<string>;
}): RecallPrefixResult {
  // Only the product entry key is implemented; another key is not guessed at.
  if (input.entryKey !== undefined && input.entryKey !== "plugin.memory-autopilot") {
    return { parts: input.system, mode: "unlocated", residual: true, ambiguous: [] };
  }
  const knownTexts = (input.knownTexts ?? []).filter((value) => value.trim().length >= 8);
  const before = input.system.map((part) => part.text).join("\n");
  const hadOwnedEvidence = input.system.some(
    (part) =>
      isOwnedPrefixPart(part) ||
      knownTexts.some((known) => part.text.includes(known)),
  );
  const result = applyOwnedContextDetailed(input.system, input.freshText, knownTexts);
  if (hadOwnedEvidence && result.parts.length > input.system.length) {
    // An owned marker exists but its boundary could not be recognised. The
    // helper would append a second block; keep the request as-is and report
    // the degraded shape instead of double-injecting.
    return { parts: input.system, mode: "unlocated", residual: true, ambiguous: result.ambiguous };
  }
  let parts: RecallSystemPart[] = result.parts;

  const revoked = input.revokedTexts
    .map(normalizeText)
    .filter((value) => value.length > 0);
  if (revoked.length > 0) {
    const next: RecallSystemPart[] = [];
    for (const part of parts) {
      if (!isOwnedPrefixPart(part)) {
        next.push(part);
        continue;
      }
      const body = normalizeText(part.text);
      if (!revoked.some((value) => body.includes(value))) {
        next.push(part);
        continue;
      }
      // Remove only the owned source, keeping any host text wrapped around a
      // recorded copy. Never drop the whole part if it also carries host data.
      next.push(...applyOwnedContextDetailed([part], "").parts);
    }
    parts = next;
  }

  const ambiguous = result.ambiguous;
  if (ambiguous.length > 0) {
    return { parts, mode: "unlocated", residual: true, ambiguous };
  }
  const after = parts.map((part) => part.text).join("\n");
  if (parts.length > input.system.length) {
    return { parts, mode: "appended", residual: false, ambiguous };
  }
  if (after !== before) {
    return { parts, mode: "contextWrapper", residual: false, ambiguous };
  }
  return { parts, mode: "none", residual: false, ambiguous };
}

const OWNED_OPEN = '<context key="plugin.memory-autopilot">';
const ALT_OWNED_OPEN = '<context key="api/plugin.memory-autopilot">';

/**
 * Precise owned evidence for the revocation fallback: exact metadata key or
 * exactly our own single `<context key>` wrapper. Never a generic heading and
 * never "same fact".
 */
function isOwnedPrefixPart(part: RecallSystemPart): boolean {
  if (part.metadata) {
    const experimental = part.metadata.experimental;
    if (isRecord(experimental) && Array.isArray(experimental.instructions)) {
      for (const entry of experimental.instructions) {
        if (
          isRecord(entry) &&
          (entry.key === "api/plugin.memory-autopilot" ||
            entry.key === "plugin.memory-autopilot")
        ) {
          return true;
        }
      }
    }
  }
  for (const open of [OWNED_OPEN, ALT_OWNED_OPEN]) {
    if (
      part.text.startsWith(open) &&
      part.text.trimEnd().endsWith("</context>") &&
      part.text.indexOf(open, open.length) === -1
    ) {
      return true;
    }
  }
  return false;
}
