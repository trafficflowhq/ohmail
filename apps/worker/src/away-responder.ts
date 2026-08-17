import { and, asc, eq, gt, gte, isNull, ne, or } from "drizzle-orm";
import {
  awayResponderSent, awayResponders, folderState, mailboxes, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import { autoReplySuppression, silentLogger, type Logger } from "@trafficflow/core";
import type { OutboundMessage } from "@trafficflow/core/adapters/imap";
import { mintMessageId } from "@trafficflow/core/mail";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE AWAY RESPONDER'S SENDER — the half that had never existed
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT WAS SHIPPED, AND WHAT IT DID ───────────────────────────────────────────────────────

   `away_responders` has been a table since mail 0010 and `PUT /away-responder` has been writing
   rows into it for as long. NOTHING in this system has ever read one. Not a single automatic reply
   has been sent: there was a form, a stored row and a REST endpoint, and no sender at either end
   of them. This file is the sender.

   That history is why the guards below are the substance of the slice and the send is the easy
   part. A responder that has never fired has also never been observed to fire WRONGLY, so nothing
   here can be argued from experience — each suppression has to be a structure that can be watched
   to fail, and `test/away-responder.test.ts` mutates each one and watches a second or
   an errant reply leave.

   ── NOTHING IS EVER SENT WITHOUT THE USER SAYING SO ─────────────────────────────────────────

   An away reply is mail leaving somebody's mailbox in their name while they are not looking, so
   the invariant has to be answered head-on rather than exempted.

   It is answered by what the instruction IS. This is not a model deciding to write to somebody: it
   is a DETERMINISTIC standing instruction — this exact subject and this exact body, composed by
   the mailbox's owner in advance, to correspondents matching a stated audience, for a stated period. The
   consent is the configuration, and the pass has no latitude of its own: it composes nothing,
   chooses no words, and consults no classifier (this file imports no model and reaches no credit
   gate). Turning the responder on IS the authorisation, in the same way that enabling a workflow
   is the authorisation for its steps.

   What the invariant then requires is that the standing instruction cannot reach anyone its owner
   did not mean, and cannot fire twice. That is the suppression set, and it is the whole of the
   safety argument:

     audience        `screened_in` (the default) answers only senders already past the Screener.
     already_replied at most one reply per sender per enablement episode — the UNIQUE on
                     `away_responder_sent`, claimed BEFORE the send.

   Before any of those, a row must be a CANDIDATE at all, and re-read history is not one. Two
   per-row facts gate candidacy in the query itself (see the candidate query's note for why the
   query and not the loop): a placement authored outside ohmail
   (`folder_state.last_set_by = 'external'` — the passive-backfill and owner-filed shape) is not
   an arrival, and a stated send time (`messages.date`) older than the episode floor — or absent
   — is mail written before this away period existed.
     list_mail       never to a mailing list or an ESP campaign. A reply to a list is delivered to
                     every subscriber; it is also public.
     auto_submitted  never to something that announced itself as automatic (RFC 3834). Two
                     responders answering each other is an unbounded loop between mail systems.
     service_sender  never to `no-reply@`, `bounce@`, `postmaster@` and the rest — nobody reads
                     those, and some of them bounce back.
     own_address     never to any address on this account. Ingest sees the Sent copy of every
                     message the account sends; without this the responder answers itself.
     sensitive       never to a message the pipeline flagged sensitive or `no_forward`. That mail
                     is a login code, a password reset or an account alert, and a reply to it both
                     tells a possible attacker the address is live and puts the flagged subject
                     line into an outbound message.
     no_send_path    no reply from a mailbox this process is not currently the organizer of.

   And every reply it does send carries `Auto-Submitted: auto-replied`, which is this system's half
   of the same courtesy it demands above — the header that stops somebody else's responder
   answering ours.

   ── CLOUD ONLY (owner decision) ─────────────────────────────────────────────────────────────

   This file lives under `apps/worker/src`, which is reachable only from the hosted worker: the
   four subpaths this app exports (`./sync`, `./lease`, `./entry`, `./classifier-fault`) do not
   include it, so the local desktop engine cannot import it even by accident — asserted by a
   suite rather than trusted.
   A local install's mailbox is organized by the same lease; if it also answered mail there would be
   two responders on one mailbox with two separate at-most-once records.

   ── WHY IT IS A WORKER PASS AND NOT AN API ROUTE ────────────────────────────────────────────

   The trigger is "mail arrived", which nothing on the API host observes. It also SENDS, which
   means an SMTP connection, which means the process that already holds one per mailbox — the
   worker, which is also the single elected writer, so exactly one process runs this and the
   at-most-once record has one author. It needs nothing from the services package (the dependency
   rule, `test/deps.test.ts`): the db and core packages are the whole of its imports.

   ── WHAT "NEWLY INGESTED" MEANS, AND WHY THERE IS NO CURSOR ─────────────────────────────────

   The candidate set is `messages.created_at > episode floor`, where the floor is the LATER of the
   responder's `updated_at` (when this configuration was written) and its `starts_at` (when the
   owner said the away period begins). So enabling a responder never answers the backlog — mail
   that arrived before the current configuration existed is not a candidate at all, which is also
   why the migration seeds no suppression rows.

   `created_at` alone is NOT "newly ingested is newly arrived", and treating it as though it were
   was a real defect: `insertMessage` omits `createdAt`, so the column default stamps a
   first-time backfill's years-old mail with the ingest instant, inside any live episode's window.
   The candidacy predicates on the query below are the correction: the ingest-clock bound stays
   (it is the only indexed-adjacent bound there is), and a row must ALSO carry a placement we
   authored and a stated send time inside the episode to be a candidate at all.

   There is deliberately no resume cursor. `away_responder_sent` IS the idempotency: a sender that
   has been answered is excluded by the claim, so re-running the pass over the same window writes
   nothing. A cursor would add a second, weaker record of the same fact — and `rules.retro_cursor`
   already documents what a `messages.id` cursor costs (a random UUID is monotone only within one
   run's ordering, so a backlog still draining is skipped for ever).

   ── THE CANDIDATE QUERY IS UNINDEXED, AND THAT IS A DECISION WITH A COST ────────────────────

   `WHERE account_id = $1 AND created_at > $2` has no index behind it: `messages` carries six
   indexes and not one of them leads with `(account_id, created_at)`. So for an account whose
   responder is LIVE, each cycle walks that account's rows through an `account_id`-prefix index and
   filters on the heap. That is real, and it is not hidden here so nobody has to rediscover it.

   The index was considered and refused, on `0047_read_order`'s stated rule: a plain `CREATE INDEX`
   on the largest table in the schema takes a lock that blocks writes for the length of the build,
   and `CREATE INDEX CONCURRENTLY` cannot run inside the transaction the migrator wraps every
   migration in. So shipping the index means either a write outage during the deploy or a hand-run
   operator step, and neither is worth taking for a query that runs ONLY for an account that is
   away right now — the probe above returns before this query for everybody else, which is
   ~everybody. The candidate index is a recorded follow-up for the day that
   population is large enough to matter.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Where a first-contact stranger waits. `audience='screened_in'` does not answer mail sitting here. */
const SCREENER = "ohmail/Screener";

/**
 * Candidate rows examined per pass. The same order of magnitude as the sibling passes, for a
 * different reason: this one is bounded by what it may SEND, not by what it may write, so the read
 * is generous and {@link AWAY_SENDS_PER_CYCLE} is the real limit.
 */
export const AWAY_BATCH = 200;

/**
 * Replies one account may send in one cycle.
 *
 * A cap on OUTBOUND MAIL, which is a different kind of budget from the sibling passes' write
 * budgets: those pace the reconciler, this bounds the damage a misconfiguration can do before
 * anybody notices. Ten is chosen to be obviously survivable rather than to be sufficient — a
 * genuine away period answers a handful of people per poll interval, and an account that hits this
 * ceiling every cycle is a fact worth reading in the log rather than a throughput problem.
 */
export const AWAY_SENDS_PER_CYCLE = 10;

/** Why a candidate was NOT answered. Every member is asserted by a mutation test. */
export type AwaySuppression =
  | "already_replied"
  | "not_screened_in"
  | "list_mail"
  | "auto_submitted"
  | "service_sender"
  | "own_address"
  | "sensitive"
  | "no_send_path"
  | "send_failed";

/** Why the pass did no work at all for an account. */
export type AwaySkip = "no_row" | "disabled" | "out_of_window" | "unconfigured";

/** The narrow send seam. `ImapAdapter` satisfies it; a test passes a spy. */
export interface AwaySendPort {
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
}

/**
 * Open a send path for one mailbox, or `null` when there is none.
 *
 * `null` is not an error and must not be treated as one: the worker returns it for a mailbox this
 * process is not currently attached to, which is the ordinary state of a mailbox another shard
 * organizes. It suppresses WITHOUT claiming, so the reply is still owed and the shard that does
 * hold the mailbox sends it.
 */
export type OpenAwaySend = (mailboxId: string) => Promise<AwaySendPort | null>;

export interface AwayResponderDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  /** The send seam, injected. Production hands over the attached adapter; tests hand over a spy. */
  openSend: OpenAwaySend;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link AWAY_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link AWAY_SENDS_PER_CYCLE}. */
  sendsPerCycle?: number;
}

