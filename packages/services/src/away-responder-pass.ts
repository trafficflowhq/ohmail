import { and, asc, eq, exists, gt, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messages,
  type Tx,
} from "@trafficflow/db";
import {
  awayEligibility, awayNormalizeAddress, awayTextHash, createLogger, isDeliveryReport,
  mintMessageId, replySubject,
  type AwayAudience, type AwaySuppression, type Logger, type OpenSendAdapter, type SendAdapter,
} from "@trafficflow/core/mail";
import type { Db } from "./context.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE AWAY RESPONDER'S PASS — reply-only, throttled per person, on all three hosts
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHY IT MOVED OUT OF THE WORKER, AND WHAT THAT FIXED ─────────────────────────────────────

   It was `apps/worker/src/away-responder.ts`, and the honest reading of the evidence is that IT
   HAD ALMOST CERTAINLY NEVER DELIVERED A SINGLE REPLY. `apps/worker/src/smtp-size.ts` measured
   that the sync host's platform blocks outbound SMTP submission at the port level — twelve hosts,
   every dial a timeout, IMAP to the same host 300 ms — and the pass sent through the worker's
   attached adapter. Every one of those dials threw; every throw KEPT the at-most-once claim (the
   correct answer to an ambiguous SMTP failure, and the wrong outcome when the failure is
   deterministic); and so each correspondent was silenced for the rest of the episode by a send
   that never left the building. No `away_responder_pass sent>0` line has ever been recorded.

   So the pass runs where a send can actually happen: the API host on Cloud, the drain on a
   standalone desktop, the send clock on a self-host. One implementation, the three hosts the
   scheduled-send pass already runs on, sending through the adapter each of them already builds.

   ── THE SAFETY ARGUMENT, WHICH IS THE WHOLE OF THIS FILE ────────────────────────────────────

   An away reply is mail leaving somebody's mailbox in their name while they are not looking, so
   the rule that nothing is sent unless the person asked for it has to be answered head-on rather
   than exempted. It is answered by what the instruction IS: a DETERMINISTIC standing order —
   this exact text, written in advance by the person whose mailbox it is, to correspondents
   matching a stated audience, at a stated rate, for a stated period. The pass composes nothing,
   chooses no words, and consults no classifier. Turning the responder on IS the authorisation.

   What that requires in exchange is that the instruction cannot reach anyone its owner did not
   mean and cannot fire more often than they said. Those are two different mechanisms and they are
   deliberately in two different places:

     WHO      `awayEligibility` in `@trafficflow/core` — a pure function over one row, so every
              guard is a branch a table test can reach and watch fail. Not in this file.
     HOW OFTEN the atomic upsert below. A property of the database, not of this control flow.

   ── REPLY-ONLY (owner requirement) ──────────────────────────────────────────────────────────

   The responder has no subject of its own any more. It answers with `Re: <what they wrote>`,
   `In-Reply-To` and `References` pointing at their message, so the reply lands in the thread they
   started rather than arriving as a new message with a subject they never saw. `replySubject` is
   the client's own implementation, promoted to core for this: one encoding of "`Re: ` exactly
   once", or the one reply nobody reads before it leaves is the one that ships `Re: RE: Re:`.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Replies one INVOCATION may send, across every account it serves.
 *
 * Five, and it is a cap on OUTBOUND MAIL rather than on database work — a different kind of budget
 * from the sibling passes'. It bounds the damage a misconfiguration can do before anybody notices,
 * and it is sized for the host with the least room: the hosted route runs inside a serverless
 * invocation with a 60-second ceiling, and each reply is an SMTP dial plus an IMAP append to the
 * user's own servers (seconds each, unbounded in the tail). A genuine away period answers a handful
 * of people per minute; an account that hits this ceiling every cycle is a fact worth reading in
 * the log rather than a throughput problem to tune away.
 */
export const AWAY_SENDS_PER_RUN = 5;

/** Candidate rows examined per account per run. The send budget above is the real limit. */
export const AWAY_BATCH = 200;

/**
 * Candidate BOUNCES examined per account per run — see {@link markUndeliverableFromBounces}.
 *
 * Small on purpose. A bounce arrives within minutes of a failed delivery, the pass runs on a
 * clock, and one correspondent needs marking exactly once — so this is a runaway brake rather
 * than a page size, and a responder that somehow accumulated more than this many unmatched
 * bounces has a problem no page size fixes.
 */
export const AWAY_BOUNCE_SCAN = 50;

/**
 * How far back a bounce is believed to be about a reply this pass sent.
 *
 * Seven days. A delivery report normally arrives in seconds and at worst after an MTA's retry
 * schedule gives up, which is four to five days on the common defaults. The window exists so the
 * scan stays indexed and bounded rather than walking an account's whole history every tick; it is
 * not a correctness bound, because a bounce older than this tells us about a trip that has ended.
 */
export const AWAY_BOUNCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Accounts one invocation will consult. A responder that is live right now is rare, so this is a
 * runaway brake rather than a page size — and it is bounded for the same reason the scheduled
 * pass bounds its own walk: one invocation must finish inside a platform deadline.
 */
export const AWAY_ACCOUNTS_PER_RUN = 50;

/** The throttle members, as the closed set this pass and the service validator share. */
export const AWAY_THROTTLES = ["always", "per_message", "per_day", "per_week"] as const;
export type AwayThrottle = (typeof AWAY_THROTTLES)[number];

/**
 * How many ids a reply's `References` may carry. Twenty is past what any client renders and well
 * short of anything a server refuses; the root is always kept, so a longer thread loses its middle
 * rather than its identity.
 */
export const AWAY_REFERENCES_MAX = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const defaultLog = createLogger({ service: "away-responder" });

export interface AwayResponderPassDeps {
  /**
   * STOP BEFORE THE NEXT DELIVERY — a predicate this pass consults between rows.
   *
   * A pass that has begun is not entitled to finish. On the desktop the mailbox can change hands
   * mid-pass: the socket dies, a re-dial re-reads the organizer lease, and a stranger's claim is
   * found — while this loop is still holding rows it claimed under the old answer. Sending them
   * duplicates the real organizer's reply, from an install the mailbox no longer belongs to, and
   * no amount of checking BEFORE the pass can see it because the change happens during.
   *
   * Answering `true` stops the loop where it stands. Rows already claimed are left to the
   * reconciler, which is the same recovery any crash mid-pass takes; nothing new is invented for
   * this case. Absent means "never cancel", so every hosted caller is unchanged.
   */
  cancelled?: () => boolean;

