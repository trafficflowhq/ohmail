import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  approvals, autoReplyByUsWhere, drafts, folderState, mailboxes, messageBodies, messageStates, messages,
  recordChange, rules as rulesTbl, type Tx,
} from "@trafficflow/db";
import {
  DEFAULT_OHBOX_POLICY, DESTINATIONS, authVerdictFromHeaders, evaluateRules,
  silentLogger, type Logger, type NormalizedMessage, type Rule,
} from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { carryDialect, dialect } from "@trafficflow/db/dialect";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   APPLYING A NEW RULE TO MAIL THAT IS ALREADY FILED
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT WAS ASKED FOR, AND WHAT WAS ACTUALLY SHIPPED ──────────────────────────────────────

   *"but also allow it to actually create the rule and apply it to ALL messages future and
    previous, this should be the default behaviour to efficiently manage the mailbox."*

   A rule is consulted when mail ARRIVES and never afterwards. So the sheet's answer was to
   compose one `move` mutation per matching message the client mirror holds and fire them all
   from the browser (`sender-screening.ts#planScreeningChange`).

   **The SET was right and everything else about it was wrong.** The mirror is complete — `/sync`
   replays the whole `change_log` from seq 0 (`sync-service.ts`) and `Engine.drain` loops until
   `hasMore` is false — so "every message the mirror holds" really is every message. But each of
   those mutations is its own `POST /messages/:id/move`, and each of those takes the account's
   `account_sync_state` row lock for its transaction. Three thousand messages is three
   thousand HTTP requests from a browser tab, serializing that account's entire write path three
   thousand times, unawaited and unreported — and if the tab is closed seven hundred messages in, the rule
   exists, those moved, and NOTHING will ever finish the rest. That is the
   "state that needs a human" the desired-state design exists to make unreachable.

   ── IT WRITES AN INTENT. IT NEVER OPENS IMAP. ──────────────────────────────────────────────

   The organize-in-place principle: organization lands in real IMAP folders, but the API never opens a connection to
   apply it — moves defer to the worker via `folder_state` desired-state. This pass is on the
   worker and STILL does not open IMAP, for a different reason: `reconcileFolders`
   (`apps/worker/src/sync.ts`) is the one code path that knows how to do a move crash-safely,
   it holds the mailbox's adapter and its lease, and a second mover racing it inside the same
   process would be two organizers for one mailbox. So this pass writes `desired_folder` plus a
   `move` change and stops. `rule-retro.no-imap.test.ts` fails if an IMAP client is constructed.

   ── THE PACING IS NOT ABOUT THIS PASS. IT IS ABOUT THE RECONCILER. ─────────────────────────

   `RULE_RETRO_WRITES_PER_CYCLE` is the load-bearing constant and its reason is downstream:
   `reconcileFolders` reads `repo.listPendingFolderStates(mailboxId)`, which has NO LIMIT, and
   walks it serially doing one IMAP move per row inside the sync cycle. `beat()` is the last
   thing in that cycle and `leaderStaleMs` is two minutes, so a few hundred pending rows push
   one cycle past the heartbeat and the deployment pages an operator with "no mailbox is
   syncing" — which would be TRUE, and caused by a user clicking a destination. Worse, any error
   that is not `MessageGoneError` aborts the whole reconcile pass, so one poison row among four
   thousand stops that mailbox's reconciliation every cycle, permanently.

   Hence a cap on how much desired state this pass may CREATE per account per cycle, rather than
   a cap on what the user may ask for. The request is legitimate; the pacing is ours. At a 60 s
   poll, four thousand messages take about 40 minutes and the mailbox stays reconciled throughout.

   (The unbounded `listPendingFolderStates` is a real defect in a shared path and is NOT fixed
   here — fixing the reconciler from this slice would put an untested change to every mailbox's
   move path behind a feature nobody has run yet.)

   ── IT RE-EVALUATES. IT DOES NOT INVERT. ───────────────────────────────────────────────────

   Same doctrine as `sensitive-rescreen.ts`, whose header argues it at length: a pass that
   applies its own understanding of a rule is a SECOND router, and a second router drifts from
   the first. So the new rule's `match` narrows the CANDIDATES — that is a cost decision, and the
   two indexes 0034 adds are what make it one — but the DECISION comes from `evaluateRules` with
   the account's whole rule set, its `contacts`, and the same header verdict the pipeline uses.
   A message moves to whatever the router says, which is not always the new rule's destination:
   a higher-priority deny rule still wins, and a message it wins for stays where the deny put it.

   The consequence is visible to the user and the copy must survive it: the number the sheet
   previews is how much mail MATCHES, and never a promise of how much will move.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Rows examined per transaction.
 *
 * The same 100 as `KICKSTART_BATCH` and `SENSITIVE_RESCREEN_BATCH`, and for the same reason:
 * {@link recordChange} takes the account's `account_sync_state` row lock for the length of its
 * transaction, so a whole-backlog transaction would stall every API write for that account
 * while the pass drained. 100 rows is a few milliseconds of lock.
 */
export const RULE_RETRO_BATCH = 100;

/**
 * Desired-state rows this pass may create for ONE ACCOUNT in ONE worker cycle.
 *
 * THE REASON IS THE RECONCILER, NOT THIS PASS — see the header. `reconcileFolders` walks an
 * unbounded `listPendingFolderStates` serially, one IMAP move per row, inside the sync cycle,
 * and `beat()` is the last statement of that cycle while `leaderStaleMs` is 120 000 ms
 * (`packages/db/src/alerts.ts`). Queue a few hundred moves and the cycle misses its heartbeat,
 * so a user clicking "Reads" on a big sender pages an operator. Queue four thousand and one
 * non-`MessageGoneError` failure aborts that mailbox's reconcile every cycle for ever.
 *
 * This is therefore a number that should be MEASURED and tuned, not defended. It is separate
 * from {@link RULE_RETRO_BATCH} deliberately: that one is about a database lock, this one is
 * about how much physical mail movement one poll interval can absorb.
 */
export const RULE_RETRO_WRITES_PER_CYCLE = 100;

/**
 * Pages one rule may walk in one cycle before the pass gives up and says so.
 *
 * A bound and not a `while (true)`. Termination here is the CURSOR and not an empty page — a
 * candidate the router declines to move STAYS a candidate — so a paging bug would otherwise be
 * an unbounded loop against the live database rather than one warning line.
 */
export const RULE_RETRO_MAX_PAGES = 500;

