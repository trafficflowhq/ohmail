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
import { dialect } from "@trafficflow/db/dialect";
import type { Db } from "./context.js";

/**
 * The away responder's pass — reply-only, throttled per person, on all three hosts. It moved out
 * of the worker because the sync host's platform blocks outbound SMTP at the port level, so the
 * worker pass had almost certainly never delivered a reply. It now runs where a send can happen:
 * the API host on Cloud, the drain on a standalone desktop, the self-host send clock. Safety: an
 * away reply is a DETERMINISTIC standing order — exact text, written in advance, to a stated
 * audience, at a stated rate; the pass composes nothing. WHO is `awayEligibility` in core (pure,
 * table-testable); HOW OFTEN is the atomic upsert below. Reply-only: `Re: <what they wrote>` with
 * `In-Reply-To`/`References`, via `replySubject`.
 */

/**
 * Replies one INVOCATION may send, across every account it serves. Five — a cap on OUTBOUND MAIL
 * rather than database work: it bounds what a misconfiguration can do before anybody notices,
 * sized for the host with the least room (the hosted route runs in a serverless invocation with a
 * 60-second ceiling, and each reply is an SMTP dial plus an IMAP append, seconds each, unbounded
 * in the tail). A genuine away period answers a handful of people per minute; an account hitting
 * this ceiling every cycle is a fact worth reading in the log, not a throughput problem to tune
 * away.
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
   * Stop before the next delivery — a predicate this pass consults between rows. A pass that has
   * begun is not entitled to finish: on the desktop the mailbox can change hands MID-PASS (the
   * socket dies, a re-dial re-reads the organizer lease, a stranger's claim is found) while this
   * loop still holds rows claimed under the old answer — sending them duplicates the real
   * organizer's reply from an install the mailbox no longer belongs to, and no check BEFORE the
   * pass can see it. `true` stops the loop where it stands; claimed rows are left to the
   * reconciler, the same recovery any crash takes. Absent means "never cancel", so every hosted
   * caller is unchanged.
   */
  cancelled?: () => boolean;

  /** The send transport — `makeSendAdapter` on the hosted and self-hosted hosts, the local dial on the desktop. */
  openSendAdapter: OpenSendAdapter;
  /**
   * May this account's automation still fire? — the suspension gate, INJECTED: the fact lives in
   * the cloud half (`account_suspensions`) and this pass ships in the desktop engine bundle,
   * which may not name a cloud table. The hosted route and self-host clock inject the real read;
   * the standalone door injects nothing, which resolves to ELIGIBLE. Consulted BEFORE the
   * candidates are read, so a suspended account's mail is not examined and no ledger row is
   * written: replies go out promptly once the suspension lifts. Not inside a claim transaction —
   * the claim here is per-reply — but the signature matches the scheduled pass's, so one injector
   * serves both.
   */
  accountEligible?: (accountId: string, db: Db) => Promise<boolean>;
  /**
   * Which mailboxes this pass may answer for — absent means ALL, the hosted clock's shape. The
   * organizer JOIN already refuses a mailbox this install merely reads; this exists for the
   * standalone desktop: the drain calls the pass once PER RUNTIME, and without narrowing each
   * organizing runtime would scan and claim for every other one. AN EMPTY ARRAY MEANS NONE, not
   * absent: `undefined` is "no filter"; `[]` is "this caller has no mailboxes", which must answer
   * NOTHING. Folding them would make an install with no organizing runtime answer mail for every
   * mailbox in the store.
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

  /* Both before the probe. The ORDER between these two is not load-bearing and was measured not to
     be: the sweep's WHERE does not read `enabled_at` and it clears the column anyway, so a heal
     that ran first leaves the same row. Expiry is first because it saves the heal that write. */
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
 * The probe — every responder that is LIVE right now, one indexed read. `enabled_at IS NOT NULL`
 * is required: treating NULL as "the beginning of time" would answer the entire stored backlog. A
 * writer CAN produce that shape — during a rolling deploy an older API saves `enabled: true`
 * without writing `enabled_at`, and the probe would exclude the row FOR EVER: a responder
 * silently dead. So {@link healMissingEnabledAt} stamps `now()` on exactly that shape first — the
 * healing run answers no backlog. Nothing is composed here: a responder with no body is
 * unfinished, not defaulted — inventing text would put words nobody wrote into mail sent in their
 * name.
 */