export interface AwayResponderResult {
  /** False ⇒ nothing beyond the one-row responder read happened. `skip` says why. */
  ran: boolean;
  skip: AwaySkip | null;
  /** Candidate rows examined. */
  examined: number;
  /** Replies actually accepted by SMTP. */
  sent: number;
  /** Suppression reason → how many candidates it held back. */
  suppressed: Partial<Record<AwaySuppression, number>>;
  /** True ⇒ {@link AWAY_SENDS_PER_CYCLE} was reached; the rest wait for the next cycle. */
  capped: boolean;
}

const empty = (skip: AwaySkip): AwayResponderResult => ({
  ran: false, skip, examined: 0, sent: 0, suppressed: {}, capped: false,
});

/** Lowercase, trimmed — the one normalisation of an address in this file. */
const norm = (addr: string | null | undefined): string => (addr ?? "").trim().toLowerCase();

/**
 * ONE PASS FOR ONE ACCOUNT.
 *
 * Reads the account's responder row (one indexed read, and for the overwhelming majority of
 * accounts that read is the whole cost of this pass), decides whether it is live right now, and
 * answers each newly-ingested message that clears every suppression above.
 */
export async function awayResponderPass(
  db: Tx, deps: AwayResponderDeps, nowArg?: Date,
): Promise<AwayResponderResult> {
  const log = deps.log ?? silentLogger;
  const now = nowArg ?? deps.now?.() ?? new Date();
  const batch = deps.batch ?? AWAY_BATCH;
  const budget = deps.sendsPerCycle ?? AWAY_SENDS_PER_CYCLE;
  const { accountId } = deps;

  // ── THE PROBE: ONE ROW, AND FOUR WAYS TO STOP HERE ──────────────────────────────────────
  //
  // `away_responders` holds at most one row per account (UNIQUE(account_id)), so this is a single
  // indexed read. An account with no row, a disabled responder, a window that has not opened or has
  // closed, and a responder with nothing written in it all return here having read nothing else.
  const [responder] = await db.select().from(awayResponders)
    .where(eq(awayResponders.accountId, accountId)).limit(1);
  if (!responder) return empty("no_row");
  if (!responder.enabled) return empty("disabled");

  // IN-WINDOW, inclusive at both ends. An absent bound is OPEN at that end — which is what the
  // column means and what the API accepts — and never "now", because reading an absent `startsAt`
  // as the current instant would make an enabled responder with no dates answer nobody.
  const startsAt = responder.startsAt;
  const endsAt = responder.endsAt;
  if (startsAt && now.getTime() < startsAt.getTime()) return empty("out_of_window");
  if (endsAt && now.getTime() > endsAt.getTime()) return empty("out_of_window");

  // NOTHING IS COMPOSED HERE. A responder with no subject or no body is not a responder with
  // defaults — it is an unfinished one, and inventing either would put words nobody wrote into
  // mail sent in their name. The Settings form requires both; this is the same requirement stated
  // where it cannot be bypassed.
  const subject = (responder.subject ?? "").trim();
  const bodyText = (responder.body ?? "").trim();
  if (subject.length === 0 || bodyText.length === 0) return empty("unconfigured");

  // ── THE EPISODE FLOOR ────────────────────────────────────────────────────────────────────
  //
  // The LATER of "when this configuration was written" and "when the away period begins". Both
  // halves are needed: `updated_at` alone would answer mail that arrived between a scheduled
  // start being saved and that start arriving, and `starts_at` alone (or its absence) would answer
  // the entire stored backlog the moment somebody enables a responder with no dates.
  const floor = startsAt && startsAt.getTime() > responder.updatedAt.getTime()
    ? startsAt : responder.updatedAt;

  // Every address on this account, INCLUDING disabled and errored mailboxes: an address that was
  // ours is still ours, and a responder that answers a former mailbox of its own owner is the same
  // loop as one that answers its current one. Also the source of the `From` identity below.
  const ownRows = await db.select({ id: mailboxes.id, address: mailboxes.address })
    .from(mailboxes).where(eq(mailboxes.accountId, accountId));
  const ownAddresses = new Set(ownRows.map((m) => norm(m.address)));
  const addressOf = new Map(ownRows.map((m) => [m.id, m.address] as const));

  const candidates = await db.select({
    id: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    messageIdHeader: messages.messageIdHeader,
    noForward: messages.noForward,
    sensitivityCategory: messages.sensitivityCategory,
    headers: messageBodies.headers,
    desiredFolder: folderState.desiredFolder,
  })
    .from(messages)
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .leftJoin(folderState, eq(folderState.messageId, messages.id))
    // ── CANDIDACY: A ROW MUST BE A NEW ARRIVAL, AND THE QUERY IS WHERE THAT IS DECIDED ────
    //
    // `created_at > floor` reads the INGEST clock, and the ingest clock lies about history:
    // `insertMessage` omits `createdAt`, so a first-time backfill stamps years-old mail with
    // the ingest instant — inside the window of any episode live while the backfill drains. A
    // responder that trusted it would send real replies to a decade of correspondents in the
    // account owner's name. Two more per-row facts are therefore required of a candidate:
    //
    //   placement   `folder_state.last_set_by` must not be `'external'` — a placement the
    //               account's owner authored outside ohmail, which is what a passively-adopted
    //               folder's rows carry (`NewPlan.passive`; `commitChange` writes `'external'`
    //               for exactly that shape) and what `adopt_external` records for a move made
    //               in another client. Every retro pass requires `'us'` in ITS candidate query
    //               for the same reason (`pipeline.ts`'s passive note); the one pass that
    //               SENDS holds the same line. A row with NO `folder_state` yet stays a
    //               candidate: placement lands in the same transaction as the message row, so
    //               an absent row is a mid-cycle fresh ingest, and the audience gate below
    //               already treats it as un-admitted.
    //   sent time   `messages.date` — the message's own stated send time, the one per-row
    //               clock a backfill cannot re-stamp — must be at or after the episode floor
    //               (inclusive AT the floor, matching the window's inclusive ends). A NULL
    //               date fails the SQL comparison and is out: not provably new, and absent
    //               evidence may not select the acting branch — here the branch that sends
    //               mail. The accepted costs are small and fail toward silence: a sender's
    //               skewed clock can lose them a reply, and a sender forging a fresh Date buys
    //               one reply their genuinely new mail would have earned anyway.
    //
    // These live in the WHERE clause and not in the loop, and that is a decision with a
    // reason. `screener-auto.ts`'s rule — a guard in the WHERE clause cannot be watched to
    // fail — is about CONSENT decisions over rows already in hand. Candidacy is different in
    // kind, and it has a failure mode the loop cannot fix: a held row writes no claim, so it
    // stays in the window for ever, and a first-time backfill contributes THOUSANDS of held
    // rows with post-floor ingest stamps. Held in the loop, they pin the oldest-`batch` page
    // every cycle and a genuine arrival behind them is never even examined. The starvation
    // test ("a wall of backfilled rows…") holds that shape red, and each predicate's deletion
    // is watched red by the backfill tests beside it.
    .where(and(
      eq(messages.accountId, accountId),
      gt(messages.createdAt, floor),
      gte(messages.date, floor),
      or(isNull(folderState.lastSetBy), ne(folderState.lastSetBy, "external")),
    ))
    // Oldest first: if the budget clips this cycle, the people who wrote first are answered first.
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(batch);

  const suppressed: Partial<Record<AwaySuppression, number>> = {};
  const hold = (why: AwaySuppression): void => { suppressed[why] = (suppressed[why] ?? 0) + 1; };

  // WITHIN one pass a sender may appear in several candidate rows. The database UNIQUE is what
  // makes the reply at-most-once ACROSS passes and across workers; this set is only so the second
  // row of the same sender is not counted as a suppression it did not earn.
  const seen = new Set<string>();
  let sent = 0;
  let examined = 0;
  let capped = false;

  for (const m of candidates) {
    if (sent >= budget) { capped = true; break; }
    examined += 1;

    const sender = norm(m.fromAddress);
    if (sender.length === 0 || sender.indexOf("@") <= 0) continue;   // not an address; nothing to answer
    if (seen.has(sender)) continue;

    // ── THE SUPPRESSIONS THAT NEED NO NETWORK AND NO WRITE, CHEAPEST FIRST ────────────────
    //
    // Read ONTO the row and applied here rather than pushed into the candidate query, on
    // `screener-auto.ts`'s rule: a guard in the WHERE clause cannot be watched to fail — deleting
    // it changes which rows come back, and a test then proves something about a query instead of
    // about a decision. Every one of these can be deleted in place and the test that covers it
    // goes red with an errant reply in the spy.
    if (ownAddresses.has(sender)) { seen.add(sender); hold("own_address"); continue; }

    // SENSITIVITY KEEPS, and it is the same class `pipeline.ts` force-keeps in the Ohbox. A
    // sensitivity-flagged message is a login code, a password reset or a security alert; `no_forward`
    // is the user's own instruction that this message's content does not leave. Replying quotes
    // nothing, but it does confirm to whoever sent it that the address is live and attended, and an
    // away reply to a password-reset flow is a signal handed to whoever started that flow.
    if (m.sensitivityCategory !== null || m.noForward) {
      seen.add(sender); hold("sensitive"); continue;
    }

    // THE AUDIENCE. `screened_in` is the default and it means exactly this: a message whose desired
    // folder is the Screener is a stranger the account's owner has not admitted, and it gets no reply. A row
    // with NO `folder_state` yet (ingested this cycle, not yet placed) is treated as NOT screened in
    // — absent evidence may not select the acting branch.
    if (responder.audience !== "everyone" && (m.desiredFolder ?? SCREENER) === SCREENER) {
      seen.add(sender); hold("not_screened_in"); continue;
    }

    // LIST MAIL, RFC 3834 LOOP STOPS, AND SERVICE SENDERS — one call, and the SAME implementation
    // the router's machine-sent test uses, so there is no second encoding of "this was generated,
    // not typed" to drift. A message with no stored body row has no headers to clear it: `{}` reads
    // as "no markers", which is the permissive answer, so the address test below still applies.
    const headerVerdict = autoReplySuppression(
      (m.headers ?? {}) as Readonly<Record<string, unknown>>, sender,
    );
    if (headerVerdict !== null) { seen.add(sender); hold(headerVerdict); continue; }

    // ── THE SEND PATH, RESOLVED BEFORE THE CLAIM ─────────────────────────────────────────
    //
    // Deliberately ahead of the claim, and it is the one ordering exception below. A mailbox this
    // process does not hold is the ordinary case (another shard has it), and claiming for it would
    // spend the account's one reply to this sender on a send that never happens.
    const port = await deps.openSend(m.mailboxId);
    const from = addressOf.get(m.mailboxId) ?? "";
    if (!port || from.length === 0) { hold("no_send_path"); continue; }

    // ── CLAIM, THEN SEND. NEVER THE OTHER WAY ROUND ──────────────────────────────────────
    //
    // `INSERT … ON CONFLICT DO NOTHING RETURNING id`: two workers racing this sender both attempt
    // it, exactly one gets a row, the loser sends nothing. There is no read-then-write window.
    //
    // Claiming FIRST makes a crash between here and SMTP cost one unsent reply. Claiming after
    // would make it a duplicate reply to a stranger, again on every re-run — and at-most-once is
    // the requirement. The same argument, in the same words, as `unsubscribe_records`.
    const claim = await db.insert(awayResponderSent).values({
      accountId,
      sender,
      responderUpdatedAt: responder.updatedAt,
      messageId: m.id,
      mintedMessageId: null,
      sentAt: now,
    }).onConflictDoNothing({
      target: [
        awayResponderSent.accountId, awayResponderSent.sender, awayResponderSent.responderUpdatedAt,
      ],
    }).returning({ id: awayResponderSent.id });

    seen.add(sender);
    if (claim.length === 0) { hold("already_replied"); continue; }
    const claimId = claim[0]!.id;

    // The id is minted UP FRONT and stored on the claim, exactly as the interactive send path does
    // it: the delivered message then carries an id we chose, so the Sent-folder copy is
    // attributable to this row and an operator can tell an away reply from a typed one.
    const at = from.lastIndexOf("@");
    const mintedMessageId = mintMessageId(at >= 0 ? from.slice(at + 1) : "");

    const outbound: OutboundMessage = {
      from,
      to: m.fromAddress,
      subject,
      text: bodyText,
      messageId: mintedMessageId,
      // Threading, and evidence: the reply hangs off the message that triggered it. Omitted when
      // the original carried no `Message-ID`, rather than invented.
      ...(m.messageIdHeader ? { inReplyTo: m.messageIdHeader, references: m.messageIdHeader } : {}),
      // RFC 3834 §5. On EVERY outgoing reply, with no branch that can omit it: it is what stops the
      // recipient's own responder answering this one, and it is the same marker `auto_submitted`
      // above refuses to reply to. A responder that demands it of others and does not set it is the
      // loop, viewed from the other end.
      headers: { "Auto-Submitted": "auto-replied" },
    };

    try {
      await port.send(outbound);
    } catch (err) {
      // THE CLAIM STAYS. SMTP is not transactional, so a throw means the delivery is AMBIGUOUS —
      // it may have reached the server before the failure. Deleting the claim would let the next
      // cycle send a second copy of a reply that was delivered; the interactive send path answers
      // the same ambiguity by probing the Sent folder and NEVER resending, and the conservative
      // half of that answer is the one an unattended pass can hold. So this sender is not answered
      // this episode, loudly, rather than answered twice quietly.
      hold("send_failed");
      log.error("away_reply_send_failed", {
        accountId, mailboxId: m.mailboxId, messageId: m.id, err,
        reason: "the at-most-once claim is KEPT — an SMTP throw is ambiguous, and a resend risks a " +
          "duplicate reply to this correspondent; no further reply is sent this episode",
      });
      continue;
    }

    await db.update(awayResponderSent).set({ mintedMessageId })
      .where(eq(awayResponderSent.id, claimId));
    sent += 1;
  }

  if (candidates.length === batch && sent < budget) {
    // A full page with budget left means there is more to look at than one pass read. Said once,
    // because the next cycle re-reads from the same floor and the claims exclude what was answered.
    log.info("away_responder_page_full", {
      accountId, examined: candidates.length,
      reason: "the candidate window is larger than one batch; the next cycle re-reads it and the " +
        "at-most-once claims exclude everyone already answered",
    });
  }

  // `examined` counts rows this pass actually DECIDED about, which is not `candidates.length` once
  // the budget clips the loop — reporting the fetch size as the examination would overstate what the
  // pass looked at in exactly the case an operator is reading the number to understand.
  return { ran: true, skip: null, examined, sent, suppressed, capped };
}