  /** The send transport — `makeSendAdapter` on the hosted and self-hosted hosts, the local dial on the desktop. */
  openSendAdapter: OpenSendAdapter;
  /**
   * MAY THIS ACCOUNT'S AUTOMATION STILL FIRE? — the suspension gate, INJECTED for
   * `ScheduledSendPassDeps.accountEligible`'s reason verbatim: the fact lives in the cloud half
   * (`account_suspensions`) and this pass ships in the desktop engine bundle, which may not name a
   * cloud table. The hosted route and the self-host clock inject the real read; the standalone door
   * injects nothing, which resolves to ELIGIBLE — its store has no suspension concept and the
   * machine's own login is the boundary.
   *
   * Consulted BEFORE this account's candidates are read, so a suspended account's mail is not even
   * examined and no ledger row is written for it: nothing is decided, and the replies are sent
   * promptly once the suspension lifts rather than being permanently recorded as suppressed.
   *
   * It is handed the SAME handle this pass is running on. Unlike the scheduled pass's, this call is
   * NOT inside a claim transaction — the claim here is per-reply and opens later — so there is no
   * deadlock rule to observe. The signature matches the sibling's anyway, so one injector serves
   * both and neither host has to remember which shape it is passing.
   */
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>;
  /**
   * WHICH MAILBOXES THIS PASS MAY ANSWER FOR — absent means ALL of them, which is the hosted
   * clock's shape.
   *
   * The organizer JOIN below already refuses a mailbox this install merely READS, so this filter is
   * not what makes a reader silent. It exists for the standalone desktop's shape after multi-mailbox:
   * the drain calls this pass once PER RUNTIME, and without the narrowing each organizing runtime
   * would scan and claim for every other organizing mailbox in the same install. The UNIQUE makes
   * that harmless — one of them wins the reservation and the rest read zero rows — but it is N times
   * the work and a log nobody can attribute to a mailbox.
   *
   * AN EMPTY ARRAY MEANS NONE, and is not the same as absent — the "absent config selects the
   * dangerous branch" shape, separated deliberately rather than collapsed by a truthiness test.
   * `undefined` is "no filter"; `[]` is "this caller has no mailboxes to answer for", which must
   * answer NOTHING. Folding them would make a desktop install with no organizing runtime behave
   * like the hosted clock and answer mail for every mailbox in the store.
   */
  mailboxIds?: readonly string[];
  log?: Logger;
  now?: () => Date;
  /** Test seams. */
  batch?: number;
  sendsPerRun?: number;
}

export interface AwayResponderPassResult {
  /** Accounts with a live responder that this invocation looked at. */
  accounts: number;
  /** Candidates DECIDED — every one of them wrote a ledger row. */
  examined: number;
  sent: number;
  /** SMTP threw; the claim is kept and no second copy is ever offered. */
  unverified: number;
  /** The per-sender reservation refused: answered recently enough. */
  throttled: number;
  /** An eligibility guard held. */
  suppressed: number;
  /**
   * ACCOUNTS the suspension gate parked. Nothing about them was read or decided.
   *
   * Two counters and not one, because the old single `deferred` mixed units: this arm counted
   * ACCOUNTS and the send-path arm counted CANDIDATES, so `deferred: 51` could be fifty-one
   * messages, or one suspended account plus fifty messages, and an operator had no way to tell.
   */
  deferredAccounts: number;
  /**
   * CANDIDATES left for the next run without a ledger row, because their mailbox had no send path.
   * Nothing is decided and no reservation is spent.
   */
  deferredCandidates: number;
  /** True ⇒ the send budget was reached and there was more to answer. */
  capped: boolean;
  /**
   * CORRESPONDENTS newly marked unreachable this run, because a bounce for an earlier reply came
   * back. Counted separately from every other number here: it is not a decision about a candidate
   * and it spends no budget — it is what this run LEARNED, and a non-zero value is the operator's
   * signal that a responder has been writing to a dead address.
   */
  undeliverableMarked: number;
  /**
   * RESPONDERS THIS RUN SWITCHED OFF because their chosen end date had passed — see
   * {@link expireEndedResponders}. Its own counter and not folded into `accounts`: those are
   * responders that were LIVE, and this one is the number that just stopped being.
   */
  expired: number;
}

/** One live responder, as the probe reads it. */
interface LiveResponder {
  accountId: string;
  body: string;
  audience: AwayAudience;
  throttle: AwayThrottle;
  /**
   * WHICH PILES THIS RESPONDER ANSWERS — the stored `text[]`, passed through to the one decision
   * site. `readonly string[]` and not `AwayPile[]`: it comes off a column, so a member this build
   * does not know is representable, and `awayEligibility` refuses it. Narrowing here would move
   * that refusal into a cast.
   */
  piles: readonly string[];
  /** max(enabled_at, starts_at) — the candidate floor. Never null: the probe requires enabled_at. */
  floor: Date;
}

/** One candidate, as the query hands it over. */
interface Candidate {
  id: string;
  mailboxId: string;
  fromAddress: string | null;
  subject: string;
  messageIdHeader: string | null;
  inReplyToChain: string | null;
  noForward: boolean;
  sensitivityCategory: string | null;
  headers: Record<string, unknown> | null;
  desiredFolder: string | null;
  alreadyReplied: boolean;
  /**
   * HAS A BOUNCE FOR AN EARLIER AWAY REPLY TO THIS SENDER COME BACK? — read in the candidate
   * query and handed to `awayEligibility` as a decided boolean, exactly like `alreadyReplied` and
   * for the same reason: the eligibility rule may not reach a database.
   */
  senderUndeliverable: boolean;
  ownAddress: string;
}

/**
 * ONE BOUNDED PASS. Never throws for a per-row or per-account fault — one broken responder must not
 * stop the rest, and the caller's own catch is for the probe alone.
 */
export async function runAwayResponderPass(
  db: Db, deps: AwayResponderPassDeps,
): Promise<AwayResponderPassResult> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? ((): Date => new Date());
  const batch = deps.batch ?? AWAY_BATCH;
  const budget = deps.sendsPerRun ?? AWAY_SENDS_PER_RUN;
  const result: AwayResponderPassResult = {
    accounts: 0, examined: 0, sent: 0, unverified: 0, throttled: 0, suppressed: 0,
    deferredAccounts: 0, deferredCandidates: 0, capped: false, undeliverableMarked: 0,
    expired: 0,
  };

  /* NONE MEANS NONE, decided before a single row is read. See the field's own note. */
  if (deps.mailboxIds !== undefined && deps.mailboxIds.length === 0) return result;

  /* Before the probe, in this order: a responder whose end date has passed is switched OFF (so the
     probe cannot consider it and the heal below cannot stamp it), then a responder enabled by an
     older API build is given the enablement instant the probe requires. */
  result.expired = await expireEndedResponders(db, now(), deps.mailboxIds, log);
  await healMissingEnabledAt(db, now());
  const live = await liveResponders(db, now(), deps.mailboxIds);

  for (const responder of live) {
    if (result.sent >= budget) { result.capped = true; break; }
    /* AND THE CALLER'S OWN STOP — see `cancelled`. An away reply is a promise made on the
       mailbox's behalf, so an install that has just discovered the mailbox is not its own must
       not keep making them. */
    if (deps.cancelled?.()) { result.capped = true; break; }
    /* COUNTED HERE AND NOT FROM `live.length`, because the budget can break this loop on account
       one of thirty: reporting the PROBE's size would tell an operator judging fleet coverage that
       thirty accounts were served when twenty-nine were never read. `capped: true` beside it is
       what says the rest are waiting. */
    result.accounts += 1;
    try {
      await answerForAccount(db, deps, responder, result, budget, batch, now, log);
    } catch (err) {
      // Per-account containment. A responder whose candidate read threw leaves NO ledger rows, so
      // the next run re-examines exactly the same window — nothing is spent and nobody is silenced.
      log.error("away_responder_account_failed", {
        accountId: responder.accountId, err,
        reason: "no reply was sent for this account and no candidate was decided; the next run " +
          "re-reads the same window and the ledger excludes only what was actually decided",
      });
    }
  }
  return result;
}

