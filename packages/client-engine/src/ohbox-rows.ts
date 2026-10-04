import {
  arrivalMs,
  conversationKeyOf,
  isItipAcknowledgement,
  ohboxView,
  resurfacedFocus,
  resurfacedThreads,
  type ResurfacedThreadRow,
} from "./selectors.js";
import type { EntityReader } from "./store.js";
import type { EngineMessage } from "./types.js";

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
  /** What a click, ↵ and the row's verbs act on: the latest unread member, else the face. */
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
  return {
    key, section, members, placing, face,
    openTarget: unread.length > 0 ? latestOf(unread) : face,
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
 * it is a member of its row (the open reads it, and the row's own target would then move to an older
 * unread member); the row's target when it is not; the opened message when no row holds its
 * conversation. Callers take it once, at the open, so a later change to the row cannot move it.
 */
export function rowOpenTarget(
  reader: EntityReader, opened: EngineMessage, openHeld: string | null = null,
): EngineMessage {
  const key = conversationKeyOf(opened);
  const rows = ohboxRows(reader, openHeld);
  for (const section of SECTIONS) {
    const row = rows[section].find((r) => r.key === key);
    if (row) return row.members.some((m) => m.id === opened.id) ? opened : row.openTarget;
  }
  return opened;
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
