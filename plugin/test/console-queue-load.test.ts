import { describe, expect, it } from "vitest";
import {
  baselineBanner,
  queueLoadModel,
} from "../../console/src/pages/queue-load";

const base = {
  loading: false,
  error: false,
  hasLoaded: true,
  itemCount: 3,
  hasFilters: false,
};

describe("queueLoadModel", () => {
  it("never renders a failed first load as an empty queue", () => {
    const model = queueLoadModel({ ...base, hasLoaded: false, error: true, itemCount: 0 });
    expect(model.state).toBe("error");
    expect(model.writesBlocked).toBe(true);
    expect(model.showEmptyQueue).toBe(false);
    expect(model.showFilteredEmpty).toBe(false);
    expect(model.canRetry).toBe(true);
    expect(model.message).toContain("未显示为空");
  });

  it("keeps the last good list visible and pauses writes after a failed refresh", () => {
    const model = queueLoadModel({
      ...base,
      error: true,
      lastLoadedAt: "2026-11-06T10:00:00.000Z",
      lastLoadedLabel: "10:00",
    });
    expect(model.state).toBe("stale");
    expect(model.writesBlocked).toBe(true);
    expect(model.message).toContain("10:00");
    expect(model.message).toContain("写入已暂停");
    expect(model.showEmptyQueue).toBe(false);
    expect(model.canRetry).toBe(true);
  });

  it("blocks writes while the first load or a refresh is in flight", () => {
    const first = queueLoadModel({ ...base, hasLoaded: false, loading: true, itemCount: 0 });
    expect(first.state).toBe("loading");
    expect(first.writesBlocked).toBe(true);
    expect(first.message).toBe("正在加载队列…");

    const refresh = queueLoadModel({ ...base, loading: true });
    expect(refresh.state).toBe("loading");
    expect(refresh.writesBlocked).toBe(true);
    expect(refresh.message).toBe("正在更新队列…");
  });

  it("distinguishes a filtered empty result from a truly empty queue", () => {
    const filtered = queueLoadModel({ ...base, itemCount: 0, hasFilters: true });
    expect(filtered.state).toBe("ready");
    expect(filtered.writesBlocked).toBe(false);
    expect(filtered.showFilteredEmpty).toBe(true);
    expect(filtered.showEmptyQueue).toBe(false);
    expect(filtered.message).toContain("没有符合当前筛选");

    const empty = queueLoadModel({ ...base, itemCount: 0 });
    expect(empty.state).toBe("ready");
    expect(empty.showEmptyQueue).toBe(true);
    expect(empty.showFilteredEmpty).toBe(false);
    expect(empty.message).toBe("队列为空。");
  });

  it("reports a normal ready list and count", () => {
    const model = queueLoadModel(base);
    expect(model.state).toBe("ready");
    expect(model.writesBlocked).toBe(false);
    expect(model.message).toBe("当前显示 3 条候选");
  });
});

describe("baselineBanner", () => {
  it("does not claim coverage for an unindexed project", () => {
    const banner = baselineBanner({
      state: "ready",
      projectKey: "proj-a",
      itemProjectKey: "proj-b",
    });
    expect(banner.tone).toBe("info");
    expect(banner.message).toContain("未匹配不等于未覆盖");
  });

  it("explains a partial index with counts and truncation", () => {
    const banner = baselineBanner({
      state: "partial",
      filesSeen: 201,
      filesIndexed: 200,
      truncatedFiles: 1,
    });
    expect(banner.tone).toBe("warning");
    expect(banner.message).toContain("200/201");
    expect(banner.message).toContain("1 个文件被截断");
    expect(banner.message).toContain("未匹配不等于未覆盖");
  });

  it("treats stale and failed baselines as incomplete, not ready", () => {
    expect(
      baselineBanner({ state: "stale", builtAt: "2026-11-06T10:00:00.000Z" }).message,
    ).toContain("覆盖判断可能不完整");
    expect(baselineBanner({ state: "error" }).tone).toBe("error");
    expect(baselineBanner({ state: "empty" }).message).toContain("未匹配不等于未覆盖");
    expect(baselineBanner({ state: "ready" }).tone).toBe("none");
  });

  it("warns when the project baseline is empty or not configured", () => {
    const empty = baselineBanner({
      state: "ready",
      projectCoverageState: "empty",
    });
    expect(empty.tone).toBe("info");
    expect(empty.message).toContain("该项目基线未索引");
    expect(
      baselineBanner({ state: "ready", projectCoverageState: "not-configured" }).message,
    ).toContain("项目基线未配置");
  });

  it("explains unreadable files instead of claiming a complete 2/2 index", () => {
    const banner = baselineBanner({
      state: "partial",
      filesSeen: 2,
      filesIndexed: 2,
      errors: 1,
    });
    expect(banner.message).toContain("1 处");
    expect(banner.message).not.toContain("2/2");
  });
});
