/**
 * TYPED TEXT IS NEVER LOST SILENTLY — the composer's close, as a decision rather than a branch
 * inside a sheet (`send-cancel.ts`'s idiom: there is no React Native renderer in this workspace,
 * so the decision is driven directly and `MessageActions.tsx` is read to prove it takes it).
 *
 * Every road out — Cancel, the backdrop, the back gesture — asks this after `cancelAct` said
 * "close". A letter worth a row is kept as a draft first, its files on this phone
 * (`compose/letter-store.ts`); files past what the phone keeps, or a keep that failed, are said in
 * place, so one stray tap loses nothing.
 */
import type { ComposerPhase } from "./send-cancel";

/**
 * What the close does: keep the text, say why it cannot and wait, or just close. `tooLong`: the
 * text is past the draft limit, so no keep can land — said in place, and the next close discards.
 */
export type KeepAct = "keep" | "ask" | "close" | "tooLong";

/**
 * Worth a draft row — the web's `worthCreating`: a body, a new mail's own subject, or a file. A
 * reply's subject and a recipient alone are not something the person wrote.
 */
export function worthKeeping(o: { fresh: boolean; subject: string; body: string; files?: number }): boolean {
  return o.body.trim() !== "" || (o.fresh && o.subject.trim() !== "") || (o.files ?? 0) > 0;
}

/**
 * `armed` is the second press after the sheet said why it could not keep something — that press
 * is the person choosing to discard. Only an idle composer keeps: a queued or unverified send
 * already has its text on its way, and closing a sending one is not offered. A queued send whose
 * Cancel is owed is the exception: its words go nowhere, so they are kept as an idle letter's are.
 */
export function keepAct(o: {
  phase: ComposerPhase;
  worth: boolean;
  /** Files past what this phone keeps with drafts: named before the keep, which goes without them. */
  filesOver: number;
  armed: boolean;
  /** The body is past `DRAFT_BODY_MAX_BYTES`. */
  tooLong?: boolean;
  /** A Cancel the server could not answer is owed over this sheet's send, and no row holds its words. */
  cancelOwed?: boolean;
}): KeepAct {
  const idle = o.phase === "idle" || (o.phase === "queued" && o.cancelOwed === true);
  if (!idle || o.armed) return "close";
  if (o.worth && o.tooLong === true) return "tooLong";
  if (o.worth && o.filesOver > 0) return "ask";
  return o.worth ? "keep" : "close";
}

/**
 * A composer UNMOUNTED without a close (its route replaced or covered by a fold): an idle letter
 * worth a row is kept quietly, as the close would have kept it, with the files that fit; a send in
 * flight or a keep already running keeps its own.
 */
export function unmountKeep(o: { phase: ComposerPhase; worth: boolean; keeping: boolean; tooLong?: boolean }): "keep" | "nothing" {
  return o.phase === "idle" && o.worth && !o.keeping && o.tooLong !== true ? "keep" : "nothing";
}

/**
 * THE AUTOSAVE MARKS THE SCREEN SAVED ONLY ONCE ITS KEEP ANSWERED `kept`. Marked before, a refused
 * keep (a removed mailbox, a refused edit) left the close nothing worth keeping, and the sheet
 * closed over words no row held. `onScreen` is what the keep carried, not what is there now.
 */
export async function autosaveKeep(
  saved: { current: string | null },
  onScreen: string,
  keep: () => Promise<"kept" | "refused" | "tooLong">,
): Promise<void> {
  if ((await keep()) === "kept") saved.current = onScreen;
}

/**
 * THE VERSION A BOUND SHEET'S WORDS ARE BASED ON: the row it holds and that row's version as last
 * known. A confirmed save names the next version; a queued save keeps the base (the adapter moves it
 * along this phone's own saves when it lands); a row named without a version states none.
 */
export interface DraftBase {
  row: string | null;
  rev: string | null;
  /** The keys of this sheet's own saves of the row: the engine's kept copy of one of them is this sheet's. */
  waited?: readonly string[];
}

export function baseAfter(b: DraftBase, r: { draftId: string | null; revision?: string; key?: string | null }): DraftBase {
  if (r.draftId === null) return b;
  const same = r.draftId === b.row;
  const next: DraftBase = r.revision ? { row: r.draftId, rev: r.revision } : same ? { row: b.row, rev: b.rev } : { row: r.draftId, rev: null };
  const waited = [...(same ? b.waited ?? [] : []), ...(r.key ? [r.key] : [])].slice(-16);
  return waited.length > 0 ? { ...next, waited } : next;
}

/** The keys of this sheet's own saves of `row`. */
export function waitedFor(b: DraftBase, row: string | null): readonly string[] {
  return row !== null && row === b.row ? b.waited ?? [] : [];
}

/** The version a save or send of `row` states: only the base's own row's. */
export function baseFor(b: DraftBase, row: string | null): string | null {
  return row !== null && row === b.row ? b.rev : null;
}
