/**
 * Pure helpers shared by Settings and Skills to keep an editable draft apart
 * from the last persisted snapshot.
 *
 * Both pages reload in the background on every SSE refresh. A background load
 * must never silently replace something the user typed, while an explicit
 * reload may discard the draft the user chose to abandon.
 */

export interface LoadTicket {
  /** Monotonic request id; only the newest request may update the form. */
  id: number;
  /** Serialized draft at the moment the request was sent. */
  draftAtStart: string;
}

export interface LoadOutcome {
  draft: string;
  saved: string;
  applied: boolean;
}

export interface LoadInput {
  ticket: LoadTicket;
  latestTicketId: number;
  draft: string;
  saved: string;
  loaded: string;
  /** True when the user explicitly asked to reload and discard the draft. */
  explicit: boolean;
}

export function newLoadTicket(id: number, draft: string): LoadTicket {
  return { id, draftAtStart: draft };
}

/** A draft is clean exactly when it matches the last persisted snapshot. */
export function isDraftDirty(draft: string, saved: string): boolean {
  return draft !== saved;
}

export function applyLoad(input: LoadInput): LoadOutcome {
  const keep: LoadOutcome = {
    draft: input.draft,
    saved: input.saved,
    applied: false,
  };
  if (input.ticket.id !== input.latestTicketId) return keep;
  // Anything typed after the request was sent wins over the response, even
  // for an explicit reload.
  if (input.draft !== input.ticket.draftAtStart) return keep;
  // Background refresh must not overwrite unsaved edits.
  if (!input.explicit && isDraftDirty(input.draft, input.saved)) return keep;
  return { draft: input.loaded, saved: input.loaded, applied: true };
}

export interface SaveOutcome {
  /** Serialized baseline to remember after the attempt. */
  saved: string;
  /** True when the server response may replace the form. */
  adoptResponse: boolean;
  /** True when edits made after the request was sent were preserved. */
  keptNewerEdits: boolean;
  ok: boolean;
}

export interface SaveInput {
  ok: boolean;
  /** Serialized draft that was sent to the server. */
  submitted: string;
  /** Serialized draft at the moment the response arrived. */
  currentDraft: string;
  /** Serialized baseline before the save started. */
  savedBefore: string;
  /** Serialized snapshot the server reports as persisted. */
  responseSaved: string;
}

export function applySaveResult(input: SaveInput): SaveOutcome {
  if (!input.ok) {
    return {
      saved: input.savedBefore,
      adoptResponse: false,
      keptNewerEdits: input.currentDraft !== input.submitted,
      ok: false,
    };
  }
  if (input.currentDraft !== input.submitted) {
    return {
      saved: input.responseSaved,
      adoptResponse: false,
      keptNewerEdits: true,
      ok: true,
    };
  }
  return {
    saved: input.responseSaved,
    adoptResponse: true,
    keptNewerEdits: false,
    ok: true,
  };
}

/** Pages that keep their local draft state after the user leaves the tab. */
export type RetainedPage = "queue" | "skills" | "settings";

function isRetainedPage(tab: string): tab is RetainedPage {
  return tab === "queue" || tab === "skills" || tab === "settings";
}

/**
 * Record a first visit to a retained page. Other tabs never drag a page into
 * memory, so an unvisited editor cannot pre-start its background loads.
 */
export function rememberPageVisit(
  visited: readonly RetainedPage[],
  tab: string,
): readonly RetainedPage[] {
  if (!isRetainedPage(tab) || visited.includes(tab)) return visited;
  return [...visited, tab];
}

/**
 * A retained page mounts on its first visit and stays mounted afterwards, so
 * its local draft survives later tab switches.
 */
export function isPageMounted(
  visited: readonly RetainedPage[],
  activeTab: string,
  page: RetainedPage,
): boolean {
  return activeTab === page || visited.includes(page);
}

/** Exactly one retained page is visible; the others stay mounted but hidden. */
export function isPageVisible(activeTab: string, page: RetainedPage): boolean {
  return activeTab === page;
}

export type SkillListDecision =
  | { kind: "ignored" }
  | { kind: "unchanged" }
  | { kind: "kept-unavailable"; id: string };

export interface SkillListInput {
  /** Id of the list request that produced this response. */
  requestId: number;
  latestRequestId: number;
  selectedId: string | null;
  ids: readonly string[];
}

/**
 * A background list refresh may only update the list. It must never clear the
 * selected draft: a missing item is marked unavailable so the page can keep the
 * notes/detail, disable decisions and offer an explicit discard instead.
 */
export function reconcileSkillList(input: SkillListInput): SkillListDecision {
  if (input.requestId !== input.latestRequestId) return { kind: "ignored" };
  if (!input.selectedId) return { kind: "unchanged" };
  if (input.ids.includes(input.selectedId)) return { kind: "unchanged" };
  return { kind: "kept-unavailable", id: input.selectedId };
}

/** Decisions are blocked while another request runs or the draft is missing. */
export function canSubmitSkillDecision(input: {
  busy: boolean;
  unavailable: boolean;
}): boolean {
  return !input.busy && !input.unavailable;
}

/** Retained editors that can hold an unsaved draft across tab switches. */
export type DraftForm = "queue" | "settings" | "skills";

export interface DirtyForms {
  queue: boolean;
  settings: boolean;
  skills: boolean;
}

export const CLEAN_FORMS: DirtyForms = { queue: false, settings: false, skills: false };

const DRAFT_FORM_LABELS: Record<DraftForm, string> = {
  queue: "审批队列草稿",
  settings: "设置页",
  skills: "Skill Review 备注",
};

const DRAFT_FORM_ORDER: readonly DraftForm[] = ["settings", "skills", "queue"];

/**
 * Register one form's dirty state without touching the other form. Returning
 * the same object for no-op updates lets React skip the render.
 */
export function setFormDirty(
  current: DirtyForms,
  form: DraftForm,
  dirty: boolean,
): DirtyForms {
  if (current[form] === dirty) return current;
  return { ...current, [form]: dirty };
}

function dirtyFormNames(current: DirtyForms): DraftForm[] {
  return DRAFT_FORM_ORDER.filter((form) => current[form]);
}

export function hasDirtyForms(current: DirtyForms): boolean {
  return dirtyFormNames(current).length > 0;
}

export interface DisconnectDraftWarning {
  forms: DraftForm[];
  message: string;
}

/**
 * Disconnecting clears the token and unmounts the retained editors, so their
 * unsaved drafts vanish without a beforeunload prompt. Only produce a warning
 * when at least one form actually holds an unsaved draft.
 */
export function disconnectDraftWarning(
  current: DirtyForms,
): DisconnectDraftWarning | null {
  const forms = dirtyFormNames(current);
  if (forms.length === 0) return null;
  const details = forms
    .map((form) => `${DRAFT_FORM_LABELS[form]}有未保存的修改`)
    .join("；");
  return {
    forms,
    message: `${details}，断开连接后会丢失。`,
  };
}
