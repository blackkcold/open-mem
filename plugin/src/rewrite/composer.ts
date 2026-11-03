import { bigrams, compact, jaccard } from "../linter.js";
import type { RewriteInput, RewriteOutput } from "./types.js";

export function composeRewrite(input: RewriteInput): RewriteOutput {
  const started = Date.now();
  const targetText = compact(input.target.text);
  const candidateText = compact(input.candidate.text);

  if (input.conflict > 0.5 || (input.candidate.kind === "rule" && input.action === "merge_into")) {
    return {
      action: "keep_both",
      title: input.target.title,
      text: targetText,
      preserved: [targetText],
      dropped: [{ text: candidateText, reason: "冲突或规则类条目需要人工决定是否合并" }],
      rationale: "检测到冲突/规则，保留目标，候选交由人工处理。",
      source: "composer",
      latencyMs: Date.now() - started,
    };
  }

  if (normalize(targetText).includes(normalize(candidateText))) {
    return {
      action: "merge",
      title: input.target.title,
      text: targetText,
      preserved: [targetText],
      dropped: [],
      rationale: "目标已覆盖候选内容。",
      source: "composer",
      latencyMs: Date.now() - started,
    };
  }
  if (normalize(candidateText).includes(normalize(targetText))) {
    return {
      action: input.action === "replace" ? "replace" : "merge",
      title: chooseTitle(input, candidateText),
      text: candidateText,
      preserved: [candidateText],
      dropped: [],
      rationale: "候选包含目标的全部信息。",
      source: "composer",
      latencyMs: Date.now() - started,
    };
  }

  const kept = splitClauses(targetText);
  const dropped: Array<{ text: string; reason: string }> = [];
  for (const clause of splitClauses(candidateText)) {
    if (kept.some((existing) => similarClause(existing, clause))) continue;
    if (kept.length >= 2) {
      dropped.push({ text: clause, reason: "保持原子性：合并后最多两条子句" });
      continue;
    }
    const next = `${[...kept, clause].join("；")}。`;
    if (next.length <= input.maxChars) {
      kept.push(clause);
    } else {
      dropped.push({ text: clause, reason: "超过长度上限" });
    }
  }

  let text = `${kept.join("；")}。`;
  if (text.length > input.maxChars) {
    text = `${text.slice(0, Math.max(1, input.maxChars - 1))}…`;
  }
  return {
    action: input.action === "replace" ? "replace" : "merge",
    title: chooseTitle(input, text),
    text,
    preserved: kept,
    dropped,
    rationale: "模板合并：保留目标并追加候选的独有信息。",
    source: "composer",
    latencyMs: Date.now() - started,
  };
}

function chooseTitle(input: RewriteInput, text: string): string {
  if (input.target.title.length <= input.titleMaxChars) return input.target.title;
  const prefix =
    input.candidate.kind === "rule"
      ? "[R]"
      : input.candidate.kind === "preference"
        ? "[P]"
        : input.candidate.kind === "skill"
          ? "[S]"
          : "[F]";
  return `${prefix} ${compact(text).slice(0, Math.max(0, input.titleMaxChars - 4))}`.slice(
    0,
    input.titleMaxChars,
  );
}

function splitClauses(text: string): string[] {
  const parts = compact(text)
    .split(/[。；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [compact(text)];
}

function similarClause(left: string, right: string): boolean {
  return jaccard(bigrams(left), bigrams(right)) >= 0.8;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
