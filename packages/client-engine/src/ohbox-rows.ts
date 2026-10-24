import {
  arrivalMs,
  conversationKeyOf,
  isFromSomeone,
  isItipAcknowledgement,
  isOwnSent,
  newestFromSomeone,
  ohboxView,
  pileOfState,
  resurfacedFocus,
  resurfacedThreads,
  threadOf,
  winningStates,
  type OhboxView,
  type ResurfacedThreadRow,
} from "./selectors.js";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { isHeldFolder } from "@trafficflow/core/destinations";
import type { EntityReader } from "./store.js";
import { FOLDER_OF_VIEW, type EngineMessage } from "./types.js";

/*
 * ONE ROW PER CONVERSATION, ACROSS SECTIONS (owner 2026-09-28). The Ohbox draws a conversation at
 * most once over Resurfaced, New, Earlier and the Older tail: the fold walks the four lists top
 * down, the FIRST section to claim a key owns the row, and a member met later joins that row — it
 * is never a second row and never dropped. `ohboxView` already files a whole conversation into
 * one group, so on the engine's own lists nothing is absorbed; the absorb is the belt for the web
 * view's session order and the Older tail. Read state, counts and picks stay per message.
 */

export type OhboxRowSection = "resurfaced" | "new" | "earlier" | "older";

const SECTIONS: readonly OhboxRowSection[] = ["resurfaced", "new", "earlier", "older"];

/** One rendered Ohbox row: a conversation, or a lone message. */
export interface OhboxRow {
  /** {@link conversationKeyOf} — stable while a newer member takes the row's face. */
  key: string;
  section: OhboxRowSection;
  /** Every member on the row: the owning section's first, each list in its own order. */
  members: EngineMessage[];
  /** The members that came from the owning section's own list — what a slide is judged on. */
  placing: EngineMessage[];
  /** Whose words and stamp the row shows: the newest member a person wrote (Resurfaced: the focus). */
  face: EngineMessage;
  /**
   * What a click, ↵ and the row's verbs act on. While an unread letter waits (not our own Sent
   * copy): the newest letter, read or unread, so a conversation opens on its newest (c3) and an
   * older unread member never pulls the open back; an unread acknowledgement somebody sent counts.
   * Else the face when somebody else wrote it; else the newest member somebody else wrote (an
   * answered conversation stands for the letter, not our reply); else, our own mail alone, its
   * latest unread, else the face.
   */
  openTarget: EngineMessage;
  unreadCount: number;
  /**
   * PRESENT ONLY ON A RESURFACED ROW the engine still holds: the server's thread length, the unread
   * arrivals since the pin, and the pinned members Done releases. One field, so they cannot disagree.
   */
  resurfaced?: { count: number; newSince: number; pinned: EngineMessage[] };
}

export interface OhboxRowLists {
  resurfaced: readonly EngineMessage[];
  new: readonly EngineMessage[];
  earlier: readonly EngineMessage[];
  older?: readonly EngineMessage[];
}

/** Arrival order for faces and targets; an undated member is older than anything dated. */
function timeOf(m: EngineMessage): number {
  return arrivalMs(m) ?? Number.NEGATIVE_INFINITY;
}

/** The newest member by arrival; a tie keeps the earlier one in row order. */
function latestOf(members: readonly EngineMessage[]): EngineMessage {
  let best = members[0]!;
  for (const m of members) if (timeOf(m) > timeOf(best)) best = m;
  return best;
}

/** The newest member a PERSON wrote — a calendar acknowledgement is a member, never the face. */
function faceOf(members: readonly EngineMessage[]): EngineMessage {
  const human = members.filter((m) => !isItipAcknowledgement(m));
  return latestOf(human.length > 0 ? human : members);
}

/**
 * An unread member that is not our own Sent copy. Own mail is ingested read; a copy flagged unread
 * (a row's Mark unread over every member did that) is no letter for the row to stand for.
 */
const isUnreadLetter = (m: EngineMessage): boolean => m.unread && !isOwnSent(m);

