import { sql } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import { hashToken } from "./auth/crypto.js";

/**
 * The ONE per-IP slot limiter, shared — the waitlist's `reserveJoinSlot`, lifted unchanged and
 * given a second caller rather than a second limiter. Not the lockout counter: that answers 423
 * "too many failed attempts", false in every word on a registration endpoint — no account,
 * nothing failed. A signup limit is a SLOT CLAIM: N per rolling window, 429 on the N+1th. ONE
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` — a read-modify-write counter collapses concurrent
 * attempts into one increment. ISO strings in the raw `sql` templates, never `Date`s. The IP is
 * HASHED: `${namespace}:${sha256(ip)}` — a rate-limit table is not a place to accumulate
 * plaintext addresses.
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
    })
    .returning({ failures: authThrottle.failures });

  // A missing row can only mean the write did not happen, and "we could not count this
  // attempt" must REFUSE rather than admit — the other default leaves the endpoint
  // unbounded exactly when its counter is broken.
  return (row?.failures ?? Number.MAX_SAFE_INTEGER) <= input.max;
}
