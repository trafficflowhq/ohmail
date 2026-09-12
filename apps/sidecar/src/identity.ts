/* `randomUUID` from the module rather than the global `crypto`: this file is bundled for the phone,
   where Hermes has no such global, and the read was a launch-time failure there. `organizer-lease.ts`
   carries the same correction and the measurement behind it. */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  accounts, mailboxes, sessions, users,
  closeStoodDownAppointments, isMailboxDisabledReason, isOrganizerKind, standDownMemory,
  type MailboxDisabledReason, type Tx,
} from "@trafficflow/db";
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
  /**
   * THE SEED MAILBOX — the row the shell's single-mailbox surfaces answer for, which since the
   * install can hold several is a narrower thing than "the mailbox".
   *
   * It is the live row whose address matches the one this launch was configured with; failing
   * that, the OLDEST live row; failing that, the empty string. The middle arm is what keeps an
   * install working after its seed was removed with others left behind — `config.json` goes on
   * naming an address nothing serves, and answering the mailbox that IS there is more honest than
   * answering none.
   *
   * `""` is reachable only on an install with no mailboxes at all, which the shell does not spawn
   * into (it starts no engine without `OHMAIL_IMAP_HOST`/`USER`). It is stated in the type rather
   * than assumed away, because the alternative is a lookup that silently matches no row.
   */
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
  /**
   * The mailbox this install organizes. Doubles as the local user's address.
   *
   * **`null` ONLY on a paired door**, and the absence is a fact rather than a gap. An install set
   * up from a pairing link names a COMPUTER; which mailboxes it reads is the host's answer, and
   * nothing knows it at the moment the world is built. So there is no seed to mint and no address
   * to name a user row after — `shouldSeedMailbox` already answers `false` for an absent address,
   * which is the whole of what "no seed" needs, and the mirror fills the roster from the host.
   *
   * It is `null` and never `""`. An empty string reads as an address that was configured and is
   * blank, which is a different and wrong claim: `sameOwner("")` matches nothing, so a mirror
   * whose owner was recorded that way would be discarded on every launch.
   */
  address: string | null;
  displayName?: string;
  now: Date;
}

