import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, api, clearToken, exchangeConnectTicket, getToken, readTokenFromLocation, setTransport } from "../../console/src/api.js";
import { connectionHint } from "../../console/src/extension/errors.js";

afterEach(() => vi.unstubAllGlobals());

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const end = css.indexOf("}", start);
  return end === -1 ? "" : css.slice(start, end);
}

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

/**
 * Structural source/style checks only. These do not render React, do not open a
 * portal, and do not prove anything about a real browser or visual layout.
 */
describe("relation acknowledgement source structure (not a DOM/visual test)", () => {
  const queue = source("../../console/src/pages/Queue.tsx");

  it("retries once with the reported relation ids and versions", () => {
    expect(queue).toContain("RELATION_ACK_REQUIRED");
    expect(queue).toContain("acknowledgedRelations");
    expect(queue).toContain("存在需要确认的关系");
    expect(queue).toContain("仍然写入");
    expect(queue).toContain('cancelLabel: "取消"');
    expect(queue).toContain("danger: true");
    expect(queue).toContain("version: entry.version");
    expect(queue).toContain("RELATION_ACK_CANCELLED");
    expect(queue).toContain("restoreFocusWhenEnabled(trigger)");
  });

  it("shows the target, relation and reasons before asking for confirmation", () => {
    expect(queue).toContain("relationTitle(entry.relation)");
    expect(queue).toContain("entry.reasons.join");
    expect(queue).toContain("我已核对以上关系，仍然写入。");
  });
});

describe("queue load state source structure (not a DOM/visual test)", () => {
  const queue = source("../../console/src/pages/Queue.tsx");
  const styles = source("../../console/src/styles.css");

  it("uses the load state machine and never renders a failure as an empty queue", () => {
    expect(queue).toContain("queueLoadModel");
    expect(queue).toContain("showEmptyQueue");
    expect(queue).toContain("showFilteredEmpty");
    expect(queue).toContain("load.canRetry");
    expect(queue).toContain("baselineBanner");
    expect(queue).toContain('aria-live="polite"');
    expect(queue).toContain('role="alert"');
    expect(queue).toContain('role="status"');
    expect(queue).toContain("aria-label={`存在冲突或分类不一致");
    expect(queue).toContain("filterPending = filterKey !== loadedFilter && !queueError");
    expect(queue).toContain("busy || load.writesBlocked || batchPreview.eligible.length === 0");
  });

  it("defines the warning banner tone used by baseline and stale states", () => {
    expect(cssRule(styles, ".banner.warning")).toContain("var(--warning)");
  });

  it("keeps narrow screens scrollable and touch targets usable", () => {
    expect(cssRule(styles, ".table-wrap")).toContain("overflow-x: auto");
    expect(cssRule(styles, ".panel")).toContain("overflow: hidden");
    expect(styles).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.btn, \.input, \.select, \.nav \{ min-height: 44px; \}/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.queue-layout, \.skills-layout, \.map-layout, \.settings \{ grid-template-columns: 1fr; \}/,
    );
  });
});

describe("coverage summary source structure (not a DOM/visual test)", () => {
  const queue = source("../../console/src/pages/Queue.tsx");

  it("renders conflict and coverage as separate chips from the summary", () => {
    expect(queue).toContain("coverageSummary");
    expect(queue).toContain("conflictCount");
    expect(queue).toContain("mismatchCount");
    expect(queue).toContain("coveredCount");
    expect(queue).toContain("存在冲突");
    expect(queue).toContain("存在覆盖");
    expect(queue).toContain("summary?.relation ?? coverage?.[0]?.relation");
    expect(queue).not.toContain("coverage[0].relation");
  });
});

describe("confirmation dialog source structure (not a DOM/visual test)", () => {
  const styles = source("../../console/src/styles.css");
  const confirm = source("../../console/src/extension/confirm.tsx");

  it("preserves preview line breaks and wraps long values", () => {
    const message = cssRule(styles, ".confirm-message");
    expect(message).toContain("white-space: pre-wrap");
    expect(message).toMatch(/overflow-wrap:\s*(anywhere|break-word)/);
  });

  it("caps the preview and card to the viewport with vertical scrolling", () => {
    const message = cssRule(styles, ".confirm-message");
    expect(message).toMatch(/max-height:[^;]*(?:calc|min|max)\([^;]*(?:dvh|vh)/);
    expect(message).toMatch(/overflow-y:\s*auto/);

    const card = cssRule(styles, ".confirm-card");
    expect(card).toMatch(/max-height:[^;]*(?:dvh|vh)/);
    expect(card).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps the confirm and cancel actions outside the scrolling preview", () => {
    const messageIndex = confirm.indexOf('className="confirm-message"');
    const actionsIndex = confirm.indexOf('className="confirm-actions"');
    expect(messageIndex).toBeGreaterThan(-1);
    expect(actionsIndex).toBeGreaterThan(messageIndex);
    expect(confirm.slice(messageIndex, actionsIndex)).toContain("</p>");
  });

  it("makes the scrolling preview keyboard reachable without changing the trap or description", () => {
    expect(confirm).toContain('className="confirm-message"');
    expect(confirm).toContain("tabIndex={0}");
    expect(confirm).toContain("ref={messageRef}");
    expect(confirm).toContain('role="region"');
    expect(confirm).toContain('aria-describedby="openmem-confirm-message"');
    expect(confirm).toContain('id="openmem-confirm-message"');
    expect(confirm).toMatch(/messageRef\.current\s*\?\?\s*cancelRef\.current/);
    expect(confirm).toContain('event.key === "Escape"');
    expect(confirm).toContain("cancelRef.current?.focus()");
    expect(confirm).toContain("target.focus({ preventScroll: true })");

    const focus = cssRule(styles, ".confirm-message:focus-visible");
    expect(focus).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });
});
