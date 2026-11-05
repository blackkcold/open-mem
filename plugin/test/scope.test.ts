import { describe, expect, it } from "vitest";
import { classifyScope } from "../src/memory/scope.js";

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

  it("defaults unknown content to session, never global", () => {
    expect(classifyScope("不要用 nohup 启动 dev server", project)).toBe("session");
    expect(classifyScope("检查一下这个函数", project)).toBe("session");
  });
});
