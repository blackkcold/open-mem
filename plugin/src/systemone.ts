import type {
  DecisionInput,
  DecisionNeighbor,
  DecisionResult,
  ItemKind,
  MergeAction,
  Strictness,
} from "./types.js";

import { modelHeaders } from "./util/endpoint.js";
import { redactText } from "./redact.js";

const KIND_VALUES: ItemKind[] = ["fact", "preference", "rule", "reference", "skill"];
const MERGE_VALUES: MergeAction[] = [
  "create",
  "merge_into",
  "replace",
  "keep_both",
  "reject_duplicate",
];

export class SystemOneError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, message: string, detail = "") {
    super(message);
    this.name = "SystemOneError";
    this.status = status;
    this.detail = detail;
  }
}

export interface SystemOneOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export class SystemOneClient {
  constructor(private readonly options: SystemOneOptions) {}

  async classify(input: DecisionInput): Promise<DecisionResult> {
    const started = Date.now();
    const request = buildRequest(this.options.model, input);
    let response: Response;
    try {
      response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: modelHeaders(this.options.endpoint, this.options.apiKey),
        redirect: "error",
        body: redactText(JSON.stringify(request), { paths: false }).text,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "System One 请求超时"
          : `System One 网络错误：${error instanceof Error ? error.message : String(error)}`;
      throw new SystemOneError(0, message);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SystemOneError(
        response.status,
        httpMessage(response.status),
        body.slice(0, 500),
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new SystemOneError(0, "System One 返回的不是合法 JSON");
    }
    return parseResponse(data, input, this.options.model, Date.now() - started);
  }
}

function buildRequest(model: string, input: DecisionInput): Record<string, unknown> {
  const neighbors = (input.neighbors ?? []).slice(0, 3);
  const targetCriteria: Record<string, string> = {
    none: "Keep the candidate as a new memory; do not merge it into an existing entry.",
  };
  neighbors.forEach((neighbor, index) => {
    targetCriteria[`n${index + 1}`] = trim(`${neighbor.title}: ${neighbor.text}`, 260);
  });

  const questions: Record<string, unknown> = {
    kind: {
      type: "choice",
      instructions:
        "Classify the candidate. fact = durable environment/project fact; preference = how the user likes work done; rule = an imperative that changes future behavior; reference = a pointer to a file, URL, or document; skill = a reusable workflow that should become a skill; ignore = transient or not worth remembering.",
      criteria: {
        fact: "A durable fact about the project, environment, or tooling.",
        preference: "A user preference about style, tools, or workflow.",
        rule: "An imperative rule that changes how future work is done.",
        reference: "A pointer to a file, URL, command, or document.",
        skill: "A reusable multi-step workflow or procedure.",
        ignore: "Transient, task-specific, or not worth remembering.",
      },
    },
    safety: {
      type: "noul",
      instructions:
        "Does this candidate affect safety, credentials, privacy, destructive actions, or irreversible operations?",
      criteria: {
        false: "No safety, credential, privacy, or destructive impact.",
        true: "It affects safety, credentials, privacy, or destructive/irreversible actions.",
      },
    },
    strict_limit: {
      type: "noul",
      instructions:
        "Does this candidate impose a hard numeric limit, quota, timeout, permission boundary, or scope restriction?",
      criteria: {
        false: "No hard limit or permission boundary.",
        true: "It imposes a hard limit, quota, timeout, permission, or scope restriction.",
      },
    },
    duplicate: {
      type: "noul",
      instructions:
        "Is the candidate already fully covered by the candidate neighbors listed in the state? Consider meaning, not only wording.",
      criteria: {
        false: "It adds information that is not already covered.",
        true: "It is already fully covered by an existing neighbor.",
      },
    },
    safe_auto: {
      type: "noul",
      instructions:
        "Is it safe to apply this candidate automatically without asking the user first, assuming it passes the text linter? Removal, contradiction, permissions, strict limits, and safety topics must be false.",
      criteria: {
        false: "A human should review it before it is written.",
        true: "It is additive, low-risk, and safe to write without review.",
      },
    },
    conflict: {
      type: "noul",
      instructions:
        "Does the candidate contradict or reverse an existing neighbor (for example, use X vs do not use X)?",
      criteria: {
        false: "No contradiction with any neighbor.",
        true: "It contradicts or reverses an existing neighbor.",
      },
    },
    merge_action: {
      type: "choice",
      instructions:
        "Choose how the candidate should be handled. Prefer create for new information, merge_into when a neighbor should absorb it, replace when the candidate supersedes a neighbor, keep_both when both must remain, reject_duplicate when a neighbor already covers it.",
      criteria: {
        create: "Create a new memory; no neighbor is a suitable merge target.",
        merge_into: "Merge the candidate into one existing neighbor.",
        replace: "Replace one existing neighbor with the candidate.",
        keep_both: "Keep both entries; they are related but must not be merged.",
        reject_duplicate: "Reject the candidate; an existing neighbor already covers it.",
      },
    },
  };

  if (neighbors.length > 0) {
    questions.merge_target = {
      type: "choice",
      instructions:
        "If merge_action is merge_into, replace, or reject_duplicate, choose the target neighbor. Otherwise choose none.",
      criteria: targetCriteria,
    };
  }

  return {
    model,
    state: {
      candidate: {
        title: input.title,
        text: input.candidate,
        kind_hint: input.existingTitles.length > 0 ? "unknown" : "unknown",
        scope: input.scope,
        project: input.project ?? "",
      },
      neighbors: neighbors.map((neighbor) => ({
        id: neighbor.id,
        title: neighbor.title,
        text: trim(neighbor.text, 240),
        kind: neighbor.kind,
        scope: neighbor.scope,
        status: neighbor.status,
        similarity: neighbor.similarity,
      })),
      limits: {
        memory_max_chars: 200,
        rule_max_chars: 160,
        title_max_chars: 30,
      },
    },
    questions,
  };
}

function parseResponse(
  value: unknown,
  input: DecisionInput,
  model: string,
  latencyMs: number,
): DecisionResult {
  const data = isRecord(value) ? value : {};
  const answers = isRecord(data.answers) ? data.answers : undefined;
  if (!answers) throw new SystemOneError(0, "System One 响应缺少 answers");

  const kindAnswer = choiceOf(answers, "kind");
  const mergeAnswer = choiceOf(answers, "merge_action");
  const targetAnswer = choiceOf(answers, "merge_target");
  const safety = noulOf(answers, "safety");
  const strictLimit = noulOf(answers, "strict_limit");
  const duplicate = noulOf(answers, "duplicate");
  const safeAuto = noulOf(answers, "safe_auto");
  const conflict = noulOf(answers, "conflict");

  const kind: ItemKind | "ignore" =
    kindAnswer.choice === "ignore"
      ? "ignore"
      : isKind(kindAnswer.choice)
        ? kindAnswer.choice
        : "fact";

  const neighbors = (input.neighbors ?? []).slice(0, 3);
  const targetIndex =
    targetAnswer.choice && /^n[1-3]$/.test(targetAnswer.choice)
      ? Number(targetAnswer.choice.slice(1)) - 1
      : -1;
  const mergeTargetId =
    targetIndex >= 0 && neighbors[targetIndex] ? neighbors[targetIndex].id : undefined;

  const mergeAction: MergeAction = isMergeAction(mergeAnswer.choice)
    ? mergeAnswer.choice
    : duplicate >= 0.9
      ? "reject_duplicate"
      : duplicate >= 0.6
        ? "keep_both"
        : "create";

  const confidence =
    mergeAnswer.confidence > 0
      ? mergeAnswer.confidence
      : Math.max(
          ...[safety, strictLimit, duplicate, safeAuto, conflict].map((probability) =>
            Math.abs(probability - 0.5) * 2,
          ),
        );

  const strictness: Strictness =
    safety > 0.5
      ? "safety"
      : strictLimit > 0.5
        ? "strict_limit"
        : kind === "rule" || kind === "skill"
          ? "workflow"
          : kind === "preference"
            ? "preference"
            : "unknown";

  const risk = clamp01(
    Math.max(
      safety,
      strictLimit * 0.9,
      kind === "rule" ? 0.35 : kind === "preference" ? 0.2 : 0.12,
      conflict * 0.8,
    ),
  );
  const usage = isRecord(data.usage)
    ? {
        inputTokens:
          typeof data.usage.input_tokens === "number" ? data.usage.input_tokens : 0,
        outputTokens:
          typeof data.usage.output_tokens === "number" ? data.usage.output_tokens : 0,
      }
    : undefined;

  return {
    kind,
    duplicate: clamp01(duplicate),
    safeAuto: clamp01(safeAuto),
    risk,
    confidence: clamp01(confidence),
    strictness,
    reasons: [
      `System One · ${kind}`,
      `duplicate ${Math.round(duplicate * 100)}%`,
      `safe_auto ${Math.round(safeAuto * 100)}%`,
      `action ${mergeAction}`,
      ...(mergeTargetId ? [`target ${mergeTargetId}`] : []),
    ],
    source: "systemone",
    mergeAction,
    // reject_duplicate also needs its target: consolidation uses it to drop
    // the duplicate before it reaches the queue.
    mergeTargetId:
      mergeAction === "merge_into" ||
      mergeAction === "replace" ||
      mergeAction === "reject_duplicate"
        ? mergeTargetId
        : undefined,
    conflict: clamp01(conflict),
    safety: clamp01(safety),
    strictLimit: clamp01(strictLimit),
    usage,
    latencyMs,
    model,
  };
}

function choiceOf(
  answers: Record<string, unknown>,
  name: string,
): { choice?: string; confidence: number } {
  const answer = answers[name];
  if (!isRecord(answer)) return { confidence: 0 };
  return {
    choice: typeof answer.choice === "string" ? answer.choice : undefined,
    confidence: typeof answer.confidence === "number" ? clamp01(answer.confidence) : 0,
  };
}

function noulOf(answers: Record<string, unknown>, name: string): number {
  const answer = answers[name];
  if (typeof answer === "number" && Number.isFinite(answer)) return clamp01(answer);
  if (!isRecord(answer)) return 0;
  const value = answer.noul ?? answer.probability ?? answer.value ?? answer.score;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
}

function httpMessage(status: number): string {
  if (status === 401) return "OLLAMA_API_KEY 缺失或无效";
  if (status === 402) return "Ollama Cloud 额度不足，请检查用量或升级套餐";
  if (status === 404) return "System One 模型不存在，请检查模型 ID";
  if (status === 413) return "输入超过 System One 限制";
  if (status === 400) return "System One 请求不合法";
  if (status >= 500) return "System One 服务暂时不可用";
  return `System One 返回 HTTP ${status}`;
}

function isKind(value: string | undefined): value is ItemKind {
  return typeof value === "string" && (KIND_VALUES as string[]).includes(value);
}

function isMergeAction(value: string | undefined): value is MergeAction {
  return typeof value === "string" && (MERGE_VALUES as string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export type { DecisionNeighbor };
