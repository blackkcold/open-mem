import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { composeRewrite } from "../src/rewrite/composer.js";
import { validateRewrite } from "../src/rewrite/validate.js";
import { SystemTwoClient } from "../src/rewrite/systemtwo.js";
import { RewriteService } from "../src/rewrite/index.js";
import { Store } from "../src/store.js";
import type { RewriteInput, RewriteOutput } from "../src/rewrite/types.js";

const input: RewriteInput = {
  candidate: {
    title: "[F] dev server 检查",
    text: "启动前检查 5199 是否被占用",
    kind: "fact",
    scope: "global",
  },
  target: {
    id: "item_1",
    title: "[F] dev server 端口 5199",
    text: "本地 dev server 端口是 5199",
    kind: "fact",
    scope: "global",
  },
  action: "merge_into",
  maxChars: 200,
  titleMaxChars: 30,
  conflict: 0,
};

const validOutput: RewriteOutput = {
  action: "merge",
  title: "[F] dev server 端口 5199",
  text: "本地 dev server 端口是 5199；启动前检查 5199 是否被占用。",
  preserved: ["本地 dev server 端口是 5199", "启动前检查 5199 是否被占用"],
  dropped: [],
  rationale: "保留端口并追加检查动作。",
  source: "systemtwo",
  latencyMs: 10,
};

describe("rewrite composer", () => {
  it("merges a complementary fact without losing the port", () => {
    const output = composeRewrite(input);
    expect(output.action).toBe("merge");
    expect(output.text).toContain("5199");
    expect(output.text).toContain("检查");
    expect(validateRewrite(input, output).ok).toBe(true);
  });

  it("keeps rules out of automatic merge", () => {
    const output = composeRewrite({
      ...input,
      candidate: { ...input.candidate, kind: "rule", text: "不要用 nohup 启动 dev server" },
      target: { ...input.target, kind: "rule", text: "启动 dev server 时使用 nohup" },
    });
    expect(output.action).toBe("keep_both");
    expect(output.text).toBe("启动 dev server 时使用 nohup");
  });

  it("respects the length limit and records dropped clauses", () => {
    const output = composeRewrite({ ...input, maxChars: 34 });
    expect(output.text.length).toBeLessThanOrEqual(34);
    expect(output.dropped.length).toBeGreaterThan(0);
  });
});

describe("rewrite validator", () => {
  it("rejects a new number that was not in the inputs", () => {
    const validation = validateRewrite(input, {
      ...validOutput,
      text: "本地 dev server 端口是 8080；启动前检查 5199 是否被占用。",
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(" ")).toContain("8080");
  });

  it("rejects a dropped clause without a reason", () => {
    const validation = validateRewrite(input, {
      ...validOutput,
      dropped: [{ text: "5199", reason: "" }],
    });
    expect(validation.ok).toBe(false);
  });

  it("rejects a rule merge and a conflict merge", () => {
    const rule = validateRewrite(
      {
        ...input,
        candidate: { ...input.candidate, kind: "rule" },
      },
      { ...validOutput, action: "merge" },
    );
    expect(rule.ok).toBe(false);
    expect(rule.errors.join(" ")).toContain("规则");

    const conflict = validateRewrite(
      { ...input, conflict: 0.9 },
      { ...validOutput, action: "merge" },
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.errors.join(" ")).toContain("冲突");
  });
});

describe("System Two client", () => {
  it("passes the model variant through generate.text", async () => {
    let seen: { providerID: string; id: string; variant?: string } | undefined;
    const ctx = {
      generate: {
        text: async (request: {
          model: { providerID: string; id: string; variant?: string };
        }) => {
          seen = request.model;
          return JSON.stringify(validOutput);
        },
      },
    };
    const client = new SystemTwoClient({
      ctx,
      config: {
        ...DEFAULT_CONFIG.rewrite,
        model: {
          providerID: "ollama-cloud",
          id: "deepseek-v4.1-flash:1017",
          variant: "high",
        },
      },
    });
    const output = await client.rewrite(input);
    expect(seen).toEqual({
      providerID: "ollama-cloud",
      id: "deepseek-v4.1-flash:1017",
      variant: "high",
    });
    expect(output.model?.variant).toBe("high");
  });

  it("parses the JSON contract through generate.text", async () => {
    const ctx = {
      generate: {
        text: async () => JSON.stringify(validOutput),
      },
    };
    const client = new SystemTwoClient({
      ctx,
      config: DEFAULT_CONFIG.rewrite,
    });
    const output = await client.rewrite(input);
    expect(output.source).toBe("systemtwo");
    expect(output.text).toContain("5199");
    expect(output.action).toBe("merge");
  });
});

describe("RewriteService", () => {
  it("falls back to the composer when System Two returns invalid JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-rewrite-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        rewrite: { transport: "opencode", enabled: true },
      });
      const service = new RewriteService({
        ctx: { generate: { text: async () => "not json" } },
        config,
        store,
      });
      const output = await service.suggest(input);
      expect(output.source).toBe("composer");
      expect(output.rationale).toContain("System Two");
      expect(output.text).toContain("5199");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shares a request budget between service instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-rewrite-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig({ rewrite: { transport: "opencode", enabled: true, maxCallsPerHour: 1 } });
      let calls = 0;
      const ctx = { generate: { text: async () => { calls++; return JSON.stringify(validOutput); } } };
      await new RewriteService({ store, config, ctx }).suggest(input);
      await new RewriteService({ store: new Store(dir), config, ctx }).suggest({ ...input, candidate: { ...input.candidate, text: "另一个候选" } });
      expect(calls).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("caches a successful rewrite", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-rewrite-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        rewrite: { transport: "opencode", enabled: true },
      });
      let calls = 0;
      const service = new RewriteService({
        ctx: {
          generate: {
            text: async () => {
              calls += 1;
              return JSON.stringify(validOutput);
            },
          },
        },
        config,
        store,
      });
      const first = await service.suggest(input);
      const second = await service.suggest(input);
      expect(first.source).toBe("systemtwo");
      expect(second.text).toBe(first.text);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