/**
 * Find-or-create the one account and the one user, and — only when the roster says a mailbox is
 * genuinely missing — the SEED mailbox. Idempotent: the second launch finds all three.
 *
 * The account and the user are still exactly one each, for the reasons the header gives. The
 * MAILBOX is not: an install holds as many rows as the person has connected, and this function
 * creates at most the first of them. Every later mailbox arrives through `POST /local/mailboxes`
 * with a probed credential, which is the only way one should — the environment can name one
 * address, and a door that minted rows from it would have no way to prove any of them.
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

  /* ── EVERY ROW THIS INSTALL HOLDS, NOT ONLY THE ONE NAMED BY THE ENVIRONMENT ──────────────
   *
   * This used to be a `limit(1)` lookup of the seed address, because an install had exactly one
   * mailbox and finding it WAS finding the install's mailbox. It is now the whole non-tombstoned
   * set, for two reasons that are really the same one:
   *
   *  · the ROSTER — every live row gets a runtime, so the caller needs them all;
   *  · the SEED DECISION — {@link shouldSeedMailbox} turns on whether ANY other mailbox is live,
   *    not merely on whether this address has a row. Without that, an install whose seed was
   *    removed while a second mailbox remained would mint the seed again on the next launch:
   *    `config.json` still carries the address (removing one of several is not a sign-out), no
   *    active row matches it, and the old rule reads exactly that as "make one".
   *
   * The predicate is UNCHANGED from the single-mailbox version — `status <> 'disabled' or
   * disabled_reason is not null` — and the docblock above still describes it exactly: a reader is
   * live, a paused row (`disabled` WITH a reason) is the same mailbox and must not be duplicated,
   * and a tombstone (`disabled`, reason NULL) is excluded so a re-add mints a fresh row.
   *
   * Ordered active-first and then oldest-first: the first arm is the old lookup's tie-break for
   * one address, the second is the roster's own contract (`LocalRoster` — insertion order is
   * `created_at` order).
   */
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
        /* -- THE PRE-CONSENT STATE IS A READER, ON THIS DOOR TOO ----------------------------
         *
         * This line was `organizeConsentedAt: input.now`, under a docblock headed *"ADDING THE
         * MAILBOX IS THE CONSENT ON THIS DOOR"* whose argument rested on one premise: **"there is
         * no such screen and no such second step here"**. That was true when it was written and
         * it is not true any more. The guided setup flow landed on this door — the connect
         * navigates to `#/first-run`, the consent screen states what will be re-arranged, and
         * "Agree and start organizing" is `POST /local/mailboxes/:id/organize`, which writes the
         * consent, the baseline, the window and the scope in one transaction.
         *
         * With the stamp written HERE, that screen could never be the thing that grants anything.
         * `deriveOnboardingStep`'s consent row is `if (!consented) return "consent"`, so a fresh
         * mailbox skipped straight past it; and the engine's own gate reads the LEASE, where an
         * empty `ohmail/_meta` means "nobody has ever organized this mailbox", which organizes.
         * The measured result on a released build: six folders created and the backlog moved,
         * six seconds after somebody typed a password, with nothing having asked them anything.
         *
         * So the row is created in the state the consult names as the whole answer to this
         * question — *"Connect writes row+credential in one tx as a consent-less reader → mirror
         * builds at once, nothing moves, `ohmail/*` never created … There is no half-applied
         * mailbox because the reader mode IS the pre-consent state"* — which is also exactly what
         * `POST /mailboxes` creates on the hosted door. One shape, two doors.
         *
         * ── AND THE ROLE HAS TO BE WRITTEN, BECAUSE THE COLUMN'S DEFAULT IS THE OTHER ONE ────
         *
         * `organizer_role` is `NOT NULL DEFAULT 'organizer'` (0083, correct for the backfill it
         * was written for), so omitting it here would leave a row saying `organizer` with no
         * consent — the two halves disagreeing, which is the failure shape this area keeps
         * producing. `standDownMemory` already reads the PAIR and answers `null` for "no holder
         * and no consent", so a launch on this row reports itself as never having stood down
         * rather than as demoted; that predicate is what makes this safe and it is already there.
         *
         * The hazard the old docblock named is unchanged and is now correct rather than merely
         * avoided: `authorizeOrganizerTakeover` refuses when `role !== 'reader' && consentedAt
         * !== null` — an install that already organizes. A consent-less reader is precisely the
         * row that SHOULD answer `authorized`, because agreeing is the becoming.
         *
         * A HEADLESS INSTALL is not stranded: `runOrganizeHere` (`organize-here.ts`) is the CLI
         * that writes the same consent, for a machine with no window to show the screen on.
         */
        organizerRole: "reader",
      })
      .returning({ id: mailboxes.id })
  )[0]!.id;

  return { accountId, userId, mailboxId, standDownReason: null, takeoverAuthorizedAt: null };
}

/** One live mailbox, as the boot reads it before building a runtime for it. */
export interface LocalRosterRow {
  id: string;
  address: string;
  displayName: string | null;
  standDownReason: string | null;
  takeoverAuthorizedAt: Date | null;
}

/**
 * EVERY MAILBOX THIS INSTALL RUNS, oldest first — the boot's one roster read.
 *
 * `status <> 'disabled'` and nothing else. That is narrower than the predicate
 * {@link ensureLocalWorld} uses to decide whether a row already exists, and the difference is the
 * point: a paused row (`disabled` WITH a reason) is the same mailbox and must not be duplicated,
 * but it is not RUNNING and must not be given a login, a claim or a poll timer. Being found and
 * being attached are different questions about the same row.
 *
 * ── AND THE STATE THAT ARGUMENT WAS WRITTEN ABOUT NO LONGER SURVIVES THE BOOT ─────────────────
 *
 * It was written about the ≤0.13.x PAUSED row, and for that row it was a one-way door: excluded
 * here means no runtime, so no lease read, so a takeover authorized on it could never be spent.
 * {@link endLegacyOrganizerPauses} ends that state before this read runs, so the exclusion now
 * covers exactly the rows the CURRENT build leaves `disabled` — a tombstone, a row superseded by a
 * live sibling on its address, and whatever a later build pauses. The rule is unchanged; the
 * population it applies to is the one it was always right about.
 *
 * ── READ ONCE, AT BOOT, AND NEVER ON A TIMER ──────────────────────────────────────────────────
 *
 * The hosted worker re-reads its roster periodically because other processes write its
 * `mailboxes` table. Here the only writers are this engine's own routes, so attach and detach are
 * events — `POST /local/mailboxes` and `DELETE /local/mailboxes/:id` — and a poll would be this
 * process asking itself something it already knows.
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
  }));
}

/** One mailbox this install HOLDS and does not RUN, as the boot reports it. */
export interface UnattachedRosterRow {
  id: string;
  /** `organized_elsewhere:*` for a paused row; NULL for a tombstone the person removed. */
  disabledReason: string | null;
}

