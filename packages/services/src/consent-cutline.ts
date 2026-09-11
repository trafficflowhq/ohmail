import { sql, type SQL } from "drizzle-orm";
import { DEFAULT_DORMANCY_DAYS, type ScreeningScope } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
import { activeSenderExpr, anyOf, resolveCutline } from "@trafficflow/db";

/**
 * The cutline, server-side — how many senders are still owed a decision. The client computes this
 * over its own mirror; this asks the database, for callers with no mirror. Two implementations of
 * one rule, so `consent-cutline.pg.test.ts` runs both over the same rows and requires the same
 * answer. A DECISION is an enabled rule naming the sender or their domain whose destination is
 * not the Screener itself: a rule pointing AT the Screener is the absence of a decision, and
 * reading it as one would exempt that sender for ever. The window is measured from `now` until
 * the account has a `screening_baseline_at` (mail 0056), that instant afterwards — see {@link
 * CutlineOptions.baselineAt}.
 */

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
 * The two folders a message can sit in without any decision behind it. MUST equal the client
 * engine's `UNDECIDED_RESIDENCES` — the half this file lacked: `inbound` admitted all six
 * presented folders, so a sender whose only mail is in Reads, Receipts, Screened or Quarantine
 * counted as owed a decision (measured: three active undecided senders here, one on the client).
 * An explicit placement is itself an answer. NOT simply `AND fs.desired_folder IN (…)` on
 * `inbound` — that would restrict the ACTIVITY test too: `senderActivity` runs over every
 * presented folder, so a sender with old mail at the gate and unread mail in Reads is ACTIVE. The
 * six-folder scan stays; the residence test is a per-sender flag at the count.
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
   * When this account finished screening its backlog (`account_settings.screening_baseline_at`,
   * mail 0056), or `null`/absent for an account that has never decided anything. The client
   * engine's `ConsentOptions.baselineAt` carries the whole argument — the resurrection it stops,
   * and why the narrowing is gated on the baseline being PRESENT rather than folded into a `??
   * now()` default. Both files implement one rule and `consent-cutline.pg.test.ts` runs them over
   * the same rows; this is the SQL half and nothing about it may be reasoned about separately.
   * `null`/absent means cutoff `now - dormancyDays` with unread outranking age — byte-identical
   * counts to before the field existed.
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
   * Four constructs here spell differently on the two stores, and three were invisible to the
   * construct census until this file was read: `bool_or`, `position(x IN y)` and `substring(x
   * FROM n)` are SQL SYNTAX whose separator is a keyword, so no list of function names could
   * match them. `bool_or` needs no dialect member — `max(case when … then 1 else 0 end) = 1` is
   * the same question in a spelling both stores accept, and a member for something already
   * expressible on both would be a third dialect nobody tests. The other two do: the server's
   * take keywords where this store takes commas, and `strpos` reverses the argument order.
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
 * Is there screening work waiting? The honest form of "is the backlog empty". The predicate this
 * replaces asked whether any mail sat in the Screener FOLDER, which answers a different question:
 * after a migration that folder can hold thousands of messages from senders nobody will ever be
 * asked about, because they went quiet years ago — a permanent backlog that never empties.
 * Dormant senders are not work; only a sender with unread or recent mail and no decision behind
 * them is.
 */
export async function hasUndecidedActiveSenders(
  ctx: ServiceContext, opts: CutlineOptions = {},
): Promise<boolean> {
  return (await cutlineCounts(ctx, opts)).activeUndecidedSenders > 0;
}
