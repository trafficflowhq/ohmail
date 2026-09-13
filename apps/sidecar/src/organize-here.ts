import { and, eq, ne, sql } from "drizzle-orm";
import { accountSettings, mailboxes, standDownMemory, type OrganizerIntent,} from "@trafficflow/db";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
// The product default and the scope union, from the ONE place that owns them — never a second
// literal `60` and never a hand-written string union. `consent-cutline.ts` re-exports these from
// core for the same reason and its header says so.
import { DEFAULT_DORMANCY_DAYS, type ScreeningScope } from "@trafficflow/core/mail";
import { openLocalDb, type LocalDb } from "./db.js";

/**
 * "Organize this mailbox from this machine" — the one action that ends a stand-down, inside the
 * invariant EXACTLY ONE ACTIVE ORGANIZER PER MAILBOX (two would classify one message and issue
 * competing moves). The claim lives in `ohmail/_meta`, but standing down must OUTLIVE the process,
 * and once the other organizer releases that folder is empty and reads as "nobody has ever organized
 * this" (which organizes) — so the local row records the stand-down and this is its exit. Clearing
 * the reason alone is not enough: a QUIET claim is not absent (the lease refuses it, so without the
 * stamp the install stands down again), and a reason-less disabled row is a TOMBSTONE (a second row
 * on re-add). So status, reason and stamp move in one write; the authorization is ONE-SHOT.
 */

/** What {@link authorizeOrganizerTakeover} found, and therefore what it did. */
export type TakeoverAuthorizationOutcome =
  /** The mailbox was stood down. It is now clear to organize, and one takeover is authorized. */
  | "authorized"
  /**
   * The mailbox is not stood down; this install already organizes it, so no stamp is written and
   * none may be — a second press is not a second becoming. That is a statement about the MAILBOX
   * ROW, and never about `account_settings`: {@link requestOrganizerTakeover} (the button and
   * setup flow) writes the window and scope when a `screening` answer rides along, and BOTH doors
   * write the settings record itself where none is readable ({@link settingsRecordReadable}) —
   * a consent whose record never existed is not a consent that has already been written down. A
   * readable record is left alone on either door. It can throw a `LocalConsentRefusal` from the
   * window write, on the first-consent path's bounds.
   */
  | "already_organizing"
  /** The mailbox was REMOVED from this install, which is not a stand-down. Nothing was written. */
  | "removed"
  /** This install has no mailbox for that address at all. Nothing was written. */
  | "no_mailbox";

export interface TakeoverAuthorizationResult {
  outcome: TakeoverAuthorizationOutcome;
  /** The reason the mailbox was stood down, when it was. */
  previousReason: string | null;
  mailboxId: string | null;
}

export interface AuthorizeTakeoverInput {
  /**
   * WHICH MAILBOX — by address or by id, and exactly one of them.
   *
   * The CLI has only an address: it reads the same environment the engine does, and the mailbox
   * is named once there. The Settings pane has only an id, because it is looking at a row it
   * already fetched — and an address would be strictly worse there, since the pane folds two
   * rows for one address (a live one and a superseded tombstone) and the address alone cannot
   * say which of them the person pressed. The address arm keeps its ordering rule for the same
   * reason; the id arm needs none.
   */
  address?: string;
  mailboxId?: string;
  now: Date;
  /**
   * WHICH VERB WAS PRESSED — required on both doors, for `MailboxService.organizeHere`'s reason.
   * The stamp says a person asked; only this says what they asked for, and the lease's rule 6
   * consults it at the fence. Every caller in this package passes `"takeover"`: this install has
   * a takeover verb and that is what its two doors mean.
   */
  intent: OrganizerIntent;
}

/**
 * Record that a human has asked this install to organize this mailbox. Writes nothing unless there
 * is a stand-down to end, so running it twice is harmless and running it on a healthy mailbox is a
 * no-op rather than a fresh authorization left lying around. It does NOT decide whether the takeover
 * succeeds: the mailbox is still the authority — the next launch reads the lease first, and an
 * organizer still actively renewing its claim keeps the mailbox regardless of what was authorized
 * here. That ordering is the point — this grants permission to ASK, never permission to WIN.
 */
