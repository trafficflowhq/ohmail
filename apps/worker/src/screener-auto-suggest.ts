import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  accountSettings, folderState, messages,
  resolveCutline, senderIsActiveSql, senderIsDecidedSql, type ResolvedCutline,
  screenerAttemptKey, storeScreenerSuggestion,
  screenerSuggestedSenderExists, hasScreenerSuggestionForSender, AI_ACTION_WEIGHTS,
  decisionCanBeApplied, readRequestEligibility,
  type RefundObligationPort, type SpendPort, type Tx,
} from "@trafficflow/db";
import { capabilityForKind } from "@trafficflow/core/adapters/organizer-lease";
import {
  askScreeningQuestion, capSuggestion, senderCheckAll, senderFacts, silentLogger,
  type ClassifierPort, type Logger, type SenderSignals,
} from "@trafficflow/core/mail";

/** The sort floor for a message with no date — the same instant `to_timestamp(0)` named. */
const EPOCH = new Date(0);

/* SCREENER AUTO-SUGGEST — buy the model's advice about INCOMING held senders while the account's opt-in
 * is on. Its own file, not `screener-auto.ts` (whose invariant is that it neither calls the model nor
 * spends): this is the money contract, explicit, behind its own opt-in. It DECIDES nothing — one advisory
 * `routing_decisions` row per sender (`input_provenance = 'screener_suggestion'`, `status = 'suggestion'`,
 * never `pending_approval`/`approved`), so every sender still waits for a human. Four spend bounds: ONE
 * PURCHASE PER SENDER; the WATERMARK `account_settings.auto_suggest_at` (only senders ingested after
 * opt-in); the per-cycle cap {@link AUTO_SUGGEST_BATCH}; and `spend()` (never `tryDebit`) BEFORE the
 * model, first refusal stops the pass. Flagged mail (`no_ai`/`sensitivity_category`, `sensitive.ts`) is
 * excluded, unlike the pressed `ScreenerService.suggest`. Buying is shared across the app boundary
 * (`askScreeningQuestion`, `storeScreenerSuggestion`, one ledger `screenerAttemptKey`); `apps/sidecar` runs this same function from its drain tail like `bubbleUpPass`, refused unless the host declares `unmetered`. */

/** Where held first-contact senders wait — the queue this pass reads and never writes. */
const SCREENER = "ohmail/Screener";

/**
 * HOW MANY SENDERS ONE AUTOMATIC BATCH BUYS — this pass's whole spend for one account, per cycle. The
 * SAME NUMBER as `AUTO_BATCH_SIZE` in `apps/webapp/app/shell/screener-suggest.ts`, because it is the
 * same policy: an automatic path spends without a press, so its bound must be a number somebody can live
 * with being wrong about. Ten is a rounding error against the smallest tier's monthly allowance. It is a
 * second literal, not an import (neither file can see the other — this app depends only on the mail core
 * and db), so a test READS the other source and pins them equal (asserting it FOUND the literal first).
 * ON THE STANDALONE DOOR it bounds MODEL CALLS rather than credits: the cap does nothing on an ordinary
 * drain (new senders trickle in) and bounds the one crowd — the first sync after the switch turns on.
 */
export const AUTO_SUGGEST_BATCH = 10;

export interface ScreenerAutoSuggestDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  /**
   * The model, resolved for THIS cycle.
   *
   * ABSENT ⇒ the pass does not run and does not even read the opt-in. That covers both the
   * deployment with no model configured and the one whose classifier circuit is currently OPEN,
   * and in both the right answer is to do nothing: there is no user waiting on this, so a pass
   * that spent now and failed at the model would charge for an outage we already know about.
   */
  classifier?: ClassifierPort;
  /**
   * The account's AI spend gate. ABSENT ⇒ the pass does not run unless {@link unmetered} DECLARES
   * that this host has no ledger — this is the only thing in the product that spends without a
   * press, so "we did not supply one" is not a state it may operate in.
   */
  credits?: SpendPort;
  /**
   * A HOST DECLARING THAT NOTHING HERE IS METERED, which is not the same as omitting the gate. `true` is
   * the standalone desktop engine and nothing else: that tier is free, its model is the installer's own
   * key or machine, and there is no ledger to read (`apps/sidecar`'s service bag declares its entitlements
   * `UNMETERED`). A DECLARATION, not an inference from `credits === undefined`, for the reason
   * `sendSurfaceMaxTotalBytes: null` is: a host that said nothing gets the STRICTER branch. Inferring
   * "unmetered" from an absent gate would turn a future wiring mistake (a `classifyGateFor` returning
   * undefined for a missing subscription row) into a pass that spends with no meter, silently and for
   * ever; here the same mistake does nothing, which is visible. A test pins both directions.
   */
  unmetered?: true;
  /**
   * WHERE A REFUND THIS PASS OWES IS REMEMBERED. Composed beside {@link credits} by any host with
   * an entitlements program; absent on an unmetered one, which owes nothing.
   *
   * A refund here is a `release` like any other and can be lost like any other, and a lost one is
   * a person charged for advice they never got. The obligation is written BEFORE the reversal is
   * tried, so the debt survives the call. With a gate and no port the shortfall is LOGGED by name
   * rather than passed over; `screener-auto-suggest-composition.test.ts` is what keeps the hosted
   * worker from reaching that line at all.
   */
  obligations?: RefundObligationPort;
  /** The account's own "who belongs in my Ohbox" words, so a bought suggestion asks the same
   *  question a user-pressed one does. Absent ⇒ omitted from the request. */
  ohboxBar?: string;
  log?: Logger;
  /** Test seam. Default {@link AUTO_SUGGEST_BATCH}. */
  batch?: number;
  /**
   * The clock, for the cutline. It is read ONLY when the account has no baseline — the sliding
   * window is measured from now — so the hosted pass leaves it absent and takes the real clock.
   */
  now?: () => Date;
}

export interface ScreenerAutoSuggestResult {
  /** False ⇒ nothing was bought and nothing was read past the probe: not opted in, or no model. */
  ran: boolean;
  /** Eligible senders this cycle's page held — at most `batch`. */
  examined: number;
  /** Suggestions stored. */
  bought: number;
  /** Credits this pass actually moved. A `duplicate` charges nothing and is not counted. */
  charged: number;
  /** Why the pass stopped early, if it did. Absent ⇒ it ran the page out. */
  stopped?: "out_of_credits" | "spend_unavailable" | "ai_disabled" | "model_unavailable";
  /** True ⇒ the page was full, so more eligible senders wait for the next cycle. */
  capped: boolean;
}

/** One candidate: the sender's representative held message, and what the question needs. */
interface Candidate {
  messageId: string;
  /** WHICH MAILBOX — the unit `decisionCanBeApplied` is asked about, exactly as the manual route
   *  asks it: two mailboxes on one account can have different organizers. */
  mailboxId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  /** `messages.auth_verdict` — NULL on every row until the column is wired; permissive there. */
  authVerdict: string | null;
}

const EMPTY = (): ScreenerAutoSuggestResult => ({
  ran: false, examined: 0, bought: 0, charged: 0, capped: false,
});

/**
 * THE PASS, for ONE account. A no-op — one PK read — for every account that has not opted in.
 *
 * Pure and hermetic: a database handle, a classifier port, a gate and a logger, so a test drives it
 * with no worker, no lease and no network.
 */
