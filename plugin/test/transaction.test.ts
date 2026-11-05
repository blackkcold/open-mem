import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildSuggestion } from "../src/suggestion.js";
import type { DecisionResult } from "../src/types.js";

describe("durable Store transactions", () => {
  it("rolls back a caught nested transaction without discarding the outer writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-txn-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.transaction(async () => {
        await store.setStat("outer", 1);
        await expect(store.transaction(async () => {
          await store.setStat("inner", 2);
          await store.updateSession("aborted", { lastMessageID: "m1" });
          throw new Error("nested abort");
        })).rejects.toThrow("nested abort");
        expect(await store.readStats()).toEqual({ outer: 1 });
        await store.setStat("continued", 3);
      });
      expect(await store.readStats()).toEqual({ outer: 1, continued: 3 });
      expect((await store.readState()).sessions).toEqual({});
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["approve", "apply"])("keeps %s consistent after a crash at every actual rename boundary", async (operation) => {
    const run = promisify(execFile);
    const script = `import fs from 'node:fs/promises';
      const {Store}=await import('./src/store.ts');
      const {applyQueueDecision}=await import('./src/actions.ts');
      const {applySuggestion}=await import('./src/apply.ts');
      const {DEFAULT_CONFIG}=await import('./src/config.ts');
      const rename=fs.rename;let n=0;
      fs.rename=async(...args)=>{const value=await rename(...args);if(++n===Number(process.argv[2]))process.exit(73);return value;};
      const store=new Store(process.argv[1]);
      const result=process.argv[3]==='apply' ? await applySuggestion(store,DEFAULT_CONFIG,'q') : await applyQueueDecision(store,DEFAULT_CONFIG,'q',{action:'approve',confirmedByUser:true});
      if(!result.ok) throw new Error(result.error);console.log(JSON.stringify({renames:n}));`;
    let count = 0;
    for (let point = 0; point <= count; point++) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-txn-"));
      try {
        const store = new Store(dir);
        await store.init();
        const at = new Date().toISOString();
        await store.upsertQueue({ id: "q", title: "偏好", text: "回复先给结论", kind: "preference", scope: "global", status: "queue", source: {}, reason: "test", createdAt: at, updatedAt: at });
        if (operation === "apply") {
          const target = { id: "target", title: "输出习惯", text: "回复先给结论，再给细节", kind: "preference" as const, scope: "global" as const, status: "auto" as const, source: {}, createdAt: at, updatedAt: at, seenCount: 1 };
          await store.appendItem(target);
          const decision: DecisionResult = { kind: "preference", duplicate: 0.6, safeAuto: 0.7, risk: 0.1, confidence: 0.95, strictness: "preference", reasons: [], source: "heuristic", mergeAction: "merge_into", mergeTargetId: target.id, conflict: 0 };
          const entry = (await store.listQueue())[0];
          await buildSuggestion({ store, config: DEFAULT_CONFIG }, entry, decision, target);
        }
        const child = run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir, String(point), operation], { cwd: process.cwd() });
        if (point === 0) count = (JSON.parse((await child).stdout) as { renames: number }).renames;
        else await expect(child).rejects.toMatchObject({ code: 73 });
        const recovered = new Store(dir);
        await recovered.init();
        const queued = (await recovered.listQueue()).some((item) => item.id === "q");
        const active = (await recovered.listItems()).filter((item) => item.status === "auto");
        expect(active).toHaveLength(operation === "apply" ? 1 : Number(!queued));
        if (operation === "apply") {
          expect(active[0].seenCount).toBe(2);
          expect(queued).toBe(false);
          expect(await recovered.listJournal()).toHaveLength(1);
        }
        if (!queued) {
          expect(await recovered.readAutoMemory()).toContain("回复先给结论");
          expect((await recovered.listChangelog()).some((entry) => entry.action === (operation === "apply" ? "apply_merge_into" : "approve"))).toBe(true);
        }
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    expect(count).toBeGreaterThan(3);
  }, 120_000);
  it("rolls back staged writes on failure and reads its own writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-txn-"));
    try {
      const store = new Store(dir);
      await store.init();
      await expect(store.transaction(async () => {
        await store.setStat("a", 1);
        expect((await store.readStats()).a).toBe(1);
        expect(JSON.parse(await readFile(store.statsPath, "utf8"))).toEqual({});
        await store.updateSession("s", { lastMessageID: "m" });
        throw new Error("abort");
      })).rejects.toThrow("abort");
      expect(await store.readStats()).toEqual({});
      expect((await store.readState()).sessions).toEqual({});
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not leak transaction context to a concurrent operation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-txn-"));
    try {
      const store = new Store(dir);
      await store.init();
      await Promise.all([store.transaction(async () => {
        await store.incrementStat("n");
        await new Promise((resolve) => setTimeout(resolve, 20));
        await store.incrementStat("n");
      }), store.incrementStat("n")]);
      expect((await store.readStats()).n).toBe(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each([1, 2, 3])("replays a crash after commit rename %i", async (point) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-txn-"));
    try {
      const store = new Store(dir);
      await store.init();
      const script = `import fs from 'node:fs/promises';
        const {Store}=await import('./src/store.ts');
        const store=new Store(process.argv[1]);
        const rename=fs.rename; let n=0;
        fs.rename=async(...args)=>{const result=await rename(...args); if(++n===Number(process.argv[2])) process.exit(73); return result;};
        await store.transaction(async()=>{await store.setStat('committed',1);await store.updateSession('s',{lastMessageID:'m'});});`;
      await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir, String(point)], { cwd: process.cwd() })).rejects.toMatchObject({ code: 73 });
      const recovered = new Store(dir);
      await recovered.init();
      expect((await recovered.readStats()).committed).toBe(1);
      expect((await recovered.readState()).sessions.s.lastMessageID).toBe("m");
      await recovered.init();
      expect((await recovered.readStats()).committed).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
