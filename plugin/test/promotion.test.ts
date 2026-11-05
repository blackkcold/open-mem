import { describe, expect, it } from "vitest";
import { canPromote } from "../src/memory/promotion.js";
import type { Item } from "../src/types.js";

function item(overrides: Partial<Item>): Item {
  const now = new Date().toISOString();
  return {
    id: "item_existing",
    title: "existing",
    text: "existing memory",
    kind: "fact",
    scope: "project",
    status: "auto",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const base = {
  text: "回复先给结论",
  kind: "preference" as const,
  scope: "session" as const,
  evidenceCount: 1,
  distinctSessions: 1,
};

describe("canPromote", () => {
  it("blocks task-only wording even when the legacy flag is absent", () => {
    expect(canPromote({ ...base, text: "本次回复先给结论" }, { target: "global", confirmedByUser: true, existing: [] })).toEqual({ ok: false, reason: "task-only" });
  });
  it("does not treat another project's memory as a duplicate", () => {
    expect(canPromote(base, { target: "project", projectKey: "A", confirmedByUser: true, existing: [item({ text: base.text, projectKey: "B" })] })).toEqual({ ok: true });
  });
  it("blocks task-only session notes", () => {
    expect(
      canPromote(
        { ...base, taskOnly: true },
        { target: "project", confirmedByUser: true, projectKey: "A", existing: [] },
      ),
    ).toEqual({ ok: false, reason: "task-only" });
  });

  it("requires manual approval for rules", () => {
    expect(
      canPromote(
        { ...base, kind: "rule" },
        { target: "project", projectKey: "A", existing: [] },
      ),
    ).toEqual({ ok: false, reason: "rule requires approval" });
  });

  it("requires a project key for project promotion", () => {
    expect(
      canPromote(base, { target: "project", confirmedByUser: true, existing: [] }),
    ).toEqual({ ok: false, reason: "project key required" });
  });

  it("rejects volatile identifiers for global promotion", () => {
    expect(
      canPromote(
        { ...base, text: "备份在 /Users/me/backup 目录" },
        {
          target: "global",
          confirmedByUser: true,
          existing: [],
        },
      ),
    ).toEqual({ ok: false, reason: "volatile identifier" });
  });

  it("allows a confirmed global rule and a project preference", () => {
    expect(
      canPromote(
        { ...base, kind: "rule" },
        { target: "global", confirmedByUser: true, existing: [] },
      ),
    ).toEqual({ ok: true });
    expect(
      canPromote(base, {
        target: "project",
        confirmedByUser: true,
        projectKey: "A",
        existing: [],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a duplicate at the target tier", () => {
    expect(
      canPromote(
        { ...base, text: "回复先给结论" },
        {
          target: "project",
          confirmedByUser: true,
          projectKey: "A",
          existing: [item({ text: "回复先给结论", projectKey: "A" })],
        },
      ),
    ).toEqual({ ok: false, reason: "duplicate of item_existing" });
  });
});