export async function screenerAutoSuggestPass(
  db: Tx, deps: ScreenerAutoSuggestDeps,
): Promise<ScreenerAutoSuggestResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? AUTO_SUGGEST_BATCH;
  const { accountId, classifier, credits: gate } = deps;

  // MODEL AND METER FIRST, BEFORE THE OPT-IN IS EVEN READ. Neither is a refusal to report: a host
  // with no classifier does not sell this, and a pass with no gate must not spend. Checking them
  // ahead of the probe also makes the common no-model case free.
  //
  // `!gate && !deps.unmetered` and NOT `!gate`: a host with no ledger has to SAY so — see
  // {@link ScreenerAutoSuggestDeps.unmetered} for why an absent gate alone may never be read as
  // permission. The hosted worker passes a gate and no declaration, so this line is byte-for-byte
  // the refusal it always was for it.
  if (!classifier) return EMPTY();
  if (!gate && !deps.unmetered) return EMPTY();

  // ── THE OPT-IN PROBE, AND THE WATERMARK, IN ONE PK READ ────────────────────────────────────
  //
  // `auto_suggest_at IS NOT NULL` IS the opt-in — a NULL, an absent row and (up the stack) a
  // failed read all mean OFF, and OFF spends nothing. The same column then serves as the
  // watermark, which is why it was stored as a timestamp rather than a boolean in the first
  // place: "was this on before or after that message arrived" is exactly the question bound (1)
  // has to answer, and a boolean cannot.
  //
  // Read EVERY cycle, never cached: turning the switch off is the brake, and a cached ON would
  // keep spending after somebody pulled it.
  const [settings] = await db.select({
    autoSuggestAt: accountSettings.autoSuggestAt,
    // The cutline's three answers, on the PK read the opt-in probe already makes. A sender the
    // cutline has retired is not a question, so buying advice about them spends money on a row
    // no surface shows.
    screeningBaselineAt: accountSettings.screeningBaselineAt,
    dormancyDays: accountSettings.dormancyDays,
    screeningScope: accountSettings.screeningScope,
  })
    .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const watermark = settings?.autoSuggestAt ?? null;
  if (!watermark) return EMPTY();

  const cutline = resolveCutline({
    baselineAt: settings?.screeningBaselineAt ?? null,
    dormancyDays: settings?.dormancyDays ?? null,
    scope: settings?.screeningScope ?? null,
    now: deps.now?.() ?? new Date(),
  });
  const page = await selectCandidates(db, { accountId, watermark, limit: batch, cutline });

  /* ── NO ORGANIZER, NO SPEND ────────────────────────────────────────────────────────────────
   *
   * The gate the MANUAL purchase route has had since 0.14.1, applied at the automatic caller
   * through the SAME function. Stop the sole organizer and Cloud keeps the connected reader in
   * its served list: this pass went on buying the model's advice about held senders every cycle,
   * advice whose only use is a decision that mailbox may no longer make. Nobody pressed anything,
   * so nobody was told — the charge just kept happening.
   *
   * ONE READ PER DISTINCT MAILBOX, not per sender: forty senders in one mailbox ask once. Asked
   * BEFORE the loop, so an ineligible mailbox costs one indexed PK read per cycle and no spend at
   * all; asked AGAIN inside the exclusive region below, because a stand-down landing between this
   * read and the claim is the race this filter cannot see, and that charge is refunded.
   */
  const appliable = new Map<string, boolean>();
  for (const mailboxId of new Set(page.map((c) => c.mailboxId))) {
    appliable.set(mailboxId, decisionCanBeApplied(await readRequestEligibility(
      db, accountId, mailboxId, capabilityForKind("screener.decide"),
    )));
  }
  const candidates = page.filter((c) => appliable.get(c.mailboxId) === true);
  if (candidates.length < page.length) {
    log.info("screener_auto_suggest_no_organizer", {
      accountId, dropped: page.length - candidates.length,
      reason: "no install can apply a Screener decision on these mailboxes, so their advice is " +
        "not bought — the condition the manual purchase route refuses",
    });
  }

  const result: ScreenerAutoSuggestResult = {
    // `capped` reads the PAGE, which is what the query answered; `examined` reads the eligible
    // set, which is what this field has always meant.
    ...EMPTY(), ran: true, examined: candidates.length, capped: page.length >= batch,
  };

  // WHO THESE SENDERS REALLY ARE, BEFORE ANY OF THEM IS ASKED ABOUT. Deterministic, free, and
  // over the WHOLE candidate set at once because `campaign` is a fact about the set: one subject
  // arriving from unrelated strangers is invisible to a check that sees one message. The answer
  // is used twice below — as facts in the request, and as the cap on what comes back.
  const signals = senderCheckAll(candidates.map((c) => ({
    fromAddress: c.fromAddress,
    fromName: c.fromName,
    subject: c.subject,
    snippet: c.snippet,
    authVerdict: c.authVerdict,
  })));

  for (const [index, c] of candidates.entries()) {
    // The set-wide check above, for this candidate. Never undefined — `senderCheckAll` answers one
    // per input, in order — and an empty one would silently disarm the cap, so it is asserted.
    const checked: SenderSignals = signals[index] ?? { senderDomain: "", urgency: false };
    // THE MONEY QUESTION, BEFORE THE MODEL QUESTION. `spend`, not `tryDebit`: "out of credits", "AI
    // switched off" and "ledger unwell" decide whether the pass stops or is idle, and a boolean throws
    // that away. The source is the MESSAGE, which makes this free to retry and impossible to double-charge
    // against the client's own batch. The whole block is SKIPPED on an unmetered host — skipped rather
    // than satisfied by a permissive stub gate, which would put a second always-yes "may this account
    // spend" in the codebase that refuses nothing the day it is wired to the hosted side. `charged` stays
    // 0 there, the truth: a standalone install moves no credits because it has none. The bare key is the
    // MESSAGE — what makes this pass and a person's press claim the same work, and the next ask free.
    const attemptKey = screenerAttemptKey(c.messageId);
    /**
     * THE ATTEMPT THIS CANDIDATE CHARGED, when it charged one — what the reversal below must name.
     *
     * `undefined` covers both "nothing was charged" cases and they are different: an unmetered host
     * (no gate at all) and a `duplicate` whose earlier attempt is still open. Neither may be
     * refunded — the first has no ledger and the second's money bought a verdict this pass is about
     * to serve for free.
     */
    let chargedAttempt: string | undefined;
    /**
     * THE CLAIM THIS CANDIDATE HOLDS, and the latch that makes the release ONE call.
     *
     * `claimed` is set only where the gate hands the claim over — `ok` and `duplicate`. An
     * `inflight` names ANOTHER holder (the person pressing Suggest for this sender) and every
     * refusal holds nothing, so releasing on those paths would give away a claim this pass never
     * took and let a second model call be bought for one credit. `released` is set before the
     * await, so a release that faults is reported rather than retried.
     */
    let claimed = false;
    let released = false;
    /**
     * DOES THE ONE RELEASE REVERSE THE CHARGE — the already-advised path, and nothing else.
     *
     * The answer the three named releases gave, unchanged: a sender advised between the candidate
     * query and the claim is refunded; a fault is not, because the charge buys a free retry next
     * cycle over the same message and that is the claim this pass's caller already makes.
     */
    let refundOnRelease = false;
    /**
     * Give the claim back, once; reverse the charge only when told to.
     *
     * A REVERSAL IS OWED BEFORE IT IS TRIED. The obligation is written first, so a release the
     * program never receives leaves a debt the drain settles instead of a charge nobody remembers;
     * the receipt is what closes it. `owe` is idempotent per (account, attempt), so a pass that
     * dies after writing and before releasing owes the same one debt next cycle.
     */
    const releaseClaim = async (refund: boolean): Promise<void> => {
      if (!gate || !claimed || released) return;
      released = true;
      const meta = { messageId: c.messageId };
      const reverses = refund && chargedAttempt !== undefined;
      if (reverses && deps.obligations) {
        await deps.obligations.owe({
          accountId, action: "screener", attemptKey, attempt: chargedAttempt!,
          reason: "no_organizer", meta,
        });
      } else if (reverses) {
        // A metered host with no memory for what it owes. Named rather than passed over: the
        // hosted worker composes both (`screener-auto-suggest-composition.test.ts`), so reaching
        // this line at all is a wiring fault and not a state to design around.
        log.warn("screener_auto_suggest_refund_unrecorded", {
          accountId, messageId: c.messageId,
          reason: "a refund is owed and no obligation port was composed beside the gate, so a " +
            "lost release would leave this charge with nothing to reverse it",
        });
      }
      const receipt = await gate.release(accountId, reverses
        ? { action: "screener", attemptKey, refund: true, attempt: chargedAttempt!, meta }
        : { action: "screener", attemptKey, refund: false, meta });
      if (reverses && receipt === "settled" && deps.obligations) {
        await deps.obligations.settle(accountId, chargedAttempt!);
      }
    };
    try {
      if (gate) {
        const outcome = await gate.spend(accountId, "screener", attemptKey, { messageId: c.messageId });
        // SOMEBODY IS ALREADY BUYING THIS ONE: SKIP THE CANDIDATE, NOT THE PASS. `continue`, where every
        // other refusal `break`s — the others are properties of the ACCOUNT (empty balance, a subscription
        // that may not spend, an unwell ledger), so every remaining candidate would refuse the same way and
        // continuing is N useless round trips. This is a property of ONE MESSAGE: the user is pressing
        // Suggest for that sender right now (SEC3-MONEY-1), which needs no unusual behaviour since this pass
        // and that surface select the same representative. Nothing is lost — the request path stores the
        // verdict and `selectCandidates` filters it out next cycle — and it is NOT counted in `stopped`,
        // which would make a healthy cycle read as a refusal.
        if (outcome.verdict === "inflight") {
          log.info("screener_auto_suggest_inflight", { accountId, messageId: c.messageId });
          continue;
        }
        if (outcome.verdict !== "ok" && outcome.verdict !== "duplicate") {
          // FIRST REFUSAL STOPS THE ACCOUNT'S PASS FOR THIS CYCLE. Every remaining candidate would be
          // refused for the same reason — the balance, the subscription state, or the ledger — so
          // continuing would be N useless round trips per cycle, for ever, on every empty account.
          // One refused call per opted-in account per cycle is the bound this gives.
          result.stopped = outcome.verdict === "insufficient"
            ? "out_of_credits"
            : outcome.verdict === "refused" && outcome.reason === "ai_disabled"
              ? "ai_disabled"
              : "spend_unavailable";
          break;
        }
        // THE CLAIM IS THIS PASS'S FROM HERE, and only from here: `ok` and `duplicate` are the two
        // verdicts that hand it over, and the door below gives back nothing without this line.
        claimed = true;
        // Recorded, not yet counted: `result.charged` is added to below, once this candidate is past
        // the entitlement re-check, because a charge that is handed straight back moved nothing.
        if (outcome.verdict === "ok") chargedAttempt = outcome.attempt;
      }

      // THE ORGANIZER, RE-ASKED INSIDE THE EXCLUSIVE REGION. The filter above ran once for the
      // whole page; a stand-down, a removal or a takeover by an older build landing between that
      // read and this claim leaves a charge for advice that can no longer be applied. Asked again
      // where it sees every earlier commit, and the charge comes back through the obligation row
      // rather than being written off — this is the same "a spend that bought nothing" class as a
      // drafter that threw, and the same door reverses it.
      if (!decisionCanBeApplied(await readRequestEligibility(
        db, accountId, c.mailboxId, capabilityForKind("screener.decide"),
      ))) {
        log.info("screener_auto_suggest_organizer_left", {
          accountId, messageId: c.messageId,
          ...(chargedAttempt !== undefined ? { refunding: chargedAttempt } : {}),
        });
        refundOnRelease = true;
        continue;
      }

      // THE ENTITLEMENT, RE-ASKED INSIDE THE EXCLUSIVE REGION (SEC3-MONEY-1, SEC3-MONEY-3). `selectCandidates`
      // ran once at the top, so a caller that advised this SENDER since (a press, the client's batch, another
      // host) leaves a candidate list that predates the answer; the question is asked again here where it sees
      // every earlier holder's commit. BY SENDER, and UNCONDITIONALLY — both corrections: it used to ask about
      // the MESSAGE and only on `duplicate`, which is right for the pressed path and wrong here, where two
      // hosts picking DIFFERENT representatives for one sender hold two ledger sources and both charge. THE
      // CHARGE COMES BACK via `refundAttempt` (not `refund`, whose marker any non-charging decision clears);
      // it holds the attempt id this pass was told it charged. Exactly-once is the ledger's (`UNIQUE
      // (account_id, refund:<attempt>)` plus the refund-origin trigger), so a retry cannot pay twice.
      if (await hasScreenerSuggestionForSender(db, accountId, c.fromAddress)) {
        if (chargedAttempt !== undefined) {
          log.info("screener_auto_suggest_sender_already_advised",
            { accountId, messageId: c.messageId, refunded: chargedAttempt });
        }
        // THE ONE EXIT THAT REVERSES THE CHARGE. The door below names the attempt this pass was
        // told it charged, which is the stronger claim than any in-process marker: exactly-once is
        // the ledger's, so a retry cannot pay twice.
        refundOnRelease = true;
        continue;
      }
      // `+= the weight` and not `++`: the field is credits, and `spend()` moves that many per
      // call. A `charged: false` is a free retry of an attempt already on record — reporting it as
      // spend would say the account paid twice for one message. This pass books `debit_classify`,
      // weight 1; naming the weight is what keeps the tally right now that prices are per-reason.
      if (chargedAttempt !== undefined) result.charged += AI_ACTION_WEIGHTS.debit_classify;

      let verdict;
      try {
        const facts = senderFacts(checked);
        verdict = await askScreeningQuestion(classifier, {
          fromAddress: c.fromAddress,
          subject: c.subject,
          snippet: c.snippet,
          ...(deps.ohboxBar ? { ohboxBar: deps.ohboxBar } : {}),
          ...(facts ? { senderFacts: facts } : {}),
        });
      } catch (err) {
        // STOP, where the user-pressed path CONTINUES — nobody is waiting here, and a model fault is almost
        // always the whole endpoint, so pressing on would charge the rest of the batch against an outage
        // every cycle. THE CHARGE IS NOT REFUNDED: the old reason ("the ledger source is the message, so the
        // next cycle's attempt is `duplicate` and free") was false once the representative moves — a sender
        // sending again during an outage moved it, a fresh source, a second charge per cycle. What makes the
        // retry free now is the candidate query (the sender is unadvised, so the next cycle asks about their
        // CURRENT representative), and the fault charge is bounded to one per cycle by this stop and to a
        // handful by the classifier's own fault gate (`classifierForCycle` withholds the port after faults).
        // It is the ONLY stop an unmetered host has, and carries the same bound there.
        log.warn("screener_auto_suggest_model_failed", { accountId, messageId: c.messageId, err });
        // The claim goes back unrefunded at the door below, for the reason the request path gives:
        // the charge stands and buys a free retry next cycle, and a claim left behind would make
        // that retry wait out the TTL first.
        result.stopped = "model_unavailable";
        break;
      }

      // THE FACTS CAP THE ANSWER, and the cap is what gets STORED — a forged sender, a crowd at
      // one subject or a failed authentication is not a thing the model may overrule from the
      // sender's own words. With no signal this returns the verdict object itself, so the stored
      // row for every ordinary sender is byte-for-byte the row this pass always wrote.
      const capped = capSuggestion(verdict, checked);
      if (capped !== verdict) {
        log.info("screener_auto_suggest_sender_check", {
          accountId, messageId: c.messageId, reason: capped.reasonCode,
          from: capped.destination === verdict.destination ? undefined : verdict.destination,
        });
      }
      await storeScreenerSuggestion(db, {
        accountId,
        messageId: c.messageId,
        destination: capped.destination,
        confidence: capped.confidence,
        rationale: capped.rationale,
        spam: capped.spam,
      });
      result.bought++;
    } finally {
      // ONE DOOR, AND AFTER THE STORE. Every exit from this candidate leaves through here — the
      // two `continue`s, the two `break`s, a throw from the entitlement re-check or the store,
      // and any exit added later — because a release written on the exits somebody had in mind is
      // not a release the next exit has, and a claim left behind answers the next cycle
      // `inflight` on a message nobody worked on until the TTL runs out. Never earlier than the
      // store: between a release and the insert there is a window with no suggestion on record
      // and nothing holding the source, where a request is told `duplicate` — already paid for,
      // proceed — and buys the model a second time. A release that faults is reported once and
      // never retried, and it never replaces the error this candidate is already carrying.
      try {
        await releaseClaim(refundOnRelease);
      } catch (err) {
        log.warn("screener_auto_suggest_release_failed", { accountId, messageId: c.messageId, err });
      }
    }
  }

  if (result.bought > 0 || result.stopped) {
    log.info("screener_auto_suggest", {
      accountId, examined: result.examined, bought: result.bought, charged: result.charged,
      ...(result.stopped ? { stopped: result.stopped } : {}),
      capped: result.capped,
    });
  }
  return result;
}

