import { and, asc, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { accounts, readDrainCursor, writeDrainCursor, type ReleaseOutcome, type Tx } from "@trafficflow/db";
import { releaseAcceptedErasure, resumeAccountErasure, type ServiceContext, type ThrottleKeys } from "@trafficflow/services";
import type { Logger } from "@trafficflow/core/mail";

const ACCOUNTS_PER_TICK = 10;
const TICK_BUDGET_MS = 5_000;

export async function accountErasurePass(db: Tx, log: Logger, opts: {
  now: () => Date;
  forAccount: (id: string) => Tx;
  shard?: SQL | undefined;
  shardKey: string;
  release?: ((accountId: string) => Promise<ReleaseOutcome>) | undefined;
  throttleKeys?: ThrottleKeys | undefined;
  /** The runner's hook: a failed account is skipped for this tick, and the runner still hears of it. */
  noteFault?: ((err: unknown) => void) | undefined;
}): Promise<void> {
  const deadline = Date.now() + TICK_BUDGET_MS;
  const key = "account_erasure:" + opts.shardKey;
  const after = await readDrainCursor(db, key);
  const now = opts.now().toISOString();
  const progress = accounts.erasureProgress;
  const dataDue = sql<boolean>`${progress}->>'complete' = 'false'`;
  const billingDue = opts.release ? sql<boolean>`(${progress} is null or (
    ${progress}->>'billing' in ('pending', 'cancel_failed')
    and coalesce(${progress}->>'billingRetryAt', '') <= ${now}
    and coalesce(${progress}->>'billingLease', '') <= ${now}
  ))` : sql<boolean>`false`;
  const owed = await db.select({ id: accounts.id, at: accounts.erasedAt, dataDue, billingDue })
    .from(accounts).where(and(
      isNotNull(accounts.erasedAt), opts.shard, or(dataDue, billingDue),
      after === null ? undefined : sql`(${accounts.erasedAt}, ${accounts.id})
        > (${after.at.toISOString()}::timestamptz, ${after.messageId}::uuid)`,
    )).orderBy(asc(accounts.erasedAt), asc(accounts.id)).limit(ACCOUNTS_PER_TICK);
  for (const { id, at, dataDue, billingDue } of owed) {
    if (Date.now() >= deadline) return;
    const ctx: ServiceContext = {
      accountId: id, db: opts.forAccount(id) as unknown as ServiceContext["db"],
      userId: null, now: opts.now, requestId: "",
    };
    if (dataDue) {
      try {
        const receipt = await resumeAccountErasure(ctx, opts.throttleKeys ? { throttleKeys: opts.throttleKeys } : {});
        if (receipt) log.info("account_erasure_complete", { ...receipt });
      } catch (err) {
        opts.noteFault?.(err);
        log.error("account_erasure_slice_failed", { accountId: id, err });
      }
    }
    if (billingDue) {
      try {
        if (await releaseAcceptedErasure(ctx, opts.release) === "cancel_failed") {
          log.warn("account_erasure_billing_pending", { accountId: id });
        }
      } catch (err) {
        opts.noteFault?.(err);
        log.error("account_erasure_release_record_failed", { accountId: id, err });
      }
    }
    await writeDrainCursor(db, key, { at: at!, messageId: id }, opts.now());
  }
  if (owed.length < ACCOUNTS_PER_TICK && after !== null) await writeDrainCursor(db, key, null, opts.now());
}
