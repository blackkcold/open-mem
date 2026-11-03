import { lintText } from "../linter.js";
import type { RewriteInput, RewriteOutput, RewriteValidation } from "./types.js";

const IDENTIFIER_RE =
  /(?:\d+(?:\.\d+)?)|(?:https?:\/\/[^\s，。；;、]+)|(?:(?:~|\/)[A-Za-z0-9._\-\/]+)|(?:(?:ses|msg|prt)_[A-Za-z0-9]+)/g;

export function validateRewrite(
  input: RewriteInput,
  output: RewriteOutput,
): RewriteValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = output.title.trim();
  const text = output.text.trim();

  if (!title) errors.push("标题为空");
  if (!text) errors.push("正文为空");
  if (title.length > input.titleMaxChars) {
    errors.push(`标题 ${title.length} 字，超过 ${input.titleMaxChars}`);
  }

  const lint = lintText({
    title,
    text,
    kind: input.candidate.kind,
    scope: input.candidate.scope,
    maxChars: input.maxChars,
    titleMaxChars: input.titleMaxChars,
  });
  errors.push(...lint.errors);
  warnings.push(...lint.warnings);

  const inputIds = new Set(extractIdentifiers(`${input.target.text} ${input.candidate.text}`));
  const outputIds = new Set(extractIdentifiers(text));
  const droppedIds = new Set(extractIdentifiers(output.dropped.map((drop) => drop.text).join(" ")));

  for (const id of outputIds) {
    if (!inputIds.has(id)) errors.push(`输出出现输入中不存在的数字/标识：${id}`);
  }
  for (const id of inputIds) {
    if (!outputIds.has(id) && !droppedIds.has(id)) {
      errors.push(`丢失输入中的数字/标识：${id}`);
    }
  }
  for (const drop of output.dropped) {
    if (!drop.reason.trim()) errors.push(`丢弃项缺少理由：${drop.text.slice(0, 30)}`);
  }

  if (input.candidate.kind === "rule" && output.action === "merge") {
    errors.push("规则类条目不允许自动合并，只能保留两条或替换");
  }
  if (input.conflict > 0.5 && output.action !== "keep_both") {
    errors.push("检测到冲突，必须保留两条");
  }
  if (output.action === "keep_both" && text !== input.target.text.trim()) {
    warnings.push("keep_both 时正文与目标不同，请确认");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function extractIdentifiers(text: string): string[] {
  const matches = text.match(IDENTIFIER_RE) ?? [];
  return [...new Set(matches.map((match) => match.trim()).filter(Boolean))];
}
