import { sql } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import { hashToken } from "./auth/crypto.js";

/**
 * The ONE per-IP slot limiter, shared — the waitlist's `reserveJoinSlot`, lifted and given more
 * callers rather than a second limiter. Not the lockout counter: its 423 "too many failed
 * attempts" is false on a registration endpoint. A SLOT CLAIM: N per rolling window, 429 on the
 * N+1th, in ONE `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` (a read-modify-write
 * counter collapses concurrent attempts into one increment), compared BEFORE it counts: a claim
 * at the ceiling updates nothing, so a refused attempt never moves the counter and the row reads
 * at most `max`. ISO strings in the raw `sql` templates, never `Date`s. The IP is
 * HASHED: `${namespace}:${sha256(ip)}` — no plaintext addresses in a rate-limit table.
 */
export async function reserveIpSlot(
  tx: Tx,
  input: { namespace: string; ip: string; now: Date; max: number; windowMs: number },
): Promise<boolean> {
  const key = `${input.namespace}:${hashToken(input.ip)}`;
  const floorIso = new Date(input.now.getTime() - input.windowMs).toISOString();
  const nowIso = input.now.toISOString();
  const rolled = sql`${authThrottle.windowStartedAt} < ${floorIso}::timestamptz`;

  const [row] = await tx.insert(authThrottle)
    .values({ key, failures: 1, windowStartedAt: input.now, updatedAt: input.now })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: {
        failures: sql`case when ${rolled} then 1 else ${authThrottle.failures} + 1 end`,
        windowStartedAt: sql`case when ${rolled} then ${nowIso}::timestamptz else ${authThrottle.windowStartedAt} end`,
        updatedAt: input.now,
      },
      setWhere: sql`${rolled} or ${authThrottle.failures} < ${input.max}`,
    })
    .returning({ failures: authThrottle.failures });

  // No row: the ceiling declined the update, or the write did not happen. Both REFUSE — "we
  // could not count this attempt" admitting would leave the endpoint unbounded exactly when its
  // counter is broken.
  return (row?.failures ?? Number.MAX_SAFE_INTEGER) <= input.max;
}
