import type { Suggestion } from "../types";

/** Mirrors the server's compact() so "only whitespace changed" is not an edit. */
export function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function suggestionApplyState(input: {
  suggestion: Suggestion | undefined;
  suggestionState: "pending" | "ready" | "failed" | undefined;
  title: string;
  text: string;
  overLimit: boolean;
}): {
  bodyEdited: boolean;
  titleEdited: boolean;
  edited: boolean;
  canApply: boolean;
} {
  const { suggestion } = input;
  const bodyEdited = Boolean(
    suggestion && compactText(input.text) !== compactText(suggestion.proposedText),
  );
  const titleEdited = Boolean(
    suggestion && compactText(input.title) !== compactText(suggestion.proposedTitle),
  );
  const ready =
    input.suggestionState !== "pending" && input.suggestionState !== "failed";
  return {
    bodyEdited,
    titleEdited,
    edited: bodyEdited || titleEdited,
    canApply: Boolean(
      suggestion &&
        !input.overLimit &&
        (bodyEdited || (suggestion.validation.ok && ready)),
    ),
  };
}
