import { sql, type SQL } from "drizzle-orm";
import { DEFAULT_DORMANCY_DAYS, type ScreeningScope } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
import { activeSenderExpr, anyOf, resolveCutline } from "@trafficflow/db";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CUTLINE, SERVER-SIDE — how many senders are still owed a decision.

   The client computes this over its own mirror, because that is where the Screener is drawn
   from. This is the same question asked of the database, for the callers that have no mirror:
   anything that wants to know whether an account still has screening work waiting.

   The two must agree, and they are two implementations, so `consent-cutline.pg.test.ts` runs
   both over the same rows and requires the same answer. That is the only thing standing between
   them and the ordinary fate of a rule written twice.

   ── WHAT COUNTS AS A DECISION ────────────────────────────────────────────────────────────

   An enabled rule naming the sender or their domain, whose destination is not the Screener
   itself. A rule pointing AT the Screener says "keep holding this one", which is the absence of
   a decision written down, and reading it as one would exempt that sender from the cutline for
   ever.

   ── AND WHAT THE WINDOW IS MEASURED FROM ─────────────────────────────────────────────────

   `now`, until the account has a `screening_baseline_at` (mail 0056); that instant afterwards.
   See {@link CutlineOptions.baselineAt}, and the client's `ConsentOptions.baselineAt` for the
   full argument — the two files implement one rule and the parity test is what keeps them from
   drifting.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Days of quiet before a sender stops being asked about. MUST equal the client engine's
 * `DEFAULT_DORMANCY_DAYS`; the parity test pins the two together.
 *
 * RE-EXPORTED from core rather than declared here. It used to be a second literal `60`, and the
 * worker's router cutoff (mail 0056) would have made it a third — in a package that cannot import
 * this one. Core is the only place all three consumers can reach, so the number lives there and
 * this name goes on pointing at it; every existing importer is unaffected, and the parity test
 * still pins the client engine's independent copy against it.
 */
export { DEFAULT_DORMANCY_DAYS };
export type { ScreeningScope };

/** Folders the product presents. A Sent folder, or any of the user's own, is not one of them. */
const PRESENTED_FOLDERS = [
  "INBOX", "ohmail/Screener", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];

/**
 * The two folders a message can sit in without any decision standing behind it.
 *
 * MUST equal the client engine's `UNDECIDED_RESIDENCES`, and it is the half of the rule this
 * file did not have. `inbound` admitted all six presented folders and classified every sender in
 * them, so a sender whose only mail is in Reads, Receipts, Screened or Quarantine — mail somebody
 * has already filed — was counted as still owed a decision. Measured against the client over the
 * same rows: three active undecided senders here, one there.
 *
 * The client is the one that matches the written design, and says so at the bail it takes:
 * *"Mail anywhere else — Reads, Receipts, Screened, Quarantine — is already where somebody put
 * it. An explicit placement is itself an answer."* `GET /consent` reports this number to the
 * user, so the server counting people nobody will ever be asked about is a number nobody can act
 * on: the queue will never contain them.
 *
 * ── AND WHY THIS IS NOT SIMPLY `AND fs.desired_folder IN (…)` ON `inbound` ─────────────────
 *
 * That would restrict the ACTIVITY test as well, and the client does not. `senderActivity` runs
 * over every presented folder before the residence bail is reached, so a sender with old read
 * mail at the gate and unread mail in Reads is ACTIVE on the client. Narrowing `inbound` would
 * make the server call them dormant — trading one disagreement for another, in a case the
 * parity fixture would not have shown either. So the six-folder scan stays, and the residence
 * test is a per-sender flag applied at the count.
 */
const UNDECIDED_RESIDENCES = ["INBOX", "ohmail/Screener"];

export interface CutlineCounts {
  /**
   * Senders with a decision behind them, whichever way it went. Counted over every presented
   * folder — a decision is a rule, and a rule is true of a sender wherever their mail sits.
   */
  decidedSenders: number;
  /**
   * No decision, mail still in an undecided residence, and either unread mail or something
   * recent. These are the queue.
   */
  activeUndecidedSenders: number;
  /**
   * No decision, mail still in an undecided residence, nothing recent. They wait in History and
   * are never asked about.
   */
  dormantUndecidedSenders: number;
}