export interface RuleRetroDeps {
  /** Scope to ONE account — the worker loops its served accounts. Omitted ⇒ every account. */
  accountId?: string;
  log?: Logger;
  /** Test seam. Default {@link RULE_RETRO_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link RULE_RETRO_WRITES_PER_CYCLE}. */
  writesPerCycle?: number;
  /** Test seam. Default {@link RULE_RETRO_MAX_PAGES}. */
  maxPages?: number;
  /**
   * Re-run a rule whose `retro_done_at` is already stamped — EVIDENCE, not a repair.
   *
   * The pass is idempotent WITHOUT the marker (a message it has moved is desired into the
   * destination and is no longer a candidate), and this flag exists so that claim can be
   * exercised rather than asserted: `rule-retro.pg.test.ts` re-runs a finished rule with `force`
   * and requires ZERO writes. It is deliberately not a "re-apply everything" switch — the
   * candidate query is unchanged by it, and neither is the cursor.
   */
  force?: boolean;
  /**
   * The authserv-ids a MAILBOX's own provider signs `Authentication-Results` with — per mailbox,
   * because one account's mailboxes can sit at different providers and trust is a fact about the
   * server that holds the mailbox, never about this deployment. Production passes
   * `adapters/drizzle-repo.ts#mailboxProviderAuthservIds`; the pass resolves each mailbox once
   * per run and caches.
   *
   * REQUIRED — this used to be `trustedAuthservIds?: ReadonlySet<string>` defaulting to the
   * empty set, which is the exact shape that left the forged-`From` demotion inert at every
   * production site: for this input the absent-config default IS the dangerous branch (empty ⇒
   * every verdict `"unavailable"` ⇒ the sender's own claim decides). A caller that has genuinely
   * decided to trust nothing types `async () => NO_TRUSTED_AUTHSERV_IDS`.
   */
  trustedAuthservIdsFor: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>;
}

export interface RuleRetroResult {
  /** Owed rules this pass touched. */
  rules: number;
  /** Candidate rows examined. */
  examined: number;
  /** Rows whose desired folder changed. */
  moved: number;
  /** Rows re-evaluation left where they were — a deny rule, or already there. */
  kept: number;
  /** Rules whose backlog was finished and stamped `retro_done_at`. */
  completed: number;
  /** True ⇒ the per-cycle write budget ran out; the rest resumes next cycle. */
  capped: boolean;
}

/** One candidate, carrying everything `evaluateRules` reads — all of it from disk. */
interface RetroRow {
  messageId: string;
  /** Which mailbox holds it — the key the per-mailbox authserv trust is resolved under. */
  mailboxId: string;
  fromAddress: string;
  subject: string;
  /**
   * `message_bodies.text`, or `""` where no body row exists (mail 0052). The haystack a rule's
   * `body_contains` term is matched against — the byte-identical string ingest matched, because
   * the pipeline stores `NormalizedMessage.textBody` into that column. `""` satisfies no term,
   * so a body rule declines to fire on a body-less row and the mail stays put: fail-closed for
   * a narrowing conjunct, and the honest answer for a body this pass cannot read.
   */
  bodyText: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  desiredFolder: string;
}

/** The owed rule, as read under its own row lock. */
interface OwedRule {
  id: string;
  accountId: string;
  kind: string;
  match: string;
  destination: string;
  cursor: string | null;
}

/**
 * THE PASS. Per account: find the rules whose retroactive apply is owed, and walk each one's
 * backlog until the cycle's write budget is spent.
 *
 * Pure and hermetic — a db/tx handle, a clock and a logger — so a test drives it against
 * PGlite with no worker, no lease and no network. The transactional claims that PGlite cannot
 * see (`FOR UPDATE`, two concurrent drivers, the gap-free seq) live in `rule-retro.pg.test.ts`
 * against real Postgres, because an embedded database cannot exercise them.
 */
