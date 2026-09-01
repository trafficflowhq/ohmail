/**
 * THE MAILBOX OAuth CEREMONY STORE (cloud 0009) — mint, consume ONCE, prune.
 *
 * Three statements, beside the table they run against, for the reason `suspension.ts` gives about
 * itself: the single-use consumption is the security property of the whole redirect flow, and a
 * property expressed as "every caller remembers to write the predicate" is not a property. There is
 * one writer of `consumed_at` and it is {@link consumeOAuthCeremony}.
 *
 * ── THE CONSUME IS ONE UPDATE, AND THAT IS THE ENTIRE REPLAY DEFENCE ──────────────────────
 *
 *     UPDATE mailbox_oauth_ceremonies
 *        SET consumed_at = now
 *      WHERE state = $1 AND consumed_at IS NULL
 *   RETURNING …
 *
 * Not `SELECT … then UPDATE`. Two browsers replaying one authorization code — a double-clicked
 * consent, a prefetching client, an attacker resubmitting a captured redirect — arrive as two
 * UPDATEs on ONE ROW. Postgres serializes them on the row lock: the first sets `consumed_at` and
 * returns the row, the second re-evaluates `consumed_at IS NULL` against the committed value, finds
 * it false, and returns ZERO rows. There is no window between the read and the write for the second
 * one to occupy, which is exactly what a read-then-write version would create.
 *
 * **PGlite cannot see this.** A single-connection in-process engine has nothing to interleave, so
 * the read-then-write version passes there identically. The guard is
 * `test/oauth-ceremony.pg.test.ts` against real Postgres on :5433, which fires N
 * concurrent consumes of one state and asserts exactly one winner.
 *
 * ── THE TTL IS CHECKED AFTER THE CONSUME, NOT INSIDE IT ───────────────────────────────────
 *
 * `AND created_at > $now - $ttl` in the UPDATE would be tidier and it is wrong for this flow: an
 * expired row would return zero rows, which is the SAME answer as a replayed state and as a state
 * that never existed. Those need different sentences — "that took too long, start again" is
 * actionable, "that link is not valid" is not — so the age is judged on the RETURNED row.
 *
 * The row is still consumed on the expired path, deliberately: an aged-out state is dead for good
 * rather than dead until the clock is nudged.
 *
 * A state that matched no row and a state that was already spent are the SAME answer
 * (`"unknown"`), and that is also deliberate: distinguishing them would turn the callback into an
 * oracle for whether a given 256-bit value was ever issued.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { mailboxOauthCeremonies, mailboxOauthDeviceCeremonies } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * HOW LONG A CONSENT MAY TAKE. Ten minutes.
 *
 * It bounds the window in which a captured redirect is worth anything, and it is generous enough
 * for the real ceremony: a person who has to sign in to Microsoft, approve a scope list and
 * possibly complete their own MFA. Microsoft's authorization codes are themselves short-lived
 * (minutes), so a longer TTL here would only keep rows alive past the point where the code they
 * pair with could still be redeemed.
 */
export const OAUTH_CEREMONY_TTL_MS = 10 * 60_000;

/**
 * How long a ceremony row is KEPT. One hour — six TTLs.
 *
 * Long enough that the row is still there to explain a support question ("I clicked it and nothing
 * happened"), short enough that the table is bounded by the last hour of traffic rather than by all
 * of history. The prune is opportunistic (see {@link pruneOAuthCeremonies}).
 */
export const OAUTH_CEREMONY_RETENTION_MS = 60 * 60_000;