/**
 * Stamp an enablement instant on a row that is enabled without one — the rolling-deploy shape
 * described on {@link liveResponders}: an older API enables a responder without writing
 * `enabled_at`, and the probe would exclude the row for ever. One guarded UPDATE per run,
 * matching nothing on a healthy deployment. `now` rather than `updated_at`: a row healed here
 * answers NO backlog, because its floor is the instant of the heal — the same direction every
 * absent-evidence decision in this feature takes: an unanswered correspondent is recoverable, a
 * stranger answered from a window nobody chose is not.
 */
/**
 * Switch off every responder whose end date has passed — one guarded UPDATE per run, matching
 * nothing once run. `ends_at` already ends the answering window, so this changes no mail; it
 * changes the STATE somebody reads and what a re-enable does: without it the switch says "On"
 * while nothing is sent, and extending the date months later would answer everything in between
 * (`enabled_at` only moves on OFF → ON). The write is `put`'s own switch-off: `enabled` false,
 * `enabled_at` null, `ends_at` cleared. Idempotent by the WHERE; narrowed by the caller's
 * mailboxes exactly as the probe is.
 */
async function expireEndedResponders(
  db: Db, at: Date, mailboxIds: readonly string[] | undefined, log: Logger,
): Promise<number> {
  const rows = await (db as unknown as Tx).update(awayResponders)
    .set({ enabled: false, enabledAt: null, endsAt: null, updatedAt: at })
    .where(and(
      eq(awayResponders.enabled, true),
      isNotNull(awayResponders.endsAt),
      sql`${awayResponders.endsAt} < ${dialect(db).ts(at)}`,
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
  const d = dialect(db);
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
      // THROUGH THE SEAM'S TIMESTAMP BINDER. Written as an explicit server cast, this pass failed
      // on the device store at `unrecognized token: ":"` — and it is the pass every drain runs, so
      // it took the drain down rather than the responder. The binder writes each store's own
      // literal for one instant: the server's cast, unchanged, and this store's epoch millisecond.
      or(isNull(awayResponders.startsAt), sql`${awayResponders.startsAt} <= ${d.ts(at)}`)!,
      or(isNull(awayResponders.endsAt), sql`${awayResponders.endsAt} >= ${d.ts(at)}`)!,
      /**
       * The mailbox narrowing reaches the PROBE, not only the candidates. It used to be discarded
       * here (`void mailboxIds`). Cheaply wrong: a caller naming its mailboxes still read up to
       * `AWAY_ACCOUNTS_PER_RUN` responders for accounts it did not ask about and ran a full
       * candidate query for each. And correctly wrong: the probe is a PAGE — ordered and capped,
       * it can exclude the very account the caller named (the shared test store shows it today:
       * 70 live responders older than a freshly seeded one, cap 50), so a drain naming its own
       * mailbox would be silently served nothing. The page is now drawn from the accounts owning
       * the named mailboxes; absent means every account, the hosted clock's shape.
       */
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

  // Eligibility FIRST, the adapter only for what survives it. The order was reversed and wrong:
  // `awayEligibility` needs no network, but it was reached only inside the `try` following a
  // successful `openSendAdapter` — so a mailbox whose factory throws (no credentials,
  // disconnected, a standalone install with no submission server) left ALL its candidates
  // deferred with no ledger row. That is starvation, not waste: `readCandidates` is oldest-first
  // with a fixed limit and the ledger anti-join is the only thing that removes a row, so
  // undecidable candidates pin the oldest page of every later run — once there are `batch` of
  // them, nothing behind them on the account is examined again, including a healthy mailbox's
  // candidates. So: decide every candidate first (a suppression writes its ledger row and leaves
  // the set permanently), open a transport LAZILY, only when a candidate survives to needing one.
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
 * Which correspondents' addresses are DEAD — read the bounces from this account's own away
 * replies and stamp `away_sender_state.undeliverable_at`. Without it, a reply to a dead address
 * bounced, nothing recorded what it meant, and the next message produced another reply and
 * bounce, per throttle interval. The tie is the MINTED Message-ID on the ledger row; a delivery
 * report quotes it in `In-Reply-To`/`References`, and the address marked is the LEDGER row's
 * `sender`, never the mailer-daemon. The report test is not optional: a HUMAN reply also carries
 * the minted id, so the message must also BE a report (`isDeliveryReport`). It never blocks a
 * reply: a fault means this run does not learn — 0 on a throw.
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
 * The candidate query — every predicate is CANDIDACY, never a suppression (a guard in the WHERE
 * cannot be watched to fail; what DECIDES lives in `awayEligibility`). A row held in the loop
 * writes no ledger row, pins the oldest page, and the pass stops converging. floor: `created_at >
 * floor AND date >= floor` — the ingest clock lies about history (a backfill stamps years-old
 * mail with the ingest instant), so the message's own send time is required; NULL `date` is out.
 * placement: `last_set_by <> 'external'` — an external placement is not an arrival. ledger: the
 * anti-join — a decided candidate leaves the set permanently. organizer:
 * `organizer_role='organizer' AND status='connected'` — a READER never replies.
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
     * Is this correspondent's address dead? — one correlated EXISTS over the sender state,
     * decided in SQL. A LEFT JOIN would be the obvious and wrong shape: that table is also the
     * THROTTLE's row, so the join would put a column here whose absence (a sender never answered)
     * is indistinguishable from a present row with a null stamp. An EXISTS answers the one
     * question asked, and a sender with no row is correctly `false`. Matched on the NORMALISED
     * address, because that is what the reservation writes: `lower(trim(…))` on both sides, or a
     * correspondent who wrote from two spellings of one address is two people.
     */
    senderUndeliverable: sql<boolean>`EXISTS (
      SELECT 1 FROM ${awaySenderState} AS ss
       WHERE ss.account_id = ${messages.accountId}
         AND ss.sender = lower(trim(${messages.fromAddress}))
         AND ss.undeliverable_at IS NOT NULL
    )`.as("sender_undeliverable"),
    /**
     * Has this correspondent already heard from this mailbox about this thread? — one correlated
     * EXISTS, handed to `awayEligibility` as a boolean. "Own-authored" is `from_address` being
     * one of the account's own addresses — the only durable record of authorship: ingest sees the
     * Sent copy of everything, so a manual reply and an earlier automatic reply from ANY install
     * both land as an own-authored message in the thread. `date >= candidate.date` scopes it to a
     * reply TO this message. It covers what the ledger cannot: the ledger is per-install, so an
     * install that took over mid-window has no row for a reply another install sent — but that
     * reply is in the mailbox, and this sees it.
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
    /**
     * An INNER join — a suppression-set hole if it is not. It was a LEFT join with `headers ??
     * {}` downstream: `{}` reads as "no markers", the PERMISSIVE answer, so a message with no
     * stored body cleared `List-Id`, `List-Unsubscribe`, `Feedback-ID`, `Precedence` and the rest
     * in one go and fell through to "send". Body-less rows are real: the desktop's Cloud mirror
     * inserts `messages` without bodies and backfills them. The concrete failure is an auto-reply
     * to a mailing list, or to another responder — an unbounded loop. A message whose body has
     * not arrived is NOT A CANDIDATE YET: it costs a poll interval and fails toward silence.
     */
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
 * One candidate: decide, reserve, send, finalize — the order is the correctness argument. (1)
 * ELIGIBILITY, no network: a suppression writes its ledger row and stops. (2) THE RESERVATION,
 * one transaction committed BEFORE anything dials: `INSERT … ON CONFLICT DO NOTHING RETURNING` (0
 * rows = another runner owns it), and the sender upsert whose WHERE is the throttle (0 rows =
 * answered recently, finalized `throttled`). (3) THE SEND, outside the transaction — SMTP is not
 * transactional. (4) THE FINALIZE, a compare-and-swap on `outcome='pending'`. Reserving BEFORE
 * the send makes a crash cost ONE UNSENT REPLY; after, a duplicate reply to a stranger on every
 * re-run — and at-most-once is the requirement.
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

  // The transport, resolved BETWEEN the verdict and the reservation — both halves load-bearing:
  // after eligibility, so a mailbox that cannot dial still DECIDES the candidates a guard refuses
  // (they leave the set for good instead of pinning the oldest page); before the reservation, so
  // a candidate that needs a send but has no path costs NOTHING — no ledger row, no spent
  // throttle, nobody recorded as answered. It is `deferred` and the next run tries again, the
  // branch a standalone install with no submission server actually takes.
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
 * The reservation transaction — the ledger INSERT and the throttle upsert, committed together.
 * The upsert IS the throttle: a read ("answered in 24 h?") lets two runners both pass before
 * either writes, and for a never-answered sender there is no row to lock. `INSERT … ON CONFLICT
 * (account_id, sender) DO UPDATE SET … WHERE <predicate>` has no gap: one statement, the primary
 * key orders two runners, and zero rows returned is a DECISION, not a race. Same transaction as
 * the ledger row because split they disagree in the direction that sends twice: sender-state
 * without ledger leaves the message a candidate again; ledger without sender-state lets the next
 * message through the throttle.
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
     * The predicate — one per throttle member, each watched red by its own mutation. `always`:
     * TRUE, every message answered. `per_message`: the stored hash differs from what the
     * responder says NOW — keyed by the TEXT, never the row's `updated_at`: a save is not an
     * edit, and keying on the row is what made switching the responder off and on re-answer
     * everyone. `per_day`: the last reply is at least 24 h old; `per_week`: at least 7 days.
     * `EXCLUDED` is the row this INSERT proposed, so the SET writes the NEW instant and hash
     * whenever the predicate admits — the next message compares against this reply rather than an
     * older one.
     */
    const cutoff = new Date(
      at.getTime() - (responder.throttle === "per_week" ? WEEK_MS : DAY_MS),
    );
    // The same binder as the in-window predicate above, for the same reason: an instant compared
    // against a timestamp column has no column to take its type from, so each store needs its own
    // literal rather than the server's cast.
    const predicate = responder.throttle === "always"
      ? sql`TRUE`
      : responder.throttle === "per_message"
        ? sql`${awaySenderState.lastTextHash} <> ${textHash}`
        : sql`${awaySenderState.lastRepliedAt} <= ${dialect(db).ts(cutoff)}`;

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
 * The `References` chain for the reply: the parent's own chain, then the parent's id LAST. Two
 * bugs it had, both against the header it carried: it tested only whether the parent was the
 * chain's LAST element before appending — a parent appearing MID-chain (`<a> <p> <b>`, what a
 * reordering client or a forwarded thread produces) appended a duplicate, the dedup kept the
 * FIRST occurrence, and the chain's last id was not the message being replied to (RFC 5322 §3.6.4
 * is what strict clients place a reply by). And the trim took the LAST twenty (`slice(-20)`),
 * dropping the thread ROOT — the one id §3.6.4 says to keep when shortening. Trimming now keeps
 * the root and drops from the middle, the shape every shortening mail client uses.
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