export async function ruleRetroPass(
  db: Tx, deps: RuleRetroDeps, now: Date = new Date(),
): Promise<RuleRetroResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? RULE_RETRO_BATCH;
  const budget = deps.writesPerCycle ?? RULE_RETRO_WRITES_PER_CYCLE;
  const maxPages = deps.maxPages ?? RULE_RETRO_MAX_PAGES;
  // Per-mailbox authserv trust, resolved at most once per mailbox per run. The value is
  // configuration (which provider serves the mailbox), not row state, so caching across pages
  // cannot go stale within a pass. The read is issued on the OUTER handle — it joins no page
  // transaction and locks nothing a page holds; only its RESULT is used inside one.
  const authservCache = new Map<string, ReadonlySet<string>>();
  const trustFor = async (mailboxId: string): Promise<ReadonlySet<string>> => {
    const hit = authservCache.get(mailboxId);
    if (hit) return hit;
    const ids = await deps.trustedAuthservIdsFor(db, mailboxId);
    authservCache.set(mailboxId, ids);
    return ids;
  };

  // The owed set. `retro_requested_at IS NOT NULL AND retro_done_at IS NULL` is the ONE
  // definition of owed work — there is no queue and no second source of truth — and
  // `rules_retro_owed_idx` is the partial index that makes this probe free in the steady state.
  // `enabled` is re-checked inside every page transaction as well: a user may revoke mid-run.
  const owedFilters = [
    isNotNull(rulesTbl.retroRequestedAt),
    eq(rulesTbl.enabled, true),
    ...(deps.force ? [] : [isNull(rulesTbl.retroDoneAt)]),
    ...(deps.accountId ? [eq(rulesTbl.accountId, deps.accountId)] : []),
    /* ── A RULE THIS INSTALL CANNOT ACT ON STAYS OWED. IT IS NOT "DONE" ──────────────────────
     *
     * The owed probe is per ACCOUNT and the candidate query below is per MAILBOX. Without this
     * clause, an account whose mailbox this install does not organize selected the rule, walked
     * ZERO candidates (the `organizer_role` gate excluded every one), read a short page as the end
     * of the backlog, and stamped `retro_done_at`. Promoting the install afterwards honoured
     * nothing, because nothing was owed any more.
     *
     * What that costs is a PRESS. `retro_requested_at` is set only because a person ticked "apply
     * to existing mail"; consuming it while we could not look is a completion claim about work
     * that never happened, and the person is told nothing. It swallowed presses for `'us'` rows
     * long before `'peer'` existed — but `'peer'` is what makes it load-bearing, because this pass
     * is the only route back for mail a READER adopted, so a consumed press is the difference
     * between recoverable and not.
     *
     * **This corrects a stated expectation, and the correction is written here so the next reader
     * does not re-derive it:** an owed rule was believed to "stay owed because the
     * `organizer_role` gate holds it and fire on promotion". The gate holds the CANDIDATES; it
     * never held the rule. Now the rule stays owed because it is never SELECTED — and being
     * unselected is the only state from which a later promotion can still honour it.
     *
     * EXISTS over the account's mailboxes, not NOT EXISTS over one: an account can hold several,
     * and one organized mailbox is enough to make the walk meaningful. The per-mailbox gate below
     * is unchanged and still decides, row by row, which of them may actually be touched.
     */
    sql`exists (
      select 1 from ${mailboxes} mb
       where mb.account_id = ${rulesTbl.accountId}
         and mb.status <> 'disabled'
         and mb.organizer_role = 'organizer'
    )`,
  ];
  const owed = await db.select({ id: rulesTbl.id, accountId: rulesTbl.accountId })
    .from(rulesTbl).where(and(...owedFilters))
    .orderBy(asc(rulesTbl.createdAt), asc(rulesTbl.id));

  const result: RuleRetroResult = {
    rules: 0, examined: 0, moved: 0, kept: 0, completed: 0, capped: false,
  };
  if (owed.length === 0) return result;

  // ── THE ACCOUNT'S OWN ADDRESSES — CACHED PER ACCOUNT, AND THAT ONE IS DELIBERATE ─────────────
  //
  // These shape the candidate QUERY (`ownAddresses` is what "not from myself" excludes) and change
  // only when a mailbox is connected or removed. Cached per account rather than per run because
  // `deps.accountId` may be omitted (the CLI/test shape), so one run can walk several accounts and
  // one account's address set must never decide another's.
  //
  // **`rules` and `knownSenders` used to be cached here too, and that was the defect.** The comment
  // that stood in this place claimed *"this pass is the only writer of the state it decides
  // against, so re-reading per page would cost two queries per hundred rows to observe a change
  // that cannot happen"*. **It can happen and there are six writers**: the API's rule editor
  // (`routes/rules.ts`) writes `rules`, and the `contacts` set behind `knownSenders` is written by
  // the Screener's decide path (`screener-service.ts`), the Junk window (`junk-window.ts`), the
  // profile import, the consent seed and the ingest pipeline's own contact learning. The reads moved
  // INTO the page transaction (see there); this cache holds only what the query shape needs.
  const ownFor = (() => {
    const cache = new Map<string, string[]>();
    return async (accountId: string): Promise<string[]> => {
      const hit = cache.get(accountId);
      if (hit) return hit;
      const ownRows = await db.select({ address: mailboxes.address }).from(mailboxes)
        .where(eq(mailboxes.accountId, accountId));
      const fresh = ownRows.map((r) => r.address.toLowerCase());
      cache.set(accountId, fresh);
      return fresh;
    };
  })();

  for (const row of owed) {
    if (result.moved >= budget) { result.capped = true; break; }
    result.rules++;
    const own = await ownFor(row.accountId);

    let pages = 0;
    let exhausted = false;
    /**
     * The fence as this pass last left it — `null` until a page commits one.
     *
     * Read from the rule row INSIDE each page transaction rather than remembered from the owed
     * probe, so it is the value the walk actually resumed from even when another driver moved it
     * between the probe and the page. The completion decision compares against it; see there.
     */
    let walkedTo: string | null = null;
    for (; pages < maxPages; pages++) {
      if (result.moved >= budget) { result.capped = true; break; }

      const page = await db.transaction(async (tx) => {
        // ── THE RULE ROW IS THE SERIALIZATION POINT, AND IT IS TAKEN FIRST ─────────────────
        //
        // Two drivers (the worker cycle, and a second worker mid-failover) would otherwise both
        // read the same cursor, compute the same page and both write it. Re-reading the rule
        // FOR UPDATE inside the page transaction makes the loser block here, wake with the
        // WINNER's committed cursor, and page forward from it — so a message is examined once
        // and `change_log` gains one `move` and not two.
        //
        // It is also the revoke check: a rule the user disabled or deleted mid-run stops the
        // pass at the next page boundary rather than finishing work they have withdrawn.
        // Locking the rule BEFORE `folder_state` is a consistent order — no path in this tree
        // takes `folder_state` before `rules` — and both are taken before the
        // `account_sync_state` counter `recordChange` locks, which is the order every other
        // writer uses.
        const [live] = await tx.select({
          id: rulesTbl.id, accountId: rulesTbl.accountId, kind: rulesTbl.kind,
          match: rulesTbl.match, destination: rulesTbl.destination, cursor: rulesTbl.retroCursor,
        }).from(rulesTbl)
          .where(and(
            eq(rulesTbl.id, row.id),
            eq(rulesTbl.enabled, true),
            isNotNull(rulesTbl.retroRequestedAt),
            ...(deps.force ? [] : [isNull(rulesTbl.retroDoneAt)]),
          ))
          .limit(1)
          .for("update");
        if (!live) {
          return { gone: true, rows: 0, moved: 0, kept: 0, cursor: null, resumedFrom: null, done: false };
        }

        const rule = live as OwedRule;

        // ── THE KNOWLEDGE THE DECISION RESTS ON, RE-ASKED PER PAGE ───────────────────────────
        //
        // The pass already re-reads its OWN rule `FOR UPDATE` above, so its own half of the decision
        // was always fresh — which is exactly what made the cached half hard to see. `evaluateRules`
        // below reads the account's WHOLE rule set and its known senders, and those were cached for
        // the life of the run (see the block above the loop for the six writers that falsified the
        // comment which justified it). A user who deleted a DIFFERENT rule, or screened a sender in,
        // during a long retro walk had every later page decided under the rule set as it stood when
        // the run began.
        //
        // Bound to `tx` and taken after the rule row is locked, so the knowledge is exactly as fresh
        // as the rule that admitted this page and the candidates selected below it. The lock order is
        // unchanged: these are plain reads of `rules`/`contacts`, no row lock, taken between the
        // owned-rule lock and `folder_state`.
        // `carryDialect`, not the bare handle: a driver's transaction object is a fresh object and
        // does not inherit the connection's dialect brand, so a repository built straight from `tx`
        // refuses on its first locking statement.
        const pageRepo = makeDrizzleRepo(
          carryDialect(db, tx) as unknown as Parameters<typeof makeDrizzleRepo>[0],
        );
        const rules: Rule[] = await pageRepo.listRules(rule.accountId);
        const known: ReadonlySet<string> = await pageRepo.knownSenders(rule.accountId);

        const candidates = await selectCandidates(tx, {
          rule, ownAddresses: own, limit: batch, afterId: rule.cursor,
        });

        let moved = 0;
        let kept = 0;
        let lastId: string | null = null;
        let capped = false;

        for (const c of candidates) {
          // The budget is enforced PER ROW, not per page, so the cap is exact and the cursor
          // resumes at the last row this pass actually decided about — never past one it skipped.
          if (result.moved + moved >= budget) { capped = true; break; }

          const decision = evaluateRules({
            msg: asRuleInput(c), rules, knownSenders: known,
            auth: authVerdictFromHeaders(c.headers, c.fromAddress, await trustFor(c.mailboxId)),
            // LENIENT here, and deliberately: this pass acts ONLY on `source === "rule"` (below),
            // so the `people_only` demotion — which answers `source: "policy"` — could never change
            // an outcome it does not read. The automated-mail axis is the ohbox-tidy pass's job,
            // not this one, and threading a per-account posture through a MULTI-account run would be
            // a value with no consumer. See the `evaluateRules` filter at the `source !== "rule"`
            // guard below.
            ohboxPolicy: DEFAULT_OHBOX_POLICY,
          });
          lastId = c.messageId;

          // ONLY a rule answer moves already-filed mail. `screener` means the gate has not been
          // passed and re-screening old mail is not this pass's business; `header` and `unclear`
          // are placement refinements for a sender already past the gate, and relocating years of
          // mail on a heuristic is exactly the over-reach `sensitive-rescreen` refuses. The
          // destination is the ROUTER's, not the new rule's: a higher-priority deny rule still
          // wins, and a message it wins for is left alone.
          // `destination` is `Destination | null` on the DTO — `null` is the `unclear` answer —
          // and the null check is kept EXPLICIT rather than leaned on `source === "rule"`,
          // which happens to imply it today. The two are separate fields and a narrowing that
          // depends on their agreeing is one refactor away from filing mail into `null`.
          const to = decision.destination;
          if (decision.source !== "rule" || to === null || to === c.desiredFolder) {
            kept++;
            continue;
          }

          await upsertDesired(tx, c, to, now);
          // `meta` carries the TRUE previous desired folder, exactly as `sensitive-rescreen`
          // does. That single field is what makes a later undo possible without this pass
          // writing anything extra: the origin is durably recorded per message, in the journal
          // the client already reads. The physical move's own inverse is written by
          // `reconcileFolders` (`recordAudit("reconcile.move", …)`) one layer down.
          await recordChange(tx, {
            accountId: rule.accountId, entityType: "message", entityId: c.messageId, op: "move",
            meta: { from: c.desiredFolder, to },
          });
          moved++;
        }

        // Cursor and counter advance in the SAME transaction as the writes, so a crash can
        // neither lose a page's work nor replay it. `retro_moved` is `+=` rather than a computed
        // total: the pass is resumable, and a total would need a second scan to be honest.
        if (lastId !== null) {
          /* ── THE CURSOR ADVANCE IS A COMPARE-AND-SET; THE COUNTER IS NOT ────────────────
           *
           * A promotion clears `retro_cursor` for every owed rule on the account in the same
           * transaction as the role flip (`mailboxes.ts#clearOwedRetroFences`), because a fence
           * written while a mailbox was a READER never offered a single row of it. This page must
           * not put that fence back: it advances the cursor only while the value is still the one
           * this page transaction READ under the rule's own `FOR UPDATE`, so a reset that landed
           * in between wins and the walk starts over next cycle — which is what the reset means.
           *
           * `is not distinct from` and not `=`, because the resting value is NULL (a first page)
           * and `null = null` is null, which would refuse every first page's advance.
           *
           * ── AND IT CANNOT FIRE TODAY, WHICH IS WRITTEN DOWN RATHER THAN LEFT TO BE READ AS A
           *    GUARANTEE ─────────────────────────────────────────────────────────────────────
           *
           * Measured: deleting this `case` and writing `retro_cursor = lastId` leaves all 42 cases
           * of `rule-retro.test.ts` green. The reason is the lock taken at the top of this same
           * transaction for a different purpose — the rule row is re-read `FOR UPDATE` as the
           * revoke check — so a reset's `UPDATE` on that row BLOCKS until this page commits and
           * lands after it. The lock already orders them, and the place the lock does NOT reach is
           * the completion decision below, which is why the compare-and-set that CAN be watched
           * fail is the one there.
           *
           * It is kept because the ordering is an accident of where the lock is taken: move this
           * write out of the page transaction, or drop the `FOR UPDATE`, and a reset would be
           * silently overwritten with no test able to say so. What it must not be read as is a
           * defence against a race that exists today — it is the thing that keeps the sentence
           * above true if the structure changes.
           *
           * `retro_moved` is advanced UNCONDITIONALLY: it counts desired-state rows this rule's
           * pass has written, those writes are committed in this transaction, and a reset re-opens
           * the WALK, not the history. One statement, so the two cannot disagree about the row.
           */
          await tx.update(rulesTbl)
            .set({
              retroCursor: sql`case when ${rulesTbl.retroCursor} is not distinct from ${rule.cursor}
                               then ${lastId}::uuid else ${rulesTbl.retroCursor} end`,
              retroMoved: sql`${rulesTbl.retroMoved} + ${moved}`,
            })
            .where(eq(rulesTbl.id, rule.id));
        }

        return {
          gone: false, rows: candidates.length, moved, kept, cursor: lastId,
          // The fence this page RESUMED from, read under the rule's own lock — the honest
          // starting point for the decision's compare-and-set when this page advanced nothing.
          resumedFrom: rule.cursor,
          // A short page that was not cut short by the budget is the end of the backlog.
          done: !capped && candidates.length < batch,
        };
      });

      if (page.gone) { exhausted = false; break; }
      // What the decision below compares the fence against: the value the pass resumed from when
      // no page advanced it, and the last committed page's own cursor when one did.
      walkedTo = page.cursor ?? page.resumedFrom;
      result.examined += page.rows;
      result.moved += page.moved;
      result.kept += page.kept;
      if (page.done) { exhausted = true; break; }
      if (page.rows === 0) { exhausted = true; break; }
    }

    if (pages >= maxPages) {
      log.warn("rule_retro_truncated", {
        ruleId: row.id, accountId: row.accountId, maxPages,
        reason: "one rule's backlog exceeded a cycle's page bound — `retro_done_at` is NOT " +
          "written, so the next cycle resumes from `retro_cursor`",
      });
      continue;
    }
    if (!exhausted) continue;   // the budget ran out mid-rule; resume next cycle.

    // ── THE MARKER IS WRITTEN LAST, AND `WHERE retro_done_at IS NULL` MAKES IT THE DATABASE'S
    //    ANSWER ────────────────────────────────────────────────────────────────────────────
    //
    // Claiming it first would make a crash permanent: a rule marked applied with most of its
    // mail unmoved and nothing that would ever look again. Written last, a crash re-runs, and
    // re-running is safe because the candidate query is itself the idempotency. The predicate
    // means two drivers finishing at once produce exactly one stamp — same construction, same
    // reason, as `markKickstarted` and `sensitive_rescreen_at`.
    // ── AND IT IS ONE STAMP FOR AN ACCOUNT THAT CAN HOLD SEVERAL MAILBOXES ─────────────────
    //
    // The owed probe is per ACCOUNT (`exists … organizer_role = 'organizer'`, above) and the
    // candidate query is per MAILBOX (`not exists … organizer_role <> 'organizer'`, below), so on
    // an account where this install organizes A and only READS B the two disagree by design: the
    // rule is selected, A's backlog is walked to its end, and B's mail was never a candidate. An
    // unconditional stamp here called that "finished". Promoting B afterwards honoured nothing,
    // because nothing was owed any more — the same swallowed PRESS the `exists` clause above was
    // written for, one mailbox further in.
    //
    // So completion is the COMPLEMENT of the candidate gate, asked of the account's live
    // mailboxes: the backlog is finished only when there is no live mailbox this install does not
    // organize. It is a predicate over the mailboxes and not a second flag, and it is IN THE
    // `WHERE` beside `retro_done_at IS NULL` for that clause's own reason — a mailbox demoted
    // between a read and the stamp would otherwise be stamped over.
    //
    // `status = 'disabled'` is not "live": a disabled mailbox is one nothing will ever reconcile
    // (the candidate query's own argument), so it neither contributes candidates nor holds the
    // press open. `error` IS live — a mailbox that failed a cycle is still ours to organize.
    /* ── ONE STATEMENT, BECAUSE TWO OF THEM COULD DISAGREE ABOUT THE SAME MAILBOX ────────────
     *
     * The stamp and the cursor reset are one decision — *is this backlog finished?* — and they
     * used to be two `UPDATE`s that each asked the mailboxes for themselves. A promotion landing
     * between them answered them differently, and the pair then produced a state neither of them
     * would write alone:
     *
     *   1. the stamp asks: a live mailbox (B) is still outside the walk ⇒ withheld. Right.
     *   2. B is PROMOTED — a lease claim, or somebody pressing "Organize here".
     *   3. the reset asks the same question and now gets `false` ⇒ the cursor is KEPT.
     *
     * The rule is owed with the fence still standing, and `messages.id` is a random uuid, so the
     * next pass walks only the part of B's mail that sorts ABOVE it, calls that the end of the
     * backlog — every mailbox is organized now — and stamps. B's older matching mail is never
     * filed, and nothing anywhere says so. The two writes were each correct; the pair was not.
     *
     * So both fields move in ONE statement, under ONE evaluation of the row: the two `case` arms
     * are computed together for the row being written, so they cannot be answered by different
     * versions of `mailboxes` whatever happens in between — and that holds even when Postgres has
     * to re-check the row against a newer snapshot after a concurrent update, because the whole
     * SET list is re-evaluated together, never one arm at a time. The arms are exhaustive and
     * opposite —
     * finished ⇒ stamp and keep the cursor (it is spent either way); not finished ⇒ leave
     * `retro_done_at` NULL and clear the fence — so there is no third outcome to reason about.
     *
     * `retro_done_at IS NULL` stays in the `WHERE`: it is what makes the stamp the DATABASE's
     * answer when two drivers finish at once, and it is what keeps `force` honest — a re-run of a
     * FINISHED rule matches no row, so it neither re-stamps nor touches the cursor, which the
     * flag's docblock promises by name.
     *
     * ── WHY THE BACKLOG IS ONLY FINISHED WHEN EVERY LIVE MAILBOX IS ORGANIZED HERE ───────────
     *
     * The owed probe is per ACCOUNT (`exists … organizer_role = 'organizer'`, above) and the
     * candidate query is per MAILBOX (`not exists … organizer_role <> 'organizer'`, below), so on
     * an account where this install organizes A and only READS B the two disagree by design: the
     * rule is selected, A's backlog is walked to its end, and B's mail was never a candidate. An
     * unconditional stamp called that "finished", and promoting B afterwards honoured nothing,
     * because nothing was owed any more — the same swallowed PRESS the `exists` clause above was
     * written for, one mailbox further in.
     *
     * Completion is therefore the COMPLEMENT of the candidate gate, asked of the account's live
     * mailboxes, and a predicate over the mailboxes rather than a second flag. `status =
     * 'disabled'` is not "live": a disabled mailbox is one nothing will ever reconcile (the
     * candidate query's own argument), so it neither contributes candidates nor holds the press
     * open. `error` IS live — a mailbox that failed a cycle is still ours to organize.
     *
     * ── AND WHY THE CURSOR COMES BACK WITH THE WITHHELD STAMP ────────────────────────────────
     *
     * Withholding the stamp is only half the repair. `retro_cursor` is the last `messages.id` of
     * the last committed page, and `messages.id` is a random uuid, so the cursor is not a point in
     * time — it is a fence across the id space. B's rows sit on both sides of it, and holding the
     * rule owed with the fence in place would honour the press for whichever of B's messages
     * happen to sort high: not a wrong-looking outcome, just quietly a fraction of the mailbox.
     *
     * Clearing it is not a new state — it is exactly what `RulesService.update` writes when a rule
     * is retargeted (`retro_done_at` and `retro_cursor` both NULL), the common path for a person
     * changing their mind — and re-offering every row is safe because the candidate query is the
     * idempotency: a message this pass has already moved is desired into the destination and is no
     * longer a candidate.
     *
     * WHAT IT COSTS, named rather than discovered: the rows a re-walk re-reads are the ones the
     * router DECLINED to move (a higher-priority deny rule, a message the user triaged), because
     * everything it moved has dropped out of the candidate set. For an account that holds a reader
     * mailbox indefinitely that read repeats every cycle, bounded by `RULE_RETRO_MAX_PAGES` pages.
     * The alternative — remembering which mailboxes have been walked — needs a column, and a
     * freeze fix does not add one.
     */
    /* ── THE STAMP ALSO YIELDS TO A RESET, AND THIS IS THE HALF THE PAGE CAS CANNOT COVER ────
     *
     * The page write above is inside the transaction that holds the rule row `FOR UPDATE`, so a
     * concurrent reset blocks and lands after it. This statement is not: it runs after the loop,
     * outside every transaction, and the whole point of it is that the backlog is finished. If a
     * promotion's reset lands between the last page and here, the walk that just ended is exactly
     * the fenced walk the reset exists to discard — and stamping it would write "finished" over a
     * mailbox this pass never offered a row of.
     *
     * So the stamp arm additionally requires that the fence is still the one this pass left. It is
     * a compare-and-set on the same column the reset writes: `walkedTo` is the cursor as of this
     * pass's last committed page (or the value it started from, when no page advanced it), and a
     * reset makes it distinct. The rule then stays owed with the reset's NULL cursor, and the next
     * cycle walks the whole account from the start and stamps that.
     */
    const outside = aLiveMailboxIsOutsideTheWalk(row.accountId);
    /* ── THE STAMP IS BOUND AS AN ISO STRING WITH A CAST, AND THAT IS NOT COSMETIC ────────────
     *
     * `${now}` inside a raw `sql` fragment binds a JS `Date` with no column to take its type
     * from. `drizzle`'s column-aware path (`set({ retroDoneAt: now })`) knows the column is
     * `timestamptz` and serializes it; a fragment does not, and the real driver then refuses the
     * value outright — `postgres@3`'s `bytes.js`: *The "string" argument must be of type string or
     * an instance of Buffer or ArrayBuffer. Received an instance of Date*.
     *
     * PGlite accepted it, so the whole PGlite suite was green while every pg file that reaches
     * this statement failed (7 of them, in `rule-retro-body.pg` and `rule-retro-subject.pg`). This
     * is the "PGlite green means nothing for transactional code" rule with a different edge: the
     * two backends disagree about PARAMETER SERIALIZATION, not about transactions, and a fragment
     * is where that disagreement becomes reachable.
     *
     * The `null` in the cursor arm needs no cast — it is a literal, and Postgres takes its type
     * from the other arm (`retro_cursor`, uuid).
     */
    const [decided] = await db.update(rulesTbl)
      .set({
        retroDoneAt: sql`case
          when ${outside} then ${rulesTbl.retroDoneAt}
          when ${rulesTbl.retroCursor} is distinct from ${walkedTo === null ? sql`null` : sql`${walkedTo}::uuid`}
            then ${rulesTbl.retroDoneAt}
          else ${now.toISOString()}::timestamptz end`,
        retroCursor: sql`case when ${outside} then null else ${rulesTbl.retroCursor} end`,
      })
      .where(and(eq(rulesTbl.id, row.id), isNull(rulesTbl.retroDoneAt)))
      // The POST-update row, which is the decision itself rather than a re-read of it: a second
      // `select` would be a second snapshot, and this whole block exists because two snapshots of
      // one question can disagree.
      .returning({ doneAt: rulesTbl.retroDoneAt, cursor: rulesTbl.retroCursor });

    if (decided?.doneAt != null) {
      // Counted from the stamp the database actually wrote, not from reaching this line: a rule
      // re-run with `force` is already done and stamps nothing, and two drivers finishing at once
      // produce one stamp between them. `RuleRetroResult.completed` says "finished and stamped".
      result.completed++;
      continue;
    }
    if (decided !== undefined) {
      log.info("rule_retro_owed_pending_mailbox", {
        ruleId: row.id, accountId: row.accountId,
        reason: "the backlog is finished for the mailboxes this install organizes, and a live " +
          "mailbox of the account is not one of them — `retro_done_at` is NOT written and " +
          "`retro_cursor` is cleared, so a promotion re-walks that mailbox's mail from the start",
      });
    }
  }

  if (result.moved > 0 || result.completed > 0) {
    log.info("rule_retro_applied", {
      accountId: deps.accountId ?? null, rules: result.rules, examined: result.examined,
      moved: result.moved, kept: result.kept, completed: result.completed, capped: result.capped,
    });
  }
  return result;
}

