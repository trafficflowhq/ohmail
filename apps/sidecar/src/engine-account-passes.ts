import { eq } from "drizzle-orm";
import type { SweepClearance } from "@trafficflow/core/mail";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { DEFAULT_OHBOX_POLICY, resolveOhboxPolicy, resolveScreeningCutoff } from "@trafficflow/core/mail";
import { accountSettings, type Tx, applyInferredPressRepair } from "@trafficflow/db";
import { oncePerLaunch } from "./once-per-launch.js";
import type { SyncDeps } from "@ohmail/organizer/sync";
// The SCHEDULED-RESURFACE FLIP, from the same package and for the third instance of the same
// argument. "Resurfaces Friday at 9" is a dated promise the product makes to the user, and the
// only thing that can keep it is a pass that notices the date has arrived. On a hosted account
// the worker's cycle runs it; a standalone install has no worker at all, so this process runs the
// SAME function against the store that is authoritative here. A local reimplementation would be a
// second answer to "when is a resurface due", which is the one thing that must not differ.
import { bubbleUpPass } from "@ohmail/organizer/bubble-up";
/* A RULE'S "APPLY TO EXISTING MAIL", the worker's pass for bubble-up's reason: on this door the
   store is the authority and no worker will walk the backlog, so without it a Screener decision
   re-presented the old mail while the mailbox kept it where it was. */
