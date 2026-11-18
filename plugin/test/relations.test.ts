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

  it("treats an added number as supplementary information instead of a conflict", () => {
    const relation = classifyRelation(
      { text: "回复先给结论，3 个要点", kind: "preference" },
      { text: "回复先给结论", kind: "preference" },
    );
    expect(relation.relation).toBe("partial");
    expect(relation.identifiers.added).toContain("3");
  });

  it("compares negations by their object instead of the marker alone", () => {
    const relation = classifyRelation(
      { text: "不要使用 nohup", kind: "rule" },
      { text: "禁止使用 force push", kind: "rule" },
    );
    expect(relation.relation).not.toBe("conflict");
    expect(relation.relation).toBe("related");
    expect(relation.negation.clauses.candidate[0]?.object).toContain("nohup");
    expect(relation.negation.clauses.entry[0]?.object).toContain("force");
  });

  it("does not call a short rule covered by a long paragraph", () => {
    const relation = classifyRelation(
      { text: "使用中文" },
      { text: "团队约定：所有回复使用中文，代码注释保持英文，提交信息使用英文。", kind: "rule" },
    );
    expect(relation.relation).not.toBe("covered");
  });

  it("treats a shared title with unrelated bodies as related, not covered", () => {
    const relation = classifyRelation(
      { text: "部署前先备份数据库", title: "部署检查" },
      { text: "周五下午进行代码评审", title: "部署检查", kind: "preference" },
    );
    expect(relation.relation).not.toBe("covered");
    expect(relation.relation).toBe("related");
  });

  it("checks kind before identifier conflicts", () => {
    const relation = classifyRelation(
      { text: "本地端口是 5198", kind: "rule" },
      { text: "本地端口是 5199", kind: "fact" },
    );
    expect(relation.relation).toBe("classification-mismatch");
  });

  it("keeps a replaced value a conflict when the surrounding wording changes", () => {
    const pairs: Array<[string, string]> = [
      ["本地端口是 5198", "本地端口为 5199"],
      ["默认端口是 3000", "默认端口改为了 4000"],
      ["部署版本是 1.2.3", "部署版本为 1.2.4"],
    ];
    for (const [candidate, entry] of pairs) {
      const relation = classifyRelation(
        { text: candidate, kind: "fact" },
        { text: entry, kind: "fact" },
      );
      expect(relation.relation, `${candidate} vs ${entry}`).toBe("conflict");
    }
  });
});
