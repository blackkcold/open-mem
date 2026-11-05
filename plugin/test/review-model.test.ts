import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { parseReview, ReviewFormatError } from "../src/review/parse.js";
import { validateReviewCandidates } from "../src/review/validate.js";
import { buildReviewPrompt, ReviewProvider } from "../src/review/provider.js";
import type { ReviewInput } from "../src/review/input.js";
import type { ReviewCandidate } from "../src/types.js";

const config = mergeConfig({ review: { minConfidence: 0.7, maxCandidates: 6 } });

function inputWith(sources: ReviewInput["sources"]): ReviewInput {
  return {
    sessionID: "ses_1",
    items: [],
    chars: 0,
    hash: "abc",
    truncated: false,
    userCount: 1,
    toolCount: 1,
    rawToolChars: 0,
    sources,
  };
}

function candidate(overrides: Partial<ReviewCandidate>): ReviewCandidate {
  return {
    type: "preference",
    text: "回复一律使用中文，不要用英文",
    scope: "global",
    confidence: 0.9,
    evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" }],
    ...overrides,
  };
}

describe("parseReview", () => {
  it("accepts session scope and defaults missing scope to session", () => {
    const parsed = parseReview(
      JSON.stringify({
        summary: [],
        candidates: [
          {
            type: "rule",
            text: "本次任务只读，不要修改文件",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "只读", kind: "user" }],
          },
          {
            type: "rule",
            text: "以后所有项目都先给结论",
            scope: "global",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "以后", kind: "user" }],
          },
          {
            type: "fact",
            text: "本项目端口是 5199",
            scope: "project",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "端口", kind: "user" }],
          },
        ],
        openQuestions: [],
      }),
    );
    expect(parsed.candidates.map((candidate) => candidate.scope)).toEqual([
      "session",
      "global",
      "project",
    ]);
  });

  it("asks for session/project/global scope and task_only", () => {
    const prompt = buildReviewPrompt(
      inputWith({ m1: { user: "以后回复都用中文", tools: [] } }),
    );
    expect(prompt).toContain('"scope":"session|project|global"');
    expect(prompt).toContain("task_only");
  });

  it("parses fenced JSON and clamps confidence", () => {
    const parsed = parseReview(
      '```json\n{"summary":["a"],"candidates":[{"type":"fact","text":"端口是 47821","scope":"project","confidence":3,"evidence":[{"messageID":"m1","quote":"端口 47821","kind":"user"}]}],"openQuestions":[]}\n```',
    );
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0].confidence).toBe(1);
    expect(parsed.candidates[0].scope).toBe("project");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseReview("not json at all")).toThrow(ReviewFormatError);
  });

  it("drops entries with an unknown type or empty text", () => {
    const parsed = parseReview(
      JSON.stringify({
        summary: [],
        candidates: [
          { type: "nonsense", text: "x", confidence: 0.9, evidence: [] },
          { type: "fact", text: "", confidence: 0.9, evidence: [] },
          { type: "fact", text: "端口 47821", confidence: 0.9, evidence: [] },
        ],
        openQuestions: [],
      }),
    );
    expect(parsed.candidates).toHaveLength(1);
  });
});

