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
  /** The mailbox this install organizes. Doubles as the local user's address. */
  address: string;
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
          email: input.address.toLowerCase(),
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
      organizeConsentedAt: mailboxes.organizeConsentedAt,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
    })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      sql`(${mailboxes.status} <> 'disabled' or ${mailboxes.disabledReason} is not null)`,
    ))
    .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`, mailboxes.createdAt, mailboxes.id);

  const wanted = input.address.trim().toLowerCase();
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
    seedAddress: input.address,
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
        address: input.address,
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
