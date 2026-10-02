/**
 * WHY SOME OF A SENDER'S MAIL STAYED — the phone's half of the web sender sheet's lines
 * (`apps/webapp/app/shell/SenderMenu.tsx#stayedLines`, `sender-screening.ts#subjectOf`, the
 * reference; the webapp shell is not importable from React Native). The reasons are the server's
 * (`GET /screener/stayed`, read through `engine.whyStayed`); this module only says which rows to
 * ask about and groups the answer by place and reason, so the lines count the rows the lists show.
 */
import {
  FOLDER_OF_VIEW,
  canonicalDestination,
  consentIndex,
  decidedDestination,
  mailboxProfiles,
  ruleTwins,
  rulesList,
  twinWinner,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type Folder,
  type MutationResult,
  type StayedWhy,
} from "@ohmail/client-engine";
import type { Destination, Scope } from "./model";

export type { StayedWhy };

/** A place the lists show mail in: a pile, the gate, or History (`placeOf` answers `null`). */
export type StayedPlace = Destination | "screener" | "history";

/** The web's batch for a visible move (`RETRO_VISIBLE_MOVES`): each batch answered before the next. */
export const STAYED_MOVE_BATCH = 50;

const PLACE_OF_FOLDER = new Map<Folder, Destination | "screener">([
  [FOLDER_OF_VIEW.ohbox, "ohbox"],
  [FOLDER_OF_VIEW.reads, "reads"],
  [FOLDER_OF_VIEW.receipts, "receipts"],
  [FOLDER_OF_VIEW.screened, "screened"],
  [FOLDER_OF_VIEW.spam, "spam"],
  [FOLDER_OF_VIEW.screener, "screener"],
]);

/** What the sheet asks about: the rule's place, and the subject's rows the lists show elsewhere. */
export interface StayedAsk {
  ruled: Destination;
  elsewhere: Array<{ id: string; place: StayedPlace }>;
}

/**
 * THE ROWS A FINISHED PASS LEFT ELSEWHERE. Only when the rule deciding the subject was asked for
 * its backlog and that pass has finished: while it runs, a row elsewhere is on its way, not left.
 * `subject` newest first; `null` when there is nothing to ask.
 */
export function stayedAsk(o: {
  reader: EntityReader;
  placeOf: ReadonlyMap<string, Folder | null>;
  subject: readonly EngineMessage[];
  scope: Scope;
  match: string;
  mailboxId: string;
}): StayedAsk | null {
  const rules = rulesList(o.reader);
  const winner = twinWinner(ruleTwins(rules, o.scope, o.match));
  if (winner?.retro?.requestedAt == null || winner.retro.doneAt == null) return null;
  const decided = o.scope === "sender"
    ? decidedDestination(consentIndex(rules, mailboxProfiles(o.reader)), o.match, o.mailboxId)
    : winner.destination;
  const shown = (m: EngineMessage): StayedPlace | undefined => {
    const place = o.placeOf.has(m.id) ? o.placeOf.get(m.id)! : m.folder;
    return place === null ? "history" : PLACE_OF_FOLDER.get(canonicalDestination(place) as Folder);
  };
  const counts = new Map<StayedPlace, number>();
  for (const m of o.subject) {
    const p = shown(m);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const current = counts.size === 1 ? [...counts.keys()][0]! : null;
  const pile = (p: StayedPlace | null | undefined): Destination | null =>
    p === undefined || p === null || p === "screener" || p === "history" ? null : p;
  const ruled = decided === null ? pile(current) : pile(PLACE_OF_FOLDER.get(canonicalDestination(decided) as Folder));
  if (ruled === null) return null;
  const elsewhere: StayedAsk["elsewhere"] = [];
  for (const m of o.subject) {
    const p = shown(m);
    if (p && p !== ruled) elsewhere.push({ id: m.id, place: p });
  }
  // EVERY ROW: the engine pages the route's ceiling, so the lines count what the lists show.
  return elsewhere.length > 0 ? { ruled, elsewhere } : null;
}

/** One line per place and reason, in the order the rows came; a row with no reason is not listed. */
export function stayedLines(
  elsewhere: StayedAsk["elsewhere"], why: ReadonlyMap<string, StayedWhy>,
): Array<{ place: StayedPlace; why: StayedWhy; ids: string[] }> {
  const lines = new Map<string, { place: StayedPlace; why: StayedWhy; ids: string[] }>();
  for (const e of elsewhere) {
    const w = why.get(e.id);
    if (w === undefined) continue;
    const k = `${e.place}\u0000${w}`;
    const line = lines.get(k) ?? { place: e.place, why: w, ids: [] };
    line.ids.push(e.id);
    lines.set(k, line);
  }
  return [...lines.values()];
}

/**
 * "MOVE IT TOO": the web's `moveInBatches` — one `move` per row through the engine's one move
 * door, a batch at a time, each answered before the next. Tallied from the RAW answers: a row a
 * reader mailbox only records for its organizer is waiting, never moved.
 */
export async function moveStayedInBatches(
  ids: readonly string[], folder: Folder,
  dispatch: (m: EngineMutation) => Promise<MutationResult | null>,
): Promise<{ moved: number; refused: number; waiting: number }> {
  const tally = { moved: 0, refused: 0, waiting: 0 };
  for (let at = 0; at < ids.length; at += STAYED_MOVE_BATCH) {
    const outs = await Promise.all(ids.slice(at, at + STAYED_MOVE_BATCH).map((messageId) => dispatch({ kind: "move", messageId, folder })));
    for (const o of outs) {
      if (o === null || o.status === "rolled_back") tally.refused++;
      else if (o.status === "awaiting_organizer" || o.status === "queued") tally.waiting++;
      else tally.moved++;
    }
  }
  return tally;
}
