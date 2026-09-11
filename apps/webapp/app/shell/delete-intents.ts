"use client";

/**
 * A requested delete, on disk before the window opens. For the length of the undo window the only record of the
 * request used to be a `setTimeout` closure — a tab closed inside it lost a delete the toast reported as done (review
 * ranked it MAJOR: silent, in the direction where the product did not do what it said). No longer only a delete:
 * restore-from-Trash is held by the same window (no un-restore on the wire either), one journal for both verbs; a row
 * that does not say which is a delete ({@link DeleteIntent.kind}).
 */

/**
 * The names and the storage KEY still say "delete" — renaming the key would orphan every stranded row a previous
 * build left. A crash resolves TOWARD the delete: the intent lands synchronously before the timer, Undo removes it,
 * the commit removes it once `engine.mutate` settles, `pagehide` commits what it can, survivors replay at launch — a
 * delete thirty seconds late is a delete; one that evaporates is a lie. `localStorage` because it is synchronous,
 * owner-keyed for `screener-intents.ts`'s reason; a refusing jar leaves the request exactly as durable as the tab.
 */

import { durableRemove, durableSet, type DurableWrite } from "./durable";
import { storageOwner } from "./storage-owner";

/**
 * ONE PRESS, and every message it asked to delete.
 *
 * A PRESS AND NOT A MESSAGE, which is the whole reason this is a list. One press over a selection
 * of three opens ONE undo window; if it were journalled as three intents, `pagehide` could commit
 * two of them and lose the third, and the person would find their selection half deleted with the
 * toast having reported all of it. A press is the unit the window is offered over, so it is the
 * unit the record is kept in — atomic in, atomic out.
 */
export interface DeleteIntent {
  /** A press id, so a replay can tell two presses apart and clear exactly one. */
  id: string;
  messageIds: string[];
  /** Epoch ms at the press, from the caller's clock. */
  at: number;
  /**
   * Which verb was held — and ABSENT means `delete`, the legacy shape. Restoring out of Trash is
   * held by the same window for the same reason (no un-restore on the wire), one journal for both.
   * OPTIONAL rather than required is a compatibility decision: every row a previous build wrote
   * carries no `kind`, and a reader demanding one would DROP those rows — losing exactly the
   * deletes this journal exists to save, through the upgrade instead of the crash. A row whose
   * `kind` this build does not recognise is DROPPED rather than guessed at — the opposite
   * direction, deliberately: an unknown verb names an action this build cannot perform, and
   * replaying it as a delete would delete mail on the strength of a word we could not read.
   */
  kind?: HeldVerb;
}

/**
 * The verbs the held window may be holding. A CLOSED set, because {@link replayDeleteIntents}
 * dispatches on it: a member this build does not know is a row it must drop, not one it may
 * approximate.
 */
export type HeldVerb = "delete" | "restore";

/** Every member of {@link HeldVerb}, for the reader's membership test. */
const HELD_VERBS: readonly string[] = ["delete", "restore"];

/**
 * How long a stranded intent is still acted on. A day, matching the Screener's — past that the
 * mirror may not even hold the row, and replaying a delete somebody asked for last week against a
 * mailbox they have since reorganised is not honouring the request, it is guessing at it.
 */
export const DELETE_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export const DELETE_INTENTS_PREFIX = "ohmail.delete.intents.";

export function deleteIntentsKey(owner: string | null = storageOwner()): string {
  return `${DELETE_INTENTS_PREFIX}${owner ?? "anon"}`;
}

/**
 * How many stranded PRESSES one jar holds. A bound rather than a cap somebody will hit: a person
 * pressing Delete faster than the window closes is walking a pile, and past this the oldest are
 * dropped rather than the write refused — a quota rejection would take the whole journal with it,
 * which is the failure this file exists to prevent. Counted in presses, so a bulk press of two
 * hundred messages costs one row rather than two hundred.
 */
export const DELETE_INTENTS_MAX = 200;

