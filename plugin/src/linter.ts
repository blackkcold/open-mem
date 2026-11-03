import type { ItemKind, Scope, SkillValidation } from "./types.js";

const EXAMPLE_RE = /(?:例如|比如|譬如|举例|e\.g\.|for example|such as)/i;
const TRANSIENT_RE =
  /(?:今天|今天下午|刚刚|刚才|本次会话|当前任务|这个任务|临时|暂时|稍后|明天|昨天|session|temporary|for now)/i;
const SECRET_RE =
  /(?:sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|token\s*[:=]|password\s*[:=]|secret\s*[:=]|密码\s*[:=]|密钥\s*[:=]|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/i;
const DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/;
const SESSION_RE = /\b(?:ses|msg|prt)_[A-Za-z0-9]+\b/;
const ABS_PATH_RE = /(?:^|\s)\/(?:Users|private|var|tmp|etc)\//;
const RULE_MARKER_RE =
  /(?:必须|不要|禁止|只能|优先|避免|保持|使用|先|每次|以后|一律|永远|always|never|must|should|use|avoid|prefer|keep|do not)/i;

export function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9]+/g) ?? [];
}

export function bigrams(text: string): Set<string> {
  const parts = tokens(text);
  const out = new Set<string>();
  for (let i = 0; i < parts.length - 1; i++) out.add(`${parts[i]}${parts[i + 1]}`);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface LintInput {
  title: string;
  text: string;
  kind: ItemKind;
  scope: Scope;
  maxChars: number;
  titleMaxChars?: number;
}

export interface LintResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  normalized: string;
}

export function lintText(input: LintInput): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized = compact(input.text);
  const title = compact(input.title);
  const maxChars = input.maxChars;
  const titleMax = input.titleMaxChars ?? 30;
  const isRule = input.kind === "rule";

  if (!normalized) errors.push("text is empty");
  if (!title) errors.push("title is empty");
  if (title.length > titleMax) errors.push(`title is ${title.length} chars > ${titleMax}`);
  if (normalized.length > maxChars) errors.push(`text is ${normalized.length} chars > ${maxChars}`);
  if (EXAMPLE_RE.test(normalized)) errors.push("contains examples; move examples to a skill/reference");
  if (TRANSIENT_RE.test(normalized)) errors.push("contains transient/session-specific wording");
  if (SECRET_RE.test(normalized)) errors.push("contains a secret-like value");
  if (DATE_RE.test(normalized)) warnings.push("contains a date; keep only if the date is part of the fact");
  if (SESSION_RE.test(normalized)) errors.push("contains a session/message id");
  if (input.scope === "global" && ABS_PATH_RE.test(normalized)) {
    warnings.push("global memory contains an absolute local path; move it to project memory or a reference");
  }
  if (isRule && !RULE_MARKER_RE.test(normalized)) {
    warnings.push("rule does not look imperative; make the action explicit");
  }
  const sentences = normalized.split(/[。！？!?；;\n]+/).filter((part) => part.trim().length > 0);
  if (sentences.length > 2) errors.push("multiple claims; split into atomic entries");
  if (/\n\s*\n/.test(input.text)) errors.push("multiple paragraphs; keep one atomic entry");
  return { ok: errors.length === 0, errors, warnings, normalized };
}

export function findBestOverlap(
  text: string,
  existing: Array<{ id: string; title: string; text: string }>,
): { score: number; item?: { id: string; title: string; text: string } } {
  const target = bigrams(text);
  let best: { score: number; item?: { id: string; title: string; text: string } } = { score: 0 };
  for (const item of existing) {
    const score = jaccard(target, bigrams(`${item.title} ${item.text}`));
    if (score > best.score) best = { score, item };
  }
  return best;
}

export function hasSecret(text: string): boolean {
  return SECRET_RE.test(text);
}

export function validateSkillDraft(input: {
  name: string;
  description: string;
  content: string;
  references?: string[];
}): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = input.name.trim();
  const description = input.description.trim();
  const content = input.content;

  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    errors.push("name must be lowercase letters/digits/hyphens, 1-64 chars");
  }
  if (!description) errors.push("description is empty");
  if (description.length > 1024) warnings.push("description is long; keep it under 1024 chars");
  if (!/(?:use when|when to use|用于|当|触发|适用)/i.test(description)) {
    warnings.push("description does not state when to use the skill");
  }
  if (content.split("\n").length > 500) {
    errors.push("SKILL.md is over 500 lines; move detail to references");
  }
  if (!/^---\n[\s\S]*?\n---\n/.test(content)) {
    errors.push("SKILL.md frontmatter is missing");
  }
  if (!/##\s+Workflow|##\s+工作流/i.test(content)) {
    warnings.push("SKILL.md has no Workflow section");
  }
  if (!/##\s+Verification|##\s+验证/i.test(content)) {
    warnings.push("SKILL.md has no Verification section");
  }
  if (/(?:^|\n)#+\s+(?:README|CHANGELOG|INSTALL)/i.test(content)) {
    warnings.push("skill contains an auxiliary README/CHANGELOG/INSTALL section");
  }
  if (hasSecret(content)) errors.push("skill content contains a secret-like value");
  for (const ref of input.references ?? []) {
    if (!content.includes(ref)) warnings.push(`reference not linked from SKILL.md: ${ref}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
