import { describe, expect, it } from "vitest";
import { classifyScope, sameScopeAndProject } from "../src/memory/scope.js";

const project = "/Users/me/code/open-mem";

describe("classifyScope", () => {
  it("keeps task constraints in the session", () => {
    expect(classifyScope("MUST NOT DO: Modify files.", project)).toBe("session");
    expect(classifyScope("本次先用 8080，不要改端口", project)).toBe("session");
    expect(classifyScope("这个任务先只读，不要写盘", project)).toBe("session");
  });

  it("promotes project evidence to project", () => {
    expect(classifyScope("在这个项目中，回复要先给结论", project)).toBe("project");
    expect(classifyScope("这个仓库的测试命令是 pnpm test", project)).toBe("project");
    expect(classifyScope("本项目的端口是 5199", project)).toBe("project");
  });

  it("keeps project-local frequency wording in the project", () => {
    expect(classifyScope("本项目每次都用 pnpm 安装依赖", project)).toBe("project");
    expect(classifyScope("本项目一律先跑测试", project)).toBe("project");
    expect(classifyScope("这个仓库以后都用 pnpm", project)).toBe("project");
    expect(classifyScope("本项目永远不使用 nohup", project)).toBe("project");
    expect(classifyScope("本项目的原则是先跑测试", project)).toBe("project");
  });

  it("still treats explicit cross-project wording as global", () => {
    expect(classifyScope("以后所有项目都用 pnpm", project)).toBe("global");
    expect(classifyScope("以后所有项目都用 pnpm")).toBe("global");
    expect(classifyScope("跨项目统一使用中文回复", project)).toBe("global");
  });

  it("keeps habitual and always/never wording project-local when project evidence exists", () => {
    expect(classifyScope("我习惯在这个项目用 pnpm", project)).toBe("project");
    expect(classifyScope("never modify files in this repo", project)).toBe("project");
    expect(classifyScope("prefer pnpm in this repo", project)).toBe("project");
    expect(classifyScope("我习惯先给结论", project)).toBe("global");
    expect(classifyScope("never modify files")).toBe("global");
  });

  it("treats explicit global language as a global candidate", () => {
    expect(classifyScope("以后所有项目都用 pnpm", project)).toBe("global");
    expect(classifyScope("Always reply in Chinese", project)).toBe("global");
    expect(classifyScope("我习惯先给结论", project)).toBe("global");
    expect(classifyScope("一切以 UX 体验为先", project)).toBe("global");
  });

  it("treats stable environment facts as global", () => {
    expect(classifyScope("用户本机安装了 hermes", project)).toBe("global");
    expect(classifyScope("这台机器使用 macOS 14", project)).toBe("global");
    expect(classifyScope("openchamber 的会话预热已开启", project)).toBe("global");
  });

  it("keeps explicit temporary time language in the session", () => {
    expect(classifyScope("今天 opencode 好像卡住了", project)).toBe("session");
    expect(classifyScope("这次 opencode 启动很慢", project)).toBe("session");
    expect(classifyScope("刚才 opencode 报错了", project)).toBe("session");
  });

  it("does not promote a bare product name or ordinary error to global", () => {
    expect(classifyScope("opencode 报错了", project)).toBe("session");
    expect(classifyScope("openchamber 启动失败", project)).toBe("session");
    expect(classifyScope("hermes 连接超时", project)).toBe("session");
    expect(classifyScope("macOS 14 上崩溃了", project)).toBe("session");
  });

  it("keeps explicit persisted state global without relying on a product name", () => {
    expect(classifyScope("opencode 的自动更新已开启", project)).toBe("global");
    expect(classifyScope("系统版本是 macOS 14", project)).toBe("global");
  });

  it("defaults unknown content to session, never global", () => {
    expect(classifyScope("不要用 nohup 启动 dev server", project)).toBe("session");
    expect(classifyScope("检查一下这个函数", project)).toBe("session");
  });
});

describe("sameScopeAndProject", () => {
  it("isolates projects both ways", () => {
    expect(sameScopeAndProject({ scope: "project", projectKey: "A" }, { scope: "project", projectKey: "A" })).toBe(true);
    expect(sameScopeAndProject({ scope: "project", projectKey: "A" }, { scope: "project", projectKey: "B" })).toBe(false);
    expect(sameScopeAndProject({ scope: "project", projectKey: "A" }, { scope: "project" })).toBe(false);
    expect(sameScopeAndProject({ scope: "project" }, { scope: "project", projectKey: "A" })).toBe(false);
  });

  it("never mixes global, project and session rows", () => {
    const global = { scope: "global" as const };
    const projectA = { scope: "project" as const, projectKey: "A" };
    const sessionS1 = { scope: "session" as const, source: { sessionID: "s1" } };
    const sessionS2 = { scope: "session" as const, source: { sessionID: "s2" } };
    expect(sameScopeAndProject(global, global)).toBe(true);
    expect(sameScopeAndProject(global, projectA)).toBe(false);
    expect(sameScopeAndProject(projectA, global)).toBe(false);
    expect(sameScopeAndProject(sessionS1, global)).toBe(false);
    expect(sameScopeAndProject(sessionS1, sessionS1)).toBe(true);
    expect(sameScopeAndProject(sessionS1, sessionS2)).toBe(false);
    expect(sameScopeAndProject({ scope: "session" }, sessionS1)).toBe(false);
  });
});