/**
 * READ, TOLERANTLY, AND ACCEPT THE SHAPE THE PREVIOUS BUILD WROTE.
 *
 * The first version of this journal stored `{ messageId, at }` — one row per message. A person
 * who closes the tab inside the window and then reloads onto a NEW build must not lose the delete
 * because the record changed shape between the two: that is the very failure the journal exists
 * to prevent, arriving through the upgrade instead of through the crash. A legacy row is read as
 * a one-message press and replayed exactly like one.
 *
 * Anything else is dropped rather than guessed at. A row that parses but is not either shape
 * names no message this build can act on, and inventing one would be a delete nobody asked for.
 */
function read(): DeleteIntent[] {
  try {
    const raw = window.localStorage.getItem(deleteIntentsKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: DeleteIntent[] = [];
    for (const r of parsed) {
      if (typeof r !== "object" || r === null) continue;
      const row = r as Partial<DeleteIntent> & { messageId?: unknown; kind?: unknown };
      if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
      const ids = Array.isArray(row.messageIds)
        ? row.messageIds.filter((x): x is string => typeof x === "string" && x.length > 0)
        : typeof row.messageId === "string" && row.messageId.length > 0
          ? [row.messageId]
          : [];
      if (ids.length === 0) continue;
      /* THE VERB, or the legacy default. A row with no `kind` is a delete (see the field's own
         block); a row whose `kind` is a string this build does not know is DROPPED, because
         replaying an unreadable verb as a delete would delete mail on a guess. */
      let kind: HeldVerb = "delete";
      if (row.kind !== undefined) {
        if (typeof row.kind !== "string" || !HELD_VERBS.includes(row.kind)) continue;
        kind = row.kind as HeldVerb;
      }
      out.push({
        id: typeof row.id === "string" && row.id.length > 0 ? row.id : ids[0]!,
        messageIds: ids,
        at: row.at,
        kind,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * WRITE THE JOURNAL, AND SAY WHETHER IT LANDED — `screener-intents.ts#save`'s reason.
 *
 * It never throws at the press; what changed is that a refusal is no longer silent. `remove`
 * deletes at once on a `lost` write instead of opening an undo window it cannot honour.
 */
function write(rows: DeleteIntent[]): DurableWrite {
  const key = deleteIntentsKey();
  return rows.length === 0
    ? durableRemove(key, "delete.intents")
    : durableSet(key, JSON.stringify(rows.slice(-DELETE_INTENTS_MAX)), "delete.intents");
}

/**
 * Record the request.
 *
 * Replaces any intent with the same press id, and drops from EVERY OTHER press any message this
 * one names: a message may belong to at most one open press, or a replay would delete it twice
 * and the second would fail against a row that is already gone. A press left holding nothing
 * after that is removed with it.
 */
export function armDeleteIntent(intent: DeleteIntent): DurableWrite {
  const claimed = new Set(intent.messageIds);
  const kept: DeleteIntent[] = [];
  for (const r of read()) {
    if (r.id === intent.id) continue;
    const ids = r.messageIds.filter((id) => !claimed.has(id));
    if (ids.length > 0) kept.push(ids.length === r.messageIds.length ? r : { ...r, messageIds: ids });
  }
  return write([...kept, intent]);
}

/**
 * Forget one PRESS — Undo, and the commit's own settle.
 *
 * The commit calls this only AFTER `engine.mutate` has settled, never before it dispatches: the
 * engine persists the verb to its outbox ahead of the wire, so between the press and that write
 * this journal is the only durable copy and dropping it early reopens the hole one step along.
 */
export function disarmDeleteIntent(pressId: string): void {
  const rows = read();
  const kept = rows.filter((r) => r.id !== pressId);
  if (kept.length !== rows.length) write(kept);
}

/**
 * Every intent this boot should act on, oldest first, with the expired swept in the same pass.
 *
 * The sweep WRITES: an expired intent left in place is re-read and re-rejected on every boot for
 * ever, which is a journal that only grows — a second defect wearing the first one's clothes.
 * `nowMs` is injected so the TTL is testable without a fake clock over the whole suite.
 */
export function takeDeleteIntents(nowMs: number): DeleteIntent[] {
  const rows = read();
  if (rows.length === 0) return [];
  const live = rows.filter((r) => nowMs - r.at <= DELETE_INTENT_TTL_MS);
  if (live.length !== rows.length) write(live);
  return live.slice().sort((a, b) => a.at - b.at);
}