/**
 * THE PROBE — every responder that is LIVE right now, in one indexed read.
 *
 * `enabled_at IS NOT NULL` is required and not merely read: it is the floor's first half, and
 * treating a NULL as "the beginning of time" would answer the entire stored backlog the moment
 * such a row appeared.
 *
 * ── AND THERE IS A WRITER THAT PRODUCES ONE, WHICH THIS COMMENT USED TO DENY ───────────────
 *
 * It said the state was one "that no writer since produces". That is false during a rolling
 * deploy, and 0087 GUARANTEES the window exists — it promises an API one version older keeps
 * working, and that older `put` neither inserts nor sets `enabled_at`, which has no column
 * DEFAULT. Concrete sequence: 0087 applies; somebody whose responder is off (so `enabled_at` is
 * NULL, which is what `nextEnabledAt` writes) saves `enabled: true` against an instance still on
 * the previous build; the row is enabled with a NULL instant; and this probe would exclude it
 * FOR EVER — no error, no self-heal, a responder silently dead for the whole trip.
 *
 * So the pass heals it: {@link healMissingEnabledAt} stamps `now()` on exactly that shape before
 * the probe runs. `now()` and not `updated_at`, because the safe reading of "we do not know when
 * this was switched on" is "it is switched on as of this instant" — the run that heals answers no
 * backlog, and the next one answers ordinarily.
 *
 * NOTHING IS COMPOSED HERE. A responder with no body is not a responder with a default — it is an
 * unfinished one, and inventing text would put words nobody wrote into mail sent in their name.
 * The Settings form requires it; this is the same requirement where it cannot be bypassed. The
 * SUBJECT is deliberately not consulted at all any more: the reply derives its own.
 */
/**
 * STAMP AN ENABLEMENT INSTANT ON A ROW THAT IS ENABLED WITHOUT ONE.
 *
 * The rolling-deploy shape described on {@link liveResponders}: an API one version older enables a
 * responder without writing `enabled_at`, and the probe would then exclude the row for ever. One
 * guarded UPDATE per run, matching nothing on a healthy deployment.
 *
 * `now` rather than `updated_at`: a row healed here answers NO backlog, because its floor is the
 * instant of the heal. That is the same direction every other absent-evidence decision in this
 * feature takes — an unanswered correspondent is recoverable, a stranger answered from a window
 * nobody chose is not.
 */
/**
 * SWITCH OFF EVERY RESPONDER WHOSE END DATE HAS PASSED — one guarded UPDATE per run, matching
 * nothing once it has run.
 *
 * `ends_at` already ends the answering window (the probe's `endsAt >= now`), so this changes no
 * mail. What it changes is the STATE somebody reads and what a later re-enable does: without it the
 * row stays `enabled` for ever with a window nobody is in, so the switch says "On" while nothing is
 * sent, and extending the date months later would answer everything that arrived in between —
 * `enabled_at` only moves on OFF → ON.
 *
 * So the write is the same one `put` makes when a person switches the responder off: `enabled`
 * false, `enabled_at` null (its invariant), and `ends_at` cleared so a later "on" is an open-ended
 * responder rather than one that is instantly expired again. Idempotent by the WHERE: the second
 * pass matches nothing, which is what makes "exactly once" a property of the statement rather than
 * of a flag. Narrowed by the caller's mailboxes exactly as the probe is — turning somebody's
 * responder off is a product state change, and a drain that named its own mailbox must not make it
 * for an account it was not asked about.
 */
async function expireEndedResponders(
  db: Db, at: Date, mailboxIds: readonly string[] | undefined, log: Logger,
): Promise<number> {
  const rows = await (db as unknown as Tx).update(awayResponders)
    .set({ enabled: false, enabledAt: null, endsAt: null, updatedAt: at })
    .where(and(
      eq(awayResponders.enabled, true),
      isNotNull(awayResponders.endsAt),
      sql`${awayResponders.endsAt} < ${at.toISOString()}::timestamptz`,
      ...(mailboxIds === undefined ? [] : [exists(
        (db as unknown as Tx).select({ one: sql`1` }).from(mailboxes).where(and(
          eq(mailboxes.accountId, awayResponders.accountId),
          inArray(mailboxes.id, [...mailboxIds]),
        )),
      )]),
    ))
    .returning({ accountId: awayResponders.accountId });
  for (const row of rows) {
    log.info("away_responder_expired", {
      accountId: row.accountId,
      reason: "the end date this responder was given has passed; it is switched off and the date " +
        "cleared, so nothing further is sent until somebody turns it on again",
    });
  }
  return rows.length;
}

async function healMissingEnabledAt(db: Db, at: Date): Promise<void> {
  await (db as unknown as Tx).update(awayResponders)
    .set({ enabledAt: at })
    .where(and(eq(awayResponders.enabled, true), isNull(awayResponders.enabledAt)));
}

async function liveResponders(
  db: Db, at: Date, mailboxIds: readonly string[] | undefined,
): Promise<LiveResponder[]> {
  const rows = await (db as unknown as Tx).select({
    accountId: awayResponders.accountId,
    body: awayResponders.body,
    audience: awayResponders.audience,
    throttle: awayResponders.throttle,
    piles: awayResponders.piles,
    startsAt: awayResponders.startsAt,
    enabledAt: awayResponders.enabledAt,
  }).from(awayResponders)
    .where(and(
      eq(awayResponders.enabled, true),
      isNotNull(awayResponders.enabledAt),
      // IN-WINDOW, inclusive at both ends. An absent bound is OPEN at that end — what the column
      // means and what the API accepts — and never "now": reading an absent `startsAt` as the
      // current instant would make an enabled responder with no dates answer nobody.
      or(isNull(awayResponders.startsAt), sql`${awayResponders.startsAt} <= ${at.toISOString()}::timestamptz`)!,
      or(isNull(awayResponders.endsAt), sql`${awayResponders.endsAt} >= ${at.toISOString()}::timestamptz`)!,
      /* ── THE MAILBOX NARROWING REACHES THE PROBE, NOT ONLY THE CANDIDATES ────────────────
       *
       * This used to be discarded here (`void mailboxIds`) on the reasoning that the narrowing is
       * about candidates. That was wrong in two ways, one of them only visible against a real
       * database.
       *
       * Cheaply: a caller that named its mailboxes was still made to read up to
       * `AWAY_ACCOUNTS_PER_RUN` responders belonging to accounts it did not ask about, and then run
       * a full candidate query for each of them — every one returning nothing, because the
       * candidate filter excluded them anyway.
       *
       * And correctly: the probe is a PAGE. Ordered and capped, it can exclude the very account the
       * caller named — which is not hypothetical, it is what the shared test Postgres does today
       * (70 live responders, all with older `enabled_at` than a freshly seeded one, against a cap
       * of 50). A sidecar drain naming its own mailbox would be silently served nothing on any
       * store holding more live responders than the cap.
       *
       * So the page is drawn from the accounts that own the named mailboxes. Absent ⇒ every account,
       * which is the hosted clock's shape and unchanged. */
      ...(mailboxIds === undefined ? [] : [exists(
        (db as unknown as Tx).select({ one: sql`1` }).from(mailboxes).where(and(
          eq(mailboxes.accountId, awayResponders.accountId),
          inArray(mailboxes.id, [...mailboxIds]),
        )),
      )]),
    ))
    /* DETERMINISTIC, and it decides two things rather than one. Without an ORDER BY, Postgres
       returns whatever the scan produces, so (a) WHICH 50 responders are considered at all when
       more than 50 are live is arbitrary, and (b) the walk order is stable in practice — which,
       against a GLOBAL send budget, means an account early in that order with steady inbound mail
       consumes every send on every tick and an account later in it never gets one. Ordering by
       `enabled_at` puts the responder that has been waiting longest first, so the fleet drains in
       a defensible order instead of a scan-dependent one. */
    .orderBy(asc(awayResponders.enabledAt), asc(awayResponders.accountId))
    .limit(AWAY_ACCOUNTS_PER_RUN);

  const out: LiveResponder[] = [];
  for (const r of rows) {
    const body = (r.body ?? "").trim();
    if (body.length === 0) continue;            // unconfigured — see the header
    const enabledAt = r.enabledAt;
    if (!enabledAt) continue;                   // narrowed for the type; the WHERE already refused it
    // THE FLOOR: the LATER of "when this was turned on" and "when the away period begins". Both
    // halves are needed — `enabled_at` alone answers mail that arrived between a scheduled start
    // being saved and that start arriving; `starts_at` alone (or its absence) answers the entire
    // stored backlog the moment somebody enables a responder with no dates.
    const floor = r.startsAt && r.startsAt.getTime() > enabledAt.getTime() ? r.startsAt : enabledAt;
    out.push({
      accountId: r.accountId,
      body,
      audience: r.audience as AwayAudience,
      throttle: r.throttle as AwayThrottle,
      /* NOT defaulted to the answerable set on an absent value. The column is NOT NULL with a
         DEFAULT of `{INBOX}`, so `null` here can only mean a driver handed back something
         unexpected — and reading that as "answer everything" is the absent-evidence-selects-the
         -sending-branch mistake this file refuses everywhere else. An empty array answers nobody. */
      piles: r.piles ?? [],
      floor,
    });
  }
  return out;
}

