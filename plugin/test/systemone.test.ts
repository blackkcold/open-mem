import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemOneClient, SystemOneError } from "../src/systemone.js";
import type { DecisionInput } from "../src/types.js";

const input: DecisionInput = {
  candidate: "不要用 nohup 启动 dev server",
  title: "[R] nohup",
  existingTitles: ["[R] dev server 用 nohup"],
  neighbors: [
    {
      id: "n1",
      title: "[R] dev server 用 nohup",
      text: "启动 dev server 时使用 nohup",
      kind: "rule",
      scope: "global",
      status: "auto",
      similarity: 0.91,
    },
  ],
  scope: "global",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SystemOneClient", () => {
  it("sends 8 typed questions and maps noul/choice answers", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://ollama.com/v1/systemone");
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        questions: Record<string, unknown>;
      };
      expect(body.model).toBe("clef:27b-cloud");
      expect(Object.keys(body.questions)).toHaveLength(8);
      expect(body.questions.merge_target).toBeDefined();
      return new Response(
        JSON.stringify({
          model: "clef:27b-cloud",
          answers: {
            kind: { type: "choice", choice: "rule", confidence: 0.9 },
            safety: { type: "noul", noul: 0.95 },
            strict_limit: { type: "noul", noul: 0.1 },
            duplicate: { type: "noul", noul: 0.8 },
            safe_auto: { type: "noul", noul: 0.2 },
            conflict: { type: "noul", noul: 0.1 },
            merge_action: { type: "choice", choice: "merge_into", confidence: 0.86 },
            merge_target: { type: "choice", choice: "n1", confidence: 0.9 },
          },
          usage: { input_tokens: 120, output_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SystemOneClient({
      endpoint: "https://ollama.com/v1/systemone",
      model: "clef:27b-cloud",
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    const result = await client.classify(input);
    expect(result.source).toBe("systemone");
    expect(result.kind).toBe("rule");
    expect(result.strictness).toBe("safety");
    expect(result.risk).toBeGreaterThanOrEqual(0.9);
    expect(result.duplicate).toBeCloseTo(0.8);
    expect(result.safeAuto).toBeCloseTo(0.2);
    expect(result.mergeAction).toBe("merge_into");
    expect(result.mergeTargetId).toBe("n1");
    expect(result.confidence).toBeCloseTo(0.86);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the merge target when the action is reject_duplicate", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, { instructions?: string }>;
      };
      expect(body.questions.merge_target?.instructions).toMatch(/reject_duplicate/);
      return new Response(
        JSON.stringify({
          model: "clef:27b-cloud",
          answers: {
            kind: { type: "choice", choice: "rule", confidence: 0.9 },
            safety: { type: "noul", noul: 0.1 },
            strict_limit: { type: "noul", noul: 0.1 },
            duplicate: { type: "noul", noul: 0.96 },
            safe_auto: { type: "noul", noul: 0.4 },
            conflict: { type: "noul", noul: 0.1 },
            merge_action: { type: "choice", choice: "reject_duplicate", confidence: 0.95 },
            merge_target: { type: "choice", choice: "n1", confidence: 0.95 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SystemOneClient({
      endpoint: "https://ollama.com/v1/systemone",
      model: "clef:27b-cloud",
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    const result = await client.classify(input);
    expect(result.mergeAction).toBe("reject_duplicate");
    expect(result.mergeTargetId).toBe("n1");
  });

  it("omits merge_target when there are no neighbors", async () => {
    let questionKeys: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, unknown>;
      };
      questionKeys = Object.keys(body.questions);
      return new Response(
        JSON.stringify({
          model: "clef:27b-cloud",
          answers: {
            kind: { type: "choice", choice: "fact", confidence: 0.8 },
            safety: { type: "noul", noul: 0.05 },
            strict_limit: { type: "noul", noul: 0.05 },
            duplicate: { type: "noul", noul: 0.1 },
            safe_auto: { type: "noul", noul: 0.95 },
            conflict: { type: "noul", noul: 0.05 },
            merge_action: { type: "choice", choice: "create", confidence: 0.9 },
          },
          usage: { input_tokens: 40, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SystemOneClient({
      endpoint: "https://ollama.com/v1/systemone",
      model: "clef:27b-cloud",
      apiKey: "test-key",
      timeoutMs: 5_000,
    });
    const result = await client.classify({ ...input, neighbors: [] });
    expect(questionKeys).toHaveLength(7);
    expect(questionKeys).not.toContain("merge_target");
    expect(result.kind).toBe("fact");
    expect(result.mergeAction).toBe("create");
    expect(result.mergeTargetId).toBeUndefined();
  });

  it("maps 401 to a clear SystemOneError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })),
    );
    const client = new SystemOneClient({
      endpoint: "https://ollama.com/v1/systemone",
      model: "clef:27b-cloud",
      apiKey: "bad-key",
      timeoutMs: 5_000,
    });
    await expect(client.classify(input)).rejects.toMatchObject({
      name: "SystemOneError",
      status: 401,
    });
    await expect(client.classify(input)).rejects.toBeInstanceOf(SystemOneError);
  });
});