import { ruleRetroPass } from "@ohmail/organizer/rule-retro";
import { gapCatchupPass, NO_FOLDER_READ } from "@ohmail/organizer/gap-catchup";
import { screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";
import {
  screenerActConsentFrom, screenerAutoActPass, type ScreenerAutoActSettings,
} from "@ohmail/organizer/screener-auto-act";
/* THE IDENTITY BACKFILL (mail 0148), the worker's pass for the name repair's reason: this store is
   the authority nothing else will ever check, and one fact function decides every row. */
import { senderCheckBackfillPass } from "@ohmail/organizer/sender-check-backfill";
import { listAddressBackfillPass } from "@ohmail/organizer/list-address-backfill";
import {
  screenerImpersonationPass, type ImpersonationCutlineSettings, type ImpersonationWalk,
} from "@ohmail/organizer/screener-impersonation";
import { retireActAdmissionsPass } from "@ohmail/organizer/act-admission-retire";
import { GONE_LETTER_TIDY_BATCH, goneLetterTidyPass } from "@ohmail/organizer/gone-letter-tidy";
// The HISTORICAL-NAME REPAIR, from the same package and for the fourth instance of the same
// argument. The values it writes have to be the ones ingest would have written from the same
// headers; a second parse here would leave two populations of rows decided by different rules, and
// the disagreement would be invisible one row at a time.
import { runSenderNameBackfill } from "@ohmail/organizer/sender-name-backfill";
import { cadenceDue, type CadenceStamp } from "./pass-cadence.js";
import type { SidecarConfig } from "./engine-types.js";
import { LOCAL_NAME_BACKFILL_BATCH, LOCAL_NAME_BACKFILL_PAGES, LOCAL_ACT_RETIRE_PAGES } from "./engine-routes.js";
import type { EngineScope } from "./engine-scope.js";

/**
 * The desktop's engine, one section: the install's own passes: account-scoped, run once per drain and not once per
 * mailbox.
 */
export function accountPassesSection(scope: EngineScope, config: SidecarConfig): void {
    // The install's own passes — account-scoped, and therefore NOT per mailbox. Everything
    // below this banner and above the next takes an ACCOUNT and no mailbox: the Ohbox posture
    // and the screening window, the resurface flip, the Screener's suggestion pass and the
    // historical-name repair. They read and write rows that belong to the install rather than
    // to one server and one login, so an install running several mailboxes runs each of them
    // ONCE per drain and not once per mailbox — the same scan repeated per row would cost N
    // times as much and answer the same question N times. Moved above the per-mailbox assembly
    // so the boundary is a place in the file rather than a fact reconstructed from arguments;
    // nothing changed in the move except the flag the name repair yields on (`stopping`).

    /**
     * How this mailbox wants its Ohbox kept — read fresh, once per drain. Two columns on `account_settings`,
     * both inputs to filing: the POSTURE decides whether obvious bulk from an admitted sender is demoted
     * (`EvaluateRulesInput.ohboxPolicy` is required so no caller sits silently on the wrong side; resolved
     * every drain, model or no model), and the BAR is the account's own sentence, reaching the classifier's
     * user turn only (absent ⇒ omitted). Read with no cache, unlike the hosted worker: one account, one
     * in-process database — a cache buys nothing and costs staleness after a Settings edit. A failed read
     * files leniently and drops the bar: `people_only` is the strict posture, and defaulting to it on a blip
     * would demote a real person's mail. The event name is the hosted worker's.
     */
    const screeningNow = async (): Promise<Pick<SyncDeps, "ohboxPolicy" | "ohboxBar" | "screeningCutoff" | "signatures">
      & { actSettings?: ScreenerAutoActSettings; impersonation?: { on: boolean } & ImpersonationCutlineSettings }> => {
      /* A one-click letter's sender is worth confirming while a screen-out may unsubscribe. */
      const signaturesFor = (listLetters: boolean): SyncDeps["signatures"] =>
        scope.signatureCheck === null ? null : { ...scope.signatureCheck, listLetters };
      try {
        const [row] = await scope.db.select({
          policy: accountSettings.ohboxPolicy, bar: accountSettings.ohboxBar,
          // The window, which this door did not have. This file once contained zero
          // occurrences of `screeningCutoff`, `dormancy` or `screeningBaseline` — so the
          // standalone install, the free tier and the door most people meet first, screened
          // EVERY backfilled message regardless of age: a person with a decade of mail got a
          // decade of it moved into `ohmail/Screener`, one IMAP move at a time, into a queue
          // nobody was going to empty. The hosted worker has resolved this per cycle since
          // mail 0056 (`index.ts#screeningFor`); this is the same three columns and the same
          // resolver, deliberately, so the two cannot drift. `consentRoutes` are mounted on
          // `localRoutes` in the same commit — without them no surface can set the dial this
          // reads, and a cutoff nobody can choose is a window nobody chose.
          baselineAt: accountSettings.screeningBaselineAt,
          dormancyDays: accountSettings.dormancyDays,
          scope: accountSettings.screeningScope,
          autoActAt: accountSettings.screenerAutoActAt,
          blockAutoUnsubscribeAt: accountSettings.blockAutoUnsubscribeAt,
          impersonationOffAt: accountSettings.impersonationFilingOffAt,
        }).from(accountSettings).where(eq(accountSettings.accountId, scope.world.accountId)).limit(1);
        const cutoff = resolveScreeningCutoff(row?.baselineAt, row?.dormancyDays, row?.scope);
        return {
          ohboxPolicy: resolveOhboxPolicy(row?.policy ?? null),
          ...(row?.bar ? { ohboxBar: row.bar } : {}),
          // ABSENT ⇒ no cutoff ⇒ the gate holds every unruled sender's mail whatever its date,
          // which is both the pre-0056 behaviour and exactly what `screening_scope = 'all_time'`
          // asks for. One state, reached two ways, and `resolveScreeningCutoff` is the single
          // place that decides which.
          ...(cutoff ? { screeningCutoff: cutoff } : {}),
          signatures: signaturesFor((row?.blockAutoUnsubscribeAt ?? null) === null),
          // The cutline's row, handed to the act so its pass asks the store nothing more.
          actSettings: {
            screeningBaselineAt: row?.baselineAt ?? null,
            dormancyDays: row?.dormancyDays ?? null, screeningScope: row?.scope ?? null,
            screenerAutoActAt: row?.autoActAt ?? null,
          },
          // The impersonation filing's switch off the same row: NULL is on, the default.
          impersonation: {
            on: (row?.impersonationOffAt ?? null) === null,
            screeningBaselineAt: row?.baselineAt ?? null,
            dormancyDays: row?.dormancyDays ?? null, screeningScope: row?.scope ?? null,
          },
        };
      } catch (err) {
        scope.log("screening_pref_read_failed", {
          err,
          reason: "this mailbox's Ohbox posture and screening window could not be read, so this " +
            "pass files on the lenient default, sends no bar to a model and applies NO cutoff " +
            "(the strict direction for the gate); the next pass reads again",
        });
        return { ohboxPolicy: DEFAULT_OHBOX_POLICY, signatures: signaturesFor(false) };
      }
    };

    /**
     * WHICH MAILBOXES THIS INSTALL ORGANIZES AT THIS MOMENT — the scope handed to every pass that
     * writes mail state for the whole account at once. One source: the answer each runtime's own gate
     * (`mayOrganize`) wrote, read through the accessor that can only WITHHOLD it — a stop, a hand-back
     * or a poll timer not yet armed take a mailbox out, nothing puts one in — so a booking due at
     * launch waits for the first poll rather than flipping inside the launch drain, which is the
     * price of a source that cannot over-claim (`resurface-launch-window.test.ts` pins both halves).
     * Computed per call and never cached: an install that organizes nothing writes nothing.
     */
    const organizedMailboxIds = (): string[] =>
      scope.runtimes.all().filter((rt) => rt.organizer.organizing).map((rt) => rt.mailboxId);

    /**
     * Scheduled resurfacing — the local half of a feature that was hosted-only by accident. A message put
     * away until Friday at nine carries `state='bubbled_up'` and a `bubbleUpAt`; on Cloud the hosted worker
     * flips it, and a standalone install has no worker, so the row sat there while the shortcut promised
     * "Resurfaces {when}". The flip belongs where the authoritative store is — here this PGlite file; on the
     * Cloud door the hosted database, whose mirror learns the resurface as an ordinary delta. Behind the
     * organizer gate (inside {@link drain}): a stood-down install's database is a frozen mirror, and flipping
     * rows there would surface items in parallel with the real owner. One indexed SELECT + one UPDATE per due
     * row, per drain, not per cycle. Failures contained: the row stays due.
     */
    const resurfaceDue = async (): Promise<void> => {
      try {
        const { flipped } = await bubbleUpPass(
          /* THE SET, READ AT THE CALL — a mailbox handed over since the last drain is out of this
             one, and an install organizing none of its mailboxes flips nothing rather than
             everything. `world.accountId` stays beside it: the account is still the shard. */
          scope.db as unknown as Tx, scope.now(),
          { accountId: scope.world.accountId, mailboxIds: organizedMailboxIds() },
        );
        // Only when something moved: a settled mailbox emits this line never, which is the same
        // rule the drain summary below follows.
        if (flipped > 0) scope.log("resurface_flipped", { flipped });
      } catch (err) {
        scope.log("resurface_pass_failed", {
          err,
          reason: "scheduled resurfaces could not be flipped this pass; the rows stay due and " +
            "the next poll tries again, and mail continues to be filed either way",
        });
      }
    };

    /**
     * APPLY A RULE TO THE MAIL ALREADY FILED — the worker's `ruleRetroPass`, behind the organizer
     * gate like the flip above. It writes desired state only (`folder_state` + a `move` row); the
     * cycles that follow in the same drain reconcile it to IMAP. Its own write budget bounds it, and
     * a failure is contained: the rule stays owed and the next drain resumes from its cursor.
     */
    const retroDue = async (): Promise<void> => {
      try {
        /* THE TRUST IS READ BEFORE THE WALK, off each credential row's own IMAP host (the worker's
           resolution). The pass asks for it inside its page transaction, and on this door's one
           connection a read on the outer handle there waits for that transaction for ever. */
        const trust = new Map<string, ReadonlySet<string>>();
        for (const id of scope.runtimes.all().map((rt) => rt.mailboxId)) {
          trust.set(id, await mailboxProviderAuthservIds(scope.db, id));
        }
        const { moved, completed, capped } = await ruleRetroPass(scope.db as unknown as Tx, {
          accountId: scope.world.accountId,
          trustedAuthservIdsFor: async (_tx, mailboxId) => trust.get(mailboxId) ?? new Set<string>(),
          ...(scope.walkTurn !== undefined ? { turn: scope.walkTurn } : {}),
          ...(config.logger === undefined ? {} : { log: config.logger }),
        });
        if (moved > 0 || completed > 0) scope.log("rule_retro_pass", { moved, applied: completed, capped });
      } catch (err) {
        scope.log("rule_retro_failed", {
          err,
          reason: "no rule was marked applied and no cursor advanced past uncommitted work, so " +
            "the next drain resumes; mail already desired is carried by the reconciler",
        });
      }
    };

    /**
     * MAIL FROM A GAP — the worker's `gapCatchupPass`, for the mailboxes this install organizes
     * whose tenure has had a quiet drain ({@link gapCatchupReady}). It COUNTS the offer the person
     * answers, and files only on their press (`POST /mailboxes/:id/gap-letters` rings this drain).
     * A failure leaves the window standing, so the next drain resumes.
     */
    const gapCatchupDue = async (): Promise<void> => {
      const owedRts = scope.runtimes.all()
        .filter((rt) => rt.organizer.organizing && scope.gapCatchupReady.has(rt.mailboxId) && scope.gapOwed.has(rt.mailboxId));
      /* A WINDOW WAITS FOR ITS LETTERS' ARRIVAL TIMES while this store is still asking for them (the
         phone's backfill); it stays owed. */
      const readyRts: typeof owedRts = [];
      for (const rt of owedRts) {
        const waits = await rt.arrivalsWithheld?.().catch(() => false) ?? false;
        if (!waits) { scope.arrivalsSaid.delete(rt.mailboxId); readyRts.push(rt); continue; }
        if (scope.arrivalsSaid.has(rt.mailboxId)) continue;
        scope.arrivalsSaid.add(rt.mailboxId);
        scope.log("gap_catchup_withheld", {
          mailboxId: rt.mailboxId, outcome: "arrivals",
          reason: "the letters in the open gap window are still being given their arrival times, so the "
            + "window waits for them",
        });
      }
      const ready = readyRts.map((rt) => rt.mailboxId);
      if (ready.length === 0) return;
      try {
        /* THE TRUST IS READ BEFORE THE WALK, for `retroDue`'s reason: one connection on this door. */
        const trust = new Map<string, ReadonlySet<string>>();
        for (const id of ready) trust.set(id, await mailboxProviderAuthservIds(scope.db, id));
        /* AND WHETHER EACH MAILBOX'S RULES ARE SETTLED: the last evaluation of its settings folder,
           no IO. A withheld window stays owed: an import answer does not ring this pass. */
        const settled = new Map<string, SweepClearance>(readyRts.map((rt) => [rt.mailboxId, rt.profileSync.gapClearance()]));
        const asked = new Map<string, SweepClearance>();
        const { offered, moved, completed } = await gapCatchupPass(scope.db as unknown as Tx, {
          accountId: scope.world.accountId,
          mailboxIds: ready,
          trustedAuthservIdsFor: async (_tx, mailboxId) => trust.get(mailboxId) ?? new Set<string>(),
          clearanceFor: (mailboxId) => {
            const c = settled.get(mailboxId) ?? NO_FOLDER_READ;
            asked.set(mailboxId, c);
            return c;
          },
          ...(scope.walkTurn !== undefined ? { turn: scope.walkTurn } : {}),
          ...(config.logger === undefined ? {} : { log: config.logger }),
        }, scope.now());
        for (const id of ready) {
          const c = asked.get(id);
          if (c === undefined || c.kind === "clear") scope.gapOwed.delete(id);
        }
        if (offered + moved + completed > 0) scope.log("gap_catchup_pass", { offered, moved, applied: completed });
      } catch (err) {
        scope.log("gap_catchup_failed", { err, reason: "the gap offer was not counted or filed; the next drain resumes it" });
      }
    };

    /**
     * Suggest for the senders that just arrived — "continuously" on a door that only runs while its window is open
     * means at the tail of a drain: the only moment this install can have new held senders, and the only moment it is
     * awake. Launch catch-up needs no second hook — nothing arrives while the app is closed, and an interrupted pass
     * resumes for free (the stored suggestion is the progress marker). It is the worker's pass
     * (`@ohmail/organizer/screener-auto-suggest`), not a copy: watermark, cap and ordering must agree character for
     * character with the Screener surface. Here `credits` is absent and `unmetered: true` declared; the watermark is
     * `account_settings.auto_suggest_at` (written by `PUT /local/auto-suggest` only); the first refusal stops the
     * pass via `classifierForCycle()`'s cooldown. On: at most one model call per new held sender, ever.
     */
    const suggestNew = async (ohboxBar?: string): Promise<void> => {
      // The port FIRST, so an install with no model — the common case, and the product's floor —
      // pays nothing and reads nothing. `classifierForCycle` and not `classifier`: this is
      // background work with nobody waiting, so it must take the seam that withholds a model which
      // has been failing rather than the one the Screener button uses.
      const classifier = scope.ai.classifierForCycle("screening");
      if (!classifier) return;
      try {
        const { bought, examined, capped } = await screenerAutoSuggestPass(scope.db as unknown as Tx, {
          accountId: scope.world.accountId,
          classifier,
          // THE DECLARATION, not an omission. See `ScreenerAutoSuggestDeps.unmetered`.
          unmetered: true,
          ...(ohboxBar ? { ohboxBar } : {}),
        });
        // Only when something was bought: an install that has not opted in, or one whose queue is
        // already answered for, stays silent every drain — the rule every other line here follows.
        if (bought > 0) scope.log("screener_auto_suggest", { examined, bought, capped });
      } catch (err) {
        scope.log("screener_auto_suggest_failed", {
          err,
          reason: "no suggestion was bought for the senders that just arrived; nothing is marked " +
            "and no cursor persists, so the next drain resumes at the next unanswered sender and " +
            "the Screener's own button still works in the meantime",
        });
      }
    };

    /**
     * Act on what is stored, on the act's own consent. The worker's pass again, not a copy: a
     * sender filed here has to mean what a sender filed on the hosted side means, and the decision
     * itself is `applyScreenerDecision`, the function this engine's Apply button and its request
     * drain reach. It reads advice and buys none. With the consent off in the row the drain already
     * read, it reads nothing.
     */
    const actOnSuggestions = async (settings?: ScreenerAutoActSettings): Promise<void> => {
      try {
        const { ran, filed, failed, capped } = await screenerAutoActPass(scope.db as unknown as Tx, {
          accountId: scope.world.accountId, consent: screenerActConsentFrom(scope.world.accountId),
          ...(settings ? { settings } : {}),
        });
        if (ran && (filed > 0 || failed > 0)) scope.log("screener_auto_act", { applied: filed, failed, capped });
      } catch (err) {
        scope.log("screener_auto_act_failed", {
          err,
          reason: "no waiting sender was filed; nothing is marked and no cursor persists, every " +
            "one of them still carries the suggestion and its own Apply, and the next drain asks again",
        });
      }
    };

    /**
     * How far the historical-name repair has walked THIS LAUNCH, and whether it is finished.
     *
     * Deliberately in memory and nowhere else. The database already holds the answer to "is this
     * row repaired?" — the column is either set or it is not — so a persisted cursor would be a
     * second, weaker copy of a fact the store keeps perfectly, and the two would drift the first
     * time a write was lost. What memory buys instead is a WALK POSITION, which is a different
     * thing and not durable state: see {@link backfillStoredNames}.
     */
    let namesCursor: string | undefined;
    let namesDone = false;
    /** A pass last run at `at` is due by `cadenceDue`; `null` (not yet in THIS launch) is due, so a
     * launch's first drain takes one look. */
    const passDue = (at: CadenceStamp | null, everyMs: number): boolean => cadenceDue(at, everyMs, scope.cadenceClocks);
    /** When the thread-join heal last ran in THIS launch — it repairs presentation, not a
     * promise, so once per {@link LOCAL_JOIN_HEAL_EVERY_MS} is plenty and a busy drain never
     * pays its GROUP BY. Unset so a launch's first drain takes one look (splits accumulated
     * while the app was closed), exactly the worker's gate seeding. */
    scope.lastJoinHealAt = null;
    /** When the correspondent retro last ran in THIS launch — unset, so a launch's first drain
     * releases whoever it wrote to while the app was closed; then once per
     * `CORRESPONDENT_RETRO_EVERY_MS`, the hosted cadence. */
    scope.lastCorrespondentRetroAt = null;
    /** When the inbound-quiet pass last ran in THIS launch — same seeding and cadence
     * (`LOCAL_INBOUND_QUIET_EVERY_MS`) as the heal above. */
    scope.lastInboundQuietAt = null;
    /** Where the last gated heal walk stopped, kept only while it stopped on its BUDGET — a
     * refused group never leaves the candidate predicate, so restarting from the top every six
     * hours would rescan the same refusals for ever and never reach the groups past the cap.
     * Cleared after an uncapped walk, exactly as the hosted caller keeps its per-account map. */
    scope.joinHealCursor = undefined;

    /**
     * Fill in the sender names and recipients of messages stored before there was anywhere to
     * put them — a one-time repair of this install's own store, spread over many visits. Hosted
     * rows were repaired centrally and mirrors learned the values as `/sync` deltas; a standalone
     * store is the authority nothing else has seen, so this door runs the same pass itself
     * (`@ohmail/organizer/sender-name-backfill` — a second parse would produce indistinguishable
     * rows). {@link LOCAL_NAME_BACKFILL_PAGES} pages of {@link LOCAL_NAME_BACKFILL_BATCH} rows per
     * visit; no resume state — the pass writes only unset columns (`namesCursor` is a per-launch
     * walk position, `namesDone` ends the scans); one `message` update per row repaints the window.
     */
    /** The identity backfill answered empty in THIS launch: later drains skip it at no cost. */
    let senderCheckDone = false;
    /**
     * THE IDENTITY FACT FOR ROWS OLDER THAN mail 0148, one page per drain, the worker's own pass:
     * the Ohbox's and the Screener's rows get the sentence a fresh arrival carries. It writes the
     * fact and a `message` update for a marked row, never a move. Contained like the name repair.
     */
    const backfillSenderChecks = async (): Promise<void> => {
      if (senderCheckDone || scope.stopping) return;
      try {
        const r = await senderCheckBackfillPass(scope.db as unknown as Tx, { accountId: scope.world.accountId });
        if (r.done && r.contactsDone) senderCheckDone = true;
        if (r.marked > 0) scope.log("sender_check_backfill", { scanned: r.checked, marked: r.marked });
      } catch (err) {
        scope.log("sender_check_backfill_failed", {
          err,
          reason: "some older held or Ohbox messages carry no identity sentence yet; nothing is marked " +
            "and no position is kept, so the next drain asks the store again",
        });
      }
    };
    /**
     * THE IMPERSONATION FILING IS OWED: the first drain of a launch, a drain that took mail in, the
     * switch turned on, a run that left senders waiting, and a settings question opened or answered
     * on a mailbox. Anything else costs the drain nothing, so an idle drain asks the store no more
     * than before.
     */
    scope.impersonationOwed = true;
    /** The switch as the last drain read it; `null` before the first read of this launch. */
    scope.impersonationLastOn = null;
    /** The mailboxes the last run that owed nothing more went over. */
    scope.impersonationSettledOver = null;
    /** The walk of the waiting senders, kept between drains. */
    const impersonationWalk: ImpersonationWalk = {};
    /** The organized mailboxes whose settings question the last evaluation found answered; no IO. */
    const settledMailboxIds = (): string[] => scope.runtimes.all()
      .filter((rt) => rt.organizer.organizing && rt.profileSync.gapClearance().kind === "clear")
      .map((rt) => rt.mailboxId).sort();
    /**
     * A HELD LETTER THAT IMPERSONATES A COMPANY, FILED TO SPAM ON ITS OWN — the worker's pass on this
     * store, the mailboxes this install organizes whose settings question is answered, the switch and
     * the cutline off the drain's own settings read. No model, no rule, one letter at a time with its
     * undo. Contained like the backfills.
     */
    const fileImpersonations = async (
      settings: { on: boolean } & ImpersonationCutlineSettings, mailboxIds: string[],
    ): Promise<void> => {
      if (scope.stopping) return;
      try {
        const r = await screenerImpersonationPass(scope.db as unknown as Tx, {
          accountId: scope.world.accountId, mailboxIds, settings, now: scope.now, walk: impersonationWalk,
        });
        // Not run (no mailbox organized and answered yet, as in a launch drain), cut, or failed: still owed.
        scope.impersonationOwed = !r.ran || r.capped || r.failed > 0;
        if (!scope.impersonationOwed) scope.impersonationSettledOver = mailboxIds.join(" ");
        if (r.filed > 0 || r.failed > 0) scope.log("screener_impersonation", { moved: r.filed, failed: r.failed, capped: r.capped });
      } catch (err) {
        scope.log("screener_impersonation_failed", {
          err,
          reason: "no held letter was filed and nothing is marked; the filing stays owed, so the next drain asks again",
        });
      }
    };
    /** The list-address backfill stamped this store, or found it stamped, in THIS launch. */
    let listAddressesDone = false;
    /**
     * THE ADDRESSES A MAILING LIST POSTS AS (mail 0150), read once from every stored message — the
     * worker's own pass, on this store, before the correspondent retro asks the rows. It records list
     * addresses and a stamp, never a contact or a move. Contained like the identity backfill.
     */
    const backfillListAddresses = async (): Promise<void> => {
      if (listAddressesDone || scope.stopping) return;
      try {
        const r = await listAddressBackfillPass(scope.db as unknown as Tx, { accountId: scope.world.accountId });
        listAddressesDone = true;
        if (r.ran) scope.log("list_address_backfill", { scanned: r.values, written: r.addresses });
      } catch (err) {
        scope.log("list_address_backfill_failed", {
          err,
          reason: "the store is not stamped, so the next drain reads its stored mail again; what was " +
            "recorded stays, and new mail records its own list addresses as it arrives",
        });
      }
    };
    /** The gone-letter tidy found this store clean in THIS launch: later drains skip it at no cost. */
    const goneLettersTidied = new Set<string>();
    /**
     * LETTERS THAT LEFT THE SERVER BEFORE THEIR WORDS WENT WITH THEM, a page per drain — the
     * worker's own pass on this store, which is its own authority: the preview, the search
     * document, the summary, a tracker's address and the header lines but seven of a gone letter.
     * No change row: nothing the window shows reads them. Contained like the backfills above.
     */
    const tidyGoneLetters = async (): Promise<void> => {
      if (scope.stopping || goneLettersTidied.has(scope.world.accountId)) return;
      try {
        const r = await goneLetterTidyPass(scope.db as unknown as Tx, scope.world.accountId, {
          limit: GONE_LETTER_TIDY_BATCH, done: goneLettersTidied,
        });
        if (r.tidied > 0) scope.log("gone_letter_tidy", { written: r.tidied, more: !r.done });
      } catch (err) {
        scope.log("gone_letter_tidy_failed", {
          err,
          reason: "letters that left the server keep their preview and words on this computer a while longer; "
            + "each page is its own transaction, so the next drain goes on with what is left",
        });
      }
    };
    const backfillStoredNames = async (): Promise<void> => {
      // Both guards before any query. A quitting engine must not open a transaction it may not
      // finish, and a finished repair must cost nothing at all.
      if (namesDone || scope.stopping) return;
      try {
        const r = await runSenderNameBackfill({
          db: scope.db as unknown as Tx,
          apply: true,
          accountId: scope.world.accountId,
          batch: LOCAL_NAME_BACKFILL_BATCH,
          maxRows: LOCAL_NAME_BACKFILL_BATCH * LOCAL_NAME_BACKFILL_PAGES,
          ...(namesCursor === undefined ? {} : { startAfterId: namesCursor }),
        });
        if (r.cursor !== null) namesCursor = r.cursor;
        if (r.exhausted) namesDone = true;
        // Only when something was written. A store with nothing to repair — every install created
        // after the columns existed, which is most of them — stays silent on every drain of its
        // life, and so does a store this has already finished. Counts only: WHICH message got its
        // sender back is a fact about somebody's mail, and how many did is not.
        if (r.written > 0) scope.log("sender_names_backfilled", {
          scanned: r.scanned, fillable: r.fillable, written: r.written,
        });
      } catch (err) {
        scope.log("sender_names_backfill_failed", {
          err,
          reason: "some older messages keep showing a bare address instead of the sender's name; " +
            "nothing is marked and no position is kept, so the next pass asks the store again and " +
            "the mail itself is unaffected either way",
        });
      }
    };
    /**
     * THE 0.25.9 PRESS REPAIR, ONCE PER LAUNCH: a Screener rule a person moved to the Ohbox before
     * 0.25.9 becomes theirs on this store, which is its own authority (`applyInferredPressRepair`,
     * the same module the Cloud's operator run uses). It limits itself — a written rule is no
     * longer a candidate — so a launch with nothing to repair costs one read. Counts only.
     */
    const repairOnce = oncePerLaunch(async () => {
      const r = await applyInferredPressRepair(scope.db as unknown as Tx, scope.world.accountId);
      if (r.written > 0) scope.log("inferred_presses_repaired", { fillable: r.planned, written: r.written });
    }, (err) => {
      scope.log("inferred_presses_repair_failed", {
        err,
        reason: "a rule the person moved to the Ohbox before this release keeps filing their newsletters " +
          "to News; nothing was written, so the next launch asks again",
      });
    });
    const repairInferredPresses = async (): Promise<void> => { if (!scope.stopping) await repairOnce(); };
    /**
     * THE ACT'S PAST ADMISSIONS, RETIRED ONCE PER LAUNCH (the worker's own pass): a sender only the act
     * on suggestions let in loses its rule and the contact only it wrote, and waits at the Screener
     * again. Paged to the end; it moves no mail. A failure is said once and the next launch asks again.
     */
    const retireOnce = oncePerLaunch(async () => {
      let after: string | undefined;
      for (let pages = 0; pages < LOCAL_ACT_RETIRE_PAGES && !scope.stopping; pages++) {
        const r = await retireActAdmissionsPass(scope.db as unknown as Tx, { accountId: scope.world.accountId, ...(after ? { after } : {}) });
        if (r.rules + r.contacts > 0) scope.log("act_admission_retired", { examined: r.examined, resolved: r.rules, cleared: r.contacts });
        if (r.done || r.next === null) return;
        after = r.next;
      }
    }, (err) => {
      scope.log("act_admission_retire_failed", {
        err,
        reason: "a sender the act let in before this release keeps its rule or contact for now; no letter " +
          "moved, and the next launch asks again",
      });
    });
    const retireActAdmissions = async (): Promise<void> => { if (!scope.stopping) await retireOnce(); };
    scope.screeningNow = screeningNow;
    scope.resurfaceDue = resurfaceDue;
    scope.retroDue = retroDue;
    scope.gapCatchupDue = gapCatchupDue;
    scope.suggestNew = suggestNew;
    scope.actOnSuggestions = actOnSuggestions;
    scope.passDue = passDue;
    scope.backfillSenderChecks = backfillSenderChecks;
    scope.settledMailboxIds = settledMailboxIds;
    scope.fileImpersonations = fileImpersonations;
    scope.backfillListAddresses = backfillListAddresses;
    scope.tidyGoneLetters = tidyGoneLetters;
    scope.backfillStoredNames = backfillStoredNames;
    scope.repairInferredPresses = repairInferredPresses;
    scope.retireActAdmissions = retireActAdmissions;
}