/**
 * A LIVE MAILBOX OF THIS ACCOUNT THAT THIS INSTALL DOES NOT ORGANIZE — the exact complement of
 * {@link selectCandidates}' mailbox gate, written once because it is asked twice.
 *
 * The candidate query drops a message whose mailbox is `disabled` OR not `organizer`; this asks
 * whether such a mailbox EXISTS while still being live. `true` therefore means "this pass cannot
 * see all of the account's mail", which is the one fact that decides whether a finished walk is a
 * finished BACKLOG. Written as the negation of the other predicate rather than as its own
 * sentence so an edit to one cannot silently disagree with the other.
 */
function aLiveMailboxIsOutsideTheWalk(accountId: string) {
  return sql`exists (
    select 1 from ${mailboxes} mb
     where mb.account_id = ${accountId}
       and mb.status <> 'disabled'
       and mb.organizer_role <> 'organizer'
  )`;
}

/**
 * ONE page of the mail a rule may reconsider — LOCKED FOR UPDATE, oldest id first.
 *
 * ── WRITTEN FRESH, NOT COPIED, AND THE REASON IS ONE PREDICATE ─────────────────────────────
 *
 * `sensitive-rescreen.ts#selectCandidates` excludes any message whose sender already carries an
 * enabled `rules` row. Copied into THIS pass that predicate excludes everything: the rule this
 * pass exists to apply IS an enabled rules row for exactly that sender or domain. The pass would
 * examine nothing, write nothing, stamp itself complete and report success. It is invisible once
 * it is the second item in a list of five, which is why this query is written from the ruling
 * rather than edited from that one.
 *
 * ── THE CANDIDATE SET ──────────────────────────────────────────────────────────────────────
 *
 *  · the rule's own match, by {@link matchPredicate} — narrowing only; the DECISION is the
 *    router's.
 *  · `folder_state.desired_folder <> rule.destination`. **This is the whole of the idempotency**:
 *    a row this pass has already moved is desired into the destination and drops out, which is
 *    why a second run writes nothing whether or not the marker is set.
 *  · the mailbox is not `disabled`. A disabled mailbox is one Cloud is not organizing — the
 *    lease was lost, or the user left — and nothing will ever reconcile a
 *    pending row written for it. Writing intent there would leave permanent `pending` rows and
 *    make the mailbox-stale signal lie.
 *
 * ── AND THE FIVE THINGS THAT TAKE A MESSAGE BACK OUT OF IT ─────────────────────────────────
 *
 * One rule, stated when this pass was designed: **a message the user has already
 * acted on is not ours to move.**
 *
 *  1. `folder_state.last_set_by` is `'us'` or `'peer'` — a row set `external` is a placement the
 *     user made in their own mail client. This is not a preference: `reconcileFolders` SKIPS
 *     `lastSetBy !== "us"`, so writing over it would be us reverting their hand-filing.
 *     **`'peer'` is admitted here and in no other pass** — another install of this account placed
 *     it and a reader recorded that, and this pass is the only one a person has to press for. The
 *     argument is written out at the candidate predicate below.
 *  2. no `message_states` row in a state other than `none` — reply-later, set-aside, bubbled-up
 *     and muted are the four ways the product lets someone triage, and yanking a message out of a
 *     pile they built is the failure this prevents.
 *  3. no `drafts` row replying to it — they are replying, or have replied, through ohmail.
 *  4. no DECIDED `approvals` row — `status <> 'pending'`, not mere existence: a pending approval
 *     is something WE proposed and they have not answered, so counting it as their intent would
 *     let the AI layer immunise mail from a rule the user just wrote by hand.
 *  5. no message in the same thread from one of the account's own addresses — they replied from
 *     their own client, where no draft of ours is written.
 *
 * READ IS DELIBERATELY NOT ON THAT LIST, on `sensitive-rescreen`'s reasoning: reading is not
 * consent, and the founding report was an Ohbox full of READ mail that should have
 * been filed. Excluding read mail would leave behind precisely what this exists to move.
 *
 * ── AND THE LOCK ───────────────────────────────────────────────────────────────────────────
 *
 * `FOR UPDATE OF folder_state`, `of` the one table and not the whole join: `message_bodies` is on
 * the NULLABLE side of a LEFT JOIN, which Postgres refuses to lock, and locking `messages` would
 * serialize the pass against ordinary ingest for no benefit. Two concurrent runs both block on
 * the same row; the loser re-reads the committed row, finds it already desired into the
 * destination, and drops it. That claim is `rule-retro.pg.test.ts` on real Postgres, because
 * PGlite is single-connection and `FOR UPDATE` there is a no-op that always succeeds.
 */