/**
 * EVERY MAILBOX THIS INSTALL HOLDS AND DOES NOT RUN — {@link loadLocalRoster}'s complement.
 *
 * ── WHY THE COMPLEMENT NEEDS A READER OF ITS OWN ──────────────────────────────────────────────
 *
 * The roster read is `status <> 'disabled'`, and its docblock is right that being FOUND and being
 * ATTACHED are different questions. What nothing answered was the third one: WHICH rows the answer
 * left out. The boot's only line about the roster is a COUNT of what it attached, so an install
 * holding two mailboxes and running one logged `count: 1` and never named the other — and
 * `ensureLocalWorld`'s own lookup is wider (`or disabled_reason is not null`), so the row it left
 * out can be the SEED, whose id the `serving` line then prints. The log said `serving <id>` for the
 * one mailbox this install was not running, which is how an incident on that shape gets read
 * backwards.
 *
 * Separate from the roster read rather than a widening of it, deliberately: three call sites use
 * `loadLocalRoster` to FIND a row by id, and a wider predicate would silently start finding paused
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
 * END A PAUSE A BUILD OLDER THAN MAIL 0083 LEFT — migration 0083's backfill, run again at boot.
 *
 * `disabled` + an `organized_elsewhere:*` reason is the PRE-0083 SPELLING of a reader: the
 * stand-down had nowhere else to write, so it encoded the ROLE in the CONNECTION. A row in that
 * shape is excluded by {@link loadLocalRoster} for ever, which means no runtime, so no lease read,
 * so a takeover authorized on it can never be spent — the pane offers "Organize here instead" and
 * nothing acts on it. 0083's backfill fixed the population once; the 0.13.x stand-down went on
 * writing the shape afterwards, so the predicate has to stay rather than be a migration.
 *
 * THE ROLE IS NOT A TERM OF THE PREDICATE, and reading it as one would leave the ordinary case
 * paused: the 0.13.x write was `{ status: 'disabled', disabledReason, takeoverAuthorizedAt: null }`
 * and named no role at all, so a mailbox this install ORGANIZED keeps `organizer` (the column's
 * default) and only a row that had already been through 0083's backfill says `reader`. Both are
 * the same paused mailbox. 0083's own statement tests the status and the reason and nothing else.
 *
 * IT MAKES A READER, NEVER AN ORGANIZER. One organizer per mailbox is the lease's to enforce and
 * this write claims nothing: the row joins the roster as a reader, with the reason it was paused
 * for kept as `organized_by_kind` so {@link standDownMemory} still answers `organized_elsewhere:*`
 * for it. `disabled_reason` is cleared because a `connected` row carrying one is a row saying two
 * different things about itself, and that column has had no writer since 0083. Becoming an
 * organizer again needs the press, the stamp and the lease, exactly as it does for every reader.
 *
 * THE SIBLING GUARD IS NOT HYPOTHETICAL — it is 0083's, in its words: `mailboxes_active_address_uq`
 * is UNIQUE on `(account_id, lower(address)) WHERE status <> 'disabled'`, and nothing stopped the
 * same address being connected again beside a paused row, so promoting one with a live sibling
 * violates the index and takes the BOOT down. Such a row is genuinely superseded and stays paused.
 * The set of live addresses grows as rows are promoted, so two paused rows on one address promote
 * the OLDEST and leave the rest — the same refusal, one statement later.
 *
 * Keyed on a predicate that is false once it has been done, like the three writes it joins: no
 * marker, no journal entry, and the second boot writes nothing.
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
    /* ── AND THE APPOINTMENTS THIS ROW CAN NO LONGER KEEP ARE CLOSED, AFTER THE REWRITE ──────
     *
     * A pause left by ≤0.13.x can carry a scheduled send from before the handover, and the
     * rewrite is what makes that dangerous: the row goes back to `connected`, where
     * `ScheduleService` and `SendService` accept work — while the scheduled-send pass lives
     * inside the organizer drain a READER never runs. So the appointment would sit saying
     * "Sends Tue 14:50" for a time that has gone, for ever — the orphan a handover's own
     * close exists to prevent, reached by another door, and the census beside that close
     * refuses this site without it.
     *
     * AFTER the update, not before: the close's own precondition is `organizer_role = 'reader'`
     * read `FOR UPDATE` inside its transaction, and the common ≤0.13.x row still says
     * `organizer` — so called first it would refuse and close nothing.
     *
     * NOT in one transaction with the rewrite, which is the shipped stand-down's own ruling
     * ("a stand-down must never be contingent on closing an appointment. A failed close is
     * retried by the launch catch-up while the row still says stood down") — and it holds here
     * for the same reason: the row is attached from this launch on, so its own launch catch-up
     * closes anything a failure here leaves. */
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
 * ── WHY THIS LIVES HERE AND NOT WITH THE ROSTER ────────────────────────────────────────────────
 *
 * It is a question about the roster, so the roster looked like its home — and putting it there was
 * a structural mistake with a census to prove it. `roster.ts` names the worker's sync and profile
 * modules in its types, because the runtime record is shaped by them; `identity.ts` is shared with
 * the CLOUD engine, whose whole safety property is that its module graph cannot reach an organizer.
 * One import across that line put the worker's sync loop and the IMAP adapter into the Cloud
 * engine's graph.
 *
 * The predicate itself needs none of that — it takes four booleans and returns one — and the
 * question it answers ("should this launch create the seed mailbox row?") is an identity question.
 * So it lives beside the function that acts on it, and the edge does not exist.
 */
