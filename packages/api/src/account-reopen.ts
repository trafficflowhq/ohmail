import { and, desc, eq, gt, max, or } from "drizzle-orm";
import { withAccountTx } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { mailboxes, parkedResumeSet, parkedResumeWhere } from "@trafficflow/db";
// Hosted-only: imported by `routes/account.ts` alone, which the local door never mounts.
import { accountLifecycleNotices } from "@trafficflow/db/cloud";
import type { ApiDeps } from "./deps.js";

/**
 * THE REOPENING BANNER'S ONE FACT (cloud 0040) — an idempotent INSERT on a GET, deliberate and
 * named here so nobody "fixes" it. The anchor is the PARK (mail 0135), else the newest
 * `account_closed` block (a reader-only account parks nothing), else the newest `closed` notice.
 * The route asks this BEFORE `resumeAfterReopen` clears the block. ONCE PER CLOSURE: a `reopened`
 * notice sent after the anchor answers it. NO COUNT: any number here is the free month's mail.
 * Bound: the worker's belt can clear the block before any client reads, and then a reader-only
 * account reopened inside one night has no anchor and no banner. Best-effort by contract.
 */
export async function reopenedCatchUp(
  deps: ApiDeps, ctx: ServiceContext,
): Promise<{ since: string } | null> {
  const accountId = ctx.accountId;
  try {
    const [parked] = await deps.db.select({ at: max(mailboxes.organizerParkedAt) })
      .from(mailboxes).where(eq(mailboxes.accountId, accountId));
    const [blocked] = await deps.db.select({ at: max(mailboxes.syncBlockedSince) })
      .from(mailboxes).where(and(
        eq(mailboxes.accountId, accountId),
        eq(mailboxes.syncBlockedReason, "account_closed"),
      ));
    const [closed] = await deps.db.select({ anchor: accountLifecycleNotices.anchor })
      .from(accountLifecycleNotices)
      .where(and(
        eq(accountLifecycleNotices.accountId, accountId),
        eq(accountLifecycleNotices.kind, "closed"),
      ))
      .orderBy(desc(accountLifecycleNotices.anchor))
      .limit(1);
    const anchor = parked?.at ?? blocked?.at ?? closed?.anchor ?? null;
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
    // FENCED, like every session-holding writer of an account-owned row: a GET racing the
    // caller's own erasure must not plant a notice after the Art. 17 sweep commits.
    const inserted = await withAccountTx(ctx, async (tx) =>
      tx.insert(accountLifecycleNotices)
        .values({ accountId, kind: "reopened", anchor })
        .onConflictDoNothing()
        .returning());
    return inserted.length === 0 ? null : { since: anchor.toISOString() };
  } catch {
    // A missing table (an API ahead of cloud 0040), a fenced refusal or any read fault costs
    // the banner, never the wall's read.
    return null;
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