/** One account: gate, read, group by mailbox, answer. */
async function answerForAccount(
  db: Db, deps: AwayResponderPassDeps, responder: LiveResponder,
  result: AwayResponderPassResult, budget: number, batch: number,
  now: () => Date, log: Logger,
): Promise<void> {
  // THE SUSPENSION GATE, before anything is read or decided. A parked account's mail is not
  // examined at all, so nothing is recorded as suppressed and the replies go out promptly once the
  // suspension lifts — see the field's note.
  if (deps.accountEligible && !(await deps.accountEligible(responder.accountId, db))) {
    result.deferredAccounts += 1;
    return;
  }

  /* ── WHAT CAME BACK, BEFORE ANYTHING GOES OUT ────────────────────────────────────────────
   *
   * Read for THIS account and BEFORE its candidates, so a correspondent whose address bounced is
   * already unreachable when this run decides about their next message rather than one run later.
   * Ordering it after the read would cost exactly one more reply and one more bounce per
   * correspondent, which is the loop being fixed. */
  result.undeliverableMarked += await markUndeliverableFromBounces(
    db, responder.accountId, now(), log,
  );

  // Every address on this account, INCLUDING disabled and errored mailboxes: an address that was
  // ours is still ours, and a responder that answers a former mailbox of its own owner is the same
  // loop as one that answers its current one.
  const ownRows = await (db as unknown as Tx)
    .select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, responder.accountId));
  const ownAddresses = new Set(ownRows.map((m) => awayNormalizeAddress(m.address)));

  const candidates = await readCandidates(db, responder, deps.mailboxIds, batch);
  if (candidates.length === 0) return;

  const textHash = awayTextHash(responder.body);

  // ── ELIGIBILITY FIRST, THE ADAPTER ONLY FOR WHAT SURVIVES IT ─────────────────────────────
  //
  // The order here was the other way round and it was wrong in a way this file's own header
  // claimed it was not. `awayEligibility` needs no network, no adapter and no clock, but it used to
  // be reached only INSIDE the `try` that follows a successful `openSendAdapter` — so a mailbox
  // whose factory throws (no credentials, disconnected since the mail arrived, a standalone install
  // with no submission server) left ALL of its candidates deferred with no ledger row.
  //
  // That is a starvation shape, not merely a wasted run: `readCandidates` is oldest-first with a
  // fixed `limit`, and the ledger anti-join is the only thing that removes a row from the set. Those
  // undecidable candidates therefore occupy the oldest page of every subsequent run for ever, and
  // once there are `batch` of them NOTHING behind them on that account is examined again —
  // including candidates on a different, perfectly healthy mailbox — the pass starved by its own
  // away arm, reintroduced by the ordering, in the function whose header says the design avoids it.
  //
  // So: decide every candidate first (a suppression writes its ledger row and leaves the set
  // permanently, whether or not this mailbox can dial), and open a transport LAZILY, only when a
  // candidate has actually survived to the point of needing one.
  const byMailbox = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const held = byMailbox.get(c.mailboxId);
    if (held) held.push(c); else byMailbox.set(c.mailboxId, [c]);
  }

  for (const [mailboxId, group] of byMailbox) {
    if (result.sent >= budget) { result.capped = true; return; }
    /* ── THE CALLER'S STOP, PER MAILBOX ─────────────────────────────────────────────────────
     *
     * The check at the top of `runAwayResponderPass` sees the pass ONCE, and the desktop hands
     * this pass a single account — so on the door that needs it most, that outer check fires
     * before any work and never again. Everything that could go wrong during a pass therefore
     * went unseen: the socket dies, a re-dial re-reads the lease, a stranger's claim is found,
     * and this loop is still holding candidates it selected under the old answer. */
    if (deps.cancelled?.()) { result.capped = true; return; }

    /* THE TRANSPORT, OPENED AT MOST ONCE PER MAILBOX AND ONLY ON DEMAND. `null` once a factory has
       thrown, so a broken mailbox costs ONE failed dial per run rather than one per candidate. */
    /* A one-field box rather than a bare `let`: the handle is assigned inside a closure and read
       in `finally`, and TypeScript narrows a closure-assigned `let` to `never` at the read. */
    const held: { adapter: SendAdapter | null } = { adapter: null };
    let openFailed = false;
    const transport = async (): Promise<SendAdapter | null> => {
      if (held.adapter || openFailed) return held.adapter;
      try {
        held.adapter = await deps.openSendAdapter(mailboxId);
      } catch (err) {
        openFailed = true;
        log.warn("away_responder_no_send_path", {
          accountId: responder.accountId, mailboxId, err,
          reason: "no reservation was spent and no correspondent was recorded as answered — the " +
            "candidates that needed a send are examined again next run; the ones an eligibility " +
            "guard refused were decided anyway, so they cannot pin the page",
        });
      }
      return held.adapter;
    };

    try {
      for (const candidate of group) {
        if (result.sent >= budget) { result.capped = true; return; }
        /* AND PER CANDIDATE, which is the one that actually bounds the damage. A mailbox's group
           can hold many correspondents, and each `answerOne` is a DELIVERY: without this, a
           hand-over discovered after the first reply still let the rest of the group go out in
           the user's name from an install that no longer organizes the mailbox. Beside the
           budget check because it answers the same question — may this pass send one more? */
        if (deps.cancelled?.()) { result.capped = true; return; }
        await answerOne(
          db, responder, candidate, ownAddresses, textHash, transport, result, now, log,
        );
      }
    } finally {
      // ALWAYS, including the send-budget return above: a leaked authenticated socket on the send
      // path is worse than elsewhere, because what follows it is a retry of a send. `adapter` is
      // null when nothing on this mailbox ever needed a transport, which is the common case for a
      // page of mailing-list mail.
      if (held.adapter) {
        await held.adapter.close().catch(() => { /* already broken; nothing to act on */ });
      }
    }
  }
}