function rowOf(
  key: string, section: OhboxRowSection, members: EngineMessage[], placing: EngineMessage[],
  engineRow: ResurfacedThreadRow | undefined,
): OhboxRow {
  const unread = members.filter((m) => m.unread);
  if (section === "resurfaced" && engineRow) {
    // The engine's focus while it is on the row; during a slide the row can hold a subset, and a
    // target it cannot show is a click going nowhere, so the rule is re-asked over what is here.
    const here = new Set(members.map((m) => m.id));
    const pinned = engineRow.pinned.filter((m) => here.has(m.id));
    const focus = here.has(engineRow.openTarget.id)
      ? engineRow.openTarget
      : resurfacedFocus(members, pinned);
    return {
      key, section, members, placing, face: focus, openTarget: focus, unreadCount: unread.length,
      resurfaced: { count: engineRow.count, newSince: engineRow.newSince.length, pinned },
    };
  }
  const face = faceOf(members);
  const letters = unread.filter(isUnreadLetter);
  return {
    key, section, members, placing, face,
    openTarget: letters.length > 0
      ? latestOf(members.filter((m) => isUnreadLetter(m) || isFromSomeone(m)))
      : isFromSomeone(face) ? face : newestFromSomeone(members) ?? (unread.length > 0 ? latestOf(unread) : face),
    unreadCount: unread.length,
  };
}

/**
 * Fold the four lists into rows. Each section's rows stand in first-claim order, which is its own
 * list's order, so the fold never re-sorts what the caller placed. `engineRows` are the
 * Resurfaced rows the engine holds ({@link resurfacedThreads}); a Resurfaced key it no longer holds
 * (a Done mid-slide) is an ordinary row.
 */
export function foldOhboxRows(
  lists: OhboxRowLists,
  engineRows: readonly ResurfacedThreadRow[],
): Record<OhboxRowSection, OhboxRow[]> {
  const claims = new Map<string, { section: OhboxRowSection; members: EngineMessage[]; placing: EngineMessage[] }>();
  const order: Record<OhboxRowSection, string[]> = { resurfaced: [], new: [], earlier: [], older: [] };
  const seen = new Set<string>();
  for (const section of SECTIONS) {
    for (const m of lists[section] ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const key = conversationKeyOf(m);
      if (!claims.has(key)) {
        claims.set(key, { section, members: [], placing: [] });
        order[section].push(key);
      }
      const claim = claims.get(key)!;
      claim.members.push(m);
      if (claim.section === section) claim.placing.push(m);
    }
  }
  const engineRowOf = new Map(engineRows.map((r) => [r.key, r]));
  const out = { resurfaced: [], new: [], earlier: [], older: [] } as Record<OhboxRowSection, OhboxRow[]>;
  for (const section of SECTIONS) {
    for (const key of order[section]) {
      const c = claims.get(key)!;
      out[section].push(rowOf(key, section, c.members, c.placing, engineRowOf.get(key)));
    }
  }
  return out;
}

/**
 * WHAT A CONVERSATION OPENED FROM ITS OHBOX ROW IS ACTED ON — Forward, the Forward key and the phone
 * reader's verbs: the row's own answer, read off the rows the Ohbox draws and never recomputed over
 * the whole thread, so a member the row would not open at cannot become it. The opened message while
 * it is a member of its row (an explicit open of an older member — search, a URL, a notification,
 * a square — stays on it); the row's target when it is not; the opened message when no row holds
 * its conversation. Callers take it once, at the open, so a later change to the row cannot move it.
 */
export function rowOpenTarget(
  reader: EntityReader, opened: EngineMessage, openHeld: string | null = null,
): EngineMessage {
  // A held message stands in no row (its place is the gate or Quarantine): opened, it is its own
  // target, never one a header another sender wrote would redirect it to.
  if (isHeldFolder(opened.folder)) return opened;
  const key = conversationKeyOf(opened);
  const rows = ohboxRows(reader, openHeld);
  for (const section of SECTIONS) {
    const row = rows[section].find((r) => r.key === key);
    if (row) return row.members.some((m) => m.id === opened.id) ? opened : row.openTarget;
  }
  return opened;
}

/**
 * What a triage press or a Mark unread over a set acts on: `ids`, less our own mail whose
 * conversation the set also carries somebody else's letter of. A folded row picked or dragged
 * hands in every member; the letter is filed or marked unread and our reply stays as it was. Own
 * mail with no letter beside it, and ids the reader lacks, are kept, in order.
 */
export function triageSubjectIds(reader: EntityReader, ids: readonly string[]): string[] {
  const rows = ids.map((id) => reader.get<EngineMessage>("message", id));
  const lettered = new Set<string>();
  for (const m of rows) if (m && isFromSomeone(m)) lettered.add(conversationKeyOf(m));
  return ids.filter((_, i) => {
    const m = rows[i];
    return m === undefined || isFromSomeone(m) || !lettered.has(conversationKeyOf(m));
  });
}

/**
 * What a Park on `messageId` files. Standing in an Ohbox row: every member of it that stands in the
 * Ohbox, our own reply included, so the row leaves (a Resurfaced row's pins, and its INBOX and own Sent
 * members not filed in a pile). Parked: every parked member of its conversation, so the un-press
 * mirrors the press. In another pile, in no row, or unknown to the reader: itself.
 */