async function selectCandidates(
  t: Tx,
  opts: { rule: OwedRule; ownAddresses: readonly string[]; limit: number; afterId: string | null },
): Promise<RetroRow[]> {
  const { rule } = opts;
  const filters = [
    eq(messages.accountId, rule.accountId),
    matchPredicate(rule),
    sql`${folderState.desiredFolder} <> ${rule.destination}`,
    // ── A RULE MAY ONLY MOVE MAIL OUT OF A FOLDER ohmail ORGANIZES ───────────────────────────
    //
    // The candidate set was `desired_folder <> rule.destination` and nothing about WHICH folder the
    // message is in, so anything not already at the destination qualified — including the customer's
    // own folders (`Archive`, `Private/Family`, `_archive/Clients/…`, now that those are read)
    // and their **Sent folder**, which has been read since the Sent watch landed. A rule saying
    // "mail from this sender goes to Reads" would therefore have emptied fifteen years of somebody's
    // archive into a newsletter folder, in their real mailbox, on one pass — and, on the Sent side,
    // filed the mail they WROTE under Receipts.
    //
    // An ALLOW-LIST over the frozen six rather than "not in (sent, passive…)", because that is the
    // safe form: a folder nobody has thought about is excluded by default, so the next observed
    // folder does not become a mover's candidate the day it starts being read.
    // `types.ts#isOrganizedFolder` is the same statement in TypeScript.
    //
    // `DESTINATIONS` comes from `@trafficflow/core`, NOT from `@trafficflow/core/adapters/imap`, and
    // that is enforced: `rule-retro.no-imap.test.ts` scans this file's imports and fails on
    // `adapters/imap`. This pass runs beside `reconcileFolders`, which holds the mailbox's adapter and
    // its organizer lease, so a bulk mover that could dial would be a second organizer for one
    // mailbox — the thing `ohmail/_meta`'s lease exists to make impossible. Importing a six-string
    // list from a module that carries `imapflow` is how that guard gets weakened by accident, and it
    // is how this line was first written.
    //
    // The `last_set_by` line below is the second, independent gate, and either one alone is
    // sufficient. Both are here because they fail differently: this one is a property of the FOLDER
    // and holds even for a row some future path writes `'us'`.
    sql`${folderState.desiredFolder} in ${sql`(${sql.join(
      DESTINATIONS.map((f) => sql`${f}`), sql`, `,
    )})`}`,
    /* -- THIS IS THE ONE PASS THAT ADMITS `'peer'`, AND ONLY BECAUSE A PERSON PRESSED ---------
     *
     * `'peer'` is a placement made by ANOTHER install of this same account, in a folder ohmail
     * organizes, recorded by a READER that watched it happen (`pipeline.ts#readerAdoption`). It
     * used to be written `'external'`, which says the person filed it by hand and means "hands
     * off, for ever" — so mail sitting at the gate behind a decision they had already made could
     * never be reached again by the rule they wrote. That is the defect this admits.
     *
     * It is safe HERE and nowhere else because this pass is the only one gated on a PRESS: a rule
     * only becomes owed when its owner asked for it to be applied to mail already on disk
     * (`retro_requested_at`). `ohbox-tidy` and `screener-auto` run unbidden, and admitting `peer`
     * there would make a promotion re-file the other install's placements in bulk — the exact
     * shape the import hold refuses. They stay `'us'`-only, deliberately.
     *
     * `'external'` is still excluded, and that distinction is the whole reason a third value
     * exists rather than a widened `!= 'external'`: a person dragging a message into `INBOX` in
     * Apple Mail arrives at this table looking identical, and their hand still wins.
     *
     * ONE NAMED CONSEQUENCE, unchanged in kind: a rule created WITH retro during a reader window
     * stays owed (the `organizer_role` gate below holds it) and fires on promotion. That is what
     * already happened for `'us'` rows and now also happens for `'peer'` ones. The press was the
     * user's, and the five user-intent exclusions below still apply to every row it touches.
     */
    inArray(folderState.lastSetBy, ["us", "peer"]),
    /* -- THE MAILBOX IS ONE THIS INSTALL STILL ORGANIZES — BOTH HALVES (mail 0083) ----------
     *
     * `status = 'disabled'` was the whole test, and it stopped being sufficient the moment the
     * loser of an organizer lease became a READER instead of a disabled row. A reader is
     * `connected`, so without the second clause this pass took its rows as candidates and wrote
     * `desired_folder` with `last_set_by: 'us'` on a mailbox another install is arranging.
     *
     * The rows are REACHABLE, which is why this is a defect rather than a theoretical one. A
     * reader's own ingest writes `'peer'` (`'external'` before the third value existed), which
     * this pass now admits — but a demoted organizer also keeps its store, and every row it filed
     * while it WAS the organizer is still `'us'`. Both are exactly the rows a new rule's retro
     * pass would re-file, and this clause is what stops it while the install is a reader.
     *
     * The consequence is not merely a queued move. `reconcileFolders` is skipped for a reader, so
     * nothing executes it today — and that is the trap: the intent sits in `folder_state` waiting,
     * and fires in full the instant the install is ever promoted. Mail moved by a decision taken
     * when this install had no right to take it, arriving one handover later.
     *
     * ONE `NOT EXISTS` rather than two, because the two facts are one question about one row and
     * splitting them would let a future edit answer half of it.
     */
    sql`not exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
    // 2 — the user has triaged this message.
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    // 3 — the user is replying, or has replied, through ohmail.
    sql`not exists (
      select 1 from ${drafts} d where d.in_reply_to_message_id = ${messages.id}
    )`,
    // 4 — the user decided on an AI proposal about this message.
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  /* -- 5 — THE USER replied from their own mail client. A MACHINE'S REPLY IS NOT THAT ---------
   *
   * Guarded on a non-empty address list because `in ()` is a syntax error, and skipped for a NULL
   * `thread_id` because an unthreaded message has no conversation to search.
   *
   * `and not autoReplyByUsWhere(...)` for `ohbox-tidy.ts`'s reason, stated there: the five
   * exclusions above are the ways A PERSON has acted on a message, and an automatic reply is the
   * one thing in this table that looks like their action and is not. A rule somebody explicitly
   * pressed retro on would otherwise skip exactly the mail the responder had answered while they
   * were away — the mail most likely to need filing.
   *
   * NARROWING only: a thread with a reply the person actually wrote is excluded as before.
   */
  if (opts.ownAddresses.length > 0) {
    filters.push(sql`not exists (
      select 1 from ${messages} sent
       where sent.account_id = ${messages.accountId}
         and sent.thread_id = ${messages.threadId}
         and ${messages.threadId} is not null
         and lower(sent.from_address) in ${sql`(${sql.join(opts.ownAddresses.map((a) => sql`${a}`), sql`, `)})`}
         and not ${autoReplyByUsWhere(dialect(t), {
           accountId: sql`sent.account_id`,
           id: sql`sent.id`,
           fromAddress: sql`sent.from_address`,
           messageIdHeader: sql`sent.message_id_header`,
         })}
    )`);
  }
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));

  const rows = await t.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    desiredFolder: folderState.desiredFolder,
    headers: messageBodies.headers,
    // The body text rides the join `headers` already pays for (mail 0052). NULL on the LEFT
    // JOIN's empty side, `""` downstream — see `RetroRow.bodyText`.
    bodyText: messageBodies.text,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit)
    .for("update", { of: folderState });

  return rows.map((r) => ({
    messageId: r.messageId,
    mailboxId: r.mailboxId,
    fromAddress: r.fromAddress,
    subject: r.subject,
    bodyText: r.bodyText ?? "",
    headers: (r.headers as Record<string, string[]> | null) ?? {},
    observedFolder: r.observedFolder,
    desiredFolder: r.desiredFolder,
  }));
}

/**
 * Whose mail this rule is about, in SQL, written to hit the indexes 0034 adds.
 *
 * `sender` is an equality on `lower(from_address)` — `messages_account_from_addr_idx`.
 *
 * `domain` is an equality on the FIRST-`@` domain — `messages_account_from_domain_idx` — and
 * never `like '%@corp.com'`, which can use no index AND also matches `evil-corp.com`. First-`@`
 * and not `split_part(…, '@', 2)`: the two disagree on an address holding two `@`, and this pass
 * moves the mail a sheet has already previewed with the client's `domainOf`, which is first-`@`.
 * The same expression is what `screener-service#heldRowsForDomain` uses, so the set a rule MOVES
 * and the set it is understood to COVER are computed the same way.
 *
 * A `header` rule reaches here as a predicate that matches NOTHING, deliberately: no surface can
 * compose one (`rule_create` has no `header` member) and applying one retroactively would mean
 * re-reading stored headers under a matcher `evaluateRules` owns. Such a rule's retro request
 * therefore completes immediately having moved nothing, which is honest — rather than silently
 * matching every message, which is what an omitted arm would have done.
 */
function matchPredicate(rule: OwedRule) {
  const match = rule.match.trim().toLowerCase();
  if (match === "") return sql`false`;
  if (rule.kind === "sender") return sql`lower(${messages.fromAddress}) = ${match}`;
  if (rule.kind === "domain") {
    return sql`substring(lower(${messages.fromAddress}) from position('@' in lower(${messages.fromAddress})) + 1) = ${match}`;
  }
  return sql`false`;
}

/**
 * Write the INTENT and nothing else: the new desired folder, observed untouched.
 *
 * `reconcile_status` is derived here rather than passed in, exactly as `upsertFolderState`
 * derives it, so a row can never claim a convergence it does not have: desired ≠ observed ⇒
 * `pending`, and `pending` is what makes the worker's reconciler pick it up. `conflict` is reset
 * for the same reason the folder reconciler resets it — this is a fresh statement of where the
 * message belongs.
 */
async function upsertDesired(t: Tx, row: RetroRow, destination: string, now: Date): Promise<void> {
  const reconcileStatus = destination === row.observedFolder ? "reconciled" : "pending";
  await t.insert(folderState).values({
    messageId: row.messageId, desiredFolder: destination, observedFolder: row.observedFolder,
    lastSetBy: "us", reconcileStatus, conflict: false,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    set: {
      desiredFolder: destination, observedFolder: row.observedFolder, lastSetBy: "us",
      reconcileStatus, conflict: false, updatedAt: now,
    },
  });
}

/**
 * The persisted row in the shape `evaluateRules` reads — and NOTHING else is invented.
 *
 * The rules layer looks at exactly four things: the sender, the subject, the headers and — since
 * `body_contains` (mail 0052) — the plain text, and all four are already on disk. So this pass
 * opens no IMAP connection and re-parses no MIME: `textBody` is `message_bodies.text` read back,
 * which is the byte-identical string ingest matched, and `""` where no body row exists (a body
 * rule then declines to fire — fail-closed for a narrowing conjunct). `htmlBody` stays empty
 * because no rule reads it; if one ever does, this function is where that becomes a visible lie
 * rather than a silent one. Deliberately identical in shape to the sibling passes' `asRuleInput`
 * (`ohbox-tidy.ts`, `sensitive-rescreen.ts`), so the passes cannot come to disagree about what a
 * stored message looks like to the router.
 */
function asRuleInput(row: RetroRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [],
    cc: [],
    date: null,
    headers: row.headers,
    textBody: row.bodyText,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}