/**
 * WHICH CORRESPONDENTS' ADDRESSES ARE DEAD — read the bounces that came back for this account's
 * own away replies and stamp `away_sender_state.undeliverable_at`. Returns how many were newly
 * marked.
 *
 * ── THE STATE THIS FIXES ────────────────────────────────────────────────────────────────────
 *
 * A responder wrote to an address that does not accept mail. The bounce arrived in its owner's own
 * Ohbox, and nothing recorded what it MEANT — so the next message from the same correspondent
 * produced another reply and another bounce, once per throttle interval for the length of the trip.
 * The bounce itself is harmless (a delivery report is refused as a candidate in its own right);
 * the missing fact is the problem.
 *
 * ── HOW A BOUNCE IS TIED TO THE REPLY IT IS ABOUT ───────────────────────────────────────────
 *
 * By the MINTED Message-ID. Every reply is sent with a `<uuid@domain>` this pass minted and
 * recorded on the ledger row before it dialled — that column exists so a delivered copy is
 * attributable — and a delivery report quotes the failed message's id in `In-Reply-To` or
 * `References`. So the join is ledger.minted_message_id ⊂ bounce.in-reply-to/references, and the
 * address marked is the LEDGER ROW's `sender`: the person the failed reply was addressed to, never
 * the mailer-daemon that reported it.
 *
 * ── AND WHY THE DELIVERY-REPORT TEST IS NOT OPTIONAL ────────────────────────────────────────
 *
 * A HUMAN who replies to an away reply also carries `In-Reply-To: <the minted id>`. On the id
 * alone, answering "thanks, have a good trip" would mark that person's address dead and silence
 * them for the rest of the trip — a live correspondent lost to a courtesy. So a matched id is only
 * half the test; the message must also BE a delivery report, and that question is asked through
 * `isDeliveryReport` — the same function the eligibility rule uses, because two encodings of "is
 * this a bounce" would disagree the first time a sender folded the `Content-Type` header, and this
 * is the direction that disagreement fails in.
 *
 * The id match is done in SQL (it is a substring test over an indexed, account-scoped set) and the
 * report shape in TypeScript (it is a policy, and the shared one). Neither half decides alone.
 *
 * ── IT NEVER THROWS AND NEVER BLOCKS A REPLY ────────────────────────────────────────────────
 *
 * A fault here means this run does not LEARN something; it must not mean the run does not answer
 * anybody. So the whole thing is contained and returns 0 on a throw — the same per-account
 * containment `answerForAccount`'s caller applies, one level in.
 */
async function markUndeliverableFromBounces(
  db: Db, accountId: string, at: Date, log: Logger,
): Promise<number> {
  try {
    const since = new Date(at.getTime() - AWAY_BOUNCE_WINDOW_MS);
    /* The candidate bounces: a message on this account, inside the window, whose threading
       headers quote one of this account's own minted reply ids, for a correspondent not already
       marked. `->>` on a stored header renders an ARRAY value as its JSON text (`["<id>"]`), which
       a substring test reads correctly — the map is written array-valued by `mime.ts`. */
    const rows = await (db as unknown as Tx).select({
      sender: awayReplies.sender,
      headers: messageBodies.headers,
      minted: awayReplies.mintedMessageId,
    })
      .from(awayReplies)
      .innerJoin(messages, and(
        eq(messages.accountId, awayReplies.accountId),
        // NOT the message the reply answered — that one is the parent, not a bounce.
        ne(messages.id, awayReplies.messageId),
      ))
      .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(
        eq(awayReplies.accountId, accountId),
        isNotNull(awayReplies.mintedMessageId),
        // Only a reply that actually went out can have bounced. A `throttled` or `suppressed` row
        // never dialled, and its minted id was cleared for exactly that reason.
        inArray(awayReplies.outcome, ["sent", "unverified"]),
        gt(messages.createdAt, since),
        // ALREADY MARKED CORRESPONDENTS ARE OUT, so a bounce that stays in the mailbox does not
        // re-stamp the same person on every tick — which would move `undeliverable_at` forward for
        // ever and make "when did we learn this" a lie.
        sql`NOT EXISTS (
          SELECT 1 FROM ${awaySenderState} AS ss
           WHERE ss.account_id = ${awayReplies.accountId}
             AND ss.sender = ${awayReplies.sender}
             AND ss.undeliverable_at IS NOT NULL
        )`,
        sql`(
             ${messageBodies.headers}->>'in-reply-to' LIKE '%' || ${awayReplies.mintedMessageId} || '%'
          OR ${messageBodies.headers}->>'references'  LIKE '%' || ${awayReplies.mintedMessageId} || '%'
        )`,
      ))
      .limit(AWAY_BOUNCE_SCAN);

    /* THE SHARED REPORT TEST. A matched id plus a human reply is a live correspondent; only a
       matched id plus a delivery report is a dead address. */
    const dead = new Set<string>();
    for (const r of rows) {
      if (isDeliveryReport((r.headers ?? {}) as Record<string, unknown>)) dead.add(r.sender);
    }
    if (dead.size === 0) return 0;

    /* One guarded UPDATE. `IS NULL` in the WHERE as well as in the read above, because two runners
       can reach this with the same row in hand — the first stamp is the one that stands, and the
       count returned is what THIS run actually changed. */
    const marked = await (db as unknown as Tx).update(awaySenderState)
      .set({ undeliverableAt: at })
      .where(and(
        eq(awaySenderState.accountId, accountId),
        inArray(awaySenderState.sender, [...dead]),
        isNull(awaySenderState.undeliverableAt),
      ))
      .returning({ sender: awaySenderState.sender });

    if (marked.length > 0) {
      // NO ADDRESS IN THE LOG. The count and the account, which is what an operator can act on.
      log.info("away_sender_undeliverable", {
        accountId, marked: marked.length,
        reason: "a delivery report came back for an away reply sent to these correspondents; no " +
          "further automatic reply is sent to them, which is what stops one bounce per throttle " +
          "interval arriving in this mailbox for the rest of the away period",
      });
    }
    return marked.length;
  } catch (err) {
    log.warn("away_bounce_scan_failed", {
      accountId, err,
      reason: "this run did not learn which correspondents are unreachable; nothing was decided " +
        "and no reply was withheld — the next run reads the same bounces",
    });
    return 0;
  }
}

/**
 * THE CANDIDATE QUERY — and every predicate in it is candidacy, never a suppression.
 *
 * The distinction is `screener-auto.ts`'s rule and it decides what belongs here: a guard in the
 * WHERE clause cannot be watched to fail, so anything that DECIDES about a row in hand lives in
 * `awayEligibility` where a table test can delete it. What lives here is what makes a row a
 * candidate at all — and those have a failure mode the loop cannot fix, because a row held in the
 * loop writes no ledger row, stays in the window for ever, and pins the oldest page of every
 * subsequent run, so the pass stops converging and a genuine arrival behind them is never seen.
 *
 *   floor        `created_at > floor AND date >= floor`. The ingest clock LIES about history —
 *                `insertMessage` omits `createdAt`, so a first-time backfill stamps years-old mail
 *                with the ingest instant, inside any live window — so the message's own stated send
 *                time is required as well. A NULL `date` fails the comparison and is out: not
 *                provably new, and absent evidence may not select the branch that sends mail.
 *   placement    `last_set_by <> 'external'` — a placement authored outside ohmail is not an
 *                arrival. A row with NO placement stays a candidate (placement lands in the same
 *                transaction as the message), and the audience guard treats it as un-admitted.
 *   ledger       `LEFT JOIN away_replies … WHERE ar.id IS NULL` — a decided candidate leaves the
 *                set permanently. This is what makes the pass converge.
 *   organizer    `JOIN mailboxes ON organizer_role='organizer' AND status='connected'`. A READER
 *                never replies. Its own claim would be a second responder on one mailbox, and a
 *                stranger writing once would get two identical replies from the same person — one
 *                of them from a machine that was told to stop organizing the mailbox.
 */
