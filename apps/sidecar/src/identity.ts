import { and, eq, isNull, sql } from "drizzle-orm";
import { accounts, mailboxes, sessions, users, standDownMemory } from "@trafficflow/db";
import { generateToken, hashToken } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";

/**
 * THE LOCAL WORLD: who the desktop user is, to a schema that was written for Cloud.
 *
 * The desktop tier is free, fully standalone and has **no account and no signup** — there is
 * nobody to register with and no limit to enforce. But `packages/api`'s middleware chain is not
 * optional and should not be: it is the same chain Cloud runs, and running a second, laxer one
 * locally is precisely the divergence the single-implementation rule exists to prevent. So
 * instead of bypassing the gates, the sidecar SATISFIES them against a single-user database that
 * lives on the user's own disk.
 *
 * Three rows, and each one answers a specific middleware:
 *
 *  · `accounts` — the tenant every row in the schema is scoped by. Exactly one, ever.
 *  · `users` with `emailVerifiedAt` SET — `withVerifiedEmail` (packages/api/src/middleware.ts)
 *    403s an unproven address. On Cloud that gate stops an unverified stranger generating cost;
 *    here the "address" is the user's own mailbox on their own machine, there is no cost to
 *    generate and nobody to prove anything to. Setting it is not weakening the gate, it is
 *    recording that the question the gate asks has already been answered by the tier.
 *  · `sessions` with `scope: 'full'` and `lastTwofaAt` SET — `withStepUp` gates the sensitive
 *    routes on a recent second factor. There is no second factor on a local install and inventing
 *    one would be theatre; the credential is the pipe, and the pipe is the parent process.
 *
 * ── THE SESSION IS PER LAUNCH, AND THAT IS ENFORCED HERE ──────────────────────────────────
 *
 * Sessions are minted per launch and never persisted. On-disk PGlite makes that a thing you have
 * to DO: a `sessions` row survives a reboot, so without {@link mintLaunchSession} revoking what it
 * finds, every token ever minted would stay a live credential inside a file on disk. Only the hash
 * is ever written; the token itself exists in memory and in the `ready` frame, and dies with the
 * process.
 */

/** The synthetic local identity. Never mailed, never shown — it exists to satisfy the schema. */
export interface LocalWorld {
  accountId: string;
  userId: string;
  mailboxId: string;
  /**
   * The lease reason this mailbox's row remembers, when it remembers one — `organized_elsewhere:*`.
   *
   * Present iff this install previously STOOD DOWN from the mailbox. It is what keeps a lapsed
   * Cloud subscription from auto-resuming the desktop across a relaunch, and the lease alone
   * cannot do it: once Cloud releases its claim the folder is empty, and an empty folder
   * correctly reads as "nobody has ever organized this mailbox", which organizes. The row is the
   * memory the mailbox cannot hold.
   *
   * ── IT IS DERIVED, NOT READ (mail 0083) ─────────────────────────────────────────────────
   *
   * This was `disabled_reason`, one column, until 0083 split the CONNECTION from the ROLE and
   * left that column with no writer. The derivation is {@link standDownMemory} — shared with the
   * four other call sites that asked the same question of the same dead column, two of them on the
   * hosted side — and the value is still the same closed set, so every reader downstream of this
   * field is unchanged.
   */
  standDownReason: string | null;
  /**
   * Set iff a human has explicitly asked THIS install to become the organizer of this mailbox.
   *
   * Ceasing to organize is automatic; becoming an organizer never is. When the mailbox holds a
   * claim from an organizer that has gone quiet, the lease reports the mailbox as available and
   * refuses to take it — because "nobody is renewing" and "the user chose this machine" are
   * different facts, and only the second one authorizes a takeover. This stamp carries the second.
   *
   * It authorizes ONE becoming, not a standing right: it is cleared as soon as it is spent, so an
   * install that later stands down cannot silently seize the mailbox back on a subsequent launch.
   */
  takeoverAuthorizedAt: Date | null;
}

