/**
 * WHAT `/compose?draft=<id>` SHOWS — decided once, at the open. The route used to re-ask the live
 * Drafts list on every render, so a draft another device sent or deleted (it leaves that list)
 * swapped the open editor for "This draft can't be edited here" — a false sentence, and nothing
 * left to type into. Once the sheet has opened on a row it stays; what happened to the row is the
 * sheet's to say (`MessageActions.tsx`, `draftLeft`). No React Native renderer here: driven directly.
 */
import type { KeptReply, WorldDraft, WorldDraftEdit, WorldMail } from "../state/live";
import { Copy } from "../copy";

interface ComposeReturnRoute {
  name: string;
  state?: { index?: number; routes: readonly { name: string }[] };
}

export function composeBackLabel(route: ComposeReturnRoute | undefined): string {
  const tabs = route?.name === "(tabs)" ? route.state : undefined;
  const name = route?.name === "(tabs)" ? tabs?.routes[tabs.index ?? 0]?.name : route?.name;
  switch (name) {
    case undefined:
    case "index": return Copy.ohbox;
    case "screener": return Copy.screener;
    case "reads": return Copy.reads;
    case "receipts": return Copy.receipts;
    case "more": return Copy.tabMore;
    case "search": return Copy.search;
    case "settings": return Copy.settings;
    case "drafts/index": return Copy.draftsTitle;
    default: return Copy.back;
  }
}

/** What the sheet was opened with: the row's seed and the original of a reply or forward. */
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
  | { kind: "forwardOriginalAbsent" }
  | { kind: "replyOriginalAbsent" };

export function composeDraftPlan(
  id: string,
  held: ComposeDraftOpen | null,
  row: WorldDraft | undefined,
  originalOf: (messageId: string) => WorldMail | undefined,
): ComposeDraftPlan {
  if (held !== null && held.draft.id === id) return { kind: "sheet", open: held };
  if (!row) return { kind: "gone" };
  if (row.edit === null) return { kind: "notEditable" };
  const parent = row.edit.forwardOf ?? row.edit.replyTo;
  const original = parent ? originalOf(parent) : undefined;
  if (parent && !original) return { kind: row.edit.forwardOf ? "forwardOriginalAbsent" : "replyOriginalAbsent" };
  return { kind: "sheet", open: { draft: { id: row.id, body: row.body, ...row.edit }, original: original ?? null } };
}

/** What a Reply or Reply all press opens: the verb pressed is the mode (the audience the head names). */
export interface ReplyOpen {
  compose: "reply" | "replyAll";
  /** Open the consent and credit offer for a draft of this reply. */
  offerDraftReply?: true;
  /** The kept reply the sheet resumes, bound to its row. */
  draft?: ComposeDraftOpen["draft"];
  /** A reply is kept that this phone cannot write whole: the sheet says it is in Drafts. */
  aside?: true;
}

export type InlineComposeOpen = ReplyOpen | { compose: "forward"; confirmed?: boolean };

/** Decided once, at the press: resume the kept reply, or open fresh and say one is kept. */
export function replyOpen(kept: KeptReply, pressed: "reply" | "replyAll"): ReplyOpen {
  if (kept.kind === "resume") return { compose: pressed, draft: kept.draft };
  if (kept.kind === "aside") return { compose: pressed, aside: true };
  return { compose: pressed };
}
