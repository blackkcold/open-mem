import { describe, expect, it } from "vitest";
import { classifyRelation } from "../src/relations.js";

describe("classifyRelation", () => {
  it("treats punctuation-only changes as exact", () => {
    const relation = classifyRelation(
      { text: "启动 dev server 时使用 nohup。" },
      { text: "启动 dev server 时使用 nohup", kind: "preference" },
    );
    expect(relation.relation).toBe("exact");
    expect(relation.sameKind).toBe(true);
  });

  it("surfaces a classification mismatch instead of dropping the candidate", () => {
    const relation = classifyRelation(
      { text: "回复先给结论", kind: "rule" },
      { text: "回复先给结论", kind: "preference" },
    );
    expect(relation.relation).toBe("classification-mismatch");
    expect(relation.sameKind).toBe(false);
  });

  it("never calls a changed port a duplicate", () => {
    const relation = classifyRelation(
      { text: "本地 dev server 端口是 5198" },
      { text: "本地 dev server 端口是 5199", kind: "fact" },
    );
    expect(relation.relation).toBe("conflict");
    expect(relation.identifiers.added).toContain("5198");
    expect(relation.identifiers.missing).toContain("5199");
  });

  it("never calls an opposite negation a duplicate", () => {
    const relation = classifyRelation(
      { text: "启动 dev server 时不要使用 nohup" },
      { text: "启动 dev server 时使用 nohup", kind: "rule" },
    );
    expect(relation.relation).toBe("conflict");
    expect(relation.negation.mismatch).toBe(true);
  });

  it("catches phrase-level negation variants instead of dropping them", () => {
    const pairs: Array<[string, string]> = [
      ["不建议使用 pnpm", "建议使用 pnpm"],
      ["不再使用 nohup", "使用 nohup"],
      ["本项目不允许直接推 main", "本项目允许直接推 main"],
      ["本项目默认不启用 swap", "本项目默认启用 swap"],
    ];
    for (const [candidate, entry] of pairs) {
      const relation = classifyRelation(
        { text: candidate, kind: "rule" },
        { text: entry, kind: "rule" },
      );
      expect(relation.relation, `${candidate} vs ${entry}`).toBe("conflict");
    }
  });

  it("does not call a high-similarity changed object exact", () => {
    const relation = classifyRelation(
      {
        text: "启动 dev server 时不要使用 nohup，因为退出终端后进程可能被回收；如果需要保持后台运行，应该先确认日志目录可写，再使用受控的后台任务并在关闭终端后检查端口是否仍然监听。",
      },
      {
        text: "启动 dev server 时不要使用 screen，因为退出终端后进程可能被回收；如果需要保持后台运行，应该先确认日志目录可写，再使用受控的后台任务并在关闭终端后检查端口是否仍然监听。",
        kind: "rule",
      },
    );
    expect(relation.score).toBeGreaterThanOrEqual(0.92);
    expect(relation.relation).not.toBe("exact");
    expect(relation.relation).toBe("partial");
  });

  it("treats prerelease versions as different identifiers", () => {
    const relation = classifyRelation(
      { text: "部署版本是 1.2.3-beta，先跑完整测试。" },
      { text: "部署版本是 1.2.3-alpha，先跑完整测试。", kind: "fact" },
    );
    expect(relation.relation).toBe("conflict");
    expect(relation.identifiers.candidate).toContain("1.2.3-beta");
    expect(relation.identifiers.entry).toContain("1.2.3-alpha");
  });

  it("marks a shorter candidate as covered by a longer entry", () => {
    const relation = classifyRelation(
      { text: "使用 nohup" },
      { text: "启动 dev server 时使用 nohup 并检查端口", kind: "rule" },
    );
    expect(relation.relation).toBe("covered");
  });

  it("does not mark a candidate with extra information as covered", () => {
    const relation = classifyRelation(
      { text: "启动 dev server 时使用 nohup 并检查端口 5199" },
      { text: "启动 dev server 时使用 nohup", kind: "rule" },
    );
    expect(relation.relation).not.toBe("covered");
    expect(relation.identifiers.added).toContain("5199");
  });

  it("distinguishes partial, related and unknown evidence", () => {
    expect(
      classifyRelation(
        { text: "回复先给结论，再给细节" },
        { text: "回复先给结论", kind: "preference" },
      ).relation,
    ).toBe("partial");
    expect(
      classifyRelation(
        { text: "先给结论再补充细节" },
        { text: "回复先给结论", kind: "preference" },
      ).relation,
    ).toBe("related");
    expect(
      classifyRelation(
        { text: "完全不同的话题" },
        { text: "回复先给结论", kind: "preference" },
      ).relation,
    ).toBe("unknown");
  });

  it("preserves versions and dates as identifiers", () => {
    const relation = classifyRelation(
      { text: "升级到 v1.2.4，日期 2026-11-07" },
      { text: "升级到 v1.2.3，日期 2026-11-06", kind: "fact" },
    );
    expect(relation.relation).toBe("conflict");
    expect(relation.identifiers.added).toEqual(expect.arrayContaining(["1.2.4", "2026-11-07"]));
    expect(relation.identifiers.missing).toEqual(expect.arrayContaining(["1.2.3", "2026-11-06"]));
  });
});
