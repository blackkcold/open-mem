import { describe, expect, it } from "vitest";
import {
  CLEAN_FORMS,
  applyLoad,
  applySaveResult,
  canSubmitSkillDecision,
  disconnectDraftWarning,
  hasDirtyForms,
  isDraftDirty,
  isPageMounted,
  isPageVisible,
  newLoadTicket,
  reconcileSkillList,
  rememberPageVisit,
  setFormDirty,
} from "../../console/src/pages/draft-state";

describe("console draft state", () => {
  it("treats a draft as clean when it matches the saved snapshot", () => {
    expect(isDraftDirty("v1", "v1")).toBe(false);
    expect(isDraftDirty("v2", "v1")).toBe(true);
  });

  it("treats the draft as clean again after the user reverts to the saved value", () => {
    const saved = "v1";
    const edited = "v2";
    expect(isDraftDirty(edited, saved)).toBe(true);
    expect(isDraftDirty("v1", saved)).toBe(false);
  });

  it("applies a background refresh while the draft is clean", () => {
    const outcome = applyLoad({
      ticket: newLoadTicket(1, "v1"),
      latestTicketId: 1,
      draft: "v1",
      saved: "v1",
      loaded: "v2",
      explicit: false,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.draft).toBe("v2");
    expect(outcome.saved).toBe("v2");
    expect(isDraftDirty(outcome.draft, outcome.saved)).toBe(false);
  });

  it("keeps a dirty draft instead of overwriting it with a background refresh", () => {
    const outcome = applyLoad({
      ticket: newLoadTicket(1, "v2"),
      latestTicketId: 1,
      draft: "v2",
      saved: "v1",
      loaded: "v3",
      explicit: false,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.draft).toBe("v2");
    expect(outcome.saved).toBe("v1");
    expect(isDraftDirty(outcome.draft, outcome.saved)).toBe(true);
  });

  it("keeps edits typed after a background load request was sent", () => {
    const outcome = applyLoad({
      ticket: newLoadTicket(1, "v1"),
      latestTicketId: 1,
      draft: "v2 typed during load",
      saved: "v1",
      loaded: "v3",
      explicit: false,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.draft).toBe("v2 typed during load");
    expect(outcome.saved).toBe("v1");
  });

  it("ignores a response from an older load request", () => {
    const outcome = applyLoad({
      ticket: newLoadTicket(1, "v1"),
      latestTicketId: 2,
      draft: "v1",
      saved: "v1",
      loaded: "stale server value",
      explicit: false,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.draft).toBe("v1");
    expect(outcome.saved).toBe("v1");
  });

  it("applies an explicit reload over a draft the user agreed to discard", () => {
    const outcome = applyLoad({
      ticket: newLoadTicket(1, "v2"),
      latestTicketId: 1,
      draft: "v2",
      saved: "v1",
      loaded: "v3",
      explicit: true,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.draft).toBe("v3");
    expect(outcome.saved).toBe("v3");
  });

  it("keeps edits typed while an explicit reload is in flight", () => {
    const outcome = applyLoad({
      ticket: newLoadTicket(1, "v2"),
      latestTicketId: 1,
      draft: "v2 edited after reload started",
      saved: "v1",
      loaded: "v3",
      explicit: true,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.draft).toBe("v2 edited after reload started");
    expect(outcome.saved).toBe("v1");
  });

  it("adopts the server response and stays clean when nothing changed during save", () => {
    const outcome = applySaveResult({
      ok: true,
      submitted: "v2",
      currentDraft: "v2",
      savedBefore: "v1",
      responseSaved: "v2",
    });

    expect(outcome.adoptResponse).toBe(true);
    expect(outcome.keptNewerEdits).toBe(false);
    expect(outcome.saved).toBe("v2");
    expect(isDraftDirty("v2", outcome.saved)).toBe(false);
  });

  it("keeps newer edits and stays dirty when the user types during save", () => {
    const outcome = applySaveResult({
      ok: true,
      submitted: "v2",
      currentDraft: "v3 typed during save",
      savedBefore: "v1",
      responseSaved: "v2",
    });

    expect(outcome.adoptResponse).toBe(false);
    expect(outcome.keptNewerEdits).toBe(true);
    expect(outcome.saved).toBe("v2");
    expect(isDraftDirty("v3 typed during save", outcome.saved)).toBe(true);
  });

  it("keeps the draft and the previous baseline when the save fails", () => {
    const outcome = applySaveResult({
      ok: false,
      submitted: "v2",
      currentDraft: "v2",
      savedBefore: "v1",
      responseSaved: "ignored on failure",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.adoptResponse).toBe(false);
    expect(outcome.keptNewerEdits).toBe(false);
    expect(outcome.saved).toBe("v1");
    expect(isDraftDirty("v2", outcome.saved)).toBe(true);
  });

  it("keeps newer edits when a save fails after concurrent typing", () => {
    const outcome = applySaveResult({
      ok: false,
      submitted: "v2",
      currentDraft: "v3 typed during save",
      savedBefore: "v1",
      responseSaved: "ignored on failure",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.adoptResponse).toBe(false);
    expect(outcome.keptNewerEdits).toBe(true);
    expect(outcome.saved).toBe("v1");
    expect(isDraftDirty("v3 typed during save", outcome.saved)).toBe(true);
  });
});

describe("retained console pages", () => {
  it("does not mount an unvisited retained page", () => {
    expect(isPageMounted([], "queue", "skills")).toBe(false);
    expect(isPageMounted([], "audit", "settings")).toBe(false);
  });

  it("mounts a retained page on its first visit", () => {
    expect(isPageMounted([], "skills", "skills")).toBe(true);
    expect(isPageMounted([], "settings", "settings")).toBe(true);
  });

  it("keeps a visited page mounted after switching to another tab", () => {
    expect(isPageMounted(["skills"], "settings", "skills")).toBe(true);
    expect(isPageMounted(["settings"], "audit", "settings")).toBe(true);
  });

  it("remembers the queue, skills and settings visits", () => {
    expect(rememberPageVisit([], "queue")).toEqual(["queue"]);
    expect(rememberPageVisit([], "audit")).toEqual([]);
    expect(rememberPageVisit([], "skills")).toEqual(["skills"]);
    expect(rememberPageVisit([], "settings")).toEqual(["settings"]);
  });

  it("keeps the queue mounted and hidden after switching to audit", () => {
    const visited = rememberPageVisit(["queue"], "audit");
    expect(isPageMounted(visited, "audit", "queue")).toBe(true);
    expect(isPageVisible("audit", "queue")).toBe(false);
    expect(isPageVisible("queue", "queue")).toBe(true);
  });

  it("does not duplicate an already visited page", () => {
    const visited = rememberPageVisit(["skills"], "skills");
    expect(visited).toEqual(["skills"]);
    expect(rememberPageVisit(visited, "skills")).toBe(visited);
  });

  it("shows only the active retained page", () => {
    expect(isPageVisible("skills", "skills")).toBe(true);
    expect(isPageVisible("settings", "skills")).toBe(false);
    expect(isPageVisible("audit", "settings")).toBe(false);
  });
});

describe("skill list refresh", () => {
  const listed = {
    requestId: 2,
    latestRequestId: 2,
    selectedId: "a",
    ids: ["b", "c"],
  };

  it("ignores a stale list response", () => {
    expect(reconcileSkillList({ ...listed, requestId: 1 })).toEqual({ kind: "ignored" });
  });

  it("keeps the selected draft when the item disappears from a fresh list", () => {
    expect(reconcileSkillList(listed)).toEqual({ kind: "kept-unavailable", id: "a" });
  });

  it("keeps the selected draft when the item is still listed", () => {
    expect(reconcileSkillList({ ...listed, ids: ["a", "b"] })).toEqual({ kind: "unchanged" });
  });

  it("does nothing when no draft is selected", () => {
    expect(reconcileSkillList({ ...listed, selectedId: null })).toEqual({ kind: "unchanged" });
  });
});

describe("skill decision availability", () => {
  it("blocks every decision while the selected draft is unavailable", () => {
    expect(canSubmitSkillDecision({ busy: false, unavailable: true })).toBe(false);
  });

  it("blocks decisions while another request is running", () => {
    expect(canSubmitSkillDecision({ busy: true, unavailable: false })).toBe(false);
  });

  it("allows a decision for a listed draft when idle", () => {
    expect(canSubmitSkillDecision({ busy: false, unavailable: false })).toBe(true);
  });
});

describe("disconnect with dirty drafts", () => {
  it("does not warn when no retained form has unsaved edits", () => {
    expect(disconnectDraftWarning(CLEAN_FORMS)).toBeNull();
  });

  it("returns the same registry when a form reports the state it already has", () => {
    expect(setFormDirty(CLEAN_FORMS, "skills", false)).toBe(CLEAN_FORMS);
    const dirty = setFormDirty(CLEAN_FORMS, "settings", true);
    expect(setFormDirty(dirty, "settings", true)).toBe(dirty);
  });

  it("names only the settings draft when it is the dirty one", () => {
    const warning = disconnectDraftWarning(setFormDirty(CLEAN_FORMS, "settings", true));
    expect(warning?.forms).toEqual(["settings"]);
    expect(warning?.message).toContain("设置页");
    expect(warning?.message).not.toContain("Skill Review");
    expect(warning?.message).toContain("丢失");
  });

  it("names only the skill notes when they are the dirty draft", () => {
    const warning = disconnectDraftWarning(setFormDirty(CLEAN_FORMS, "skills", true));
    expect(warning?.forms).toEqual(["skills"]);
    expect(warning?.message).toContain("Skill Review 备注");
    expect(warning?.message).not.toContain("设置页");
    expect(warning?.message).toContain("丢失");
  });

  it("lists both dirty drafts when settings and skill notes are unsaved", () => {
    let forms = setFormDirty(CLEAN_FORMS, "skills", true);
    forms = setFormDirty(forms, "settings", true);
    const warning = disconnectDraftWarning(forms);
    expect(warning?.forms).toEqual(["settings", "skills"]);
    expect(warning?.message).toContain("设置页");
    expect(warning?.message).toContain("Skill Review 备注");
  });

  it("includes unsaved queue edits in the disconnect warning", () => {
    const forms = setFormDirty(CLEAN_FORMS, "queue", true);
    const warning = disconnectDraftWarning(forms);
    expect(warning?.forms).toEqual(["queue"]);
    expect(warning?.message).toContain("审批队列草稿");
    expect(warning?.message).toContain("丢失");
    expect(hasDirtyForms(forms)).toBe(true);
    expect(hasDirtyForms(CLEAN_FORMS)).toBe(false);
  });

  it("stops warning after the draft is saved or unregistered", () => {
    let forms = setFormDirty(CLEAN_FORMS, "skills", true);
    forms = setFormDirty(forms, "skills", false);
    expect(disconnectDraftWarning(forms)).toBeNull();
  });

  it("keeps warning about the remaining draft when only one is cleaned", () => {
    let forms = setFormDirty(CLEAN_FORMS, "settings", true);
    forms = setFormDirty(forms, "skills", true);
    forms = setFormDirty(forms, "skills", false);
    expect(disconnectDraftWarning(forms)?.forms).toEqual(["settings"]);
  });
});
