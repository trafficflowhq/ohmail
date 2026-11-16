import { and, eq } from "drizzle-orm";
import { mailboxes, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  makeDrizzleRepo, OHBOX_UNSCREENED_AUDIT_ACTION, OHBOX_UNSCREENED_GROUPS_MAX,
  OHBOX_UNSCREENED_MESSAGES_MAX, UNSCREENED_CURSOR_MAX_CHARS, UNSCREENED_FIRST_CURSOR, agreeWindowCutoff, isUnscreenedPile, unscreenedCursorOf,
  unscreenedCursorText, unscreenedGroups, unscreenedSourceFolder,
  unscreenedWalk, writeScreenerIntents, type ScreeningAnswer, type UnscreenedCursor, type UnscreenedKnowledge,
  type UnscreenedPile, type UnscreenedScope, type UnscreenedSenderGroup,
} from "@trafficflow/core/adapters/drizzle-repo";
import { ServiceError } from "./errors.js";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";

/* OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — the doors a person presses. The set is
   named once in core (`unscreened-set.ts`): the Screener's offer counts and moves it here, and the
   organize decision counts the one mailbox and window here before the press, which the organizer
   then moves after it. Asked of a pile (News, Receipts) with no window, it is that pile's note.
   The number shown and the number moved come from the same walk.

   ONE REQUEST DOES BOUNDED WORK, AND THE READS NEVER TAKE THE POOL. Every door here hands the walk
   the same time budget; a read it stopped says where (`next`) and the client's next call goes on
   from there. And at most {@link READS_AT_ONCE} reads walk at a time in one process, whoever asks:
   a walk holds a pooled connection for each of its statements, and four of them held all four. */

export {
  OHBOX_UNSCREENED_AUDIT_ACTION, OHBOX_UNSCREENED_GROUPS_MAX, OHBOX_UNSCREENED_MESSAGES_MAX,
  UNSCREENED_CURSOR_MAX_CHARS, isUnscreenedPile,
};
export type { UnscreenedPile, UnscreenedSenderGroup };

/**
 * How long one read of the offer or of a pile's note may walk, read before each of the walk's
 * statements. A request answers in about this plus one statement and its wait for a connection:
 * well inside the hosted API's limit. What it did not reach, the next call reads.
 */
export const UNSCREENED_WALK_BUDGET_MS = 4_000;

/**
 * The same for the two doors nothing goes on from: the first-run count and the press. Inside the
 * limit too, and long enough that a slow store (a phone's) still counts and moves the whole set.
 */
export const UNSCREENED_ONE_CALL_BUDGET_MS = 20_000;

/** Reads of this set one process walks at a time: half the hosted instance's pooled connections. */
export const READS_AT_ONCE = 2;

const turns: { free: number; waiting: Array<() => void> } = { free: READS_AT_ONCE, waiting: [] };

/**
 * A TURN TO WALK, or false when `ms` ran out first. The wait holds no connection and no statement,
 * so a read that gives up leaves nothing behind. {@link endTurn} hands the turn on.
 */
function takeTurn(ms: number): Promise<boolean> {
  if (turns.free > 0) {
    turns.free--;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const mine = (): void => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      turns.waiting.splice(turns.waiting.indexOf(mine), 1);
      resolve(false);
    }, ms);
    turns.waiting.push(mine);
  });
}

function endTurn(): void {
  const next = turns.waiting.shift();
  if (next) next(); else turns.free++;
}

/** What a read brings beside its scope: where to go on, and the budget's own dials. */
export interface UnscreenedRead {
  /** The `next` an earlier answer carried: this read goes on from there. */
  after?: string;
  /** {@link UNSCREENED_WALK_BUDGET_MS} unless a caller says otherwise. */
  budgetMs?: number;
  /** The clock the budget is read on. */
  clock?: () => number;
}

/** A budget as the walk takes it, less what the wait for a turn used. */
function walkBudget(ms: number, waitedFrom: number, clock?: () => number): { budgetMs: number; clock?: () => number } {
  const left = ms - ((clock ?? Date.now)() - waitedFrom);
  return { budgetMs: Math.max(0, left), ...(clock ? { clock } : {}) };
}