export interface EnsureLocalWorldInput {
  /** The mailbox this install organizes. Doubles as the local user's address. */
  address: string;
  displayName?: string;
  now: Date;
}

/**
 * Find-or-create the one account, user and mailbox. Idempotent: the second launch finds all three.
 *
 * The mailbox lookup honours the partial unique index `mailboxes_active_address_uq`
 * (`packages/db/src/schema-mail.ts`) — `(account_id, lower(address)) where status <> 'disabled'` —
 * so a mailbox the user removed leaves a tombstone rather than blocking a reconnect, exactly as
 * Cloud behaves.
 *
 * ── A LEASE STAND-DOWN IS NOT A TOMBSTONE ─────────────────────────────────────────────────
 *
 * A stood-down mailbox has to be FOUND on the next launch — otherwise relaunching the app mints a
 * fresh `connected` row and the install silently resumes organizing a mailbox it stood down from.
 * That is the forbidden auto-resume: a forgotten install on an office machine quietly becoming
 * the thing that moves someone's mail. Restarting an app is not an explicit human action about
 * who organizes a mailbox.
 *
 * Since mail 0083 a stand-down leaves the row `connected` with `organizer_role = 'reader'`, so
 * the ordinary `status <> 'disabled'` arm of the WHERE below finds it with nothing added — a
 * reader IS a live mailbox, which is the whole point of the role. The `or disabled_reason is not
 * null` arm is what still finds the OTHER shape: a row 0083's backfill deliberately left
 * `disabled` because a live sibling already held its address, and any row an older binary wrote.
 *
 * `disabled` on its own has therefore gone back to meaning one thing, and the reason column is
 * what tells its two events apart for the rows that carry it. A REMOVAL ("Remove from this Mac…",
 * `disabled_reason` NULL) is a tombstone: re-adding the address is a new mailbox and must not be
 * blocked, so it is excluded here and a fresh row is minted. A row `disabled` WITH a reason is
 * the same mailbox, paused, and is returned as-is — never re-enabled here. Only an explicit
 * action clears either shape.
 */