export interface OAuthCeremonyRow {
  state: string;
  accountId: string;
  provider: string;
  codeVerifierEnc: string;
  codeVerifierKeyVersion: number;
  returnTo: string | null;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface CreateOAuthCeremonyInput {
  /** 256-bit random, base64url. Minted by the caller — this module does not own the RNG. */
  state: string;
  accountId: string;
  provider: string;
  codeVerifierEnc: string;
  codeVerifierKeyVersion: number;
  returnTo?: string | null;
  now: Date;
}

/** Record a ceremony in flight. The `state` PK makes a collision a 23505 rather than an overwrite. */
export async function createOAuthCeremony(tx: Tx, input: CreateOAuthCeremonyInput): Promise<void> {
  await tx.insert(mailboxOauthCeremonies).values({
    state: input.state,
    accountId: input.accountId,
    provider: input.provider,
    codeVerifierEnc: input.codeVerifierEnc,
    codeVerifierKeyVersion: input.codeVerifierKeyVersion,
    returnTo: input.returnTo ?? null,
    createdAt: input.now,
  });
}

/**
 * The three answers.
 *
 * `"ok"` carries the row. `"expired"` carries it too — the caller needs `returnTo` to send the
 * browser somewhere with a sentence on it. `"unknown"` carries nothing, because there is nothing:
 * a state that never existed and one already spent are the same answer by design.
 */
export type ConsumeOAuthCeremonyOutcome =
  | { outcome: "ok"; row: OAuthCeremonyRow }
  | { outcome: "expired"; row: OAuthCeremonyRow }
  | { outcome: "unknown" };

export interface ConsumeOAuthCeremonyInput {
  state: string;
  now: Date;
  ttlMs?: number;
}

/** Spend a ceremony exactly once. See the module header — this is the whole replay defence. */
export async function consumeOAuthCeremony(
  tx: Tx, input: ConsumeOAuthCeremonyInput,
): Promise<ConsumeOAuthCeremonyOutcome> {
  // An empty `state` must never be a predicate that could match a row. It cannot today (the column
  // is NOT NULL and every writer supplies 43 base64url characters), and the check is here because a
  // falsy value reaching a `WHERE state = ''` is one typo away from being the callback's happy path.
  if (!input.state) return { outcome: "unknown" };
  const [row] = await tx.update(mailboxOauthCeremonies)
    .set({ consumedAt: input.now })
    .where(and(
      eq(mailboxOauthCeremonies.state, input.state),
      isNull(mailboxOauthCeremonies.consumedAt),
    ))
    .returning();
  if (!row) return { outcome: "unknown" };
  const out: OAuthCeremonyRow = {
    state: row.state,
    accountId: row.accountId,
    provider: row.provider,
    codeVerifierEnc: row.codeVerifierEnc,
    codeVerifierKeyVersion: row.codeVerifierKeyVersion,
    returnTo: row.returnTo,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  };
  const ttl = input.ttlMs ?? OAUTH_CEREMONY_TTL_MS;
  if (input.now.getTime() - out.createdAt.getTime() > ttl) return { outcome: "expired", row: out };
  return { outcome: "ok", row: out };
}

/**
 * Drop ceremonies older than the retention window.
 *
 * OPPORTUNISTIC, called by the START handler rather than by a cron, and that is a deliberate
 * refusal to add a scheduled surface for a table whose whole content is the last hour of consent
 * clicks. It costs one indexed DELETE on the path that is already writing a row, it is keyed by the
 * `mailbox_oauth_ceremonies_created_idx` the migration creates, and a deployment that never runs a
 * ceremony has nothing to prune. A failure is the caller's to swallow: a table that grew by one row
 * is not a reason to refuse somebody's connect.
 */
export async function pruneOAuthCeremonies(
  tx: Tx, opts: { now: Date; retentionMs?: number },
): Promise<void> {
  const cutoff = new Date(opts.now.getTime() - (opts.retentionMs ?? OAUTH_CEREMONY_RETENTION_MS));
  await tx.delete(mailboxOauthCeremonies).where(lt(mailboxOauthCeremonies.createdAt, cutoff));
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE DEVICE-CODE CEREMONY (cloud 0027) — mint, READ WITHOUT CONSUMING, lease a poll, claim ONCE.
 *
 * ── THE ONE PROPERTY THAT IS DIFFERENT, STATED BEFORE ANYTHING ELSE ────────────────────────
 *
 * Everything above this line is built on the rule that a ceremony is spent by the request that
 * reads it. THIS FLOW CANNOT WORK THAT WAY. A person is being asked to walk to a browser, type a
 * short code and approve a sign-in; the ceremony is polled every few seconds for up to fifteen
 * minutes, and every one of those polls must find the row still live. A consuming read here would
 * make the FIRST poll destroy the grant, and the failure would present as "that code is no longer
 * valid" to somebody who typed it correctly seconds earlier.
 *
 * So the arms are separated and neither one can do the other's job:
 *
 *   · {@link readDeviceCeremony}      SELECT. Writes NOTHING. Called on every poll.
 *   · {@link leaseDeviceCeremonyPoll} Writes `last_polled_at` ONLY. Never `consumed_at`.
 *   · {@link claimDeviceCeremony}     The consume-once UPDATE. Called on a TERMINAL verdict only.
 *
 * The redirect flow's arm above is untouched by all of this: it has no non-consuming read, and
 * {@link consumeOAuthCeremony} remains the only writer of `mailbox_oauth_ceremonies.consumed_at`.
 * The two tables are separate precisely so that "may this be read without being spent" has one
 * answer per flow rather than a parameter, because a parameter defaulted the wrong way — or passed
 * by a caller who copied the neighbouring call site — reintroduces the whole failure.
 *
 * The three terminal verdicts are GRANTED, DECLINED and EXPIRED. Each one claims. A pending poll
 * and a `slow_down` claim nothing, which is the entire point.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How long a device ceremony row is KEPT. One hour, matching the redirect ceremony's retention for
 * the same reason: long enough to explain a support question, short enough that the table is bounded
 * by the last hour of connect attempts rather than by all of history.
 *
 * There is deliberately no TTL constant beside it. The redirect ceremony needs one because nothing
 * in its row says when the authorization code dies; a device ceremony carries Microsoft's own
 * `expires_in` as `grant_expires_at`, so its deadline is a stored fact rather than a policy this
 * module gets to choose. Inventing a second, shorter TTL here would cut a person's approval window
 * short for no reason a reader could find.
 */
export const DEVICE_CEREMONY_RETENTION_MS = 60 * 60_000;

/** The device ceremony as stored. `deviceCodeEnc` is an envelope and NEVER leaves the server. */
export interface DeviceCeremonyRow {
  state: string;
  accountId: string;
  provider: string;
  deviceCodeEnc: string;
  deviceCodeKeyVersion: number;
  userCode: string;
  verificationUri: string;
  pollIntervalMs: number;
  grantExpiresAt: Date;
  lastPolledAt: Date | null;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface CreateDeviceCeremonyInput {
  /** 256-bit random, base64url. Minted by the caller — this module does not own the RNG. */
  state: string;
  accountId: string;
  provider: string;
  /** The KEK envelope of the `device_code`, sealed by the caller's own key provider. */
  deviceCodeEnc: string;
  deviceCodeKeyVersion: number;
  userCode: string;
  verificationUri: string;
  pollIntervalMs: number;
  grantExpiresAt: Date;
  now: Date;
}

/** Record a device ceremony in flight. The `state` PK makes a collision a 23505 rather than an overwrite. */
export async function createDeviceCeremony(tx: Tx, input: CreateDeviceCeremonyInput): Promise<void> {
  await tx.insert(mailboxOauthDeviceCeremonies).values({
    state: input.state,
    accountId: input.accountId,
    provider: input.provider,
    deviceCodeEnc: input.deviceCodeEnc,
    deviceCodeKeyVersion: input.deviceCodeKeyVersion,
    userCode: input.userCode,
    verificationUri: input.verificationUri,
    pollIntervalMs: input.pollIntervalMs,
    grantExpiresAt: input.grantExpiresAt,
    createdAt: input.now,
  });
}

const toDeviceRow = (row: typeof mailboxOauthDeviceCeremonies.$inferSelect): DeviceCeremonyRow => ({
  state: row.state,
  accountId: row.accountId,
  provider: row.provider,
  deviceCodeEnc: row.deviceCodeEnc,
  deviceCodeKeyVersion: row.deviceCodeKeyVersion,
  userCode: row.userCode,
  verificationUri: row.verificationUri,
  pollIntervalMs: row.pollIntervalMs,
  grantExpiresAt: row.grantExpiresAt,
  lastPolledAt: row.lastPolledAt,
  createdAt: row.createdAt,
  consumedAt: row.consumedAt,
});

/**
 * The three answers a non-consuming read gives.
 *
 * `"expired"` carries the row because the caller has to CLAIM it — expiry is a terminal verdict, and
 * a terminal verdict spends the ceremony so an aged-out state is dead for good rather than dead
 * until a clock is nudged. `"unknown"` carries nothing: a state that never existed and one already
 * claimed are the SAME answer, for the redirect flow's reason verbatim — telling them apart is an
 * oracle for whether a given 256-bit value was ever issued.
 */
export type ReadDeviceCeremonyOutcome =
  | { outcome: "ok"; row: DeviceCeremonyRow }
  | { outcome: "expired"; row: DeviceCeremonyRow }
  | { outcome: "unknown" };

/**
 * READ A DEVICE CEREMONY WITHOUT SPENDING IT. This is the arm the whole flow turns on.
 *
 * A plain SELECT, and the absence of a write is the property — not an optimisation. It is called on
 * every poll for as long as the grant lives, and the day it starts writing `consumed_at` is the day
 * the first poll kills the ceremony. The device-ceremony suite, which runs against a real
 * Postgres rather than an in-process stand-in, pins that in both directions: N sequential reads all succeed and leave `consumed_at` NULL, and the redirect
 * flow's own consume-once concurrency guard still holds beside it.
 *
 * An already-claimed row reads as `"unknown"`, not as `"consumed"`: once a ceremony has reached a
 * terminal verdict there is nothing further any caller may do with it, and a distinct answer would
 * only tell a stranger that this particular value had once been real.
 */
export async function readDeviceCeremony(
  tx: Tx, input: { state: string; now: Date },
): Promise<ReadDeviceCeremonyOutcome> {
  // An empty state must never be a predicate that could match a row — the same defence
  // `consumeOAuthCeremony` states, and for the same reason: a falsy value reaching a
  // `WHERE state = ''` is one typo away from being a poll route's happy path.
  if (!input.state) return { outcome: "unknown" };
  const [row] = await tx.select().from(mailboxOauthDeviceCeremonies)
    .where(and(
      eq(mailboxOauthDeviceCeremonies.state, input.state),
      isNull(mailboxOauthDeviceCeremonies.consumedAt),
    ))
    .limit(1);
  if (!row) return { outcome: "unknown" };
  const out = toDeviceRow(row);
  // The deadline is Microsoft's own `expires_in`, stored absolute at mint time. Judged on the
  // returned row rather than in the predicate, so "that took too long" stays a different answer
  // from "that is not a ceremony" — only one of the two is actionable.
  if (input.now.getTime() >= out.grantExpiresAt.getTime()) return { outcome: "expired", row: out };
  return { outcome: "ok", row: out };
}

/**
 * TAKE THE POLL SLOT, OR BE DENIED — one UPDATE, and the fence that protects a SHARED client id.
 *
 * ── WHY THE FENCE IS SERVER-SIDE AND ATOMIC ────────────────────────────────────────────────
 *
 * The interval belongs to Microsoft (RFC 8628 §3.5 — and `slow_down` increases it cumulatively),
 * and the client id being throttled is shared by every install using the public registration. So
 * "poll no faster than the interval" cannot be a client-side courtesy: a client that ignored it, or
 * two browser tabs on the same ceremony, would degrade the flow for every other operator using that
 * registration, and the throttle would arrive as an unexplained failure somewhere else entirely.
 *
 * `last_polled_at <= now - poll_interval_ms` is therefore IN THE PREDICATE. Two concurrent polls
 * arrive as two UPDATEs on one row; Postgres serializes them, the second re-evaluates the predicate
 * against the committed `last_polled_at` and matches nothing. A read-then-write version of this
 * check has a window exactly the width of a round trip to Microsoft, which is precisely the window
 * two tabs would occupy.
 *
 * It sets `last_polled_at` and NOTHING ELSE. It cannot claim a ceremony: `consumed_at` is not in its
 * `SET`, and the only function that writes that column is {@link claimDeviceCeremony}.
 */
export async function leaseDeviceCeremonyPoll(
  tx: Tx, input: { state: string; now: Date },
): Promise<{ outcome: "ok" | "denied" }> {
  if (!input.state) return { outcome: "denied" };
  const [row] = await tx.update(mailboxOauthDeviceCeremonies)
    .set({ lastPolledAt: input.now })
    .where(and(
      eq(mailboxOauthDeviceCeremonies.state, input.state),
      isNull(mailboxOauthDeviceCeremonies.consumedAt),
      or(
        isNull(mailboxOauthDeviceCeremonies.lastPolledAt),
        /*
         * Interval arithmetic in SQL rather than in JS, because the comparison has to happen inside
         * the same statement as the write for the fence to be atomic at all. `poll_interval_ms` is
         * the row's own current value, so a `slow_down` that widened it takes effect on the very
         * next poll without this caller having to know it happened.
         *
         * THE ADDITION IS ON THE LEFT — "the due moment has arrived" — and not `now - interval` on
         * the right, deliberately. With the subtraction on the right Postgres has an untyped
         * parameter minus an interval and infers the parameter as an INTERVAL, then refuses the
         * whole predicate with `operator does not exist: timestamp with time zone <= interval`.
         *
         * AND THE INSTANT IS BOUND AS AN ISO STRING WITH AN EXPLICIT CAST, not as a `Date`. This is
         * a HAND-WRITTEN fragment, so nothing types the placeholder the way the query builder types
         * its own columns — the driver is handed a bare parameter and has to guess. postgres.js
         * refuses outright (`The "string" argument must be of type string … Received an instance of
         * Date`), which means every poll on a real deployment would have thrown. **PGlite accepts
         * the `Date` happily**, so the whole route was green in the API suite and broken in
         * production; the device-ceremony suite against a real Postgres is what found it. `::timestamptz`
         * leaves the driver nothing to infer and the comparison exactly as intended.
         */
        sql`${mailboxOauthDeviceCeremonies.lastPolledAt} + (${mailboxOauthDeviceCeremonies.pollIntervalMs} * interval '1 millisecond') <= ${input.now.toISOString()}::timestamptz`,
      ),
    ))
    .returning();
  return { outcome: row ? "ok" : "denied" };
}

/**
 * WIDEN THE INTERVAL AFTER A `slow_down` — cumulative, and stored because it has to survive the
 * request.
 *
 * RFC 8628 §3.5 requires the interval to grow by five seconds each time Microsoft says `slow_down`,
 * and NOT to reset on the next poll. Across a stateless poll route the only place that arithmetic
 * can live is the row: a caller holding it in memory is a caller that forgets it between requests,
 * and a client asked to carry it is a client that can simply not.
 *
 * The value is computed by the token client (which owns the RFC's rule and the ceiling) and written
 * here verbatim. Writes `poll_interval_ms` only — never `consumed_at`, because a `slow_down` is not
 * a terminal verdict, it is an instruction to keep going more slowly.
 */
export async function noteDeviceCeremonySlowDown(
  tx: Tx, input: { state: string; pollIntervalMs: number },
): Promise<void> {
  if (!input.state) return;
  await tx.update(mailboxOauthDeviceCeremonies)
    .set({ pollIntervalMs: input.pollIntervalMs })
    .where(and(
      eq(mailboxOauthDeviceCeremonies.state, input.state),
      isNull(mailboxOauthDeviceCeremonies.consumedAt),
    ));
}

/**
 * SPEND A DEVICE CEREMONY EXACTLY ONCE — the single-use write, on a TERMINAL VERDICT ONLY.
 *
 * The same statement shape as {@link consumeOAuthCeremony} and the same property:
 * `UPDATE … SET consumed_at = now WHERE state = $1 AND consumed_at IS NULL RETURNING …`, so N
 * concurrent callers produce exactly one winner with no read-then-write window between them.
 *
 * ── WHERE IT IS CALLED FROM, AND WHY NOT EARLIER ───────────────────────────────────────────
 *
 * On `granted`, `declined` and `expired`, and on nothing else. Claiming BEFORE the poll would be
 * the tidier-looking design and it is the bug this whole arm exists to avoid: the overwhelmingly
 * common poll result is `authorization_pending`, so a claim-first poll route would spend the
 * ceremony on its first attempt and every subsequent poll would report a grant that is very much
 * alive as gone.
 *
 * On `granted` the claim happens AFTER the token exchange, which leaves one narrow race worth
 * naming rather than hiding: two polls could in principle both be handed tokens by Microsoft, and
 * only one of them will win this UPDATE. The loser discards the tokens it holds — they are the same
 * user's own, never stored, never logged — and is answered as an unknown ceremony. The alternative
 * ordering (claim, then exchange) trades that for a worse failure: a claim followed by an exchange
 * that fails leaves the person with a burnt ceremony and a Microsoft screen that said yes.
 */
export async function claimDeviceCeremony(
  tx: Tx, input: { state: string; now: Date },
): Promise<{ outcome: "ok"; row: DeviceCeremonyRow } | { outcome: "unknown" }> {
  if (!input.state) return { outcome: "unknown" };
  const [row] = await tx.update(mailboxOauthDeviceCeremonies)
    .set({ consumedAt: input.now })
    .where(and(
      eq(mailboxOauthDeviceCeremonies.state, input.state),
      isNull(mailboxOauthDeviceCeremonies.consumedAt),
    ))
    .returning();
  if (!row) return { outcome: "unknown" };
  return { outcome: "ok", row: toDeviceRow(row) };
}

/**
 * Drop device ceremonies past retention.
 *
 * OPPORTUNISTIC, called by the START handler, for {@link pruneOAuthCeremonies}'s reason verbatim: a
 * table whose whole content is the last hour of connect attempts does not earn a scheduled surface,
 * and this costs one indexed DELETE on the path that is already writing a row. Abandoned ceremonies
 * — somebody closed the tab without approving — are half its input, which is why the predicate is
 * the age and not `consumed_at IS NOT NULL`.
 */
export async function pruneDeviceCeremonies(
  tx: Tx, opts: { now: Date; retentionMs?: number },
): Promise<void> {
  const cutoff = new Date(opts.now.getTime() - (opts.retentionMs ?? DEVICE_CEREMONY_RETENTION_MS));
  await tx.delete(mailboxOauthDeviceCeremonies)
    .where(lt(mailboxOauthDeviceCeremonies.createdAt, cutoff));
}