export interface CutlineOptions {
  /** Days. Defaults to {@link DEFAULT_DORMANCY_DAYS}. */
  dormancyDays?: number;
  /**
   * WHEN THIS ACCOUNT FINISHED SCREENING ITS BACKLOG (`account_settings.screening_baseline_at`,
   * mail 0056), or `null`/absent for an account that has never decided anything.
   *
   * The client engine's `ConsentOptions.baselineAt` carries the whole argument — the resurrection
   * it stops, why the narrowing is gated on the baseline being PRESENT rather than folded into a
   * `?? now()` default, and why that distinction is a live account's Screener queue. **Both files
   * must implement the same rule and `consent-cutline.pg.test.ts` runs them over the same rows;
   * this one is the SQL half and nothing about it may be reasoned about separately.**
   *
   * `null`/absent ⇒ cutoff `now - dormancyDays` and unread outranking age ⇒ byte-identical counts
   * to before this field existed.
   */
  baselineAt?: Date | null;
  /**
   * SCREENING SCOPE — `account_settings.screening_scope` (mail 0083). Absent ⇒ `'window'` ⇒
   * byte-identical counts to before this field existed.
   *
   * `'all_time'` means the person asked for everything to be screened, so NOTHING is dormant:
   * every undecided sender is active-undecided and the History pile has nobody in it who was
   * never asked about. It is a MODE and not a window value — `dormancyDays` is bounded 1-365, so
   * no number in it can say this — and it is implemented in BOTH cutline implementations plus
   * `resolveScreeningCutoff`, pinned together by `consent-cutline.pg.test.ts`.
   */
  scope?: ScreeningScope | string | null;
}

/**
 * One pass over the account's senders.
 *
 * Mail the USER wrote is excluded by address rather than by folder name: a Sent folder is called
 * a dozen different things, and counting the user as one of their own correspondents would make
 * every account permanently active.
 */