/** The screen: the groups and how many messages they hold. */
export interface UnscreenedSummary {
  groups: UnscreenedSenderGroup[];
  total: number;
  /** False when the walk or the group list stopped at its bound: `total` is then a floor. */
  complete: boolean;
  /**
   * Where the next call goes on ({@link UnscreenedRead.after}): present only when this one's budget
   * or page bound stopped it with senders unread. A full offer carries none.
   */
  next?: string;
}

/** What a press did. A second press over the same set is empty — the moved rows leave the set. */
export interface UnscreenedResult {
  screened: UnscreenedSenderGroup[];
  total: number;
}

/** The repo the walk reads the gate's knowledge through, bound to the caller's transaction. */
const knowledgeOf = (t: Tx): UnscreenedKnowledge =>
  makeDrizzleRepo(t as unknown as Parameters<typeof makeDrizzleRepo>[0]);

/** The offer's scope inside the account's window, or a pile's with none; `from` is where it goes on. */
async function scopeFor(
  db: Tx, accountId: string, now: Date, pile: UnscreenedPile | undefined, from: UnscreenedCursor | null = null,
): Promise<UnscreenedScope> {
  if (pile !== undefined) return { kind: "pile", pile, from };
  return { kind: "offer", cutoff: await agreeWindowCutoff(db, accountId, now), from };
}

/**
 * The whole offer in one read, inside the account's window — or, given a pile, the letters in News
 * or Receipts from senders nobody let in, at any age. `total` is the SHOWN groups' messages and
 * nothing else — every message has one sender, so a list cut at the bound must not report mail
 * behind the cut.
 */
export async function unscreenedSummary(
  db: Tx, accountId: string, now: Date, pile?: UnscreenedPile, turn?: () => Promise<void>, read: UnscreenedRead = {},
): Promise<UnscreenedSummary> {
  const from = read.after === undefined ? null : unscreenedCursorOf(read.after);
  if (read.after !== undefined && from === null) {
    throw new ServiceError("validation_failed", 400, "after must be the next of an earlier answer");
  }
  const budget = read.budgetMs ?? UNSCREENED_WALK_BUDGET_MS;
  const asked = (read.clock ?? Date.now)();
  // No turn inside the budget: nothing was read, and the same place is where the next call goes on.
  if (!await takeTurn(budget)) {
    return { groups: [], total: 0, complete: false, next: unscreenedCursorText(from ?? UNSCREENED_FIRST_CURSOR) };
  }
  try {
    const walk = await unscreenedWalk(db, knowledgeOf(db), accountId, {
      lock: false, stopAt: OHBOX_UNSCREENED_MESSAGES_MAX, scope: await scopeFor(db, accountId, now, pile, from),
      ...(turn ? { turn } : {}), ...walkBudget(budget, asked, read.clock),
    });
    const groups = unscreenedGroups(walk.rows);
    // Either bound makes `total` a floor: the walk's message bound or the shown groups' sender bound.
    const shown = walk.senders <= OHBOX_UNSCREENED_GROUPS_MAX;
    return {
      groups, total: groups.reduce((n, g) => n + g.count, 0), complete: walk.complete && shown,
      // A part that had to leave groups out is a full offer: going on would pass them by unshown.
      ...(walk.next === null || !shown ? {} : { next: unscreenedCursorText(walk.next) }),
    };
  } finally {
    endTurn();
  }
}

/**
 * THE OFFER'S PRESS. Moves the named sender groups — or every group shown — to the Screener as
 * intents; the organizer's reconciler performs the move. Idempotent by the predicate. Given a
 * pile, it screens that pile's letters from senders nobody let in.
 */
