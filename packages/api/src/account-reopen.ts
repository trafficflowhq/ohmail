import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { withAccountTx } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { mailboxes, parkedResumeSet, parkedResumeWhere, type Tx } from "@trafficflow/db";
// Hosted-only: imported by `routes/account.ts` alone, which the local door never mounts.
import {
  accountLifecycleNotices, reopenAnchorOf, untoldCatchUpOf, untoldCatchUpWhere,
} from "@trafficflow/db/cloud";
import type { ApiDeps } from "./deps.js";

/**
 * THE REOPENING BANNER'S ONE FACT (cloud 0040): a write on a GET, deliberate. The anchor is the
 * newest row the worker PLANTED untold before its roster pass cleared the facts (first, so a read
 * landing mid-pass tells the worker's row rather than minting another), else the park or the newest
 * `account_closed` block the rows still state, else the newest `closed` notice. ONE statement tells it,
 * once. A `reopened` row sent after the anchor answers it too; that assumes a told row's database clock
 * passed every anchor of its closure, which only a skew longer than the closure breaks. NO COUNT.
 * `"fault"` is a read or write that failed, a refused fence included: the caller holds the resume back.
 */
export async function reopenedCatchUp(
  deps: ApiDeps, ctx: ServiceContext,
): Promise<{ since: string } | null | "fault"> {
  const accountId = ctx.accountId;
  const db = deps.db as unknown as Tx;
  try {
    let anchor = await untoldCatchUpOf(db, accountId) ?? await reopenAnchorOf(db, accountId);
    if (anchor === null) {
      const [closed] = await deps.db.select({ anchor: accountLifecycleNotices.anchor })
        .from(accountLifecycleNotices)
        .where(and(
          eq(accountLifecycleNotices.accountId, accountId),
          eq(accountLifecycleNotices.kind, "closed"),
        ))
        .orderBy(desc(accountLifecycleNotices.anchor))
        .limit(1);
      anchor = closed?.anchor ?? null;
    }
    if (anchor === null) return null;
    const [answered] = await deps.db.select({ anchor: accountLifecycleNotices.anchor })
      .from(accountLifecycleNotices)
      .where(and(
        eq(accountLifecycleNotices.accountId, accountId),
        eq(accountLifecycleNotices.kind, "reopened"),
        gt(accountLifecycleNotices.sentAt, anchor),
      ))
      .limit(1);
    if (answered) return null;
    const since = anchor;
    // FENCED, like every session-holding writer of an account-owned row: a GET racing the caller's
    // own erasure must not plant a notice after the Art. 17 sweep commits. RETURNING says whether
    // THIS read told it: a fresh row, or the planted one made told.
    const told = await withAccountTx(ctx, async (tx) =>
      tx.insert(accountLifecycleNotices)
        .values({ accountId, kind: "reopened", anchor: since })
        .onConflictDoUpdate({
          target: [accountLifecycleNotices.accountId, accountLifecycleNotices.kind, accountLifecycleNotices.anchor],
          set: { sentAt: sql`now()` },
          setWhere: untoldCatchUpWhere(),
        })
        .returning({ anchor: accountLifecycleNotices.anchor }));
    return told.length === 0 ? null : { since: since.toISOString() };
  } catch {
    // A missing table (an API ahead of cloud 0040), a fenced refusal or any read fault: no banner,
    // and never the wall's read.
    return "fault";
  }
}

/**
 * THE REOPENING DOOR'S TWO WRITES (mail 0135), one fenced transaction on every OPEN read. The
 * `account_closed` block is the worker's report and this answer invalidates it; a mailbox the wall
 * released is asked back as a `join` through the one resume statement. Both stamp
 * `sync_requested_at`, so the worker's kick serves them within seconds. The door cannot tell a
 * transition, so it asks every time; one indexed read skips the transaction when nothing is owed.
 */
export async function resumeAfterReopen(deps: ApiDeps, ctx: ServiceContext): Promise<void> {
  const accountId = ctx.accountId;
  try {
    const [owed] = await deps.db.select({ id: mailboxes.id }).from(mailboxes)
      .where(and(eq(mailboxes.accountId, accountId), or(
        eq(mailboxes.syncBlockedReason, "account_closed"),
        parkedResumeWhere(),
      )))
      .limit(1);
    if (!owed) return;
    const now = ctx.now();
    await withAccountTx(ctx, async (tx) => {
      await tx.update(mailboxes)
        .set({ syncBlockedReason: null, syncBlockedSince: null, syncRequestedAt: now })
        .where(and(eq(mailboxes.accountId, accountId), eq(mailboxes.syncBlockedReason, "account_closed")));
      await tx.update(mailboxes)
        .set(parkedResumeSet(now))
        .where(and(eq(mailboxes.accountId, accountId), parkedResumeWhere()));
    });
  } catch {
    // The worker's roster pass is the belt: it clears the block and writes the same resume.
  }
}
