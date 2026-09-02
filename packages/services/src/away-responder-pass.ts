import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import {
  awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies, messages,
  type Tx,
} from "@trafficflow/db";
import {
  awayEligibility, awayNormalizeAddress, awayTextHash, createLogger, mintMessageId, replySubject,
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
 * Accounts one invocation will consult. A responder that is live right now is rare, so this is a
 * runaway brake rather than a page size — and it is bounded for the same reason the scheduled
 * pass bounds its own walk: one invocation must finish inside a platform deadline.
 */
export const AWAY_ACCOUNTS_PER_RUN = 50;

/** The throttle members, as the closed set this pass and the service validator share. */
export const AWAY_THROTTLES = ["always", "per_message", "per_day", "per_week"] as const;
export type AwayThrottle = (typeof AWAY_THROTTLES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const defaultLog = createLogger({ service: "away-responder" });

export interface AwayResponderPassDeps {
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
   * Left for the next run WITHOUT a ledger row — a mailbox whose adapter would not open, or an
   * account the eligibility gate parked. Nothing is decided and nothing is spent.
   */
  deferred: number;
  /** True ⇒ the send budget was reached and there was more to answer. */
  capped: boolean;
}

/** One live responder, as the probe reads it. */
interface LiveResponder {
  accountId: string;
  body: string;
  audience: AwayAudience;
  throttle: AwayThrottle;
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
    deferred: 0, capped: false,
  };

  /* NONE MEANS NONE, decided before a single row is read. See the field's own note. */
  if (deps.mailboxIds !== undefined && deps.mailboxIds.length === 0) return result;

  const live = await liveResponders(db, now(), deps.mailboxIds);
  result.accounts = live.length;

  for (const responder of live) {
    if (result.sent >= budget) { result.capped = true; break; }
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
 * `enabled_at IS NOT NULL` is required and not merely read: it is the floor's first half, and a
 * responder that is `enabled` with no enablement instant is a row 0087 could not backfill (it was
 * not enabled when the migration ran) and that no writer since produces. Treating a NULL as "the
 * beginning of time" would answer the entire stored backlog the moment such a row appeared.
 *
 * NOTHING IS COMPOSED HERE. A responder with no body is not a responder with a default — it is an
 * unfinished one, and inventing text would put words nobody wrote into mail sent in their name.
 * The Settings form requires it; this is the same requirement where it cannot be bypassed. The
 * SUBJECT is deliberately not consulted at all any more: the reply derives its own.
 */
async function liveResponders(
  db: Db, at: Date, mailboxIds: readonly string[] | undefined,
): Promise<LiveResponder[]> {
  const rows = await (db as unknown as Tx).select({
    accountId: awayResponders.accountId,
    body: awayResponders.body,
    audience: awayResponders.audience,
    throttle: awayResponders.throttle,
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
    ))
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
      floor,
    });
  }
  void mailboxIds;   // the narrowing is applied to CANDIDATES, not to the responder probe
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
    result.deferred += 1;
    return;
  }

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

  // ── ONE ADAPTER PER DISTINCT MAILBOX, RESOLVED BEFORE ITS CANDIDATES ARE CLAIMED ──────────
  //
  // The ordering is the point. A factory that throws — no credentials, a mailbox disconnected since
  // the mail arrived, a standalone install with no SMTP configured — must cost NOTHING: no ledger
  // row, no spent reservation, no correspondent silently marked answered. It is `deferred`, and the
  // next run tries again. This is risk 5 in the ruling ("injected default = untested branch"), and
  // it is the branch a standalone install with no submission server actually takes.
  const byMailbox = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const held = byMailbox.get(c.mailboxId);
    if (held) held.push(c); else byMailbox.set(c.mailboxId, [c]);
  }

  for (const [mailboxId, group] of byMailbox) {
    if (result.sent >= budget) { result.capped = true; return; }
    let adapter: SendAdapter;
    try {
      adapter = await deps.openSendAdapter(mailboxId);
    } catch (err) {
      result.deferred += group.length;
      log.warn("away_responder_no_send_path", {
        accountId: responder.accountId, mailboxId, err,
        reason: "no ledger row was written and no reservation was spent — these candidates are " +
          "examined again next run, and nobody is recorded as answered",
      });
      continue;
    }
    try {
      for (const candidate of group) {
        if (result.sent >= budget) { result.capped = true; return; }
        await answerOne(db, responder, candidate, ownAddresses, textHash, adapter, result, now, log);
      }
    } finally {
      // ALWAYS, including the send-budget return above: a leaked authenticated socket on the send
      // path is worse than elsewhere, because what follows it is a retry of a send.
      await adapter.close().catch(() => { /* already broken; nothing here can act on it */ });
    }
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
  const floorIso = responder.floor.toISOString();
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
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .leftJoin(folderState, eq(folderState.messageId, messages.id))
    .leftJoin(awayReplies, and(
      eq(awayReplies.accountId, messages.accountId), eq(awayReplies.messageId, messages.id),
    ))
    .where(and(
      eq(messages.accountId, responder.accountId),
      gt(messages.createdAt, responder.floor),
      gte(messages.date, responder.floor),
      or(isNull(folderState.lastSetBy), ne(folderState.lastSetBy, "external")),
      // A DECIDED CANDIDATE IS OUT, FOR EVER. The anti-join, and the reason the pass converges.
      isNull(awayReplies.id),
      // THE ORGANIZER JOIN. A reader never replies — see the header.
      eq(mailboxes.organizerRole, "organizer"),
      eq(mailboxes.status, "connected"),
      ...(mailboxIds === undefined ? [] : [inArray(messages.mailboxId, [...mailboxIds])]),
      // A guard against a NULL date slipping through the comparison on a driver that folds it.
      isNotNull(messages.date),
      sql`${floorIso}::timestamptz IS NOT NULL`,
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
  textHash: string, adapter: SendAdapter, result: AwayResponderPassResult,
  now: () => Date, log: Logger,
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
  }, responder.audience, ownAddresses);

  if (suppression !== null) {
    await recordDecision(db, responder, candidate, sender, "suppressed", suppression, textHash, now());
    result.examined += 1;
    result.suppressed += 1;
    return;
  }

  // ── 2. THE RESERVATION AND THE ATOMIC THROTTLE ───────────────────────────────────────────
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

  // ── 3. THE SEND ──────────────────────────────────────────────────────────────────────────
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

  // ── 4. THE FINALIZE, compare-and-swap ────────────────────────────────────────────────────
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
      await tx.update(awayReplies)
        .set({ outcome: "throttled", reason: responder.throttle, sentAt: null })
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
 * The `References` chain for the reply: the parent's own chain plus the parent's id.
 *
 * Deduplicated and bounded — a chain that already ends with the parent (some clients store it that
 * way) must not repeat it, and a pathological thread must not produce an unbounded header. Twenty
 * ids is well past what any client renders and short of anything a server would refuse.
 */
function referencesFor(parentChain: string | null, parentId: string): string {
  const ids = (parentChain ?? "").split(/\s+/).filter((s) => s.length > 0);
  if (ids[ids.length - 1] !== parentId) ids.push(parentId);
  const seen = new Set<string>();
  const unique = ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return unique.slice(-20).join(" ");
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
