"use client";

/**
 * A REQUESTED DELETE, ON DISK BEFORE THE WINDOW OPENS.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────────────────────
 *
 * The undo window made the press reversible by not sending it yet, and for the length of that
 * window the ONLY record of the request was a `setTimeout` closure in one tab's event loop. Close
 * the tab, navigate away, or let the OS reclaim the process inside it, and a delete the person
 * asked for — and which the toast reported as done — simply never happened. The module header
 * named that hole and called it a follow-up; review ranked it MAJOR, correctly: it is silent, and
 * it is silent in the direction where the product did not do what it said it did.
 *
 * ── AND IT IS NO LONGER ONLY A DELETE ─────────────────────────────────────────────────────
 *
 * Restoring a message out of Trash is held by the same window, for the identical reason: there
 * is no un-restore on the wire, so the only undo this product can honour is a delayed commit.
 * One journal for both verbs — the hole is the same hole, and two journals would be two places
 * to get the `pagehide` commit right. Each row therefore says which verb it is, and a row that
 * does not say (every row a previous build wrote) is a delete. See {@link DeleteIntent.kind}.
 *
 * The names here still say "delete" — `armDeleteIntent`, `DELETE_INTENTS_PREFIX`, the storage
 * KEY. The prefix and the key are deliberately unchanged: renaming the key would orphan every
 * stranded row a previous build left in somebody's browser, which is the exact loss this file
 * exists to prevent, arriving through a rename.
 *
 * This is `screener-intents.ts`'s answer applied to the same shape, and it is the same answer
 * because it is the same problem — that file's own header states the class ("this product decides
 * in memory and persists afterwards"), met at the Screener's consent gate. Here it is met at the
 * delete key.
 *
 * ── WHICH WAY A CRASH RESOLVES, AND WHY THAT DIRECTION ─────────────────────────────────────
 *
 * TOWARD THE DELETE. The intent lands here synchronously, before the timer is armed; Undo removes
 * it; the commit removes it only once `engine.mutate` has settled, because the engine writes its
 * durable outbox entry ahead of the wire and from that moment the outbox is the record. A tab
 * killed inside the window therefore resolves one way: `pagehide` commits what it can, and
 * whatever that did not reach is replayed at the next launch.
 *
 * The alternative — discarding a delete the toast has already reported — is the product being
 * wrong about somebody's mail on the one gesture where being wrong is least recoverable. A delete
 * that lands thirty seconds late is a delete; a delete that evaporates is a lie the person will
 * only discover by noticing the message is still there. Chosen, not defaulted into.
 *
 * ── WHY `localStorage` ────────────────────────────────────────────────────────────────────
 *
 * Because it is SYNCHRONOUS: `setItem` has returned before the press handler does, and an
 * IndexedDB write is a promise a killed tab need never settle. Owner-keyed for
 * `screener-intents.ts`'s reason — the jar is per-ORIGIN, and one account's delete must never be
 * replayed by the next account to sign in on the same browser, nor by a sibling mailbox on a
 * standalone install that mounts one engine each. A jar that refuses (Safari private mode throws)
 * leaves the request exactly as durable as the tab, which is where it was before this file.
 */

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
   * WHICH VERB WAS HELD — and ABSENT means `delete`, which is the legacy shape.
   *
   * The window is not a delete's any more: restoring a message out of Trash is held the same
   * way, for the same reason (there is no un-restore on the wire either, so the only undo this
   * product can honour is a delayed commit). One journal for both, because the failure it
   * exists to prevent is the same one — a tab closed inside the window losing a request the
   * toast already reported.
   *
   * OPTIONAL rather than required, and that is a compatibility decision rather than laziness:
   * every row a previous build wrote carries no `kind`, and a reader that demanded one would
   * DROP those rows — losing exactly the deletes this journal exists to save, through the
   * upgrade instead of through the crash. So absent reads as `delete`, which is what those
   * rows are.
   *
   * A row whose `kind` this build does not recognise is DROPPED rather than guessed at. That
   * is the opposite direction from the legacy shape and it is deliberate: an unknown verb names
   * an action this build cannot perform, and replaying it as a delete would delete mail on the
   * strength of a word we could not read.
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

function write(rows: DeleteIntent[]): void {
  try {
    if (rows.length === 0) window.localStorage.removeItem(deleteIntentsKey());
    else window.localStorage.setItem(deleteIntentsKey(), JSON.stringify(rows.slice(-DELETE_INTENTS_MAX)));
  } catch {
    // A refused jar means this request is only as durable as the tab. Never throw at the press.
  }
}

/**
 * Record the request.
 *
 * Replaces any intent with the same press id, and drops from EVERY OTHER press any message this
 * one names: a message may belong to at most one open press, or a replay would delete it twice
 * and the second would fail against a row that is already gone. A press left holding nothing
 * after that is removed with it.
 */
export function armDeleteIntent(intent: DeleteIntent): void {
  const claimed = new Set(intent.messageIds);
  const kept: DeleteIntent[] = [];
  for (const r of read()) {
    if (r.id === intent.id) continue;
    const ids = r.messageIds.filter((id) => !claimed.has(id));
    if (ids.length > 0) kept.push(ids.length === r.messageIds.length ? r : { ...r, messageIds: ids });
  }
  write([...kept, intent]);
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