export function parkSubjectIds(
  reader: EntityReader, messageId: string, openHeld: string | null = null,
): string[] {
  const m = reader.get<EngineMessage>("message", messageId);
  if (!m) return [messageId];
  const claims = winningStates(reader);
  const stateOf = (x: EngineMessage): string | undefined => claims.get(x.id)?.state ?? x.triage?.state;
  if (stateOf(m) === "set_aside") {
    const rest = threadOf(reader, messageId).filter((x) => x.id !== messageId && stateOf(x) === "set_aside");
    return [messageId, ...rest.map((x) => x.id)];
  }
  if (pileOfState(stateOf(m) ?? "")) return [messageId];
  const key = conversationKeyOf(m);
  const rows = ohboxRows(reader, openHeld);
  for (const section of SECTIONS) {
    const row = rows[section].find((r) => r.key === key);
    if (!row || !row.members.some((x) => x.id === messageId)) continue;
    const pins = new Set((row.resurfaced?.pinned ?? []).map((x) => x.id));
    const inbox = canonicalDestination(FOLDER_OF_VIEW.ohbox);
    const standing = row.members.filter((x) => pins.has(x.id) || (
      !pileOfState(stateOf(x) ?? "") && (isOwnSent(x) || canonicalDestination(x.folder) === inbox)
    )).map((x) => x.id);
    return standing.includes(messageId) ? standing : [messageId];
  }
  return [messageId];
}

/**
 * Our own mail facing the Ohbox row `m` stands for, when `m` is that row's open target with no
 * unread letter (our own Sent copy flagged unread is none) and `m` not held open; else null.
 * The web's row press records it, and Move seeds its subjects from it, so a Move on an answered
 * row still reaches every sender's letter (`moveSubjectIds`).
 */
export function ownFaceOfRow(
  reader: EntityReader, m: EngineMessage, openHeld: string | null = null,
): EngineMessage | null {
  const key = conversationKeyOf(m);
  const rows = ohboxRows(reader, openHeld);
  for (const section of SECTIONS) {
    const row = rows[section].find((r) => r.key === key);
    if (!row) continue;
    // Only where the read arm moved the target off our reply: an unread letter, or one read at
    // the open and held, stands for itself.
    return !row.members.some(isUnreadLetter) && m.id !== openHeld && row.openTarget.id === m.id
      && row.face.id !== m.id && !isFromSomeone(row.face) ? row.face : null;
  }
  return null;
}

const rowsCache = new WeakMap<
  EntityReader, { v: number; openHeld: string | null; rows: Record<OhboxRowSection, OhboxRow[]> }
>();

/**
 * THE OHBOX AS ROWS — {@link ohboxView}'s groups and the engine's Resurfaced rows, folded once.
 * The phone draws exactly these; the web folds its session-placed lists through the same
 * {@link foldOhboxRows}. Memoized on (version, openHeld), like `ohboxView`.
 */
export function ohboxRows(
  reader: EntityReader,
  openHeld: string | null = null,
): Record<OhboxRowSection, OhboxRow[]> {
  const v = reader.version();
  const hit = rowsCache.get(reader);
  if (hit && hit.v === v && hit.openHeld === openHeld) return hit.rows;
  const view = ohboxView(reader, openHeld);
  const engineRows = resurfacedThreads(reader);
  const rows = foldOhboxRows(
    { resurfaced: engineRows.flatMap((r) => r.members), new: view.newForYou, earlier: view.previouslySeen },
    engineRows,
  );
  rowsCache.set(reader, { v, openHeld, rows });
  return rows;
}

/**
 * THE OHBOX'S UNREAD — the one set the rail, the list header, mark-all-read, the dock badge and the
 * phone's tab all count: every member of every Resurfaced row, New and Earlier, once each, by the
 * mailbox's own flag (`m.unread`, never `presentsUnread`). The rail used to count New alone, so a
 * letter brought back by Resurface > Now stood in the header's number and not in the rail's.
 */
export function ohboxUnreadIds(
  resurfacedRows: readonly { members: readonly EngineMessage[] }[],
  view: Pick<OhboxView, "newForYou" | "previouslySeen">,
): string[] {
  const ids = new Set<string>();
  for (const row of resurfacedRows) for (const m of row.members) if (m.unread) ids.add(m.id);
  for (const m of view.newForYou) if (m.unread) ids.add(m.id);
  for (const m of view.previouslySeen) if (m.unread) ids.add(m.id);
  return [...ids];
}