export async function authorizeOrganizerTakeover(
  db: LocalDb,
  input: AuthorizeTakeoverInput,
): Promise<TakeoverAuthorizationResult> {
  if (!input.address && !input.mailboxId) {
    throw new Error("authorizeOrganizerTakeover: one of address or mailboxId is required");
  }
  const [row] = await db
    .select({
      id: mailboxes.id,
      /* THE ACCOUNT THAT OWNS THIS MAILBOX, and therefore the one whose screening baseline this
         consent establishes. Read off the row rather than taken from the caller: the baseline is
         now stamped by EVERY door, including the two that ask no window and were given no account,
         and a stamp a caller can forget to enable is the defect this closes. */
      accountId: mailboxes.accountId,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
      // Mail 0083 — the precondition moved off `status`. A demoted install is now `connected`
      // with `organizer_role = 'reader'`, so a `status = 'disabled'` test matches nothing this
      // build writes; and a mailbox NOBODY has consented to organize is the second state this
      // ceremony serves, which `status` could never express at all.
      organizerRole: mailboxes.organizerRole,
      // Mail 0083 — and it is here for `previousReason`, not for the preconditions above. The
      // stand-down's WHO moved onto this column when `disabled_reason` lost its writer, so it is
      // what `standDownMemory` recomposes the reason from.
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
      /* The countermand's own term — see the precondition below. */
      releaseRequestedAt: mailboxes.releaseRequestedAt,
    })
    .from(mailboxes)
    .where(input.mailboxId
      ? eq(mailboxes.id, input.mailboxId)
      : sql`lower(${mailboxes.address}) = ${input.address!.toLowerCase()}`)
    .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`)
    .limit(1);

  if (!row) return { outcome: "no_mailbox", previousReason: null, mailboxId: null };
  // A tombstone is checked FIRST (mail 0083). A removed mailbox keeps whatever role it had — a
  // removal demotes nothing, it retires the row — so asking about the role first would answer
  // `already_organizing` about a mailbox the person deleted. Re-adding it is a different action
  // with different consequences, and quietly converting one into the other here would resurrect a
  // mailbox somebody deliberately took off this machine.
  if (row.status === "disabled") {
    return { outcome: "removed", previousReason: null, mailboxId: row.id };
  }
  // Already the organizer AND already consented ⇒ nothing to ask for. Both terms: a mailbox that
  // is nominally an organizer but has never been consented to is exactly the FIRST-consent case
  // this ceremony now serves, and refusing it here would leave that case with no door.
  /* A pending release is claim-back-eligible, and without this "I changed my mind" had no door. The
   * hosted door already rules this (`mailbox-service.ts`, `releasePending`): press "Stop organizing
   * here", change your mind, press "Organize here" → `already_organizing`, no stamp, and the gate
   * releases the mailbox a minute later anyway — contradictory instructions where the LATER press is
   * the one meant. That exemption was never ported here, so the row is still `organizer` and consented
   * while the release is pending, both terms below held, and the press wrote nothing. It matters more
   * since a release that the server would not confirm stands until a pass can read `ohmail/_meta`, so
   * on a failing server this press is the only way out. A healthy organizer row with no request
   * standing is untouched — a second press is still not a second becoming. */
  if (
    row.releaseRequestedAt === null
    && row.organizerRole !== "reader" && row.organizeConsentedAt !== null
  ) {
    /* The same half the local door's arm was missing, on the door beside it — see
     * {@link settingsRecordReadable}. This arm asks no window at all, so before this it returned
     * having touched nothing whatever the account's settings looked like. */
    if (!(await settingsRecordReadable(db, row.accountId))) {
      await db.transaction(async (tx) => {
        await writeConsentScreening(tx, dialect(db), { accountId: row.accountId, now: input.now });
      });
    }
    return { outcome: "already_organizing", previousReason: null, mailboxId: row.id };
  }

  // CONSENT AND STAMP IN ONE WRITE — and the role is deliberately NOT among them. The GATE
  // promotes: the next launch reads `ohmail/_meta` and decides, and an organizer that is still
  // renewing keeps the mailbox whatever was asked here. Flipping the role from a CLI would be a
  // command line deciding who organizes a mailbox with no reference to the mailbox itself.
  //
  // `coalesce` on the consent so a re-run does not move the record of when the person first
  // agreed; the stamp is unconditional because it authorizes THIS becoming.

  // ONE TRANSACTION, SETTINGS FIRST. This arm asks no window and for that reason alone wrote no
  // `account_settings` row at all, leaving a consented mailbox with no cutoff. Settings before the
  // mailbox row is the order every other writer of that table takes, so the lock chain runs one way.
  await db.transaction(async (tx) => {
    await writeConsentScreening(tx, dialect(db), { accountId: row.accountId, now: input.now });
    await tx
      .update(mailboxes)
      .set({
        disabledReason: null,
        // The instant goes through the seam, which answers the ORIGINAL reason and a second one.
        // The original: a bare `Date` inside a raw `sql` fragment has no column type to coerce
        // against, so postgres-js binds it as TEXT and throws. The second: the two stores keep an
        // instant as different literals — an ISO string here, a count of milliseconds on a device —
        // and a `coalesce` handed the wrong one does not fail, it stores a value the column's own
        // reader cannot turn back into a date.
        organizeConsentedAt: sql`coalesce(${mailboxes.organizeConsentedAt}, ${dialect(db).ts(input.now)})`,
        takeoverAuthorizedAt: input.now,
        // …AND THE VERB, in the same write as the stamp: the gate reads the row once, so a row that
        // says a press happened and cannot say what it asked for must never exist.
        takeoverIntent: input.intent,
        /* AND THE REQUEST IS CANCELLED IN THE SAME WRITE, which is the half that makes the press a
           countermand rather than a second instruction beside the first. Left standing, the poll's
           release arm reaches it again on the very next pass and spends the stamp this write just
           made — the press destroyed one poll later instead of immediately. The hosted door cancels
           it in its own claim-back transaction for exactly this reason. */
        releaseRequestedAt: null,
      })
      .where(and(eq(mailboxes.id, row.id), ne(mailboxes.status, "disabled")));
  });

  /* -- `previousReason` IS DERIVED, AND READING THE COLUMN RETURNED NULL FOR A YEAR OF ROWS --
   *
   * This was `row.disabledReason`. Mail 0083 stopped writing that column — the demotion records
   * the ROLE and leaves the row `connected` — so from that migration onward every authorized
   * reclaim reported "no previous reason" for a mailbox that had very obviously been handed to
   * somebody. It is what the CLI prints and what the Settings press shows the person, so the one
   * sentence they get about what they just took the mailbox back FROM was blank.
   */
  return { outcome: "authorized", previousReason: standDownMemory(row), mailboxId: row.id };
}

/**
 * The same request, made while the engine is running — the Settings action's half. It cannot be
 * {@link authorizeOrganizerTakeover}, which moves status, reason and stamp together: right for the
 * CLI (the engine is not running when it lands), but from a button this process keeps serving after
 * the press — stood down, `stopped` set, poll timer cleared, login closed — and a row flipped to
 * `connected` here would advertise a mailbox nothing organizes, and `ScheduleService`/`SendService`
 * (refusing only on `status = 'disabled'`) would accept work for it. So the STAMP travels alone: the
 * row stays `disabled`, and the ENGINE spends it at its next assembly before it reads the lease —
 * the CLI's timing, no serving process between. Idempotent; the lease is still the authority.
 */
/**
 * The screening answer the consent carries — the half this door was missing. This wrote
 * `organize_consented_at` and `takeover_authorized_at` and nothing else, so `account_settings` was
 * never touched and `screening_baseline_at` stayed NULL — and the cutline reads
 * `(screeningBaselineAt ?? now()) - dormancyDays`, so the window is measured from the read, not from
 * consent: a mailbox with years of history has its ENTIRE backlog fall outside it and move to
 * `ohmail/Screener`, whatever window was chosen. The hosted door always wrote all four in one
 * transaction (`MailboxService.organizeHere`), and this is that shape brought across. It cannot be a
 * second request — the gap in which consent exists and the window does not applies the default.
 */
export interface LocalScreeningConsent {
  /** 1–365. Absent means "the person did not move the dial" and the default is stored as NULL. */
  dormancyDays?: number;
  /** `window` screens by the dial; `all_time` screens the whole history the baseline sits above. */
  scope?: ScreeningScope;
}

/** A screening answer this install refuses to store — the bounds, restated as the hosted door's. */
export class LocalConsentRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConsentRefusal";
  }
}

/** The handle a `db.transaction` callback is given — derived, so it cannot drift from `LocalDb`. */
type LocalTx = Parameters<Parameters<LocalDb["transaction"]>[0]>[0];

/**
 * THE ONE WRITER OF `screening_baseline_at` ON THIS DOOR — and it always writes it.
 *
 * The baseline is a property of "this mailbox is organized from now", not of a request field. It
 * was stamped only when a window rode along, so the doors that ask none left it NULL — "no cutoff",
 * which holds a sender’s mail whatever its age. The dials are OPTIONAL, being the answer to a
 * second question; the stamp is not, being the answer to the first. `coalesce` in SQL rather than
 * read-then-write, so two racing consents produce ONE baseline and a re-run cannot slide a live
 * install’s cutline forward.
 */
async function writeConsentScreening(
  tx: LocalTx,
  /* HANDED IN, never looked up from `tx`. A transaction object is built by the query builder and
     carries no dialect brand of its own, so resolving it here would throw inside the one block
     where the write must succeed. The caller has the handle that knows. */
  d: Dialect,
  o: {
    accountId: string; now: Date;
    /** The window just chosen, when the door asked for one. Absent ⇒ consent alone. */
    dials?: { days: number | undefined; scope: ScreeningScope };
  },
): Promise<void> {
  // NEVER STORE THE DEFAULT for the dial — `setDormancyDays`' rule and the hosted door's,
  // verbatim, so the product default can move without rewriting every install that never
  // chose. NULL here reads back as the default, and that is the point.
  const dials = o.dials === undefined
    ? {}
    : {
        dormancyDays:
          o.dials.days === undefined || o.dials.days === DEFAULT_DORMANCY_DAYS ? null : o.dials.days,
        screeningScope: o.dials.scope,
      };
  await tx.insert(accountSettings)
    .values({
      accountId: o.accountId,
      // Spread rather than written twice: a door that asked nothing must leave the scope at the
      // column's own default, and naming it here would store a choice nobody made.
      ...dials,
      screeningBaselineAt: o.now,
      updatedAt: o.now,
    })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: {
        // The two dials ARE the answer the person just gave, so they are overwritten.
        ...dials,
        screeningBaselineAt: sql`coalesce(${accountSettings.screeningBaselineAt}, ${d.ts(o.now)})`,
        updatedAt: o.now,
      },
    });
}

/**
 * IS THERE A SETTINGS RECORD TO MEASURE A WINDOW FROM — the question the `already_organizing`
 * arms never asked.
 *
 * Those arms answer about the MAILBOX ROW, and both read "the row already says so" as "everything
 * this press would write is already written". Measured on the 0.18.0 release candidate: a consented, organizing
 * mailbox whose account had no `account_settings` row at all, so the cutline was measured from
 * the moment of each later READ instead of from the agreement — no cutoff, and a row that reads
 * healthy while nothing is filed where the person expects.
 *
 * A row with a NULL baseline is not readable for this purpose either: it is a record that cannot
 * answer the question, which is the same damage under a row that exists.
 */
async function settingsRecordReadable(db: LocalDb, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ baseline: accountSettings.screeningBaselineAt })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId))
    .limit(1);
  return row !== undefined && row.baseline !== null;
}

export async function requestOrganizerTakeover(
  db: LocalDb,
  input: {
    mailboxId: string; now: Date;
    /**
     * WHICH VERB WAS PRESSED — required on both doors, for `MailboxService.organizeHere`'s reason.
     * The stamp says a person asked; only this says what they asked for, and the lease's rule 6
     * consults it at the fence. Every caller in this package passes `"takeover"`: this install has
     * a takeover verb and that is what its two doors mean.
     */
    intent: OrganizerIntent;
    /**
     * THE ACCOUNT THE CALLER BELIEVES THIS MAILBOX BELONGS TO — an assertion, not the source.
     *
     * The write reads the owning account off the mailbox ROW, because the baseline is stamped by
     * every door and two of them are given no account at all. This stays required WITH `screening`
     * and is compared against the row: a caller naming a different account is refused rather than
     * writing one account’s settings for another’s consent.
     */
    accountId?: string;
    /** See {@link LocalScreeningConsent}. Absent ⇒ the Settings claim-back, which asks nothing. */
    screening?: LocalScreeningConsent;
  },
): Promise<TakeoverAuthorizationResult> {
  /* -- THE BOUNDS ARE CHECKED BEFORE THE TRANSACTION, AND THEY THROW -------------------------
   *
   * `MailboxService.organizeHere` throws a 400 for both of these and the local door must not be
   * more permissive than the hosted one about what it will store: a `dormancyDays` of 0 or
   * 100000 is a cutline nobody can reason about, and an unknown scope is a string the read side
   * has no branch for. Outside the transaction because a refusal must write nothing at all, and
   * because a validation failure is not a database concern.
   */
  const days = input.screening?.dormancyDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
    throw new LocalConsentRefusal("dormancyDays must be an integer between 1 and 365");
  }
  const scope: ScreeningScope = input.screening?.scope ?? "window";
  if (scope !== "window" && scope !== "all_time") {
    throw new LocalConsentRefusal("screeningScope must be window or all_time");
  }
  if (input.screening && !input.accountId) {
    throw new LocalConsentRefusal("accountId is required when a screening answer is supplied");
  }
  const [row] = await db
    .select({
      id: mailboxes.id,
      /* THE ACCOUNT THAT OWNS THIS MAILBOX, and therefore the one whose screening baseline this
         consent establishes. Read off the row rather than taken from the caller: the baseline is
         now stamped by EVERY door, including the two that ask no window and were given no account,
         and a stamp a caller can forget to enable is the defect this closes. */
      accountId: mailboxes.accountId,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
      // Mail 0083 — the precondition moved off `status`. A demoted install is now `connected`
      // with `organizer_role = 'reader'`, so a `status = 'disabled'` test matches nothing this
      // build writes; and a mailbox NOBODY has consented to organize is the second state this
      // ceremony serves, which `status` could never express at all.
      organizerRole: mailboxes.organizerRole,
      // Mail 0083 — and it is here for `previousReason`, not for the preconditions above. The
      // stand-down's WHO moved onto this column when `disabled_reason` lost its writer, so it is
      // what `standDownMemory` recomposes the reason from.
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
      /* The countermand's own term — see the precondition below, and its twin in the CLI arm. */
      releaseRequestedAt: mailboxes.releaseRequestedAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, input.mailboxId))
    .limit(1);

  if (!row) return { outcome: "no_mailbox", previousReason: null, mailboxId: null };
  /* THE CALLER’S ACCOUNT IS AN ASSERTION, CHECKED. The screening state is keyed by account and
     the baseline is now read off the ROW, so a caller naming a different account would have been
     writing one account’s settings for another’s consent — silently, on a store with two. Before
     any write, and before the outcomes below, because a mismatch is a caller bug and not an
     answer about this mailbox. */
  if (input.accountId !== undefined && input.accountId !== row.accountId) {
    throw new LocalConsentRefusal("accountId does not own this mailbox");
  }
  // The tombstone first, then the role — see the CLI arm above for why that order.
  if (row.status === "disabled") {
    return { outcome: "removed", previousReason: null, mailboxId: row.id };
  }
  /* A pending release is claim-back-eligible, and without this "I changed my mind" had no door. The
   * hosted door already rules this (`mailbox-service.ts`, `releasePending`): press "Stop organizing
   * here", change your mind, press "Organize here" → `already_organizing`, no stamp, and the gate
   * releases the mailbox a minute later anyway — contradictory instructions where the LATER press is
   * the one meant. That exemption was never ported here, so the row is still `organizer` and consented
   * while the release is pending, both terms below held, and the press wrote nothing. It matters more
   * since a release that the server would not confirm stands until a pass can read `ohmail/_meta`, so
   * on a failing server this press is the only way out. A healthy organizer row with no request
   * standing is untouched — a second press is still not a second becoming. */
  if (
    row.releaseRequestedAt === null
    && row.organizerRole !== "reader" && row.organizeConsentedAt !== null
  ) {
    /* Already organizing, and the window still has to land. This returned here and wrote nothing,
     * making "How far back" DECORATIVE on every re-run: somebody widening their history to all time
     * pressed "Agree and start organizing", got a 200, and kept the window they had. The precondition
     * is about the MAILBOX ROW — so a second press is not a second becoming and leaves no spendable
     * takeover stamp — which is not an argument about `account_settings`. The window and scope ARE
     * the answer just given and the whole reason the screen has a button, so the stamp stays refused
     * and the dials are written; the baseline cannot move (its upsert is a `coalesce`). Its own
     * transaction, because there is no mailbox write here to share one with. */
    /* ── AND THE RECORD ITSELF, WHEN THERE IS NONE TO BE ALREADY-WRITTEN ──────────────────
     *
     * `already_organizing` is about the MAILBOX ROW and has never been an argument about
     * `account_settings` — the arm above already writes the dials for that reason. The half it
     * missed is the record's EXISTENCE: a press over an account with no settings record answered
     * "the row already says so" and left the account with no cutline for the life of the install.
     *
     * Only where none is readable, which is the narrow condition and deliberately not "stamp on
     * every press": that was tried and is wrong, because a press that asks no window must not
     * slide a LIVE account's cutline forward. Where there is no cutline there is nothing to
     * slide, and `writeConsentScreening`'s own `coalesce` keeps the other direction safe. */
    if (input.screening || !(await settingsRecordReadable(db, row.accountId))) {
      await db.transaction(async (tx) => {
        await writeConsentScreening(tx, dialect(db), {
          accountId: row.accountId, now: input.now,
          ...(input.screening ? { dials: { days, scope } } : {}),
        });
      });
    }
    return { outcome: "already_organizing", previousReason: null, mailboxId: row.id };
  }

  /* -- ONE TRANSACTION, BECAUSE THE CONSENT AND THE WINDOW ARE ONE ANSWER --------------------
   *
   * The settings upsert goes FIRST and the mailbox row second — the same order every other
   * writer of `account_settings` takes (`setDormancyDays`, `setThemeFace`, the hosted
   * `organizeHere`), so the lock chain runs one direction and these cannot deadlock against
   * them. A crash between the two would otherwise leave a consented mailbox with no baseline,
   * which is the exact defect this closes, reached by a narrower window.
   */
  await db.transaction(async (tx) => {
    /* UNCONDITIONAL. The window, when one came, only chooses the DIALS; the baseline is stamped
       because somebody consented, which is the same fact whether or not the door asked a second
       question. Guarded by `if (input.screening)` this left "Organize from this machine" — a door
       that asks nothing — writing a consent with no cutoff. */
    await writeConsentScreening(tx, dialect(db), {
      accountId: row.accountId, now: input.now,
      ...(input.screening ? { dials: { days, scope } } : {}),
    });
    await tx
      .update(mailboxes)
      .set({
        // Through the seam, for the two reasons the sibling write above spells out: the bare
        // `Date` postgres-js refuses, and the instant literal the two stores disagree about.
        organizeConsentedAt: sql`coalesce(${mailboxes.organizeConsentedAt}, ${dialect(db).ts(input.now)})`,
        takeoverAuthorizedAt: input.now,
        // …AND THE VERB, in the same write as the stamp — see the CLI door above.
        takeoverIntent: input.intent,
        /* Cancelled here for the reason its twin in the CLI arm gives: a request left standing is
           spent by the very next release pass, which destroys the press one poll later. */
        releaseRequestedAt: null,
      })
      .where(and(eq(mailboxes.id, row.id), ne(mailboxes.status, "disabled")));
  });

  // Derived, for the reason the CLI arm above gives — this is the half the Settings button uses.
  return { outcome: "authorized", previousReason: standDownMemory(row), mailboxId: row.id };
}

/** What the command says for each outcome. One line each; nothing needs a paragraph. */
export const TAKEOVER_MESSAGES: Record<TakeoverAuthorizationOutcome, string> = {
  authorized:
    "Authorized. This machine organizes this mailbox on its next pass — no restart. " +
    "If another organizer is still active, it keeps the mailbox and this machine goes on reading it.",
  /* "Nothing to do" was the whole sentence, and it is no longer true on every press: a mailbox
     whose account has no settings record gets one written here. Narrowed rather than dropped —
     what a person needs from this line is that no takeover was authorized. */
  already_organizing: "This machine already organizes that mailbox. No takeover was authorized.",
  removed: "That mailbox was removed from this machine. Add it again rather than authorizing a takeover.",
  no_mailbox: "This machine has no mailbox for that address.",
};

/**
 * The command's body. `organize-here-cli.ts` is what RUNS it, and the separation is deliberate:
 * this module is imported by the engine, and a module the engine imports must never execute
 * itself. See that file for what happens when it does.
 *
 * Reads the same environment the engine does, so the mailbox is named exactly once. It needs the
 * database to itself: the engine holds an exclusive lock on the data directory while it runs, and
 * two processes on one local database corrupt it. Stop ohmail, run this, start ohmail.
 */
export async function runOrganizeHere(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dataDir = env.OHMAIL_DATA_DIR;
  const address = env.OHMAIL_MAILBOX_ADDRESS ?? env.OHMAIL_IMAP_USER;
  if (!dataDir || !address) {
    process.stderr.write(
      "OHMAIL_DATA_DIR and one of OHMAIL_MAILBOX_ADDRESS or OHMAIL_IMAP_USER are required.\n",
    );
    return 2;
  }

  const opened = await openLocalDb(dataDir);
  try {
    /* `"takeover"`, as the command's own name says: `organize-here` is a person at this machine
       asking for this mailbox whoever holds it. */
    const result = await authorizeOrganizerTakeover(
      opened.db, { address, now: new Date(), intent: "takeover" },
    );
    process.stdout.write(`${TAKEOVER_MESSAGES[result.outcome]}\n`);
    return result.outcome === "authorized" ? 0 : 1;
  } finally {
    await opened.close();
  }
}
