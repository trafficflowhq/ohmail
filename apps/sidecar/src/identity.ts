/* `randomUUID` from the module rather than the global `crypto`: this file is bundled for the phone,
   where Hermes has no such global, and the read was a launch-time failure there. `organizer-lease.ts`
   carries the same correction and the measurement behind it. */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  accounts, mailboxes, sessions, users,
  closeStoodDownAppointments, isMailboxDisabledReason, isOrganizerKind, standDownMemory,
  type MailboxDisabledReason, type Tx, type OrganizerIntent,} from "@trafficflow/db";
import { generateToken, hashToken } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";

/**
 * The local world: who the desktop user is, to a schema written for Cloud. The desktop tier is
 * free, standalone and has no account or signup, but `packages/api`'s middleware chain is the same
 * one Cloud runs and must not be bypassed — so the sidecar SATISFIES it against a single-user
 * database on disk. Three rows answer three middlewares: `accounts` (the one tenant every row is
 * scoped by); `users` with `emailVerifiedAt` SET (`withVerifiedEmail`'s question is answered by the
 * tier — no cost, nobody to prove to); and `sessions` with `scope: 'full'` and `lastTwofaAt` SET (no
 * second factor on a local install; the credential is the pipe to the parent process). The session
 * is per LAUNCH — {@link mintLaunchSession} revokes what it finds, so no token outlives the process.
 */

/** The synthetic local identity. Never mailed, never shown — it exists to satisfy the schema. */
export interface LocalWorld {
  accountId: string;
  userId: string;
  /**
   * The seed mailbox — the row the shell's single-mailbox surfaces answer for, which since the
   * install can hold several is narrower than "the mailbox". It is the live row whose address
   * matches this launch's configured one; failing that, the OLDEST live row; failing that, `""`. The
   * middle arm keeps an install working after its seed was removed with others left behind —
   * `config.json` names an address nothing serves, and the mailbox that IS there is more honest than
   * none. `""` is reachable only with no mailboxes at all, which the shell does not spawn into; it is
   * stated in the type rather than assumed away, since the alternative silently matches no row.
   */
  mailboxId: string;
  /**
   * The lease reason this mailbox's row remembers, when it remembers one — `organized_elsewhere:*`.
   * Present iff this install previously STOOD DOWN from the mailbox, and it is what keeps a lapsed
   * Cloud subscription from auto-resuming the desktop across a relaunch: once Cloud releases its
   * claim the folder is empty, and an empty folder correctly reads as "nobody has ever organized
   * this", which organizes — so the row is the memory the mailbox cannot hold. DERIVED, not read
   * (mail 0083): this was `disabled_reason` until 0083 split the connection from the role and left
   * that column with no writer; {@link standDownMemory} derives it, shared with four other sites.
   */
  standDownReason: string | null;
  /**
   * Set iff a human has explicitly asked THIS install to become the organizer of this mailbox.
   * Ceasing to organize is automatic; becoming one never is. When the mailbox holds a claim from an
   * organizer that has gone quiet, the lease reports it available and refuses to take it — "nobody
   * is renewing" and "the user chose this machine" are different facts, and only the second
   * authorizes a takeover. This stamp carries the second. It authorizes ONE becoming, not a standing
   * right: cleared as soon as it is spent, so an install that later stands down cannot silently seize
   * the mailbox back on a later launch.
   */
  takeoverAuthorizedAt: Date | null;
  /**
   * Mail 0104 — WHAT that press asked for. `takeover` asks for the mailbox whoever holds it;
   * `join` asks only for one nobody is organizing, and the lease refuses it against a live
   * foreign claim however recent the press. Read in the same statement as the stamp; meaningless
   * while the stamp is NULL.
   */
  takeoverIntent: OrganizerIntent;
}

