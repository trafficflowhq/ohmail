/**
 * The mailbox OAuth ceremony store (cloud 0009) — mint, consume ONCE, prune. One writer of
 * `consumed_at`: {@link consumeOAuthCeremony}. The consume is ONE UPDATE (`SET consumed_at WHERE
 * state = $1 AND consumed_at IS NULL RETURNING`) — the entire replay defence: two browsers
 * replaying one code arrive as two UPDATEs on one row, and the second matches nothing. PGlite
 * cannot see this; the pg test fires N concurrent consumes and asserts one winner. The TTL is
 * checked AFTER the consume — an expired row inside the predicate would answer like a replayed
 * state, and the two need different sentences; the row is still consumed when expired.
 * No-such-state and already-spent are the SAME answer, or the callback becomes an oracle.
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

/**
 * The device-code ceremony (cloud 0027) — mint, READ WITHOUT CONSUMING, lease a poll, claim ONCE.
 * The redirect flow spends a ceremony on read; this flow cannot — the ceremony is polled every
 * few seconds while a person types a code in a browser, and a consuming read would make the FIRST
 * poll destroy the grant. The arms are separated: {@link readDeviceCeremony} SELECTs and writes
 * nothing; {@link leaseDeviceCeremonyPoll} writes `last_polled_at` only; {@link
 * claimDeviceCeremony} is the consume-once UPDATE, on a TERMINAL verdict only (granted, declined,
 * expired — pending and `slow_down` claim nothing). Two separate tables, so "may this be read
 * without being spent" has one answer per flow rather than a parameter.
 */

/**
 * How long a device ceremony row is KEPT — one hour, matching the redirect ceremony's retention:
 * long enough to explain a support question, short enough that the table is bounded by the last
 * hour of connect attempts. There is deliberately no TTL constant beside it: the redirect
 * ceremony needs one because nothing in its row says when the authorization code dies, while a
 * device ceremony carries Microsoft's own `expires_in` as `grant_expires_at` — the deadline is a
 * stored fact, not a policy this module chooses. A second, shorter TTL here would cut a person's
 * approval window short for no reason a reader could find.
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
 * Read a device ceremony WITHOUT spending it — the arm the whole flow turns on. A plain SELECT,
 * and the absence of a write is the property, not an optimisation: it is called on every poll,
 * and the day it writes `consumed_at` is the day the first poll kills the ceremony. The
 * device-ceremony suite, on real Postgres, pins both directions: N sequential reads succeed and
 * leave `consumed_at` NULL, and the redirect flow's consume-once guard still holds beside it. An
 * already-claimed row reads as `"unknown"`, not `"consumed"`: a terminal ceremony has nothing
 * further any caller may do, and a distinct answer would only tell a stranger the value was once
 * real.
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
 * Take the poll slot or be denied — one UPDATE, and the fence that protects a SHARED client id.
 * The interval belongs to Microsoft (RFC 8628 §3.5, cumulative on `slow_down`), and the throttled
 * client id is shared by every install using the public registration, so the fence cannot be
 * client-side courtesy. `last_polled_at <= now - poll_interval_ms` is IN THE PREDICATE: two
 * concurrent polls arrive as two UPDATEs on one row, and the second re-evaluates against the
 * committed value and matches nothing — a read-then-write version has a window the width of a
 * round trip to Microsoft. It sets `last_polled_at` and NOTHING ELSE: the only writer of
 * `consumed_at` is {@link claimDeviceCeremony}.
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
        // Interval arithmetic in SQL, inside the same statement as the write, so the fence is
        // atomic; `poll_interval_ms` is the row's own value, so a `slow_down` that widened it
        // takes effect on the next poll. The ADDITION is on the LEFT ("the due moment has
        // arrived"): with `now - interval` on the right, Postgres infers the untyped parameter as
        // an INTERVAL and refuses the whole predicate. And the instant is bound as an ISO string
        // with `::timestamptz`, not a `Date`: this is a hand-written fragment, so nothing types
        // the placeholder — postgres.js refuses a `Date` outright, while PGlite accepts it
        // happily, so the route was green in the API suite and broken in production; the
        // real-Postgres suite found it.
        sql`${mailboxOauthDeviceCeremonies.lastPolledAt} + (${mailboxOauthDeviceCeremonies.pollIntervalMs} * interval '1 millisecond') <= ${input.now.toISOString()}::timestamptz`,
      ),
    ))
    .returning();
  return { outcome: row ? "ok" : "denied" };
}

/**
 * Widen the interval after a `slow_down`. RFC 8628 §3.5 grows the interval five seconds per
 * `slow_down`, cumulatively; on a stateless poll route the only place that arithmetic can live is
 * the row. Applied IN SQL: an absolute value derived from the caller's own read LOSES increments
 * under concurrency — two polls both read 5 000, both assign 10 000, so two responses produce one
 * increase. `LEAST(poll_interval_ms + step, ceiling)` is read-modify-write in one statement, so
 * the second increments the first's committed value; RETURNING hands back what the row now holds.
 * The step and ceiling are the caller's; the arithmetic is the database's. Writes
 * `poll_interval_ms` only — a `slow_down` is not a terminal verdict.
 */
export async function noteDeviceCeremonySlowDown(
  tx: Tx, input: { state: string; stepMs: number; ceilingMs: number },
): Promise<{ pollIntervalMs: number } | null> {
  if (!input.state) return null;
  const [row] = await tx.update(mailboxOauthDeviceCeremonies)
    .set({
      pollIntervalMs: sql`LEAST(${mailboxOauthDeviceCeremonies.pollIntervalMs} + ${input.stepMs}, ${input.ceilingMs})`,
    })
    .where(and(
      eq(mailboxOauthDeviceCeremonies.state, input.state),
      isNull(mailboxOauthDeviceCeremonies.consumedAt),
    ))
    .returning();
  return row ? { pollIntervalMs: row.pollIntervalMs } : null;
}

/**
 * Spend a device ceremony exactly once — the single-use write, on a TERMINAL verdict only. The
 * same statement shape as {@link consumeOAuthCeremony}, so N concurrent callers produce one
 * winner. Called on `granted`, `declined` and `expired`, nothing else: claiming BEFORE the poll
 * looks tidier and is the bug this arm avoids — the common result is `authorization_pending`, and
 * a claim-first route would spend the ceremony on its first attempt. On `granted` the claim
 * happens AFTER the token exchange — one narrow race, named: two polls can both be handed tokens;
 * the loser discards its set and is answered unknown. The reverse ordering is worse: a claim
 * followed by a failed exchange leaves a burnt ceremony and a Microsoft screen that said yes.
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