export async function cutlineCounts(
  ctx: ServiceContext, opts: CutlineOptions = {},
): Promise<CutlineCounts> {
  /* THE RESOLUTION AND THE ACTIVE TEST BOTH COME FROM `@trafficflow/db#screener-cutline`.
   *
   * They were spelled here, and only here, which is how `GET /screener` came to list every sender
   * whose mail sits in the Screener folder while this function counted the ones still worth a
   * decision — an order of magnitude apart on a mailbox with years of history. The rule now has
   * one implementation and three readers: this count, the queue's page, the auto-suggest set. */
  const resolved = resolveCutline({
    baselineAt: opts.baselineAt ?? null,
    dormancyDays: opts.dormancyDays ?? null,
    scope: opts.scope ?? null,
    now: ctx.now(),
  });
  const cutoff = resolved.cutoff;
  const baselined = resolved.baselined;
  /**
   * ALL TIME ⇒ NO DORMANCY (mail 0083). See {@link CutlineOptions.scope}.
   *
   * Expressed as the ACTIVITY predicate rather than by moving the cutoff, and the difference is
   * not cosmetic: a cutoff pushed to epoch 0 would still be a date comparison, so a message with
   * a NULL `date` — which every arm here treats as "not recent", deliberately — would still be
   * read as dormant. Under this mode a sender with mail in an undecided residence is active
   * BECAUSE they have undecided mail, full stop, and nothing about a header decides it.
   */
  const allTime = resolved.allTime;
  const folders = sql`(${sql.join(PRESENTED_FOLDERS.map((f) => sql`${f}`), sql`, `)})`;
  const undecidedResidences = sql`(${sql.join(UNDECIDED_RESIDENCES.map((f) => sql`${f}`), sql`, `)})`;

  /**
   * FOUR CONSTRUCTS HERE SPELL DIFFERENTLY ON THE TWO STORES, and three of them were invisible to
   * the construct census until this file was read: `bool_or`, `position(x IN y)` and
   * `substring(x FROM n)` are SQL SYNTAX whose separator is a keyword, so no list of function
   * names could ever have matched them.
   *
   * `bool_or` needs no member — `max(case when … then 1 else 0 end) = 1` is the same question in
   * a spelling both stores accept, and a member for something already expressible on both would
   * be a third dialect nobody tests. The other two do: the server's take keywords where this
   * store takes commas, and `strpos` puts its arguments in the opposite order.
   */
  const d = dialect(ctx.db);
  // `anyOf` and the ACTIVE test come from `@trafficflow/db#screener-cutline`, which owns the rule
  // for all three readers. It was a closure here while this was the only one.
  const rows = await d.exec(ctx.db, sql`
    with own as (
      select lower(address) a from mailboxes where account_id = ${d.castUuid(ctx.accountId)}
    ),
    decided_sender as (
      select lower(match) m from rules
       where account_id = ${d.castUuid(ctx.accountId)} and enabled
         and kind = 'sender' and destination <> 'ohmail/Screener'
    ),
    decided_domain as (
      select lower(match) m from rules
       where account_id = ${d.castUuid(ctx.accountId)} and enabled
         and kind = 'domain' and destination <> 'ohmail/Screener'
    ),
    inbound as (
      select lower(m.from_address) addr,
             ${anyOf(sql`m.unread`)} any_unread,
             -- The BASELINED unread term: unread AND inside the window. The null test is explicit
             -- because a message with no Date header must not count as recent here, exactly as
             -- the client's messageMs answers null for one. (NO BACKTICKS anywhere in this
             -- template literal: one of them ends the tagged template and the file stops
             -- compiling, with the error pointing at a line some distance away.)
             ${anyOf(sql`m.unread and m.date is not null and m.date >= ${d.ts(cutoff)}`)}
               as any_unread_in_window,
             max(m.date) newest,
             -- Does this sender have ANY mail still sitting where no decision has been made?
             -- Activity is measured over all six presented folders (above); membership in the
             -- undecided counts is not. See UNDECIDED_RESIDENCES.
             ${anyOf(sql`fs.desired_folder in ${undecidedResidences}`)} as undecided_residence
        from messages m
        join folder_state fs on fs.message_id = m.id
       where m.account_id = ${d.castUuid(ctx.accountId)}
         and fs.desired_folder in ${folders}
         and lower(m.from_address) not in (select a from own)
       group by 1
    ),
    classified as (
      select i.addr, i.undecided_residence,
             (exists (select 1 from decided_sender r where r.m = i.addr)
              or (${d.strpos(sql`i.addr`, sql`'@'`)} > 0
                  and exists (select 1 from decided_domain dd
                               where dd.m = ${d.substr(sql`i.addr`, sql`${d.strpos(sql`i.addr`, sql`'@'`)} + 1`)}))) as decided,
             ${activeSenderExpr(d, resolved, {
               anyUnread: sql`i.any_unread`,
               anyUnreadInWindow: sql`i.any_unread_in_window`,
               newest: sql`i.newest`,
             })} as active
        from inbound i
    )
    select count(*) filter (where decided)                        as decided,
           count(*) filter (where not decided and undecided_residence and active)
                                                                  as active_undecided,
           count(*) filter (where not decided and undecided_residence and not active)
                                                                  as dormant_undecided
      from classified
  `);

  // The driver split this used to carry is gone: `d.exec` returns rows POSITIONALLY on both
  // stores, so there is no array-or-`{rows}` shape left to decide between. The three positions
  // are the three counts the statement selects, in that order.
  const r = rows[0] ?? [];
  return {
    decidedSenders: Number(r[0] ?? 0),
    activeUndecidedSenders: Number(r[1] ?? 0),
    dormantUndecidedSenders: Number(r[2] ?? 0),
  };
}

/**
 * IS THERE SCREENING WORK WAITING? The honest form of "is the backlog empty".
 *
 * The predicate this replaces asked whether any mail was sitting in the Screener FOLDER, which
 * answers a different question: after a migration, a mailbox can hold thousands of messages
 * there from senders nobody will ever be asked about, because they went quiet years ago. That
 * reads as a permanent backlog and never empties.
 *
 * Dormant senders are not work. Only a sender with unread or recent mail and no decision behind
 * them is.
 */
export async function hasUndecidedActiveSenders(
  ctx: ServiceContext, opts: CutlineOptions = {},
): Promise<boolean> {
  return (await cutlineCounts(ctx, opts)).activeUndecidedSenders > 0;
}