async function readCandidates(
  db: Db, responder: LiveResponder, mailboxIds: readonly string[] | undefined, batch: number,
): Promise<Candidate[]> {
  const rows = await (db as unknown as Tx).select({
    id: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    messageIdHeader: messages.messageIdHeader,
    noForward: messages.noForward,
    sensitivityCategory: messages.sensitivityCategory,
    headers: messageBodies.headers,
    desiredFolder: folderState.desiredFolder,
    ownAddress: mailboxes.address,
    /**
     * IS THIS CORRESPONDENT'S ADDRESS DEAD? — one correlated EXISTS over the sender state, decided
     * in SQL and handed over as a plain boolean.
     *
     * A LEFT JOIN on `away_sender_state` would have been the obvious shape and it is the wrong
     * one: that table is also the THROTTLE's row, so the join would multiply nothing but would put
     * a column on this query whose absence (a sender never answered before) is indistinguishable
     * from a present row with a null stamp. An EXISTS answers the one question asked — is there a
     * row for this sender carrying a bounce — and a sender with no row at all is correctly `false`.
     *
     * Matched on the NORMALISED address, because that is what the reservation writes: `sender` is
     * always `awayNormalizeAddress(from_address)`, so the comparison is `lower(trim(…))` on both
     * sides or a correspondent who wrote from two spellings of one address is two people.
     */
    senderUndeliverable: sql<boolean>`EXISTS (
      SELECT 1 FROM ${awaySenderState} AS ss
       WHERE ss.account_id = ${messages.accountId}
         AND ss.sender = lower(btrim(${messages.fromAddress}))
         AND ss.undeliverable_at IS NOT NULL
    )`.as("sender_undeliverable"),
    /**
     * HAS THIS CORRESPONDENT ALREADY HEARD FROM THIS MAILBOX ABOUT THIS THREAD? — one correlated
     * EXISTS, decided in SQL and handed to `awayEligibility` as a plain boolean.
     *
     * "Own-authored" is `from_address` being one of this account's own addresses, which is the only
     * durable record of authorship there is: ingest sees the Sent copy of everything the account
     * sends, so a manual reply the person typed themselves and an earlier automatic reply from any
     * install both land as a message in the thread whose author is us. `date >= candidate.date`
     * scopes it to a reply TO this message rather than to any earlier traffic in a long thread.
     *
     * It covers the case the ledger cannot: the ledger is per-install, so an install that took over
     * mid-window has no row for a reply another install sent — but that reply is in the mailbox,
     * and this sees it.
     */
    alreadyReplied: sql<boolean>`EXISTS (
      SELECT 1 FROM ${messages} AS m2
       WHERE m2.account_id = ${messages.accountId}
         AND m2.thread_id IS NOT NULL
         AND m2.thread_id = ${messages.threadId}
         AND m2.id <> ${messages.id}
         AND m2.date >= ${messages.date}
         AND lower(m2.from_address) IN (
           SELECT lower(mb2.address) FROM ${mailboxes} AS mb2
            WHERE mb2.account_id = ${messages.accountId})
    )`.as("already_replied"),
  })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    /* ── AN INNER JOIN, AND THIS IS A SUPPRESSION-SET HOLE IF IT IS NOT ────────────────────
     *
     * It was a LEFT join, with `candidate.headers ?? {}` downstream. `{}` reads as "no markers" —
     * which is the PERMISSIVE answer — so a message with no stored body cleared `List-Id`,
     * `List-Unsubscribe`, `Feedback-ID`, `Precedence`, `Auto-Submitted`, `X-Auto-Response-Suppress`
     * and the empty `Return-Path` in one go and fell straight through to "send".
     *
     * Body-less rows are not hypothetical: the desktop's Cloud mirror inserts `messages` without
     * bodies and fetches them afterwards — there is a dedicated backfill keyed on exactly
     * `isNull(messageBodies.messageId)` — and it writes `organizerRole ?? "organizer"`, so such a
     * row satisfies the organizer JOIN above. The concrete failure is an auto-reply to a mailing
     * list (delivered to every subscriber, and public) or to another responder (an unbounded loop
     * between two mail systems) — the two outcomes `rules.ts` calls the loudest possible.
     *
     * So a message whose body has not arrived is NOT A CANDIDATE YET rather than a candidate with
     * no markers. It costs a poll interval and it fails toward silence, which is the same ruling
     * `away-eligibility.ts` makes about an absent folder placement: absent evidence may not select
     * the branch that sends mail. */
    .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .leftJoin(folderState, eq(folderState.messageId, messages.id))
    .leftJoin(awayReplies, and(
      eq(awayReplies.accountId, messages.accountId), eq(awayReplies.messageId, messages.id),
    ))
    .where(and(
      eq(messages.accountId, responder.accountId),
      gt(messages.createdAt, responder.floor),
      gte(messages.date, responder.floor),
      // `ne 'external'`, so `'us'` AND `'peer'` are both candidates — deliberately. This asks
      // "did mail arrive for me", not "may I move it": a message a READER adopted at the gate
      // (`'peer'`, `pipeline.ts#readerAdoption`) is still an arrival somebody sent, and the one
      // thing that must not earn an auto-reply is a message the user themselves filed.
      or(isNull(folderState.lastSetBy), ne(folderState.lastSetBy, "external")),
      // A DECIDED CANDIDATE IS OUT, FOR EVER. The anti-join, and the reason the pass converges.
      isNull(awayReplies.id),
      // THE ORGANIZER JOIN. A reader never replies — see the header.
      eq(mailboxes.organizerRole, "organizer"),
      eq(mailboxes.status, "connected"),
      ...(mailboxIds === undefined ? [] : [inArray(messages.mailboxId, [...mailboxIds])]),
      // A guard against a NULL date slipping through the comparison on a driver that folds it.
      isNotNull(messages.date),
    ))
    // Oldest first: if the budget clips this run, the people who wrote first are answered first.
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(batch);

  return rows.map((r) => ({
    id: r.id,
    mailboxId: r.mailboxId,
    fromAddress: r.fromAddress,
    subject: r.subject,
    messageIdHeader: r.messageIdHeader,
    /* The parent's own `References`, out of the stored header map — there is no column for it.
       Read case-blind over the object's OWN keys, for the reason `awayHeaderValues` states: a
       stored header map is `JSON.parse`d, so a bare `h["references"]` both misses `References` and
       can return an inherited value. */
    inReplyToChain: headerText((r.headers ?? {}) as Record<string, unknown>, "references"),
    noForward: r.noForward,
    sensitivityCategory: r.sensitivityCategory,
    headers: (r.headers ?? null) as Record<string, unknown> | null,
    desiredFolder: r.desiredFolder,
    alreadyReplied: Boolean(r.alreadyReplied),
    senderUndeliverable: Boolean(r.senderUndeliverable),
    ownAddress: r.ownAddress,
  }));
}

/**
 * ONE CANDIDATE: decide, reserve, send, finalize.
 *
 * ── THE ORDER IS THE WHOLE CORRECTNESS ARGUMENT ─────────────────────────────────────────────
 *
 *  1. ELIGIBILITY, which needs no network and no write. A suppression writes its ledger row and
 *     stops — the row is what takes this candidate out of the set for good.
 *  2. THE RESERVATION, one transaction, two statements, committed BEFORE anything dials:
 *       · `INSERT … ON CONFLICT (account_id, message_id) DO NOTHING RETURNING id` — 0 rows means
 *         another runner owns this message. Stop, write nothing, count nothing.
 *       · the sender upsert whose `WHERE` IS the throttle — 0 rows means "answered recently
 *         enough", and the ledger row is finalized `throttled` in the same transaction.
 *  3. THE SEND, outside the transaction. SMTP is not transactional and must never be inside one.
 *  4. THE FINALIZE, a compare-and-swap on `outcome='pending'`, so exactly one writer ever records
 *     a terminal state for this reservation.
 *
 * Reserving BEFORE the send makes a crash between them cost ONE UNSENT REPLY. Reserving after
 * would make it cost a duplicate reply to a stranger, again on every re-run — and at-most-once is
 * the requirement. The same argument, in the same words, as `unsubscribe_records`.
 */