/**
 * ═══ SHOULD THE SEED ROW BE CREATED? ═══════════════════════════════════════════════════════════
 *
 * The one predicate in this file, and it is a pure function with a table test because getting it
 * wrong is the sharpest hazard in the whole in-place upgrade.
 *
 * Until now the answer was "the environment names a user, so make sure there is a row for it",
 * and that was correct while an install had exactly one mailbox: a launch with `OHMAIL_IMAP_USER`
 * set either found its row or made it. With N rows the same rule RESURRECTS a mailbox somebody
 * removed. `config.json` still carries the seed address after a removal — the shell's sign-out is
 * what clears it, and removing ONE mailbox of several is not a sign-out — so the next launch would
 * find no active row for that address and helpfully mint a fresh one: a credential-less reader row
 * for a mailbox the person deliberately took off this machine, listed in their pane, with no way
 * to tell it from a mailbox they had just added.
 *
 * So the question is asked with the roster in view. Six cases, all of them reachable:
 *
 *  1. FRESH INSTALL — no rows at all, the environment names an address → SEED. This is the only
 *     path onto the first mailbox and it must keep working exactly as it did.
 *  2. 0.13.x UPGRADE — one active row for the seed address → NOTHING. The row is already there;
 *     this is the whole of "nothing moves".
 *  3. REMOVE-THEN-RE-ADD THROUGH THE OLD DOOR — the roster is empty and the address has a
 *     tombstone → SEED. `ensureLocalWorld` correctly does not reuse a tombstone, so this mints a
 *     second row, and that is the 0.13.x behaviour kept deliberately: an install with no mailboxes
 *     at all is an install at first-run, and refusing here would strand it.
 *  4. SEED REMOVED WHILE OTHERS REMAIN — a tombstone for the seed address and ≥1 other live row →
 *     NOTHING. This is the case the old rule got wrong, and the one this predicate exists for.
 *  5. RE-ADD OF A REMOVED ADDRESS THROUGH "Add mailbox" → NOTHING here; the route makes the row,
 *     with a probed credential, which is the only way a mailbox should arrive after the first.
 *  6. NO ADDRESS AT ALL (no `OHMAIL_IMAP_USER`, no `config.address`) → NOTHING. There is nothing
 *     to name a row after, and inventing one is how an install acquires a mailbox nobody asked
 *     for.
 *
 * Note which way cases 3 and 4 differ: the SAME tombstone, and the answer turns on whether any
 * other live row exists. That is the whole rule, and it is why "is the roster empty" is an
 * argument rather than something inferred from the address.
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