export async function screenUnscreened(
  ctx: ServiceContext, opts: { addresses?: readonly string[]; pile?: unknown } = {},
): Promise<UnscreenedResult> {
  if (opts.pile !== undefined && !isUnscreenedPile(opts.pile)) {
    throw new ServiceError("validation_failed", 400, "pile must be news or receipts");
  }
  const pile = opts.pile;
  const wanted = opts.addresses;
  if (wanted !== undefined) {
    if (!Array.isArray(wanted)) {
      throw new ServiceError("validation_failed", 400, "addresses must be an array");
    }
    if (wanted.length > OHBOX_UNSCREENED_GROUPS_MAX) {
      throw new ServiceError("validation_failed", 400, "too many sender groups in one press");
    }
    if (wanted.some((a) => typeof a !== "string" || a === "" || a.length > 320)) {
      throw new ServiceError("validation_failed", 400, "addresses must be sender addresses");
    }
  }
  const named = wanted === undefined ? null : new Set(wanted.map((a) => a.toLowerCase()));

  // Through the fence: a request valid when it started must not commit rows after an erasure.
  return withAccountTx(ctx, async (t) => {
    const tx = bridgeTx(t);
    const now = ctx.now();
    const scope = await scopeFor(tx, ctx.accountId, now, pile);
    // A person's press is not queued behind the reads; out of time it moves what it reached.
    const walk = await unscreenedWalk(tx, knowledgeOf(tx), ctx.accountId, {
      lock: true, stopAt: OHBOX_UNSCREENED_MESSAGES_MAX, scope, budgetMs: UNSCREENED_ONE_CALL_BUDGET_MS,
      ...(ctx.loopTurn ? { turn: ctx.loopTurn } : {}),
    });
    const rows = walk.rows.filter((r) => named === null || named.has(r.fromAddress.toLowerCase()));
    if (rows.length === 0) return { screened: [], total: 0 };
    return writeScreenerIntents(tx, t as unknown as LedgerTx, {
      accountId: ctx.accountId, rows, now, via: pile === undefined ? "offer" : "pile", groups: "shown",
      from: unscreenedSourceFolder(scope),
      ...(ctx.loopTurn ? { turn: ctx.loopTurn } : {}),
    });
  });
}

/** What agreeing will move, read before the press: the same walk the organizer's slices run after it. */
export interface OrganizeDecisionCount {
  /** Letters the agree moves: the whole set, a floor when `complete` is false. */
  letters: number;
  /** Distinct senders among them. */
  senders: number;
  /** The same as `letters`, kept on the wire for older clients. */
  total: number;
  /** False when the walk's page bound stopped it, so `total` is a floor. */
  complete: boolean;
  /** One slice's move bound, read rather than carried as a client constant. */
  max: number;
  /** False while the mailbox's first import is still reading it: the count is what the store holds so far. */
  mirrored: boolean;
}

/**
 * THE COUNT THE ORGANIZE DECISION NAMES — this mailbox, the window the answer would store, the
 * person's own filing left out. A read: no lock, no write, no mailbox opened. A mailbox that is
 * not the caller's, or is removed, is a 404 — the same answer `GET /mailboxes/:id` gives.
 */
export async function organizeDecisionCount(
  ctx: ServiceContext, mailboxId: string, answer: ScreeningAnswer,
): Promise<OrganizeDecisionCount> {
  const days = answer.dormancyDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
    throw new ServiceError("validation_failed", 400, "dormancyDays must be an integer between 1 and 365");
  }
  if (answer.scope !== undefined && answer.scope !== "window" && answer.scope !== "all_time") {
    throw new ServiceError("validation_failed", 400, "screeningScope must be window or all_time");
  }
  const db = bridgeTx(ctx.db);
  const [mb] = await db.select({ status: mailboxes.status, importedAt: mailboxes.initialImportCompletedAt }).from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId))).limit(1);
  if (!mb || mb.status === "disabled") throw new ServiceError("not_found", 404, "mailbox not found");
  const cutoff = await agreeWindowCutoff(db, ctx.accountId, ctx.now(), answer);
  const asked = Date.now();
  const counted = (letters: number, senders: number, complete: boolean): OrganizeDecisionCount => ({
    letters, senders, total: letters, complete, max: OHBOX_UNSCREENED_MESSAGES_MAX, mirrored: mb.importedAt !== null,
  });
  // No turn inside the budget: nothing counted yet, which is a floor of none.
  if (!await takeTurn(UNSCREENED_ONE_CALL_BUDGET_MS)) return counted(0, 0, false);
  try {
    const walk = await unscreenedWalk(db, knowledgeOf(db), ctx.accountId, {
      lock: false, scope: { kind: "agree", mailboxId, cutoff }, ...(ctx.loopTurn ? { turn: ctx.loopTurn } : {}),
      ...walkBudget(UNSCREENED_ONE_CALL_BUDGET_MS, asked),
    });
    return counted(walk.matched, walk.senders, walk.complete);
  } finally {
    endTurn();
  }
}
