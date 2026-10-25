import { and, eq } from "drizzle-orm";
import { mailboxes, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  makeDrizzleRepo, OHBOX_UNSCREENED_AUDIT_ACTION, OHBOX_UNSCREENED_GROUPS_MAX,
  OHBOX_UNSCREENED_MESSAGES_MAX, agreeWindowCutoff, unscreenedGroups, unscreenedWalk,
  writeScreenerIntents, type ScreeningAnswer, type UnscreenedKnowledge, type UnscreenedSenderGroup,
} from "@trafficflow/core/adapters/drizzle-repo";
import { ServiceError } from "./errors.js";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";

/* OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — the two doors a person presses. The set is
   named once in core (`unscreened-set.ts`): the Screener's offer counts and moves it here, and the
   organize decision counts the one mailbox and window here before the press, which the organizer
   then moves after it. The number shown and the number moved come from the same walk. */

export { OHBOX_UNSCREENED_AUDIT_ACTION, OHBOX_UNSCREENED_GROUPS_MAX, OHBOX_UNSCREENED_MESSAGES_MAX };
export type { UnscreenedSenderGroup };

/** The screen: the groups and how many messages they hold. */
export interface UnscreenedSummary {
  groups: UnscreenedSenderGroup[];
  total: number;
}

/** What a press did. A second press over the same set is empty — the moved rows leave the set. */
export interface UnscreenedResult {
  screened: UnscreenedSenderGroup[];
  total: number;
}

/** The repo the walk reads the gate's knowledge through, bound to the caller's transaction. */
const knowledgeOf = (t: Tx): UnscreenedKnowledge =>
  makeDrizzleRepo(t as unknown as Parameters<typeof makeDrizzleRepo>[0]);

/**
 * The whole offer in one read, inside the account's window. `total` is the SHOWN groups' messages
 * and nothing else — every message has one sender, so a list cut at the bound must not report mail
 * behind the cut.
 */
export async function unscreenedSummary(
  db: Tx, accountId: string, now: Date,
): Promise<UnscreenedSummary> {
  const cutoff = await agreeWindowCutoff(db, accountId, now);
  const walk = await unscreenedWalk(db, knowledgeOf(db), accountId, {
    lock: false, stopAt: OHBOX_UNSCREENED_MESSAGES_MAX, scope: { kind: "offer", cutoff },
  });
  const groups = unscreenedGroups(walk.rows);
  return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
}

/**
 * THE OFFER'S PRESS. Moves the named sender groups — or every group shown — to the Screener as
 * intents; the organizer's reconciler performs the move. Idempotent by the predicate.
 */
export async function screenUnscreened(
  ctx: ServiceContext, opts: { addresses?: readonly string[] } = {},
): Promise<UnscreenedResult> {
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
    const cutoff = await agreeWindowCutoff(tx, ctx.accountId, now);
    const walk = await unscreenedWalk(tx, knowledgeOf(tx), ctx.accountId, {
      lock: true, stopAt: OHBOX_UNSCREENED_MESSAGES_MAX, scope: { kind: "offer", cutoff },
    });
    const rows = walk.rows.filter((r) => named === null || named.has(r.fromAddress.toLowerCase()));
    if (rows.length === 0) return { screened: [], total: 0 };
    return writeScreenerIntents(tx, t as unknown as LedgerTx, {
      accountId: ctx.accountId, rows, now, via: "offer", groups: "shown",
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
  const walk = await unscreenedWalk(db, knowledgeOf(db), ctx.accountId, {
    lock: false, scope: { kind: "agree", mailboxId, cutoff },
  });
  return {
    letters: walk.matched, senders: walk.senders, total: walk.matched, complete: walk.complete,
    max: OHBOX_UNSCREENED_MESSAGES_MAX, mirrored: mb.importedAt !== null,
  };
}
