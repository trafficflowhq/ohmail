import { sql } from "drizzle-orm";
import { DEFAULT_DORMANCY_DAYS } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";

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
  const days = opts.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  // An unparseable stored baseline is treated as ABSENT rather than as epoch 0 — the client's rule
  // verbatim (`cutlineFor`), and for its reason: a 1970 baseline puts every message after the
  // cutoff and pins every undecided sender in the queue for ever.
  const baselineMs = opts.baselineAt == null ? null : opts.baselineAt.getTime();
  const baselined = baselineMs !== null && Number.isFinite(baselineMs);
  const measuredFrom = baselined ? baselineMs! : ctx.now().getTime();
  const cutoff = new Date(measuredFrom - days * 24 * 60 * 60 * 1000);
  const folders = sql`(${sql.join(PRESENTED_FOLDERS.map((f) => sql`${f}`), sql`, `)})`;
  const undecidedResidences = sql`(${sql.join(UNDECIDED_RESIDENCES.map((f) => sql`${f}`), sql`, `)})`;
  /**
   * THE UNREAD TERM, AND IT IS THE ONLY THING THE BASELINE CHANGES HERE.
   *
   * Baselined ⇒ unread mail counts only INSIDE the window (`any_unread_in_window`); absent ⇒ any
   * unread mail at all outranks age (`any_unread`), which is the pre-0056 expression unchanged.
   * The client's `senderActivity` picks between exactly these two, and the parity test runs both
   * over one set of rows precisely because two implementations of one rule is two things that can
   * drift apart silently.
   *
   * Chosen in TypeScript rather than as a SQL `CASE`, so the statement Postgres plans contains one
   * predicate and not a branch over a constant — and so the choice sits next to the comment
   * explaining it rather than three subqueries down.
   */
  const unreadTerm = baselined ? sql`i.any_unread_in_window` : sql`i.any_unread`;

  const rows = await ctx.db.execute<{
    decided: string; active_undecided: string; dormant_undecided: string;
  }>(sql`
    with own as (
      select lower(address) a from mailboxes where account_id = ${ctx.accountId}::uuid
    ),
    decided_sender as (
      select lower(match) m from rules
       where account_id = ${ctx.accountId}::uuid and enabled
         and kind = 'sender' and destination <> 'ohmail/Screener'
    ),
    decided_domain as (
      select lower(match) m from rules
       where account_id = ${ctx.accountId}::uuid and enabled
         and kind = 'domain' and destination <> 'ohmail/Screener'
    ),
    inbound as (
      select lower(m.from_address) addr,
             bool_or(m.unread) any_unread,
             -- The BASELINED unread term: unread AND inside the window. The null test is explicit
             -- because a message with no Date header must not count as recent here, exactly as
             -- the client's messageMs answers null for one. (NO BACKTICKS anywhere in this
             -- template literal: one of them ends the tagged template and the file stops
             -- compiling, with the error pointing at a line some distance away.)
             bool_or(m.unread and m.date is not null and m.date >= ${cutoff.toISOString()}::timestamptz)
               as any_unread_in_window,
             max(m.date) newest,
             -- Does this sender have ANY mail still sitting where no decision has been made?
             -- Activity is measured over all six presented folders (above); membership in the
             -- undecided counts is not. See UNDECIDED_RESIDENCES.
             bool_or(fs.desired_folder in ${undecidedResidences}) as undecided_residence
        from messages m
        join folder_state fs on fs.message_id = m.id
       where m.account_id = ${ctx.accountId}::uuid
         and fs.desired_folder in ${folders}
         and lower(m.from_address) not in (select a from own)
       group by 1
    ),
    classified as (
      select i.addr, i.undecided_residence,
             (exists (select 1 from decided_sender r where r.m = i.addr)
              or (position('@' in i.addr) > 0
                  and exists (select 1 from decided_domain d
                               where d.m = substring(i.addr from position('@' in i.addr) + 1)))) as decided,
             (${unreadTerm} or (i.newest is not null and i.newest >= ${cutoff.toISOString()}::timestamptz)) as active
        from inbound i
    )
    select count(*) filter (where decided)                        as decided,
           count(*) filter (where not decided and undecided_residence and active)
                                                                  as active_undecided,
           count(*) filter (where not decided and undecided_residence and not active)
                                                                  as dormant_undecided
      from classified
  `);

  // The two drivers behind `Db` disagree about what `execute` returns: the Postgres one hands
  // back an array subclass, PGlite an object with a `rows` property. Neither is iterable in a
  // way that covers the other, so the shape is read rather than spread.
  const list = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>)
    : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  const r = list[0] as { decided?: unknown; active_undecided?: unknown; dormant_undecided?: unknown } | undefined;
  return {
    decidedSenders: Number(r?.decided ?? 0),
    activeUndecidedSenders: Number(r?.active_undecided ?? 0),
    dormantUndecidedSenders: Number(r?.dormant_undecided ?? 0),
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
