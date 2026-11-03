import { describe, expect, it } from "vitest";
import {
  HeuristicDecisionProvider,
  HybridDecisionProvider,
  OpenCodeDecisionProvider,
} from "../src/decision.js";

const input = {
  candidate: "不要用 nohup 启动 dev server",
  title: "[R] nohup",
  existingTitles: ["[R] dev server 用 nohup"],
  scope: "global" as const,
};

describe("decision providers", () => {
  it("maps Jev predicates to kind, risk, duplicate, and safe_auto", async () => {
    const ctx = {
      experimental: {
        generate: {
          async decisions() {
            return {
              answers: {
                is_skill: { noul: 0.1 },
                is_rule: { noul: 0.9 },
                is_preference: { noul: 0.1 },
                is_fact: { noul: 0.1 },
                is_duplicate: { noul: 0.8 },
                is_safe_auto: { noul: 0.2 },
                is_safety: { noul: 0.95 },
                is_strict_limit: { noul: 0.1 },
              },
            };
          },
        },
      },
    };
    const provider = new OpenCodeDecisionProvider(ctx, { providerID: "opencode", id: "jev-1.13" });
    const result = await provider.classify(input);
    expect(result.source).toBe("jev");
    expect(result.kind).toBe("rule");
    expect(result.strictness).toBe("safety");
    expect(result.risk).toBeGreaterThanOrEqual(0.9);
    expect(result.duplicate).toBeGreaterThan(0.7);
    expect(result.safeAuto).toBeLessThan(0.3);
  });

  it("falls back to heuristic when Jev throws", async () => {
    const provider = new HybridDecisionProvider(
      { async classify() { throw new Error("offline"); } },
      new HeuristicDecisionProvider(),
    );
    const result = await provider.classify(input);
    expect(result.source).toBe("heuristic");
    expect(result.reasons).toContain("primary unavailable; heuristic fallback");
  });

  it("classifies strict limits and preferences heuristically", async () => {
    const provider = new HeuristicDecisionProvider();
    const strict = await provider.classify({
      candidate: "最多重试 3 次",
      title: "[R] retry",
      existingTitles: [],
      scope: "global",
    });
    expect(strict.strictness).toBe("strict_limit");
    expect(strict.risk).toBeGreaterThanOrEqual(0.8);

    const preference = await provider.classify({
      candidate: "我喜欢先看结论",
      title: "[P] conclusion first",
      existingTitles: [],
      scope: "global",
    });
    expect(preference.kind).toBe("preference");
    expect(preference.risk).toBeLessThan(0.3);
  });

  it("detects duplicate phrasing against existing titles", async () => {
    const provider = new HeuristicDecisionProvider();
    const result = await provider.classify({
      candidate: "dev server 用 nohup",
      title: "[R] dev server 用 nohup",
      existingTitles: ["[R] dev server 用 nohup"],
      scope: "global",
    });
    expect(result.duplicate).toBeGreaterThan(0.5);
  });
});