export interface EnsureLocalWorldInput {
  /**
   * The mailbox this install organizes; doubles as the local user's address. `null` ONLY on a paired
   * door, and the absence is a fact: an install set up from a pairing link names a COMPUTER, and
   * which mailboxes it reads is the host's answer, unknown when the world is built — so there is no
   * seed to mint and no address to name a user row after (`shouldSeedMailbox` answers `false` for an
   * absent address, and the mirror fills the roster from the host). It is `null` and never `""`: an
   * empty string reads as a configured-but-blank address, and `sameOwner("")` matches nothing, so a
   * mirror whose owner was recorded that way would be discarded on every launch.
   */
  address: string | null;
  displayName?: string;
  now: Date;
}

/**
 * Find-or-create the one account and user, and — only when the roster says a mailbox is genuinely
 * missing — the SEED mailbox. Idempotent. The account and user stay exactly one each; the MAILBOX
 * does not, and this creates at most the first (every later one arrives through
 * `POST /local/mailboxes` with a probed credential). The lookup honours
 * `mailboxes_active_address_uq`, so a removed mailbox leaves a tombstone rather than blocking a
 * reconnect. A lease STAND-DOWN is not a tombstone — it must be FOUND next launch, or relaunching
 * silently resumes organizing (the forbidden auto-resume); since mail 0083 it leaves the row
 * `connected` `reader` (found by the ordinary arm), while a removal (reason NULL) mints fresh.
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
          /* EMPTY WHEN THERE IS NO ADDRESS YET — the local user row is an artifact of this
             install, not a claim about a mailbox, and a paired door has not been told one. The
             mirror carries the real addresses on the mailbox rows it pulls. */
          email: input.address?.toLowerCase() ?? "",
          displayName: input.displayName ?? "",
          // See the header: the gate's question is answered by the tier, not skipped.
          emailVerifiedAt: input.now,
        })
        .returning({ id: users.id })
    )[0]!.id;

  /* Every row this install holds, not only the one named by the environment. This was a `limit(1)`
   * lookup of the seed address (an install had one mailbox); it is now the whole non-tombstoned set,
   * for two faces of one reason: the ROSTER needs every live row a runtime, and the SEED DECISION
   * ({@link shouldSeedMailbox}) turns on whether ANY other mailbox is live — without which an install
   * whose seed was removed while a second remained would mint the seed again. The predicate is
   * UNCHANGED (`status <> 'disabled' or disabled_reason is not null`): a reader is live, a paused row
   * is the same mailbox, a tombstone is excluded. Ordered active-first then oldest-first — the old
   * tie-break, then the roster's `created_at` contract. */
  const nonTombstoned = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
      organizerRole: mailboxes.organizerRole,
      organizedByKind: mailboxes.organizedByKind,
      // Mail 0088 — the third term of `standDownMemory`'s live arm. It is what tells a
      // RELEASED mailbox (no holder, no occupancy) from a stood-down one, which are
      // otherwise the same row shape and want opposite sentences.
      organizerState: mailboxes.organizerState,
      // Mail 0088 — the release MARKER, and the fourth term of `standDownMemory`'s live arm. It is
      // what tells a released mailbox from a stood-down one, which are otherwise the same row once
      // the winner's claim goes away.
      organizerReleasedAt: mailboxes.organizerReleasedAt,
      organizeConsentedAt: mailboxes.organizeConsentedAt,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      // Mail 0104 — the VERB behind the stamp, read in the SAME statement as the stamp and never
      // separately: the gate acts on the pair, and two reads can straddle a press.
      takeoverIntent: mailboxes.takeoverIntent,
    })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      sql`(${mailboxes.status} <> 'disabled' or ${mailboxes.disabledReason} is not null)`,
    ))
    .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`, mailboxes.createdAt, mailboxes.id);

  const wanted = (input.address ?? "").trim().toLowerCase();
  const seedRow = wanted
    ? nonTombstoned.find((r) => r.address.trim().toLowerCase() === wanted) ?? null
    : null;

  /* Asked ONLY when no live row carries the address, because that is the only case whose answer
     it changes — and it is one indexed read that an ordinary launch never makes. A tombstone plus
     an empty roster is a first-run install (seed); a tombstone plus anything live is a seed
     somebody removed (do not resurrect). */
  const tombstonedSeed = seedRow === null && wanted
    ? (await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(
          eq(mailboxes.accountId, accountId),
          sql`lower(${mailboxes.address}) = ${wanted}`,
          eq(mailboxes.status, "disabled"),
          isNull(mailboxes.disabledReason),
        ))
        .limit(1)).length > 0
    : false;

  const seed = shouldSeedMailbox({
    seedAddress: input.address ?? "",
    activeSeedRow: seedRow !== null,
    tombstonedSeed,
    rosterEmpty: nonTombstoned.length === 0,
  });

  if (!seed) {
    /* THE SEED'S ROW IS THE ONE THE SHELL'S SINGLE-MAILBOX SURFACES ANSWER FOR, and when the seed
       address has no row the OLDEST LIVE ONE stands in. That fallback is what keeps a working
       install from reporting itself unconfigured after its seed was removed: `config.json` names
       an address nothing serves, and the honest answer is the mailbox that IS there rather than
       nothing at all. With no rows at all the id is the empty string — a state the shell does not
       spawn into (it will not start an engine without `OHMAIL_IMAP_HOST`/`USER`), stated here
       rather than left to be a lookup that silently matches no row. */
    const standing = seedRow ?? nonTombstoned.find((r) => r.status !== "disabled") ?? null;
    return {
      accountId,
      userId,
      mailboxId: standing?.id ?? "",
      standDownReason: standing ? standDownMemory(standing) : null,
      takeoverAuthorizedAt: standing?.takeoverAuthorizedAt ?? null,
      takeoverIntent: standing?.takeoverIntent === "takeover" ? "takeover" : "join",
    };
  }

  /* Reaching here means {@link shouldSeedMailbox} said SEED, which by its own case 2 means no
     non-tombstoned row carries this address. The second lookup that used to stand here — the same
     address, the same predicate, `limit(1)` — could therefore only ever answer nothing, so it is
     gone rather than kept as a belt-and-braces read that no launch can take. The find half of
     "find-or-create" is the roster read above; this is the create. */
  const mailboxId = (
    await db
      .insert(mailboxes)
      .values({
        accountId,
        provider: "imap",
        /* NON-NULL BY CONSTRUCTION: `shouldSeedMailbox` returns false for an absent address, and
           this line is only reached when it returned true. Asserted rather than defaulted, because
           a `?? ""` here would mint a mailbox row named after nothing — the row this branch exists
           to create is the one the address names. */
        address: input.address!,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        status: "connected",
        /* The pre-consent state is a READER, on this door too. This was `organizeConsentedAt:
         * input.now`, on the premise "there is no consent screen here" — no longer true: the guided
         * setup landed, and "Agree and start organizing" is `POST /local/mailboxes/:id/organize`,
         * which writes the consent, baseline, window and scope in one transaction. With the stamp
         * written HERE that screen granted nothing, so the row is created a consent-less reader — the
         * same shape `POST /mailboxes` creates on the hosted door. The ROLE is written because the
         * column defaults to `organizer`; `authorizeOrganizerTakeover` refuses only `role !==
         * 'reader' && consentedAt !== null`, so a reader answers `authorized`, and a headless install
         * uses `runOrganizeHere` (`organize-here.ts`). */
        organizerRole: "reader",
      })
      .returning({ id: mailboxes.id })
  )[0]!.id;

  return {
    accountId, userId, mailboxId, standDownReason: null,
    takeoverAuthorizedAt: null, takeoverIntent: "join",
  };
}

/** One live mailbox, as the boot reads it before building a runtime for it. */
export interface LocalRosterRow {
  id: string;
  address: string;
  displayName: string | null;
  standDownReason: string | null;
  takeoverAuthorizedAt: Date | null;
  /** Mail 0104 — what the press above ASKED FOR; meaningless while the stamp is NULL. */
  takeoverIntent: OrganizerIntent;
}

/**
 * Every mailbox this install runs, oldest first — the boot's one roster read. `status <> 'disabled'`
 * and nothing else, narrower than {@link ensureLocalWorld}'s existence predicate: a paused row is
 * the same mailbox and must not be duplicated, but it is not RUNNING and gets no login, claim or
 * poll timer — being found and being attached are different questions. The old ≤0.13.x paused row
 * that made this a one-way door (excluded ⇒ no runtime ⇒ no lease read ⇒ a takeover that can never
 * be spent) is ended by {@link endLegacyOrganizerPauses} before this read, so the exclusion now
 * covers exactly the rows the current build leaves `disabled`. READ ONCE at boot, never on a timer:
 * the only writers of this table are this engine's own routes, so attach and detach are events.
 */
export async function loadLocalRoster(db: LocalDb, accountId: string): Promise<LocalRosterRow[]> {
  const rows = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
      // The four `standDownMemory` reads together — see {@link LocalWorld.standDownReason}. Read
      // per row rather than once for the install, because a stand-down is a fact about ONE
      // mailbox: a machine can be the organizer of one and a reader of another at the same time.
      organizerRole: mailboxes.organizerRole,
      organizedByKind: mailboxes.organizedByKind,
      // Mail 0088 — the third term of `standDownMemory`'s live arm. It is what tells a
      // RELEASED mailbox (no holder, no occupancy) from a stood-down one, which are
      // otherwise the same row shape and want opposite sentences.
      organizerState: mailboxes.organizerState,
      // Mail 0088 — the release MARKER, and the fourth term of `standDownMemory`'s live arm. It is
      // what tells a released mailbox from a stood-down one, which are otherwise the same row once
      // the winner's claim goes away.
      organizerReleasedAt: mailboxes.organizerReleasedAt,
      organizeConsentedAt: mailboxes.organizeConsentedAt,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      // Mail 0104 — the VERB behind the stamp, read in the SAME statement as the stamp and never
      // separately: the gate acts on the pair, and two reads can straddle a press.
      takeoverIntent: mailboxes.takeoverIntent,
    })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      sql`${mailboxes.status} <> 'disabled'`,
    ))
    .orderBy(mailboxes.createdAt, mailboxes.id);
  return rows.map((r) => ({
    id: r.id,
    address: r.address,
    displayName: r.displayName ?? null,
    standDownReason: standDownMemory(r),
    takeoverAuthorizedAt: r.takeoverAuthorizedAt ?? null,
    /* A value the column's closed set does not hold cannot be written by this program, and a
       store that somehow carries one is read as the verb that yields rather than the one that
       displaces — the direction that cannot produce two organizers. */
    takeoverIntent: r.takeoverIntent === "takeover" ? "takeover" : "join",
  }));
}

/** One mailbox this install HOLDS and does not RUN, as the boot reports it. */
export interface UnattachedRosterRow {
  id: string;
  /** `organized_elsewhere:*` for a paused row; NULL for a tombstone the person removed. */
  disabledReason: string | null;
}

/**
 * Every mailbox this install holds and does not run — {@link loadLocalRoster}'s complement. The
 * roster read is `status <> 'disabled'`, and what nothing answered was WHICH rows it left out: the
 * boot's only roster line is a COUNT of what it attached, so an install holding two and running one
 * logged `count: 1` and never named the other — and `ensureLocalWorld`'s wider lookup means the
 * left-out row can be the SEED, whose id the `serving` line then prints (an incident that reads
 * backwards). Separate from the roster read rather than a widening of it, deliberately: three call
 * sites use `loadLocalRoster` to FIND a row by id, and a wider predicate would silently find paused
 * rows there. This one has one caller and one purpose.
 */
export async function loadUnattachedLocalRoster(
  db: LocalDb, accountId: string,
): Promise<UnattachedRosterRow[]> {
  const rows = await db
    .select({ id: mailboxes.id, disabledReason: mailboxes.disabledReason })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      eq(mailboxes.status, "disabled"),
    ))
    .orderBy(mailboxes.createdAt, mailboxes.id);
  return rows.map((r) => ({ id: r.id, disabledReason: r.disabledReason ?? null }));
}

/** A pause this boot ended: the row's id and the memory the rewrite kept for it. */
export interface EndedOrganizerPause {
  id: string;
  /** The `organized_elsewhere:*` the row carried — now recorded as `organized_by_kind`. */
  keptReason: MailboxDisabledReason;
  /** Appointments closed with the stand-down's sentence, because a reader cannot keep them. */
  closedSends: number;
}

/**
 * End a pause a build older than mail 0083 left — migration 0083's backfill, run again at boot.
 * `disabled` + an `organized_elsewhere:*` reason is the PRE-0083 spelling of a reader (the
 * stand-down encoded the ROLE in the CONNECTION); {@link loadLocalRoster} excludes that shape for
 * ever, so no runtime, no lease read, and a takeover authorized on it can never be spent. THE ROLE
 * IS NOT A TERM of the predicate — the 0.13.x write named no role, so a mailbox this install
 * organized keeps the `organizer` default — it tests status and reason only, like 0083. It makes a
 * READER, never an organizer; the SIBLING GUARD is 0083's — `mailboxes_active_address_uq` means
 * promoting a row with a live sibling takes the boot down, so a superseded row stays paused.
 */
export async function endLegacyOrganizerPauses(
  db: LocalDb, accountId: string, now: Date,
): Promise<EndedOrganizerPause[]> {
  const rows = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
    })
    .from(mailboxes)
    .where(eq(mailboxes.accountId, accountId))
    .orderBy(mailboxes.createdAt, mailboxes.id);

  const live = new Set(
    rows.filter((r) => r.status !== "disabled").map((r) => r.address.trim().toLowerCase()),
  );
  const ended: EndedOrganizerPause[] = [];
  for (const row of rows) {
    if (row.status !== "disabled") continue;
    // A TOMBSTONE HAS NO REASON, and that is the whole discriminator this file already turns on:
    // `disabled` with a reason is a pause, `disabled` without one is a mailbox somebody removed
    // here. A removal is not resumed, and a value outside the closed set is not one either.
    if (!isMailboxDisabledReason(row.disabledReason)) continue;
    const address = row.address.trim().toLowerCase();
    if (live.has(address)) continue;
    /* `isOrganizerKind` for `standDownMemory`'s reason at the same derivation: the reason's suffix
       and the kind column carry the same closed three today, so this narrows by construction and
       is the guard for the day they stop being equal — an unrankable kind reads `unknown`, which
       the column's CHECK admits and which fails closed at every reader downstream. */
    const suffix = row.disabledReason.slice("organized_elsewhere:".length);
    const kind = isOrganizerKind(suffix) ? suffix : "unknown";
    await db
      .update(mailboxes)
      .set({
        status: "connected",
        organizerRole: "reader",
        organizedByKind: kind,
        // BEING BEATEN IS NOT RELEASING (mail 0088). The reason says another organizer holds this
        // mailbox, so the release marker must be absent or `standDownMemory` answers null for it
        // and the row comes back as a mailbox nobody ever organized.
        organizerReleasedAt: null,
        disabledReason: null,
        /* ── THE EVENT IS STAMPED HERE, OR THE ROW CHANGES STATE WITH NOBODY TOLD ────────────
         *
         * The notice is derived (`organizer_event_at > coalesce(organizer_event_seen_at, …)`), so
         * every writer of the (role, state, holder) triple stamps it in the SAME statement —
         * and the same invariant closes the mailbox's pending sends. This is such a write, not
         * a birth: a birth INSERTs a mailbox nobody has organized, and those are the exemptions.
         * What the person sees changes on this launch — a mailbox that was off and offered
         * "Organize here instead" comes up reading, with a banner naming who holds it — so being
         * told once is the honest answer, and the row's own pre-0083 state carried no stamp at
         * all (the column post-dates it), so nothing is re-shown. */
        organizerEventAt: now,
      })
      .where(and(eq(mailboxes.id, row.id), eq(mailboxes.status, "disabled")));
    live.add(address);
    /* And the appointments this row can no longer keep are closed, after the rewrite. A pause left
     * by ≤0.13.x can carry a scheduled send, and the rewrite makes it dangerous: the row goes back
     * to `connected` (where `ScheduleService`/`SendService` accept work) while the scheduled-send
     * pass lives in the organizer drain a READER never runs — so the appointment would say "Sends
     * Tue 14:50" for a time gone by for ever (the orphan a handover's close prevents; the census
     * refuses this site without it). AFTER the update, because the close's precondition is
     * `organizer_role = 'reader'` FOR UPDATE. NOT in one transaction with the rewrite — a stand-down
     * must never be contingent on a close; the launch catch-up retries a failure. */
    const closed = await closeStoodDownAppointments(db as unknown as Tx, {
      accountId, mailboxId: row.id, reason: row.disabledReason, now,
    });
    ended.push({ id: row.id, keptReason: row.disabledReason, closedSends: closed.closed });
  }
  return ended;
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
 * `accessExpiresAt` is a day, not Cloud's 15 minutes: there is no refresh ceremony and no user to
 * re-authenticate, so a short expiry would only stop the app while open — the real bound is the
 * process (the token is never written and the next launch revokes what it finds). The revoke is
 * narrowed to `deviceId IS NULL`, and that is load-bearing: `establishPairedDevice` (Phase 3) mints
 * a REMOTE device's session into this same table, so a blanket sweep unpaired every phone on every
 * desktop restart (`pairing-local.e2e.test.ts`, watched red). The discriminator is structural — a
 * launch session never carries a device row; paired sessions die by their own lifecycle.
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
      familyId: randomUUID(),
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

/**
 * Why this lives here and not with the roster. It is a question about the roster, so `roster.ts`
 * looked like home — and putting it there was a structural mistake with a census to prove it:
 * `roster.ts` names the worker's sync and profile modules in its types, and `identity.ts` is shared
 * with the CLOUD engine, whose whole safety property is that its module graph cannot reach an
 * organizer. One import across that line would put the worker's sync loop and the IMAP adapter into
 * the Cloud engine's graph. The predicate needs none of it — four booleans in, one out — and is an
 * identity question, so it lives beside the function that acts on it and the edge does not exist.
 */
/**
 * Should the seed row be created? The one predicate in this file, a pure function with a table test
 * because getting it wrong is the sharpest hazard in the in-place upgrade. The old answer ("the
 * environment names a user, so ensure a row") was right for one mailbox and RESURRECTS a removed one
 * with N: `config.json` keeps the seed address after a removal (removing one of several is not a
 * sign-out), so the next launch would mint a credential-less reader for a removed mailbox. So it is
 * asked with the roster in view. The sharp pair among the six reachable cases is the SAME tombstone
 * with the answer turning on whether ANY other live row exists (only a tombstone ⇒ SEED; a seed
 * removed while others remain ⇒ NOTHING) — why "is the roster empty" is an argument, not inferred.
 */
export interface SeedDecisionInput {
  /** `config.address ?? config.imap.auth.user`, trimmed by the caller or not — this normalizes. */
  seedAddress: string | null | undefined;
  /** Is there a live (non-tombstoned) row for the seed address? */
  activeSeedRow: boolean;
  /** Does the store hold a tombstone for the seed address? */
  tombstonedSeed: boolean;
  /** Are there NO live rows at all — not merely none for this address? */
  rosterEmpty: boolean;
}

/** Whether this launch should create the seed mailbox row. See the header's six cases. */
export function shouldSeedMailbox(input: SeedDecisionInput): boolean {
  const address = (input.seedAddress ?? "").trim();
  // Case 6 — nothing to name a row after.
  if (!address) return false;
  // Case 2 — the row is already there. This is every ordinary launch after the first.
  if (input.activeSeedRow) return false;
  /* Cases 3 and 4, which are the same tombstone and different answers. An empty roster is an
     install at first-run whatever the store remembers, so the seed is made; a roster with anything
     live in it is an install whose seed was REMOVED, and re-minting it is the resurrection. */
  if (input.tombstonedSeed) return input.rosterEmpty;
  // Case 1 — a fresh install, or an address this store has never heard of. Case 5 never reaches
  // here: the route's row is active, so `activeSeedRow` answered above.
  return true;
}
