import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { acceptReviewCandidates } from "../src/review/accept.js";
import { promoteSessionNote } from "../src/memory/session-promotion.js";
import type { ReviewInput } from "../src/review/input.js";
import type { ReviewRunResult } from "../src/types.js";

const text = "本次只读，不要修改文件";
const projectText = "以后回复先给结论";

function input(): ReviewInput {
  return {
    sessionID: "ses_session",
    items: [
      { id: "m1", role: "user", kind: "text", text },
      { id: "m2", role: "user", kind: "text", text: projectText },
    ],
    chars: text.length + projectText.length,
    hash: "session-hash",
    truncated: false,
    userCount: 2,
    toolCount: 0,
    rawToolChars: 0,
    sources: {
      m1: { user: text, tools: [] },
      m2: { user: projectText, tools: [] },
    },
  };
}

function result(): ReviewRunResult {
  return {
    summary: [],
    openQuestions: [],
    model: "test",
    candidates: [
      {
        type: "rule",
        text: "本次只读，不要修改文件",
        scope: "session",
        taskOnly: true,
        confidence: 0.95,
        evidence: [{ messageID: "m1", quote: "只读", kind: "user" }],
      },
      {
        type: "preference",
        text: "以后回复先给结论",
        scope: "project",
        confidence: 0.9,
        evidence: [{ messageID: "m2", quote: "以后回复先给结论", kind: "user" }],
      },
    ],
  };
}

describe("promoteSessionNote", () => {
  it.each(["foreign-project", "too-long"])("rejects unsafe note promotion: %s", async (scenario) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-session-promote-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendReview({ id: "review_safe", sessionID: "s1", projectKey: "A", sessionNotes: [{ type: "preference", text: scenario === "too-long" ? "长".repeat(1000) : "回复先给结论", evidence: [], createdAt: new Date().toISOString() }] });
      const result = await promoteSessionNote(store, mergeConfig({}), "review_safe", 0, { targetScope: "project", projectKey: scenario === "foreign-project" ? "B" : "A", confirmedByUser: true });
      expect(result.ok).toBe(false);
      expect(await store.listItems()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("promotes a session note to a project", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-session-promote-"));
    try {
      const store = new Store(dir);
      await store.init();
      const now = new Date().toISOString();
      await store.appendReview({
        id: "review_1",
        sessionID: "ses_1",
        projectKey: "A",
        status: "ready",
        createdAt: now,
        candidates: 1,
        dropped: 0,
        sessionNotes: [
          {
            type: "preference",
            text: "回复先给结论",
            evidence: [{ messageID: "m1", quote: "先给结论", kind: "user" }],
            createdAt: now,
          },
        ],
      });
      const result = await promoteSessionNote(
        store,
        mergeConfig({}),
        "review_1",
        0,
        { targetScope: "project", projectKey: "A", confirmedByUser: true },
      );
      expect(result.ok).toBe(true);
      expect(result.item?.scope).toBe("project");
      expect(result.item?.projectKey).toBe("A");
      expect(await store.listItems()).toHaveLength(1);
      const stored = (await store.listReviews())[0].sessionNotes as Array<{ status?: string; promotedItemID?: string }>;
      expect(stored[0].status).toBe("promoted");
      expect(stored[0].promotedItemID).toBe(result.item?.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks a task-only session note", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-session-promote-"));
    try {
      const store = new Store(dir);
      await store.init();
      const now = new Date().toISOString();
      await store.appendReview({
        id: "review_2",
        sessionID: "ses_2",
        projectKey: "A",
        status: "ready",
        createdAt: now,
        candidates: 1,
        dropped: 0,
        sessionNotes: [
          {
            type: "rule",
            text: "本次只读，不要修改文件",
            taskOnly: true,
            evidence: [{ messageID: "m1", quote: "只读", kind: "user" }],
            createdAt: now,
          },
        ],
      });
      const result = await promoteSessionNote(
        store,
        mergeConfig({}),
        "review_2",
        0,
        { targetScope: "global", confirmedByUser: true },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("task-only");
      expect(await store.listItems()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("acceptReviewCandidates session notes", () => {
  it("stores session candidates as notes, never hooks or queue items", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-session-notes-"));
    try {
      const store = new Store(dir);
      await store.init();
      const accepted = await acceptReviewCandidates(
        input(),
        result(),
        "review_1",
        { store, config: mergeConfig({}), project: "/repo/a" },
      );
      expect(accepted.created).toBe(1);
      expect(accepted.sessionNotes).toHaveLength(1);
      expect(accepted.sessionNotes[0].text).toBe(text);
      expect(accepted.sessionNotes[0].taskOnly).toBe(true);

      const hooks = await store.listHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].text).toBe(projectText);
      expect(hooks.some((hook) => hook.text === text)).toBe(false);
      expect(await store.listQueue()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
