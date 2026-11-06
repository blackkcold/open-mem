import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { parseReview, ReviewFormatError } from "../src/review/parse.js";
import { validateReviewCandidates } from "../src/review/validate.js";
import { buildReviewPrompt, ReviewCacheError, ReviewProvider } from "../src/review/provider.js";
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

  it("downgrades a global claim that only has project-local wording", () => {
    const scoped = inputWith({
      m1: { user: "本项目每次都用 pnpm 安装依赖", tools: [] },
    });
    const result = validateReviewCandidates(
      [
        candidate({
          text: "本项目每次都用 pnpm 安装依赖",
          scope: "global",
          evidence: [
            {
              messageID: "m1",
              quote: "本项目每次都用 pnpm 安装依赖",
              kind: "user",
            },
          ],
        }),
      ],
      scoped,
      config,
    );
    expect(result.accepted[0].scope).toBe("project");
  });

  it("keeps a project claim when the evidence is durable but not task-only", () => {
    const scoped = inputWith({
      m1: { user: "以后回复先给结论", tools: [] },
    });
    const result = validateReviewCandidates(
      [
        candidate({
          text: "以后回复先给结论",
          scope: "project",
          evidence: [
            { messageID: "m1", quote: "以后回复先给结论", kind: "user" },
          ],
        }),
      ],
      scoped,
      config,
    );
    expect(result.accepted[0].scope).toBe("project");
  });

  it("does not let the model paraphrase a project-local quote into global", () => {
    const scoped = inputWith({
      m1: { user: "本项目每次都用 pnpm 安装依赖", tools: [] },
    });
    const result = validateReviewCandidates(
      [
        candidate({
          text: "所有项目每次都必须用 pnpm 安装依赖",
          scope: "global",
          evidence: [
            {
              messageID: "m1",
              quote: "本项目每次都用 pnpm 安装依赖",
              kind: "user",
            },
          ],
        }),
      ],
      scoped,
      config,
    );
    expect(result.accepted[0].scope).toBe("project");
  });

  it("downgrades an unsupported global claim to session", () => {
    const scoped = inputWith({ m1: { user: "回复先给结论再补充细节", tools: [] } });
    const result = validateReviewCandidates(
      [
        candidate({
          text: "回复先给结论再补充细节",
          scope: "global",
          evidence: [{ messageID: "m1", quote: "回复先给结论再补充细节", kind: "user" }],
        }),
      ],
      scoped,
      config,
    );
    expect(result.accepted[0].scope).toBe("session");
  });

  it("keeps explicit cross-project wording global", () => {
    const scoped = inputWith({
      m1: { user: "以后所有项目都用 pnpm", tools: [] },
    });
    const result = validateReviewCandidates(
      [
        candidate({
          text: "以后所有项目都用 pnpm",
          scope: "global",
          evidence: [
            { messageID: "m1", quote: "以后所有项目都用 pnpm", kind: "user" },
          ],
        }),
      ],
      scoped,
      config,
    );
    expect(result.accepted[0].scope).toBe("global");
  });

  it("accepts global only when scopeEvidence is a literal cross-project user quote", () => {
    const scoped = inputWith({
      m1: { user: "以后所有项目都要用中文回复", tools: [] },
    });
    const supported = validateReviewCandidates(
      [
        candidate({
          text: "始终使用中文回复",
          scope: "global",
          scopeEvidence: "所有项目都要用中文回复",
          evidence: [
            {
              messageID: "m1",
              quote: "以后所有项目都要用中文回复",
              kind: "user",
            },
          ],
        }),
      ],
      scoped,
      config,
    );
    expect(supported.accepted[0].scope).toBe("global");

    const sessionOnly = inputWith({
      m1: { user: "始终使用中文回复", tools: [] },
    });
    const unsupported = validateReviewCandidates(
      [
        candidate({
          text: "始终使用中文回复",
          scope: "global",
          scopeEvidence: "每个项目都要用中文",
          evidence: [
            {
              messageID: "m1",
              quote: "始终使用中文回复",
              kind: "user",
            },
          ],
        }),
      ],
      sessionOnly,
      config,
    );
    expect(unsupported.accepted[0].scope).toBe("session");
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

const invalidCaches: Array<[string, string]> = [
  ["entries: null", '{"version":1,"entries":null}'],
  ["entries: array", '{"version":1,"entries":[]}'],
  ["entries: scalar", '{"version":1,"entries":42}'],
  ["entries: string", '{"version":1,"entries":"nope"}'],
  ["an unsupported version", '{"version":2,"entries":{}}'],
  ["unknown top-level keys without entries", '{"version":1,"foo":1}'],
  ["a top-level array", "[]"],
  ["a top-level null", "null"],
];

async function providerWith(
  fetchImpl: typeof fetch,
  patch: Record<string, unknown> = {},
  storeFactory?: (dir: string) => Store,
  log?: (message: string, error?: unknown) => void,
): Promise<{ provider: ReviewProvider; dir: string; store: Store }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-"));
  const store = storeFactory?.(dir) ?? new Store(dir);
  await store.init();
  const provider = new ReviewProvider({
    store,
    config: mergeConfig({
      rewrite: { endpoint: "https://ollama.com" },
      review: { timeoutMs: 5000, ...patch },
    }),
    key: "test-key",
    fetchImpl,
    log,
  });
  return { provider, dir, store };
}

class GatedCacheStore extends Store {
  readCalls = 0;
  private gate?: Promise<void>;
  private releaseGate?: () => void;

  blockCacheRead(): void {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  resumeCacheRead(): void {
    this.releaseGate?.();
  }

  override async readCacheFile<T>(file: string, fallback: T): Promise<T> {
    this.readCalls += 1;
    if (this.gate) await this.gate;
    return super.readCacheFile(file, fallback);
  }
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

  it("retries cache loading after a temporary read failure and preserves the file", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const { provider, dir, store } = await providerWith(fetchImpl);
    const cachePath = store.reviewCachePath;
    const corrupt = "{broken cache";
    try {
      await writeFile(cachePath, corrupt, "utf8");
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });

      // The read failure must surface, and no model request may be sent while
      // the cache is unreadable.
      await expect(provider.review(input)).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readFile(cachePath, "utf8")).toBe(corrupt);

      // Repairing the environment must let the same instance reload instead of
      // replaying a permanently rejected in-flight promise.
      await writeFile(cachePath, "{}\n", "utf8");
      const result = await provider.review(input);
      expect(result.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shares one in-flight cache read between concurrent requests", async () => {
    let gatedStore: GatedCacheStore | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const { provider, dir } = await providerWith(
      fetchImpl,
      {},
      (target) => {
        gatedStore = new GatedCacheStore(target);
        return gatedStore;
      },
    );
    const gated = gatedStore;
    if (!gated) throw new Error("gated store was not created");
    try {
      gated.blockCacheRead();
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
      const first = provider.review(input);
      const second = provider.review(input);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gated.readCalls).toBe(1);

      gated.resumeCacheRead();
      const [left, right] = await Promise.all([first, second]);
      expect(left.candidates).toHaveLength(1);
      expect(right.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(invalidCaches)(
    "rejects %s without a model request or rewrite",
    async (_label, raw) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
      const { provider, dir, store } = await providerWith(fetchImpl);
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
      try {
        await writeFile(store.reviewCachePath, raw, "utf8");
        await expect(provider.review(input)).rejects.toThrow(ReviewCacheError);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(await readFile(store.reviewCachePath, "utf8")).toBe(raw);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("recovers the same provider after a structurally invalid cache is repaired", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const { provider, dir, store } = await providerWith(fetchImpl);
    const broken = '{"version":1,"entries":null}';
    const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
    try {
      await writeFile(store.reviewCachePath, broken, "utf8");
      await expect(provider.review(input)).rejects.toThrow(ReviewCacheError);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readFile(store.reviewCachePath, "utf8")).toBe(broken);

      await writeFile(store.reviewCachePath, "{}\n", "utf8");
      const result = await provider.review(input);
      expect(result.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not request or rewrite when one cache entry is malformed", async () => {
    const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
    // A different window would miss the valid entry and hit the model, which
    // is when a silent drop of the malformed row would become permanent.
    const otherInput = { ...input, hash: "def" };
    const seedFetch = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const seed = await providerWith(seedFetch);
    const cachePath = seed.store.reviewCachePath;
    try {
      await seed.provider.review(input);
      expect(seedFetch).toHaveBeenCalledTimes(1);
      const validCache = await readFile(cachePath, "utf8");

      const parsed: { version: number; entries: Record<string, unknown> } =
        JSON.parse(validCache);
      parsed.entries.broken = { at: "not-a-number", result: {} };
      const corrupted = `${JSON.stringify(parsed)}\n`;
      await writeFile(cachePath, corrupted, "utf8");

      const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
      const provider = new ReviewProvider({
        store: seed.store,
        config: mergeConfig({ review: { timeoutMs: 5000 } }),
        key: "test-key",
        fetchImpl,
      });

      const failure: unknown = await provider
        .review(otherInput)
        .catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(ReviewCacheError);
      if (!(failure instanceof ReviewCacheError)) {
        throw new Error("expected ReviewCacheError");
      }
      // Privacy: cache keys are untrusted content. Report category + count,
      // never the raw key. This assertion was previously `toContain("broken")`;
      // it is stricter about disclosure, not weaker about detection.
      expect(failure.message).not.toContain("broken");
      expect(failure.message).toMatch(/1 条/);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readFile(cachePath, "utf8")).toBe(corrupted);

      // Repairing the one bad row restores the valid entry on the same instance.
      await writeFile(cachePath, validCache, "utf8");
      const recovered = await provider.review(input);
      expect(recovered.cached).toBe(true);
      expect(recovered.candidates).toHaveLength(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await rm(seed.dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a cache damaged after the first load", async () => {
    const log = vi.fn((_message: string, _error?: unknown) => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const { provider, dir, store } = await providerWith(
      fetchImpl,
      {},
      undefined,
      log,
    );
    const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
    try {
      const first = await provider.review(input);
      expect(first.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const damages = [
        '{"version":1,"entries":[]}',
        '{"version":1,"entries":{"broken":{"at":"not-a-number","result":{}}}}',
      ];
      for (let index = 0; index < damages.length; index += 1) {
        const damaged = damages[index];
        await writeFile(store.reviewCachePath, damaged, "utf8");
        // A different window misses the loaded cache, completes a model call,
        // then persist sees the damaged snapshot and must not write.
        const result = await provider.review({ ...input, hash: `next-${index}` });
        expect(result.candidates).toHaveLength(1);
        expect(await readFile(store.reviewCachePath, "utf8")).toBe(damaged);
      }

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledTimes(2);
      expect(
        log.mock.calls.map((call) => String(call[0])).join(" "),
      ).toContain("review cache write failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports cache damage by category and count without echoing content", async () => {
    const versionSecret = "SENSITIVE-VERSION-42";
    const keySecret = "PRIVATE-CACHE-KEY";
    const cases: Array<[string, string]> = [
      ["version", `{"version":"${versionSecret}","entries":{}}`],
      ["entry", `{"version":1,"entries":{"${keySecret}":null}}`],
    ];
    for (const [kind, raw] of cases) {
      const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
      const { provider, dir, store } = await providerWith(fetchImpl);
      try {
        await writeFile(store.reviewCachePath, raw, "utf8");
        const error: unknown = await provider
          .review(inputWith({ m1: { user: "以后回复都用中文", tools: [] } }))
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ReviewCacheError);
        if (!(error instanceof ReviewCacheError)) {
          throw new Error("expected ReviewCacheError");
        }
        expect(error.message).not.toContain(versionSecret);
        expect(error.message).not.toContain(keySecret);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(await readFile(store.reviewCachePath, "utf8")).toBe(raw);
        if (kind === "version") {
          expect(error.message).toContain("版本");
        } else {
          expect(error.message).toMatch(/1 条/);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps unrecognized top-level cache fields when persisting", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const { provider, dir, store } = await providerWith(fetchImpl);
    const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
    try {
      await provider.review(input);
      const parsed: {
        version: number;
        entries: Record<string, unknown>;
        note?: string;
      } = JSON.parse(await readFile(store.reviewCachePath, "utf8"));
      parsed.note = "keep-me";
      await writeFile(
        store.reviewCachePath,
        `${JSON.stringify(parsed)}\n`,
        "utf8",
      );

      const result = await provider.review({ ...input, hash: "next" });
      expect(result.candidates).toHaveLength(1);
      const after: {
        version: number;
        entries: Record<string, unknown>;
        note?: string;
      } = JSON.parse(await readFile(store.reviewCachePath, "utf8"));
      expect(after.note).toBe("keep-me");
      expect(Object.keys(after.entries)).toHaveLength(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("initializes when the review cache file does not exist", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
    const { provider, dir, store } = await providerWith(fetchImpl);
    const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
    try {
      await rm(store.reviewCachePath, { force: true });
      const result = await provider.review(input);
      expect(result.candidates).toHaveLength(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts legacy cache shapes without a version or entries field", async () => {
    const shapes = ['{"version":1}\n', '{"entries":{}}\n', '{}\n'];
    for (const shape of shapes) {
      const fetchImpl = vi.fn<typeof fetch>(async () => modelReply(validPayload));
      const { provider, dir, store } = await providerWith(fetchImpl);
      const input = inputWith({ m1: { user: "以后回复都用中文", tools: [] } });
      try {
        await writeFile(store.reviewCachePath, shape, "utf8");
        const result = await provider.review(input);
        expect(result.candidates).toHaveLength(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