describe("validateReviewCandidates", () => {
  const input = inputWith({
    m1: { user: "以后回复都用中文，别再写英文", tools: [] },
    m2: {
      tools: [{ text: "bash $ npm test → 失败 (exit 1): FAIL a.test.ts", ok: false, tool: "bash" }],
    },
    m3: { tools: [{ text: "bash $ npm run build → 完成", ok: true, tool: "bash" }] },
  });

  it("accepts a preference backed by a literal user quote", () => {
    const result = validateReviewCandidates([candidate({})], input, config);
    expect(result.accepted).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops a quote that is not a literal substring", () => {
    const result = validateReviewCandidates(
      [candidate({ evidence: [{ messageID: "m1", quote: "回复必须用英文", kind: "user" }] })],
      input,
      config,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped[0].reason).toContain("literal substring");
  });

  it("drops a fact without user evidence", () => {
    const result = validateReviewCandidates(
      [candidate({ type: "fact", evidence: [{ messageID: "m2", quote: "FAIL", kind: "tool" }] })],
      input,
      config,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped[0].reason).toContain("user quote");
  });

  it("accepts a learning only from a failing tool line", () => {
    const learning = candidate({
      type: "learning",
      text: "npm test 失败时先看第一条 FAIL 定位用例",
      evidence: [
        { messageID: "m2", quote: "bash $ npm test → 失败", kind: "tool" },
        { messageID: "m1", quote: "以后回复都用中文", kind: "user" },
      ],
    });
    expect(validateReviewCandidates([learning], input, config).accepted).toHaveLength(1);

    const wrong = candidate({
      type: "learning",
      text: "构建成功时说明类型没有问题",
      evidence: [{ messageID: "m3", quote: "bash $ npm run build → 完成", kind: "tool" }],
    });
    const rejected = validateReviewCandidates([wrong], input, config);
    expect(rejected.accepted).toHaveLength(0);
    expect(rejected.dropped[0].reason).toContain("failing tool");
  });

  it("requires two steps and both evidence kinds for a skill", () => {
    const skill = candidate({
      type: "skill",
      text: "排查测试失败的通用流程",
      steps: ["先跑 npm test", "再读第一条 FAIL"],
      evidence: [
        { messageID: "m1", quote: "以后回复都用中文", kind: "user" },
        { messageID: "m3", quote: "bash $ npm run build → 完成", kind: "tool" },
      ],
    });
    expect(validateReviewCandidates([skill], input, config).accepted).toHaveLength(1);

    const single = { ...skill, steps: ["只做一步"] };
    const rejected = validateReviewCandidates([single], input, config);
    expect(rejected.accepted).toHaveLength(0);
    expect(rejected.dropped[0].reason).toContain("2 steps");
  });

  it("drops low confidence and duplicate candidates", () => {
    const low = candidate({ confidence: 0.4 });
    const duplicate = candidate({ text: "回复一律使用中文，不要用英文。" });
    const result = validateReviewCandidates([candidate({}), duplicate, low], input, config);
    expect(result.accepted).toHaveLength(1);
    expect(result.dropped.map((entry) => entry.reason).join(" ")).toContain("duplicate");
    expect(result.dropped.map((entry) => entry.reason).join(" ")).toContain("below floor");
  });

  it("caps the accepted set", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      candidate({
        text: `偏好条目 ${index} 号内容`,
        evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" }],
      }),
    );
    const result = validateReviewCandidates(many, input, mergeConfig({ review: { maxCandidates: 3 } }));
    expect(result.accepted).toHaveLength(3);
    expect(result.dropped.filter((entry) => entry.reason.includes("cap"))).toHaveLength(6);
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function modelReply(payload: unknown): Response {
  return response({
    message: { content: JSON.stringify(payload) },
    prompt_eval_count: 10,
    eval_count: 5,
  });
}

const validPayload = {
  summary: ["用户偏好中文"],
  candidates: [
    {
      type: "preference",
      text: "回复一律使用中文，不要用英文",
      scope: "global",
      confidence: 0.9,
      evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" }],
    },
  ],
  openQuestions: [],
};

async function providerWith(
  fetchImpl: typeof fetch,
  patch: Record<string, unknown> = {},
): Promise<{ provider: ReviewProvider; dir: string; store: Store }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-"));
  const store = new Store(dir);
  await store.init();
  const provider = new ReviewProvider({
    store,
    config: mergeConfig({
      rewrite: { endpoint: "https://ollama.com" },
      review: { timeoutMs: 5000, ...patch },
    }),
    key: "test-key",
    fetchImpl,
  });
  return { provider, dir, store };
}

describe("ReviewProvider", () => {
  it("returns candidates with usage and caches the result", async () => {
    const fetchImpl = vi.fn(async () => modelReply(validPayload));
    const { provider, dir } = await providerWith(fetchImpl as unknown as typeof fetch);
    try {
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
      const first = await provider.review(input);
      expect(first.candidates).toHaveLength(1);
      expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      const second = await provider.review(input);
      expect(second.cached).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends the configured thinking level to Ollama", async () => {
    let body:
      | {
          model?: string;
          think?: string;
          options?: { num_predict?: number };
        }
      | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return modelReply(validPayload);
    });
    const { provider, dir } = await providerWith(
      fetchImpl as unknown as typeof fetch,
      {
        model: {
          providerID: "ollama-cloud",
          id: "deepseek-v4.1-flash:1017",
          variant: "high",
        },
      },
    );
    try {
      await provider.review(inputWith({ m1: { user: "以后回复都用中文", tools: [] } }));
      expect(body?.model).toBe("deepseek-v4.1-flash:1017");
      expect(body?.think).toBe("high");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps output and appends known titles after the transcript", async () => {
    let body:
      | {
          options?: { num_predict?: number };
          messages?: Array<{ content: string }>;
        }
      | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return modelReply(validPayload);
    });
    const { provider, dir } = await providerWith(
      fetchImpl as unknown as typeof fetch,
      { maxOutputTokens: 900, maxCandidates: 2 },
    );
    try {
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
      input.knownTitles = ["已有标题"];
      await provider.review(input);
      expect(body?.options?.num_predict).toBe(900);
      const prompt = body?.messages?.[0]?.content ?? "";
      expect(prompt).toContain("At most 2 candidates");
      expect(prompt.indexOf("Known titles")).toBeGreaterThan(
        prompt.indexOf("Transcript:"),
      );

      const base = buildReviewPrompt(input, 2);
      const withKnown = buildReviewPrompt({ ...input, knownTitles: ["已有标题"] }, 2);
      expect(withKnown.startsWith(base)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repairs invalid JSON once", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ message: { content: "not json" } }))
      .mockResolvedValueOnce(modelReply(validPayload));
    const { provider, dir } = await providerWith(fetchImpl as unknown as typeof fetch);
    try {
      const result = await provider.review(inputWith({ m1: { user: "以后回复都用中文", tools: [] } }));
      expect(result.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries a 5xx response once", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "boom" }, 503))
      .mockResolvedValueOnce(modelReply(validPayload));
    const { provider, dir } = await providerWith(fetchImpl as unknown as typeof fetch);
    try {
      const result = await provider.review(inputWith({ m1: { user: "以后回复都用中文", tools: [] } }));
      expect(result.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not retry a 4xx response", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "unauthorized" }, 401));
    const { provider, dir } = await providerWith(fetchImpl as unknown as typeof fetch);
    try {
      await expect(
        provider.review(inputWith({ m1: { user: "以后回复都用中文", tools: [] } })),
      ).rejects.toThrow("401");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens the circuit after three failures", async () => {
    const fetchImpl = vi.fn(async () => response({ error: "boom" }, 500));
    const { provider, dir } = await providerWith(fetchImpl as unknown as typeof fetch);
    try {
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(provider.review(input)).rejects.toThrow();
      }
      const calls = fetchImpl.mock.calls.length;
      await expect(provider.review(input)).rejects.toThrow("熔断");
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