/**
 * THE ELIGIBLE SENDERS — one representative per held sender, watermarked, unadvised, oldest first. The
 * representative is chosen by the SAME rule the Screener page and purchase use
 * (`DISTINCT ON (lower(from_address)) … ORDER BY lower(from_address), sort_key DESC, id DESC`, character
 * for character `ScreenerReadService.heldSenderPage`), which keeps the money safe: stored suggestion and
 * ledger source are both MESSAGE-keyed. The representative is the unit of WORK but no longer of
 * ENTITLEMENT (SEC3-MONEY-3): predicate 2 names the SENDER. The three outer predicates sit OUTSIDE the
 * `DISTINCT ON` so they filter a set already one row per sender — a flagged newest would else promote an
 * OLDER message and buy against different mail than the row on screen. The watermark clock is `created_at`
 * (ours), never `messages.date` (the sender's, removed from `pipeline.ts`); `ORDER BY created_at ASC`. */
async function selectCandidates(
  db: Tx, opts: { accountId: string; watermark: Date; limit: number; cutline?: ResolvedCutline },
): Promise<Candidate[]> {
  const d = dialect(db);
  // THE EPOCH THROUGH THE SEAM: `to_timestamp(0)` is the server's name for it and the device
    // store has no such function — there the instant IS the number, which is what `d.ts` knows.
    const sortKey = d.truncMs(sql`coalesce(${messages.date}, ${d.ts(EPOCH)})`) as SQL<Date>;
  const sender = sql`lower(${messages.fromAddress})`;

  /* ONE HELD MESSAGE PER SENDER, AS A WINDOW — the same row `distinct on (k) … order by k, o`
     picks, chosen by `row_number() over (partition by k order by o) = 1`, which both stores have
     and only the server has the first of. The ordering moves inside the window, where the leading
     `k` was never about ordering the answer. Nothing about WHICH message represents a sender
     changes, which is what the paragraph below depends on. */
  // `account_id` LEADS the predicate rather than filtering a cross-account result.
  const reps = db.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    // THE TWO THE SENDER CHECK READS BESIDE THE SUBJECT. `from_name` is the identity the sender
    // asserted; `auth_verdict` is the one fact here nobody outside could write — NULL on every
    // row until that column is wired, and NULL is permissive, so reading it changes nothing today
    // and needs no second pass the day it is computed.
    fromName: messages.fromName,
    authVerdict: messages.authVerdict,
    subject: messages.subject,
    snippet: messages.snippet,
    createdAt: messages.createdAt,
    // CARRIED SO THE OUTER PREDICATE CAN READ THEM, and read there rather than here — see the
    // sensitivity paragraph below for why filtering inside this `DISTINCT ON` would be a defect.
    noAi: messages.noAi,
    sensitivityCategory: messages.sensitivityCategory,
    sortKey: sortKey.as("sort_key"),
    rank: sql<number>`row_number() over (
      partition by ${sender} order by ${sortKey} desc, ${messages.id} desc
    )`.as("rank"),
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, opts.accountId),
      eq(folderState.desiredFolder, SCREENER),
    ))
    .as("reps");

  const rows = await db.select({
    messageId: reps.messageId,
    mailboxId: reps.mailboxId,
    fromAddress: reps.fromAddress,
    fromName: reps.fromName,
    authVerdict: reps.authVerdict,
    subject: reps.subject,
    snippet: reps.snippet,
  }).from(reps)
    .where(and(
      // Only the representative — see the window above.
      eq(reps.rank, 1),
      // (1) THE WATERMARK — consent began before this message did.
      sql`${reps.createdAt} > ${d.ts(opts.watermark)}`,
      // (2) THE PROGRESS MARKER AND PER-SENDER ENTITLEMENT, IN ONE PREDICATE: a SENDER this account holds
      // advice about (bought by this pass earlier, the client's on-open batch, or the manual ladder) is
      // not re-bought or re-asked. THIS ARM READ `rd.message_id = reps.messageId` AND THAT WAS THE DRAIN
      // (SEC3-MONEY-3): the defect lived in the COMPOSITION, not the line — the representative is the
      // sender's NEWEST held message, so a sender sending again promoted a message with no suggestion row,
      // satisfied this predicate and the watermark, and was charged under a brand-new ledger source. No
      // aliases, no user action after opt-in — ten senders a cycle until the balance was gone, at the
      // choosing of anyone who can email the account.
      sql`not ${screenerSuggestedSenderExists(dialect(db), opts.accountId, sql`lower(${reps.fromAddress})`)}`,
      // (3) THE SENSITIVITY EXCLUSION — a flagged representative is not a candidate.
      //
      // Both halves, because they are two different answers and only one of them is "we saw an
      // OTP": `sensitivity_category` is the detector's positive class, and `no_ai` additionally
      // carries its INDETERMINATE outcome — `no_ai` true with a NULL category is "we could not
      // read this confidently", which `sensitive.ts` routes here on purpose. An automatic pass
      // must take the stricter reading of both.
      eq(reps.noAi, false),
      isNull(reps.sensitivityCategory),
      // (4) THE CUTLINE — the same expression `GET /consent` counts through and `GET /screener`
      // now lists through. Without it this pass bought advice about senders no surface shows,
      // which is money spent on a question nobody is being asked. Absent ⇒ inert, so a caller
      // that reads no settings gets the query it always had.
      opts.cutline
        ? senderIsActiveSql(d, opts.accountId, sql`lower(${reps.fromAddress})`, opts.cutline)
        : undefined,
      // (5) THE DECIDED PREDICATE — the same expression the queue's page excludes through, and
      // UNCONDITIONAL for that page's reason. This pass builds its own candidate set, so arm (4)'s
      // argument reaches it twice: a sender the Screener no longer lists is a sender no surface
      // shows, and buying advice about them is money spent on a question nobody is asked.
      sql`not ${senderIsDecidedSql(d, opts.accountId, sql`lower(${reps.fromAddress})`)}`,
    ))
    .orderBy(asc(reps.createdAt), asc(reps.messageId))
    .limit(opts.limit);

  return rows.map((r) => ({
    messageId: r.messageId,
    mailboxId: r.mailboxId,
    fromAddress: r.fromAddress.toLowerCase(),
    fromName: r.fromName,
    authVerdict: r.authVerdict,
    subject: r.subject,
    snippet: r.snippet,
  }));
}
