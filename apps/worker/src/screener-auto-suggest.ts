import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  accountSettings, folderState, messages, routingDecisions,
  screenerLedgerSource, storeScreenerSuggestion,
  SCREENER_SUGGESTION_PROVENANCE, AI_ACTION_COST,
  type AiCreditGate, type Tx,
} from "@trafficflow/db";
import { askScreeningQuestion, silentLogger, type ClassifierPort, type Logger } from "@trafficflow/core/mail";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SCREENER AUTO-SUGGEST — buy the model's advice about INCOMING held senders, while the
   account's opt-in is on
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT THIS IS, AND WHY IT IS NOT IN `screener-auto.ts` ───────────────────────────────────

   Its sibling file's header states an invariant about ITSELF: "It does NOT call the model and it
   does NOT spend… auto-BUYING AI advice would be a money contract and is out of scope by
   construction (this file imports neither)." That sentence is the contract of a deterministic
   pass, and it stays true — this is the money contract, made explicitly, in its own file, behind
   its own opt-in. Sharing a file would have made a reader check which half they were reading
   before they could trust either.

   The two passes are also about different mail. That one FILES the obvious bulk out of the
   Screener with no model; this one BUYS a suggestion about the senders that are left, so a person
   opening the Screener finds the advice already there and their visit is "Apply all" rather than
   "wait while forty senders are priced and bought".

   ── IT DECIDES NOTHING. IT WRITES ONE ADVISORY ROW PER SENDER AND STOPS ─────────────────────

   No `rules` row, no `folder_state`, no `change_log`, no `approvals`. A bought suggestion is a
   `routing_decisions` row with `input_provenance = 'screener_suggestion'` and
   `status = 'suggestion'`, which nothing in the product acts on: the code that performs a
   routing decision reads
   `pending_approval`/`approved`, and no row written here ever has either. Every sender still
   waits for a human. What changes is that the human's press is now free and instant instead of
   costing a round trip they have to sit through.

   ── THE THREE BOUNDS ON SPEND, AND WHY EACH ONE IS LOAD-BEARING ─────────────────────────────

   This is the only thing in the product that spends an account's money with no press in the same
   minute, so "how much can it possibly cost" has to have an answer that does not depend on
   anybody's diligence:

    1. **THE WATERMARK.** `account_settings.auto_suggest_at` is a TIMESTAMP, not a boolean, and it
       is read here as the instant consent began: only a sender whose held REPRESENTATIVE message
       was ingested AFTER it is a candidate. So the pre-opt-in backlog — 1 698 waiting senders on
       the account that reported this feature — is not drained by turning a switch on. That
       backlog keeps the two paths it already had: the manual, priced ladder, and the client's
       on-open batch, which nibbles {@link AUTO_SUGGEST_BATCH} of it per Screener visit. See
       {@link selectCandidates} for why the clock is OUR ingest stamp and never the sender's
       `Date:` header.
    2. **THE PER-CYCLE CAP.** {@link AUTO_SUGGEST_BATCH} senders per account per cycle, and the
       page is the cap — there is no inner loop and no second page. An account receiving faster
       than that has its queue drained over several cycles rather than in one purchase.
    3. **THE GATE ITSELF.** `spend()` — never `tryDebit` — per sender, BEFORE the model call, and
       the FIRST refusal stops this account's pass for this cycle. On an empty balance that is one
       refused gate call and zero model calls: the refusal is pre-model by control flow, so
       "no credits ⇒ nothing was sent to a third party and nothing was charged" is a property of
       the order of these lines and not of a check somebody remembered to write.

   There is no persisted disarm column and no cursor table, and neither is missing. Progress is
   the STORED SUGGESTION: a sender this pass bought for has a `routing_decisions` row, the
   candidate query excludes them, and the next cycle therefore starts at the next unbought sender.
   That is the same shape the sibling pass uses (a moved row leaves the Screener and drops out),
   and it is durable across a restart because it is in the database rather than in this process.

   ── ONE IMPLEMENTATION OF BUYING, ACROSS A DEPENDENCY BOUNDARY ──────────────────────────────

   The user-pressed purchase (`POST /screener/suggest`) lives in the API's service layer, which
   this app may not import: the worker's runtime closure is core + db + drizzle + imapflow +
   postgres, its container image installs exactly that, and a guard scans this directory to keep
   it so. Calling that method is therefore not available — but re-typing what it does IS the
   defect the rule against a second path exists to prevent. So the two irreducible pieces were
   moved DOWN to where both callers can reach them, and this file calls them:

    · `askScreeningQuestion` (`@trafficflow/core/mail`) — the redaction at the caller, the
      `outbound: "prescreened"` declaration that goes with it, the screening question rather than
      the routing one, and the account's Ohbox bar.
    · `storeScreenerSuggestion` (`@trafficflow/db`) — the provenance, the inert status and the
      per-message transaction.

   What is left here is selection and pacing, which is genuinely this pass's own: the watermark,
   the cap, and stopping on the first refusal. The ledger source is shared too
   (`screenerLedgerSource`), which is what makes a double-buy impossible rather than unlikely —
   the same message bought by the client's batch and by this pass in the same minute answers
   `duplicate` on the second `spend`, charges nothing, and the stored row makes the second one
   never reach the model at all.

   ── THE STANDALONE DOOR RUNS THIS SAME FUNCTION, AND "CONTINUOUSLY" MEANS SOMETHING ELSE THERE ─

   This paragraph used to say standalone installs got nothing from this file, and that giving the
   local engine an equivalent meant first deciding what "continuously" means with no always-on
   process. That decision is made, and the answer was not a second implementation: `apps/sidecar`
   calls THIS function from the tail of its own drain, exactly as it calls `bubbleUpPass` — one
   pass, two hosts, and the host supplies what differs. Three things differ and each is a
   parameter rather than a branch in here:

    · WHEN. There, the drain tail — after a sync cycle has finished bringing mail in, which is the
      only moment a standalone install can have NEW held senders. A launch catch-up needs no second
      hook because it is the same code path: the first drain after launch. Nothing arrives while
      that app is closed, so the only thing a launch has to catch up on is a pass a quit cut short,
      and the stored suggestion resumes that for free.
    · WHAT IS SPENT. There, the installer's own API key or their own hardware — no ledger exists on
      that tier, so `credits` cannot be supplied. That is why the refusal below is written against
      {@link ScreenerAutoSuggestDeps.unmetered} rather than against an ABSENT gate: a host that says
      nothing is still refused, and only a host that DECLARES it meters nothing may proceed. An
      absent field is a host that has not been read.
    · THE THIRD BOUND. On this door `spend()` refuses first and stops the pass. On that one nothing
      can refuse for money, and what remains is the classifier's own fault gate — the local engine
      hands in `classifierForCycle()`, which is withheld after repeated faults — plus the same
      first-fault-stops rule the loop below already has. The control-flow property is identical
      either way: at most ONE failed call per pass, never N.

   The watermark and the cap are unchanged on both doors, and on the standalone door the cap is
   load-bearing for one case rather than for every cycle — a first sync after the switch was turned
   on, where the baseline window can present many senders at once.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Where held first-contact senders wait — the queue this pass reads and never writes. */