async function answerOne(
  db: Db, responder: LiveResponder, candidate: Candidate, ownAddresses: ReadonlySet<string>,
  textHash: string, transport: () => Promise<SendAdapter | null>,
  result: AwayResponderPassResult, now: () => Date, log: Logger,
): Promise<void> {
  const sender = awayNormalizeAddress(candidate.fromAddress);

  // ── 1. WHO. The whole suppression set, in one pure function. ─────────────────────────────
  const suppression = awayEligibility({
    fromAddress: candidate.fromAddress,
    headers: candidate.headers ?? {},
    desiredFolder: candidate.desiredFolder,
    sensitivityCategory: candidate.sensitivityCategory,
    noForward: candidate.noForward,
    alreadyReplied: candidate.alreadyReplied,
    senderUndeliverable: candidate.senderUndeliverable,
  }, responder.audience, ownAddresses, responder.piles);

  if (suppression !== null) {
    await recordDecision(db, responder, candidate, sender, "suppressed", suppression, textHash, now());
    result.examined += 1;
    result.suppressed += 1;
    return;
  }

  // ── 2. THE TRANSPORT, RESOLVED BETWEEN THE VERDICT AND THE RESERVATION ───────────────────
  //
  // Deliberately AFTER eligibility and BEFORE the reservation, and both halves of that placement
  // are load-bearing:
  //
  //   after eligibility — a mailbox that cannot dial still DECIDES the candidates a guard refuses,
  //     so they leave the set for good instead of pinning the oldest page of every later run;
  //   before the reservation — a candidate that would need a send but has no path must cost
  //     NOTHING: no ledger row, no spent throttle, nobody recorded as answered. It is `deferred`
  //     and the next run tries again, which is risk 5 in the ruling and the branch a standalone
  //     install with no submission server actually takes.
  const adapter = await transport();
  if (!adapter) {
    result.deferredCandidates += 1;
    return;
  }

  // ── 3. THE RESERVATION AND THE ATOMIC THROTTLE ───────────────────────────────────────────
  const at = now();
  const minted = mintMessageId(domainOf(candidate.ownAddress));
  const reservation = await reserve(db, responder, candidate, sender, textHash, minted, at);

  if (reservation === "owned_elsewhere") {
    // Another runner holds this message's only reservation. It writes the ledger row and sends (or
    // does not); this one has nothing to decide and nothing to report about it.
    return;
  }
  result.examined += 1;
  if (reservation === "throttled") {
    result.throttled += 1;
    return;
  }

  // ── 4. THE SEND ──────────────────────────────────────────────────────────────────────────
  try {
    await adapter.send({
      from: candidate.ownAddress,
      // The address as STORED, not the normalised one: the normalisation exists to compare
      // addresses, and an envelope is addressed with what the sender actually wrote.
      to: candidate.fromAddress ?? sender,
      // REPLY-ONLY. No subject of its own — see the file header.
      subject: replySubject(candidate.subject),
      text: responder.body,
      messageId: minted,
      // Threading. Omitted rather than invented when the original carried no `Message-ID`.
      ...(candidate.messageIdHeader
        ? {
          inReplyTo: candidate.messageIdHeader,
          // The parent's own chain PLUS the parent, which is what RFC 5322 §3.6.4 asks for and
          // what keeps a long thread from splitting in the recipient's client. The parent alone
          // (which is what the old worker pass sent) threads correctly in most clients and
          // strands the reply in a few.
          references: referencesFor(candidate.inReplyToChain, candidate.messageIdHeader),
        }
        : {}),
      // RFC 3834 §5, on EVERY outgoing reply with no branch that can omit it: it is what stops the
      // recipient's own responder answering this one, and it is the same marker `auto_submitted`
      // refuses to reply to. A responder that demands it of others and does not set it is the loop
      // viewed from the other end.
      headers: { "Auto-Submitted": "auto-replied" },
    });
  } catch (err) {
    // THE CLAIM STAYS. SMTP is not transactional, so a throw means the delivery is AMBIGUOUS — it
    // may have reached the server before the failure. Releasing the claim would let the next run
    // send a second copy of a reply that was delivered. The interactive send path answers the same
    // ambiguity by probing Sent and NEVER resending; `unverified` is the conservative half of that
    // answer, which is the half an unattended pass can hold on its own.
    await finalize(db, candidate, responder.accountId, "unverified", scrub(err), null, now());
    result.unverified += 1;
    log.error("away_reply_send_failed", {
      accountId: responder.accountId, mailboxId: candidate.mailboxId, messageId: candidate.id,
      err,
      reason: "the reservation is KEPT and the outcome is `unverified` — an SMTP throw is " +
        "ambiguous and a resend risks a duplicate reply to this correspondent; no further reply " +
        "is sent for this message, ever",
    });
    return;
  }

  // ── 5. THE FINALIZE, compare-and-swap ────────────────────────────────────────────────────
  await finalize(db, candidate, responder.accountId, "sent", null, minted, now());
  result.sent += 1;
  log.info("away_reply_sent", {
    accountId: responder.accountId, mailboxId: candidate.mailboxId, messageId: candidate.id,
    throttle: responder.throttle,
  });
}

/**
 * THE RESERVATION TRANSACTION — the ledger INSERT and the throttle upsert, committed together.
 *
 * ── WHY THE UPSERT IS THE THROTTLE, AND NOT A READ ──────────────────────────────────────────
 *
 * "Has this person been answered in the last 24 hours" is answerable with a MAX over an index, and
 * that answer would be a READ — after which this pass would decide, and then write. Two runners
 * can both read "no" before either writes, and the correspondent gets two replies. Serialising it
 * needs a row to lock, and for a sender who has never been answered THERE IS NO ROW TO LOCK:
 * `SELECT … FOR UPDATE` locks nothing and `INSERT … WHERE NOT EXISTS` is not serialised against a
 * concurrent INSERT of the same key. Both were considered and refused for exactly that case.
 *
 * `INSERT … ON CONFLICT (account_id, sender) DO UPDATE SET … WHERE <predicate>` has no gap. The
 * INSERT arm and the UPDATE arm are one statement; the primary key is what orders two runners; and
 * the `WHERE` on the DO UPDATE is the decision. Zero rows returned means the predicate said no —
 * a DECISION, not a race, and the difference is that it is reproducible.
 *
 * ── AND WHY IT IS IN THE SAME TRANSACTION AS THE LEDGER ROW ─────────────────────────────────
 *
 * Split, they can disagree in the direction that sends twice: a committed sender-state update with
 * no ledger row would leave the message a candidate again, and a committed ledger row with no
 * sender-state update would let the NEXT message from the same person through the throttle. One
 * transaction makes "this message is reserved" and "this person has been answered" a single fact.
 */