export async function ensureLocalWorld(db: LocalDb, input: EnsureLocalWorldInput): Promise<LocalWorld> {
  const existingAccount = (await db.select({ id: accounts.id }).from(accounts).limit(1))[0];
  const accountId =
    existingAccount?.id ??
    (await db.insert(accounts).values({ name: "This Mac" }).returning({ id: accounts.id }))[0]!.id;

  const existingUser = (
    await db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId)).limit(1)
  )[0];
  const userId =
    existingUser?.id ??
    (
      await db
        .insert(users)
        .values({
          accountId,
          email: input.address.toLowerCase(),
          displayName: input.displayName ?? "",
          // See the header: the gate's question is answered by the tier, not skipped.
          emailVerifiedAt: input.now,
        })
        .returning({ id: users.id })
    )[0]!.id;

  // Active first, then a stood-down row for the same address. Ordered rather than filtered, so a
  // user who removed the mailbox and re-added it still gets the ACTIVE row and not the paused one.
  const existingMailbox = (
    await db
      .select({
        id: mailboxes.id,
        status: mailboxes.status,
        disabledReason: mailboxes.disabledReason,
        // Mail 0083 — the stand-down's record moved onto these two, and `standDownMemory` is the
        // one place that reads all four together. Selected here rather than derived from `status`
        // because `status` no longer knows.
        organizerRole: mailboxes.organizerRole,
        organizedByKind: mailboxes.organizedByKind,
        takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, accountId),
          sql`lower(${mailboxes.address}) = ${input.address.toLowerCase()}`,
          sql`(${mailboxes.status} <> 'disabled' or ${mailboxes.disabledReason} is not null)`,
        ),
      )
      .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`)
      .limit(1)
  )[0];
  if (existingMailbox) {
    return {
      accountId,
      userId,
      mailboxId: existingMailbox.id,
      standDownReason: standDownMemory(existingMailbox),
      takeoverAuthorizedAt: existingMailbox.takeoverAuthorizedAt ?? null,
    };
  }

  const mailboxId = (
    await db
      .insert(mailboxes)
      .values({
        accountId,
        provider: "imap",
        address: input.address,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        status: "connected",
        /* -- ADDING THE MAILBOX *IS* THE CONSENT ON THIS DOOR (mail 0083) -------------------
         *
         * `organize_consented_at` NULL means "nobody has asked this install to organize this
         * mailbox", the state `POST /mailboxes` creates on Cloud so a fresh connect builds a
         * mirror and moves nothing until a human says yes on the consent screen. **There is no
         * such screen and no such second step here**: a standalone install is launched with one
         * address, by the person who owns the machine, and organizing it is the entire reason
         * they ran the app. This is migration 0083's own backfill (2) argument — *"connecting a
         * mailbox WAS the consent … so the record is true"* — applied to the rows this function
         * creates AFTER that migration, which the backfill can never reach.
         *
         * Left NULL it was not inert: `authorizeOrganizerTakeover` reads the pair
         * (`role !== 'reader' && consentedAt !== null`) to answer "you already organize this",
         * so a healthy standalone install answered `authorized` to a press on a mailbox it was
         * already organizing — writing a one-shot seizure stamp that then sat on the row waiting
         * to be spent against whoever held the mailbox next.
         */
        organizeConsentedAt: input.now,
      })
      .returning({ id: mailboxes.id })
  )[0]!.id;

  return { accountId, userId, mailboxId, standDownReason: null, takeoverAuthorizedAt: null };
}

export interface LaunchSession {
  /** The bearer token. In memory only — the database holds its hash. */
  token: string;
  sessionId: string;
  /** How many stale LAUNCH sessions this launch revoked. Nonzero on every launch after the first. */
  revoked: number;
}

/**
 * Revoke every stale LAUNCH session the database still holds, then mint one for this launch.
 *
 * `accessExpiresAt` is a day out rather than the Cloud default's 15 minutes: there is no refresh
 * ceremony on this transport and no user to re-authenticate, so a short expiry would only mean the
 * app stops working while it is open. The real lifetime bound is the process — the token is never
 * written down and the next launch revokes whatever it finds.
 *
 * ── THE REVOKE IS NARROWED TO `deviceId IS NULL`, AND THE NARROWING IS LOAD-BEARING ────────
 *
 * This swept EVERY unrevoked session of the account, and while launch sessions were the only
 * kind this database held, that was the same statement. Device pairing (Phase 3) ends that:
 * `establishPairedDevice` mints a REMOTE device's session into this same `sessions` table, and
 * under the blanket sweep every desktop restart silently unpaired every phone — each half
 * locally correct, the composition a landmine only the pair-then-relaunch scenario test sees
 * (`test/pairing-local.e2e.test.ts`, watched red against the blanket form before this WHERE
 * narrowed it). The discriminator is structural, not a flag: a launch session never carries a
 * device row — there is nothing to list or revoke about the process's own pipe — while
 * `establishPairedDevice` always sets one, because the device row IS the visibility that makes
 * pairing safe to offer. Paired sessions die by their own lifecycle instead: revocation from
 * the device list, refresh-reuse detection, or expiry.
 */
export async function mintLaunchSession(
  db: LocalDb,
  world: LocalWorld,
  now: Date,
  ttlMs = 24 * 60 * 60 * 1000,
): Promise<LaunchSession> {
  const stale = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(
      eq(sessions.accountId, world.accountId),
      isNull(sessions.revokedAt),
      // Launch sessions only — a paired device's session (deviceId set) must survive a relaunch.
      isNull(sessions.deviceId),
    ))
    .returning({ id: sessions.id });

  const token = generateToken();
  const [row] = await db
    .insert(sessions)
    .values({
      accountId: world.accountId,
      userId: world.userId,
      familyId: crypto.randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(now.getTime() + ttlMs),
      refreshExpiresAt: new Date(now.getTime() + ttlMs),
      // See the header: there is no second factor on a local install.
      lastTwofaAt: now,
      scope: "full",
    })
    .returning({ id: sessions.id });

  return { token, sessionId: row!.id, revoked: stale.length };
}