const SCREENER = "ohmail/Screener";

/**
 * HOW MANY SENDERS ONE AUTOMATIC BATCH BUYS — this pass's whole spend for one account, per cycle.
 *
 * It is the SAME NUMBER as `AUTO_BATCH_SIZE` in `apps/webapp/app/shell/screener-suggest.ts`,
 * because it is the same policy: "the automatic path spends without a press, so its bound has to
 * be a number somebody can live with being wrong about". Ten senders is a rounding error against
 * the smallest tier's monthly allowance, and a person who wants the other forty presses the manual
 * control and sees a quote first.
 *
 * **It is a second literal and not an import, and that is forced, not chosen.** The two files
 * cannot see each other in either direction: this app's runtime dependencies are the mail core and
 * the database layer and nothing else in the workspace, and the web client deliberately declares no
 * dependency on any of them — so there is no package both can reach. A test therefore READS the
 * other file's source and pins the two literals equal, asserting it FOUND the literal before
 * comparing it, because a probe that finds nothing is a claim about the probe rather than about the
 * code.
 *
 * **ON THE STANDALONE DOOR IT BOUNDS MODEL CALLS RATHER THAN CREDITS**, and the same number is
 * right for a reason that had to be checked rather than assumed. There the cap does nothing on an
 * ordinary drain — new first-contact senders arrive a few at a time, well under ten — so what it
 * actually bounds is the one drain that can present a crowd: the first sync after somebody turns
 * the switch on, where everything inside the screening baseline window lands at once. Ten calls
 * against the installer's own key, resuming next drain, is a shape somebody can watch happen.
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
  credits?: AiCreditGate;
  /**
   * **A HOST DECLARING THAT NOTHING HERE IS METERED, which is not the same as omitting the gate.**
   *
   * `true` is the standalone desktop engine and nothing else: that tier is free, its model is the
   * installer's own API key or a model server on their own machine, and there is no ledger for a
   * gate to read — `apps/sidecar`'s service bag states the same thing about `aiCredits` in the same
   * words ("an absent gate means unmetered, not ungated").
   *
   * It is a DECLARATION rather than an inference from `credits === undefined` for the reason
   * `sendSurfaceMaxTotalBytes: null` is one in that same bag: a host that said nothing must get the
   * STRICTER branch. Inferring "unmetered" from an absent gate would turn every future wiring
   * mistake on the hosted side — a `classifyGateFor` that returned undefined for an account whose
   * subscription row was missing, say — into a pass that spends an account's allowance with no
   * meter in front of it, silently and for ever. Here the same mistake is a pass that does nothing,
   * which is visible and costs no money.
   *
   * The hosted worker never sets it, and both directions are pinned by a test: an absent gate with
   * no declaration refuses, and a declared one runs while moving not one credit.
   */
  unmetered?: true;
  /** The account's own "who belongs in my Ohbox" words, so a bought suggestion asks the same
   *  question a user-pressed one does. Absent ⇒ omitted from the request. */
  ohboxBar?: string;
  log?: Logger;
  /** Test seam. Default {@link AUTO_SUGGEST_BATCH}. */
  batch?: number;
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
  fromAddress: string;
  subject: string;
  snippet: string;
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
  const [settings] = await db.select({ autoSuggestAt: accountSettings.autoSuggestAt })
    .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const watermark = settings?.autoSuggestAt ?? null;
  if (!watermark) return EMPTY();

  const candidates = await selectCandidates(db, { accountId, watermark, limit: batch });
  const result: ScreenerAutoSuggestResult = {
    ...EMPTY(), ran: true, examined: candidates.length, capped: candidates.length >= batch,
  };

  for (const c of candidates) {
    // ── THE MONEY QUESTION, BEFORE THE MODEL QUESTION ────────────────────────────────────────
    //
    // `spend`, not `tryDebit`: the difference between "you are out of credits", "this account's
    // AI is switched off" and "the ledger is unwell" decides whether this pass should stop or is
    // simply idle, and a boolean throws that away. The source is the MESSAGE, which is what makes
    // this free to retry and impossible to double-charge against the client's own batch.
    //
    // The whole block is SKIPPED on an unmetered host, and skipped rather than satisfied by a
    // permissive stub gate: a stub would put a second, always-yes implementation of "may this
    // account spend" in the codebase, and the day somebody wired it to the hosted side by mistake
    // nothing would refuse. `charged` stays 0 there, which is the truth — a standalone install
    // moves no credits because it has none.
    if (gate) {
      const outcome = await gate.spend(screenerLedgerSource(c.messageId), { messageId: c.messageId });
      if (!outcome.permitted) {
        // FIRST REFUSAL STOPS THE ACCOUNT'S PASS FOR THIS CYCLE. Every remaining candidate would be
        // refused for the same reason — the balance, the subscription state, or the ledger — so
        // continuing would be N useless round trips per cycle, for ever, on every empty account.
        // One refused call per opted-in account per cycle is the bound this gives.
        result.stopped = outcome.refusal === "quantity"
          ? "out_of_credits"
          : outcome.refusal === "state" && outcome.reason === "ai_disabled"
            ? "ai_disabled"
            : "spend_unavailable";
        break;
      }
      // `+= AI_ACTION_COST` and not `++`: the field is credits, and `spend()` moves that many per
      // call. A `charged: false` is a free retry of an attempt already on record — reporting it as
      // spend would say the account paid twice for one message.
      if (outcome.charged) result.charged += AI_ACTION_COST;
    }

    let verdict;
    try {
      verdict = await askScreeningQuestion(classifier, {
        fromAddress: c.fromAddress,
        subject: c.subject,
        snippet: c.snippet,
        ...(deps.ohboxBar ? { ohboxBar: deps.ohboxBar } : {}),
      });
    } catch (err) {
      // STOP, where the user-pressed path CONTINUES — and the difference is that nobody is
      // waiting here. There, a person has paid for a set and the remaining senders may still
      // succeed; here a model fault is almost always the whole endpoint, and pressing on would
      // charge the rest of the batch against an outage every cycle. The charge is not refunded,
      // for the reason the pressed path gives: the ledger source is the message, so the next
      // cycle's attempt over it answers `duplicate` and the retry is free.
      //
      // It is the ONLY stop an unmetered host has, and it carries the same bound there: the local
      // engine hands in a classifier that is itself withheld after repeated faults, so a model
      // server somebody quit costs one call on the first drain and none on the drains after it.
      log.warn("screener_auto_suggest_model_failed", { accountId, messageId: c.messageId, err });
      result.stopped = "model_unavailable";
      break;
    }

    await storeScreenerSuggestion(db, {
      accountId,
      messageId: c.messageId,
      destination: verdict.destination,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      spam: verdict.spam,
    });
    result.bought++;
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
 * THE ELIGIBLE SENDERS — one representative per held sender, watermarked, unbought, oldest first.
 *
 * ## The representative is chosen by the SAME rule the Screener page and the purchase use
 *
 * `DISTINCT ON (lower(from_address)) … ORDER BY lower(from_address), sort_key DESC, id DESC`:
 * the sender's newest held message, ties broken by id. That is
 * `ScreenerReadService.heldSenderPage` character for character, and the agreement is what makes
 * the money safe rather than merely tidy — the stored suggestion and the ledger source are both
 * keyed by MESSAGE, so if this pass bought against a different representative than the surface
 * shows, the account would be charged twice for one sender and see the answer once.
 *
 * ## The two outer predicates sit OUTSIDE the `DISTINCT ON`, and that is not cosmetic
 *
 * Pushing either of them into the inner query would filter rows BEFORE the representative is
 * chosen, so a sender whose true representative is (say) already bought would have an OLDER held
 * message promoted to representative and be bought a SECOND time, on different mail. The
 * predicate therefore applies to a set that is already one row per sender. This is the same
 * composition, for the same reason, that `heldSenderPage` documents for its keyset.
 *
 * ## THE WATERMARK CLOCK IS OURS. `messages.date` IS THE SENDER'S AND IS NOT USED
 *
 * `created_at` is the instant WE first stored the row. `date` is the `Date:` header, which the
 * sender writes — and `pipeline.ts` already had to remove exactly that fallback from the
 * screening cutoff after a review found it handed the gate's clock to the sender. The same
 * reasoning applies with money attached: a stranger who backdates nothing and post-dates their
 * header would otherwise decide whether an account pays to be advised about them. `created_at` is
 * `NOT NULL DEFAULT now()`, so there is no null case and no fallback to reason about.
 *
 * The cost of our clock is honest and bounded: mail INGESTED after the opt-in but delivered long
 * before it — a first sync — reads as new. The SCREENING BASELINE is what keeps that from being a
 * backlog-sized bill, because mail older than it is not held at the consent gate at all and so
 * never enters this queue; what is left is the baseline window, and bound (2) paces that at ten
 * senders a cycle.
 *
 * ## Oldest first
 *
 * `ORDER BY created_at ASC` on the outer query, so a queue arriving faster than the cap drains in
 * arrival order and the sender at the back is never starved by a newer one. The client's on-open
 * batch takes the FRONT of its queue instead — that one is answering "what is this person looking
 * at right now", which is a different question from "what has been waiting longest".
 */
async function selectCandidates(
  db: Tx, opts: { accountId: string; watermark: Date; limit: number },
): Promise<Candidate[]> {
  const sortKey = sql<Date>`date_trunc('milliseconds', coalesce(${messages.date}, to_timestamp(0)))`;
  const sender = sql`lower(${messages.fromAddress})`;

  // `account_id` LEADS the predicate rather than filtering a cross-account result.
  const reps = db.selectDistinctOn([sender], {
    messageId: messages.id,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    snippet: messages.snippet,
    createdAt: messages.createdAt,
    sortKey: sortKey.as("sort_key"),
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(
      eq(messages.accountId, opts.accountId),
      eq(folderState.desiredFolder, SCREENER),
    ))
    .orderBy(sender, desc(sortKey), desc(messages.id))
    .as("reps");

  const rows = await db.select({
    messageId: reps.messageId,
    fromAddress: reps.fromAddress,
    subject: reps.subject,
    snippet: reps.snippet,
  }).from(reps)
    .where(and(
      // (1) THE WATERMARK — consent began before this message did.
      sql`${reps.createdAt} > ${opts.watermark.toISOString()}::timestamptz`,
      // The progress marker AND the double-buy guard, in one predicate: a sender whose
      // representative already carries a suggestion — bought by this pass on an earlier cycle, by
      // the client's on-open batch, or by the manual ladder — is not re-bought and not re-asked.
      sql`not exists (
        select 1 from ${routingDecisions} rd
         where rd.account_id = ${opts.accountId}::uuid
           and rd.message_id = ${reps.messageId}
           and rd.input_provenance = ${SCREENER_SUGGESTION_PROVENANCE}
      )`,
    ))
    .orderBy(asc(reps.createdAt), asc(reps.messageId))
    .limit(opts.limit);

  return rows.map((r) => ({
    messageId: r.messageId,
    fromAddress: r.fromAddress.toLowerCase(),
    subject: r.subject,
    snippet: r.snippet,
  }));
}
