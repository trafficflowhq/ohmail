import { sql } from "drizzle-orm";
import { type Tx } from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import { hashToken } from "./auth/crypto.js";

/**
 * The ONE per-IP slot limiter, shared.
 *
 * This is `WaitlistService`'s `reserveJoinSlot`, lifted out of that file with its behaviour
 * unchanged and given a second caller: `AuthService.register`. It is deliberately NOT a
 * second limiter standing next to the waitlist's — opening registration called for
 * reusing the waitlist's mechanism rather than inventing another, and this is what reusing
 * it looks like once two call sites need it.
 *
 * ── WHY THIS SHAPE AND NOT `AuthService.throttleFailure` ─────────────────────────────
 *
 * Registration's limiter used to be the LOCKOUT counter (`throttleCheck` +
 * `throttleFailure` under `register:<ip>`), which is a different primitive wearing the
 * same table:
 *
 *  · it answers **423 `account_locked` "too many failed attempts"**, and every word of
 *    that is false on a registration endpoint. There is no account — creating one is the
 *    entire request — and nothing failed: the caller's twenty-first SUCCESSFUL signup
 *    trips it exactly as their twenty-first typo does. A refusal a person cannot act on
 *    is the same defect class as a refusal that never happens.
 *  · once tripped it stays tripped for `lockoutMs` regardless of the window, so the
 *    honest sentence ("you can sign up again shortly") could not be derived from the
 *    counter without reading a second column that means something else.
 *
 * A signup limit is a SLOT CLAIM: N per rolling window, refuse the N+1th, let the window
 * roll. That is what this is, and 429 `rate_limited` is what its callers answer with.
 *
 * ── THE STATEMENT IS THE POINT ───────────────────────────────────────────────────────
 *
 * ONE `INSERT … ON CONFLICT DO UPDATE … RETURNING`. Not SELECT-then-UPDATE: a
 * read-modify-write counter collapses concurrent attempts into a single increment, which
 * is precisely the traffic a limiter exists to catch, and it is the defect
 * `AuthService.throttleFailure` and `MailService`'s recipient limiter were both fixed for.
 * The row lock decides the race and every caller gets its own post-increment value back.
 *
 * ISO STRINGS inside the raw `sql` templates, never `Date`s — postgres-js serializes a raw
 * template parameter against the type Postgres describes for `$n` in `$n::timestamptz`,
 * which is TEXT, and hands a `Date` straight to `Buffer.byteLength`. See the long note at
 * `auth-service.ts:throttleFailure`: it is a 500 in production and green on PGlite.
 *
 * ── THE IP IS HASHED ─────────────────────────────────────────────────────────────────
 *
 * `${namespace}:${sha256(ip)}`, the shape the waitlist already used. A rate-limit table is
 * not a place to accumulate plaintext visitor addresses: the counter needs an identity, not
 * an address, and a hash is an identity. (Registration used to store the raw IP; that is
 * what this unifies away.)
 *
 * @param max how many claims succeed per window. The `max + 1`th returns `false`.
 * @returns `true` when a slot was claimed, `false` when this window is spent.
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