async function reserve(
  db: Db, responder: LiveResponder, candidate: Candidate, sender: string,
  textHash: string, minted: string, at: Date,
): Promise<"reserved" | "throttled" | "owned_elsewhere"> {
  return (db as unknown as Tx).transaction(async (tx) => {
    const claim = await tx.insert(awayReplies).values({
      accountId: responder.accountId,
      mailboxId: candidate.mailboxId,
      messageId: candidate.id,
      sender,
      outcome: "pending",
      reason: null,
      textHash,
      mintedMessageId: minted,
      decidedAt: at,
      sentAt: null,
    }).onConflictDoNothing({
      target: [awayReplies.accountId, awayReplies.messageId],
    }).returning({ id: awayReplies.id });

    // ANOTHER RUNNER OWNS THIS MESSAGE. Exactly one INSERT wins; the loser stops here having
    // written nothing. There is no read-then-write window for two runners to race through.
    if (claim.length === 0) return "owned_elsewhere";

    /**
     * THE PREDICATE — one per throttle member, and each is watched red by its own mutation.
     *
     *   always       TRUE. Every message is answered.
     *   per_message  the stored hash differs from what the responder says NOW. Keyed by the TEXT
     *                and never by the row's `updated_at`: a save is not an edit, and keying on the
     *                row is what made switching the responder off and on again re-answer everyone.
     *   per_day      the last reply is at least 24 h old.
     *   per_week     …at least 7 days old.
     *
     * `EXCLUDED` is the row this INSERT proposed, so the SET writes the NEW instant and the NEW
     * hash whenever the predicate admits — which is what makes the next message's comparison run
     * against this reply rather than against an older one.
     */
    const cutoff = new Date(
      at.getTime() - (responder.throttle === "per_week" ? WEEK_MS : DAY_MS),
    ).toISOString();
    const predicate = responder.throttle === "always"
      ? sql`TRUE`
      : responder.throttle === "per_message"
        ? sql`${awaySenderState.lastTextHash} <> ${textHash}`
        : sql`${awaySenderState.lastRepliedAt} <= ${cutoff}::timestamptz`;

    const admitted = await tx.insert(awaySenderState).values({
      accountId: responder.accountId,
      sender,
      lastRepliedAt: at,
      lastTextHash: textHash,
    }).onConflictDoUpdate({
      target: [awaySenderState.accountId, awaySenderState.sender],
      set: { lastRepliedAt: at, lastTextHash: textHash },
      setWhere: predicate,
    }).returning({ sender: awaySenderState.sender });

    if (admitted.length === 0) {
      // THE THROTTLE REFUSED. The ledger row is finalized in this same transaction — the candidate
      // is decided, leaves the set for good, and carries the reason an operator needs.
      //
      // `mintedMessageId` is CLEARED, and that is not tidiness. The id is minted before the
      // reservation so that a crash between the reservation and the send leaves an attributable
      // one; a throttled row had no send, so an id left standing on it would be a `<uuid@domain>`
      // that appears in no Sent folder and never will. The column's whole purpose is to correlate a
      // ledger row with a delivered copy, and a value that correlates with nothing is worse than
      // NULL — it is a thread an operator can pull for as long as they like.
      await tx.update(awayReplies)
        .set({ outcome: "throttled", reason: responder.throttle, sentAt: null, mintedMessageId: null })
        .where(and(eq(awayReplies.id, claim[0]!.id), eq(awayReplies.outcome, "pending")));
      return "throttled";
    }
    return "reserved";
  });
}

/**
 * THE TERMINAL WRITE, COMPARE-AND-SWAP on `outcome='pending'`.
 *
 * The CAS is what makes exactly one writer record an ending. Without it, a late finalizer from a
 * run that was overtaken could turn `sent` into `unverified` — the same defect found in the
 * interactive send path's own finalizers, and the same fix. `sent_at` is written only on `sent`:
 * an `unverified` row has no send instant it can honestly claim.
 */
async function finalize(
  db: Db, candidate: Candidate, accountId: string,
  outcome: "sent" | "unverified", reason: string | null, minted: string | null, at: Date,
): Promise<void> {
  await (db as unknown as Tx).update(awayReplies)
    .set({
      outcome, reason,
      ...(minted ? { mintedMessageId: minted } : {}),
      ...(outcome === "sent" ? { sentAt: at } : {}),
    })
    .where(and(
      eq(awayReplies.accountId, accountId),
      eq(awayReplies.messageId, candidate.id),
      eq(awayReplies.outcome, "pending"),
    ));
}

/**
 * A DECIDED-AND-NOT-SENT candidate's ledger row, written outside any transaction because there is
 * nothing to make atomic with it: no reservation is taken and no sender state moves.
 *
 * `ON CONFLICT DO NOTHING` because a concurrent runner may have reserved this message between the
 * candidate read and here. Its decision is the one that counts — it holds the reservation.
 */
async function recordDecision(
  db: Db, responder: LiveResponder, candidate: Candidate, sender: string,
  outcome: "suppressed", reason: AwaySuppression, textHash: string, at: Date,
): Promise<void> {
  await (db as unknown as Tx).insert(awayReplies).values({
    accountId: responder.accountId,
    mailboxId: candidate.mailboxId,
    messageId: candidate.id,
    sender,
    outcome,
    reason,
    textHash,
    mintedMessageId: null,
    decidedAt: at,
    sentAt: null,
  }).onConflictDoNothing({ target: [awayReplies.accountId, awayReplies.messageId] });
}

/**
 * The `References` chain for the reply: the parent's own chain, then the parent's id LAST.
 *
 * ── TWO BUGS THIS HAD, BOTH IN THE HEADER IT ALREADY CARRIED ─────────────────────────────────
 *
 * It used to test only whether the parent was the chain's LAST element before appending it. A
 * parent that appeared MID-chain — `<a> <p> <b>` with parent `<p>`, which is what a client that
 * reorders or a forwarded thread produces — therefore appended a duplicate, the dedup kept the
 * FIRST occurrence, and the result was `<a> <p> <b>`: a chain whose last id is not the message
 * being replied to. RFC 5322 §3.6.4 is what strict clients use to place a reply, and the function's
 * own sentence ("the parent's own chain PLUS the parent") was the thing it did not do.
 *
 * And the trim took the LAST twenty (`slice(-20)`), which drops the thread ROOT — the one id RFC
 * 5322 §3.6.4 says to keep when a chain must be shortened, because it is what identifies the
 * conversation. Trimming now keeps the root and drops from the middle, which is the shape every
 * mail client that shortens a chain uses.
 */
function referencesFor(parentChain: string | null, parentId: string): string {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of (parentChain ?? "").split(/\s+/)) {
    // The parent is removed wherever it sits and re-appended below, so it can only ever be last.
    if (id.length === 0 || id === parentId || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  ids.push(parentId);
  if (ids.length <= AWAY_REFERENCES_MAX) return ids.join(" ");
  // Root first, then the most recent tail — never a window that has lost the conversation's id.
  return [ids[0]!, ...ids.slice(-(AWAY_REFERENCES_MAX - 1))].join(" ");
}

/**
 * ONE HEADER AS FLAT TEXT, or null — case-blind over the map's OWN keys, and array values joined.
 *
 * The same accessor shape as `awayHeaderValues` in core and duplicated here for the same narrow
 * reason: it is a loop with no policy in it. The POLICY — which headers forbid an auto-reply — is
 * `awayEligibility`'s and is called, never copied.
 */
function headerText(headers: Record<string, unknown>, name: string): string | null {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const v = headers[key];
    if (v === null || v === undefined) return null;
    return Array.isArray(v) ? v.map((x) => String(x)).join(" ") : String(v);
  }
  return null;
}

/** The domain of an address, for minting a Message-ID that looks like it came from this mailbox. */
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : "";
}

/** class + code, never message text — the scrubbing rule `billing_events.error` states. */
function scrub(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: string } } | null;
  const cls = typeof e?.name === "string" ? e.name : e?.constructor?.name ?? "unknown";
  const code = typeof e?.code === "string" ? e.code : null;
  return code ? `${cls}:${code}` : cls;
}
