import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, clearToken, exchangeConnectTicket, getToken, readTokenFromLocation, setTransport } from "../../console/src/api.js";
import { connectionHint } from "../../console/src/extension/errors.js";

afterEach(() => vi.unstubAllGlobals());

describe("console recovery", () => {
  it("exchanges a one-time ticket and removes it from browser history", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "http://localhost/?connect=once#health" }, history: { replaceState } });
    vi.stubGlobal("localStorage", { getItem: () => "", setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "synthetic-console" }), { status: 200 })));
    expect(await exchangeConnectTicket()).toBe("synthetic-console");
    expect(replaceState).toHaveBeenCalledWith(null, "", "http://localhost/#health");
    expect(getToken()).toBe("synthetic-console");
    clearToken();
  });
  it("removes the bootstrap token from browser history without losing the connection", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "http://localhost/?token=synthetic#queue" }, history: { replaceState } });
    vi.stubGlobal("localStorage", { getItem: () => "", setItem: () => { throw new Error("storage blocked"); }, removeItem: () => {} });
    expect(readTokenFromLocation()).toBe("synthetic");
    expect(getToken()).toBe("synthetic");
    expect(replaceState).toHaveBeenCalledWith(null, "", "http://localhost/#queue");
    clearToken();
    expect(getToken()).toBe("");
  });
  it("explains how to recover from an expired token", () => {
    expect(connectionHint(new ApiError(401, "unauthorized"))).toContain("Token");
  });
  it("shows validation details instead of a bare HTTP status", async () => {
    setTransport(async () => ({ status: 400, body: JSON.stringify({ ok: false, errors: ["缺少步骤", "缺少验证"] }) }));
    await expect(api("/api/skills/x/decision")).rejects.toThrow("缺少步骤");
  });
});
