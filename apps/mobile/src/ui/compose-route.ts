/**
 * WHAT `/compose?draft=<id>` SHOWS — decided once, at the open. The route used to re-ask the live
 * Drafts list on every render, so a draft another device sent or deleted (it leaves that list)
 * swapped the open editor for "This draft can't be edited here" — a false sentence, and nothing
 * left to type into. Once the sheet has opened on a row it stays; what happened to the row is the
 * sheet's to say (`MessageActions.tsx`, `draftLeft`). No React Native renderer here: driven directly.
 */
import type { KeptReply, WorldDraft, WorldDraftEdit, WorldMail } from "../state/live";

/** What the sheet was opened with: the row's seed and, for a forward, its original. */
export interface ComposeDraftOpen {
  draft: { id: string; body: string } & WorldDraftEdit;
  original: WorldMail | null;
}

export type ComposeDraftPlan =
  | { kind: "sheet"; open: ComposeDraftOpen }
  /** The row is not in this mirror at the open: "This draft is no longer in Drafts." */
  | { kind: "gone" }
  /** The one case "can't be edited here" is true for: `draftEditOf` refused the row at the open. */
  | { kind: "notEditable" }
  | { kind: "forwardOriginalAbsent" };

export function composeDraftPlan(
  id: string,
  held: ComposeDraftOpen | null,
  row: WorldDraft | undefined,
  originalOf: (messageId: string) => WorldMail | undefined,
): ComposeDraftPlan {
  if (held !== null && held.draft.id === id) return { kind: "sheet", open: held };
  if (!row) return { kind: "gone" };
  if (row.edit === null) return { kind: "notEditable" };
  const original = row.edit.forwardOf !== null ? originalOf(row.edit.forwardOf) : undefined;
  if (row.edit.forwardOf !== null && !original) return { kind: "forwardOriginalAbsent" };
  return { kind: "sheet", open: { draft: { id: row.id, body: row.body, ...row.edit }, original: original ?? null } };
}

/** What a Reply or Reply all press opens: the verb pressed is the mode (the audience the head names). */
export interface ReplyOpen {
  compose: "reply" | "replyAll";
  /** The kept reply the sheet resumes, bound to its row. */
  draft?: ComposeDraftOpen["draft"];
  /** A reply is kept that this phone cannot write whole: the sheet says it is in Drafts. */
  aside?: true;
}

/** Decided once, at the press: resume the kept reply, or open fresh and say one is kept. */
export function replyOpen(kept: KeptReply, pressed: "reply" | "replyAll"): ReplyOpen {
  if (kept.kind === "resume") return { compose: pressed, draft: kept.draft };
  if (kept.kind === "aside") return { compose: pressed, aside: true };
  return { compose: pressed };
}
