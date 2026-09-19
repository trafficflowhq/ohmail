import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  approvals, auditAction, auditLog, autoReplyByUsWhere, drafts, folderState, mailboxes, messageBodies,
  messageStates, messages, recordChange, rules as rulesTbl, type Tx,
} from "@trafficflow/db";
import {
  DEFAULT_OHBOX_POLICY, DESTINATIONS, authVerdictFromHeaders, evaluateRules,
  silentLogger, type Destination, type Logger, type NormalizedMessage, type Rule,
} from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { carryDialect, dialect } from "@trafficflow/db/dialect";

/* APPLYING A NEW RULE TO MAIL ALREADY FILED — writes desired-state intent, never opens IMAP.
   The set is every message the mirror holds (`/sync` replays `change_log` from seq 0 in
   `sync-service.ts`; `Engine.drain` loops until `hasMore`), but instead of one
   `POST /messages/:id/move` per match from the browser (`sender-screening.ts#planScreeningChange`) —
   which serializes `account_sync_state` and strands the tail on tab close — this worker pass writes
   `desired_folder` + a `move` and stops. `reconcileFolders` (`apps/worker/src/sync.ts`) is the only
   crash-safe mover and holds the lease (a second mover = two organizers; `rule-retro.no-imap.test.ts`
   fails on an IMAP client). `RULE_RETRO_WRITES_PER_CYCLE` caps creation/cycle because `reconcileFolders`
   walks an unbounded `listPendingFolderStates` and can miss `beat()`/`leaderStaleMs`; the DECISION is
   `evaluateRules` (re-evaluate, never invert, as `sensitive-rescreen.ts`), narrowed by indexes 0034. */

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
 * The screening gate, named once. Spelled here rather than imported from the screener service,
 * which this pass may not reach: a bulk mover that can pull a service's import graph in is how an
 * IMAP dialer arrives (`rule-retro.no-imap.test.ts`). The `Destination` annotation is what keeps
 * the spelling honest — a folder outside the organized six does not compile.
 */
const SCREENER_GATE: Destination = "ohmail/Screener";

/**
 * IS THIS WALK THE RELEASE PRESS, OR AN ORDINARY RETRO?
 *
 * The press ("N held messages from senders you already decided") writes `release_held_at` and
 * `retro_requested_at` in ONE statement at ONE instant, so equal values mean the last thing asked
 * of this rule was that press and nothing has asked since. A rule edited afterwards with *apply to
 * existing mail* moves `retro_requested_at` forward and the two part company.
 *
 * It decides TWO things at once in {@link selectCandidates}, and they belong together:
 *
 *  · the WIDENING — `'external'` joins the candidates, because a placement recorded as a hand file
 *    is exactly what the person pressed to reconsider;
 *  · the NARROWING — the walk touches ONLY mail still settled AT THE GATE.
 *
 * The narrowing is what makes the press honest, and it was added after measuring the opposite: a
 * bare re-arm re-opened the rule's WHOLE backlog, so pressing "release 1 held message" also re-filed
 * a `'peer'` message sitting in Reads that the screen had never counted. The number a person is
 * shown is the number that moves.
 */
function isReleaseRun(rule: OwedRule): boolean {
  return rule.releaseHeldAt !== null
    && rule.retroRequestedAt !== null
    && rule.releaseHeldAt.getTime() === rule.retroRequestedAt.getTime();
}

/**
 * Desired-state rows this pass may create for ONE ACCOUNT in ONE worker cycle.
 *
 * The bound is the RECONCILER, not this pass: `reconcileFolders` walks an unbounded
 * `listPendingFolderStates` serially (one IMAP move/row) inside the cycle, and `beat()` is its last
 * statement while `leaderStaleMs` is 120000 ms (`packages/db/src/alerts.ts`) — a few hundred queued
 * moves miss the heartbeat, and one non-`MessageGoneError` failure aborts reconcile every cycle.
 * MEASURE and tune. Separate from {@link RULE_RETRO_BATCH} (a database lock) — this is how much
 * physical mail movement one poll interval can absorb.
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
   * The authserv-ids a MAILBOX's provider signs `Authentication-Results` with — per mailbox, since
   * one account's mailboxes can sit at different providers (production:
   * `adapters/drizzle-repo.ts#mailboxProviderAuthservIds`, resolved once per run and cached).
   * REQUIRED, not `trustedAuthservIds?: ReadonlySet<string>` defaulting to empty: for this input the
   * absent-config default IS the dangerous branch (empty ⇒ every verdict `"unavailable"` ⇒ the
   * sender's own `From` claim decides, leaving the forged-`From` demotion inert). A caller that has
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
  /**
   * WHEN THE OWNER PRESSED TO RELEASE MAIL THIS RULE NEVER REACHED — `rules.release_held_at`.
   *
   * NULL for every rule nobody has pressed, which is almost all of them. Read in exactly one
   * place ({@link selectCandidates}), for one widening and one narrowing. It is read fresh under
   * the rule's own lock per page, so a press mid-walk takes effect at the next page and a rule is
   * never walked against a stale licence.
   */
  releaseHeldAt: Date | null;
  /**
   * `rules.retro_requested_at` — carried ONLY to tell a RELEASE run from an ordinary one.
   *
   * The press writes this and {@link releaseHeldAt} in one statement at one instant, so the two
   * being EQUAL means "the last thing asked of this rule was the release press, and nothing has
   * asked since". Any ordinary re-arm — a rule edited with *apply to existing mail* — moves this
   * forward and leaves the licence behind, which is exactly when the narrowing must lift.
   */
  retroRequestedAt: Date | null;
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
    /* A RULE THIS INSTALL CANNOT ACT ON STAYS OWED — it is not "done".
     *
     * The owed probe is per ACCOUNT; the candidate query is per MAILBOX. Without this clause an
     * account whose mailbox this install does not organize selected the rule, walked zero candidates
     * (the `organizer_role` gate excluded every one), and stamped `retro_done_at` — swallowing the
     * press a person made via `retro_requested_at`, which for `'peer'` rows (mail a READER adopted)
     * is the only route back. The rule stays owed by never being SELECTED, the one state a later
     * promotion can still honour. EXISTS over the account's mailboxes (one organized mailbox makes
     * the walk meaningful); the per-mailbox gate below still decides row by row.
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

  // THE ACCOUNT'S OWN ADDRESSES — cached per ACCOUNT deliberately. They shape the candidate query
  // (`ownAddresses` = what "not from myself" excludes) and change only on connect/remove; per account
  // because `deps.accountId` may be omitted (CLI/test), so one run can walk several accounts and one
  // account's set must never decide another's. `rules` and `knownSenders` are NOT cached here: they
  // have six writers — the API rule editor (`routes/rules.ts`), the Screener decide path
  // (`screener-service.ts`), the Junk window (`junk-window.ts`), the profile import, the consent seed
  // and the ingest pipeline's contact learning — so their reads moved INTO the page transaction.
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
        // THE RULE ROW IS THE SERIALIZATION POINT, TAKEN FIRST. Re-reading the rule `FOR UPDATE`
        // inside the page transaction makes a second driver (worker cycle vs failover) block, wake
        // with the winner's committed cursor and page forward — so `change_log` gains one `move`, not
        // two. It is also the revoke check (a disabled/deleted rule stops at the next page boundary).
        // Lock order is consistent: `rules` before `folder_state`, both before the
        // `account_sync_state` counter `recordChange` takes — the order every other writer uses.
        const [live] = await tx.select({
          id: rulesTbl.id, accountId: rulesTbl.accountId, kind: rulesTbl.kind,
          match: rulesTbl.match, destination: rulesTbl.destination, cursor: rulesTbl.retroCursor,
          releaseHeldAt: rulesTbl.releaseHeldAt, retroRequestedAt: rulesTbl.retroRequestedAt,
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

        // THE KNOWLEDGE THE DECISION RESTS ON, RE-ASKED PER PAGE. `evaluateRules` below reads the
        // account's WHOLE rule set and known senders; these were once cached for the run (see the
        // six writers above), so a user deleting a different rule or screening a sender in mid-walk
        // had later pages decided under a stale set. Bound to `tx`, taken after the owned-rule lock
        // and before `folder_state` (plain reads of `rules`/`contacts`, no row lock). Use
        // `carryDialect`, not the bare handle: a `tx` object lacks the connection's dialect brand, so
        // a repo built straight from `tx` refuses its first locking statement.
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
          // The undo the account is owed, in the record a person can be shown — the same row
          // `ohbox-tidy` and `screener-auto` write, because this is the same act: a machine moved
          // mail nobody placed message by message. `ruleId` is the CAUSE, so "which press moved
          // this?" is answerable; the change row above is cause-less and indistinguishable from a
          // hand move. The physical move's own inverse stays `reconcileFolders`' to write.
          await tx.insert(auditLog).values({
            accountId: rule.accountId, action: auditAction("rule_retro_move"),
            payload: {
              mailboxId: c.mailboxId, messageId: c.messageId,
              from: c.desiredFolder, to, ruleId: rule.id,
            },
            inverse: { messageId: c.messageId, from: to, to: c.desiredFolder },
          });
          moved++;
        }

        // Cursor and counter advance in the SAME transaction as the writes, so a crash can
        // neither lose a page's work nor replay it. `retro_moved` is `+=` rather than a computed
        // total: the pass is resumable, and a total would need a second scan to be honest.
        if (lastId !== null) {
          /* THE CURSOR ADVANCE IS A COMPARE-AND-SET; THE COUNTER IS NOT.
           * A promotion clears `retro_cursor` for every owed rule in the role-flip transaction
           * (`mailboxes.ts#clearOwedRetroFences`); this page must not put a stale fence back, so it
           * advances only while the value is still the one it READ under the rule's `FOR UPDATE`
           * (`is not distinct from`, not `=`, since the resting value is NULL). It cannot fire today
           * (deleting the `case` leaves all 42 cases of `rule-retro.test.ts` green: the rule-row lock
           * orders a reset after this commit) — kept because that ordering is an accident of where the
           * lock sits. `retro_moved` advances UNCONDITIONALLY in the same statement (it counts written
           * rows; a reset re-opens the WALK, not the history), so the two cannot disagree.
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

    // THE MARKER IS WRITTEN LAST, `WHERE retro_done_at IS NULL` — the database's answer when two
    // drivers finish at once (same construction as `markKickstarted`, `sensitive_rescreen_at`);
    // claiming it first would make a crash permanent, and re-running is safe because the candidate
    // query is the idempotency. ONE stamp for an account that can hold several mailboxes: the owed
    // probe is per ACCOUNT (`organizer_role = 'organizer'`) and the candidate query per MAILBOX
    // (`organizer_role <> 'organizer'`), so completion is the COMPLEMENT of the candidate gate over
    // the account's LIVE mailboxes — a predicate, in the `WHERE`, not a second flag. `status =
    // 'disabled'` is not "live" (nothing reconciles it); `error` IS live (still ours to organize).
    /* ONE STATEMENT, BECAUSE TWO COULD DISAGREE ABOUT THE SAME MAILBOX.
     * The stamp and the cursor reset are one decision — is this backlog finished? As two `UPDATE`s a
     * promotion landing between them answered them differently (stamp withholds on live mailbox B, B
     * is promoted, reset then keeps the cursor), leaving the rule owed with a fence across the
     * `messages.id` uuid space so B's older mail is never filed. Both fields now move in ONE statement
     * under ONE row evaluation: finished ⇒ stamp and keep the spent cursor; not finished ⇒ leave
     * `retro_done_at` NULL and clear the fence. Completion is the COMPLEMENT of the candidate gate over
     * LIVE mailboxes (`status='disabled'` not live, `error` live). Clearing the cursor is what
     * `RulesService.update` writes on a retarget; re-offering is safe (candidate query = idempotency, bounded by `RULE_RETRO_MAX_PAGES`).
     */
    /* THE STAMP ALSO YIELDS TO A RESET — the half the page CAS cannot cover.
     * The page write holds the rule row `FOR UPDATE`, so a concurrent reset lands after it; this
     * stamp runs after the loop, outside every transaction. If a promotion's reset lands between the
     * last page and here, the walk that just ended is the fenced walk the reset discards, and
     * stamping would write "finished" over a mailbox this pass never offered a row of. So the stamp
     * arm requires the fence still be the one this pass left: a compare-and-set on the reset's column,
     * `walkedTo` (the last committed page's cursor, or the start value). A reset makes it distinct, the
     * rule stays owed with the NULL cursor, and the next cycle walks the whole account and stamps that.
     */
    const outside = aLiveMailboxIsOutsideTheWalk(row.accountId);
    /* THE STAMP IS BOUND AS AN ISO STRING WITH A CAST, NOT COSMETIC.
     * `${now}` inside a raw `sql` fragment binds a JS `Date` with no column to type it;
     * drizzle's column-aware path (`set({ retroDoneAt: now })`) knows the column is `timestamptz`
     * and serializes it, a fragment does not, and `postgres@3`'s `bytes.js` then refuses a `Date`.
     * PGlite accepted it, so the PGlite suite was green while 7 pg files failed
     * (`rule-retro-body.pg`, `rule-retro-subject.pg`) — the two backends disagree on PARAMETER
     * SERIALIZATION, and a fragment is where that becomes reachable. The `null` cursor arm needs no
     * cast: Postgres takes its type from the other arm (`retro_cursor`, uuid).
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
 * ONE page of mail a rule may reconsider — LOCKED FOR UPDATE, oldest id first. Written fresh, not
 * copied from `sensitive-rescreen.ts#selectCandidates` (which excludes senders with an enabled
 * `rules` row — here the rule being applied). Candidates: the rule's {@link matchPredicate}
 * (narrowing; the router decides), `folder_state.desired_folder <> rule.destination` (the
 * idempotency), mailbox not `disabled`. Five user-intent exclusions: `folder_state.last_set_by` in
 * `'us'`/`'peer'` only (`reconcileFolders` skips `!== "us"`); no non-`none` `message_states`; no
 * `drafts` reply; no DECIDED `approvals` (`status <> 'pending'`); no same-thread own-address reply.
 * READ is NOT excluded. `FOR UPDATE OF folder_state` (not `message_bodies`); `rule-retro.pg.test.ts`.
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
    // A RULE MAY ONLY MOVE MAIL OUT OF A FOLDER ohmail ORGANIZES — an ALLOW-LIST over the frozen six,
    // not `desired_folder <> rule.destination` alone, which would empty a customer's `Archive`,
    // `Private/Family`, `_archive/…` or their Sent folder into a rule's destination. Allow-list so a
    // folder nobody has thought about is excluded by default; `types.ts#isOrganizedFolder` is the same
    // statement in TypeScript. `DESTINATIONS` comes from `@trafficflow/core`, NOT
    // `@trafficflow/core/adapters/imap` (enforced by `rule-retro.no-imap.test.ts`): importing the list
    // from the module carrying `imapflow` would drag a dialer in and make this a second organizer. The
    // `last_set_by` line below is the second, independent gate (a property of the FOLDER); either suffices.
    sql`${folderState.desiredFolder} in ${sql`(${sql.join(
      DESTINATIONS.map((f) => sql`${f}`), sql`, `,
    )})`}`,
    /* THE ONE PASS THAT ADMITS `'peer'`, AND ONLY BECAUSE A PERSON PRESSED.
     * `'peer'` is a placement by ANOTHER install of this account in a folder ohmail organizes,
     * recorded by a READER (`pipeline.ts#readerAdoption`). It was once `'external'` ("hands off, for
     * ever"), which stranded mail behind a decision already made. Safe HERE and nowhere else because
     * this pass alone is gated on a PRESS (`retro_requested_at`): `ohbox-tidy` and `screener-auto` run
     * unbidden and stay `'us'`-only, or a promotion would re-file another install's placements in bulk.
     * `'external'` is still excluded — a person dragging a message into INBOX in Apple Mail arrives
     * looking identical, and their hand still wins. The five user-intent exclusions below still apply.
     */
    /* THE PRESS THAT RELEASES MAIL STUCK AT THE GATE — `rules.release_held_at`, and nothing else.
     * Without it this is `'us'`/`'peer'` as above. With it, ONE more shape joins: a row recorded
     * as a hand file that is STILL AT THE GATE and settled there. That is the set a person is
     * shown by name and count before they press ("N held messages from senders you already
     * decided"), and the press is the consent that a placement recorded as theirs may be
     * reconsidered. THREE terms keep the widening narrow, and each excludes a shape that must not
     * move: the folder is the gate, so a hand file anywhere else — an INBOX drag, a customer's own
     * folder — is untouched; OBSERVED is the gate too, so the row is settled there and nothing
     * already in flight is re-decided (spelled as a second equality against the gate rather than
     * `desired = observed`, which says the same thing about these rows and reads to
     * `mover-candidate-allowlist.census.ts` as a folder constraint naming a COLUMN);
     * and the licence is per RULE, so it reaches only the senders that rule claims. The five
     * user-intent exclusions below still apply to every one of them. */
    isReleaseRun(opts.rule)
      ? sql`(${folderState.lastSetBy} in ('us', 'peer', 'external')
             and ${folderState.desiredFolder} = ${SCREENER_GATE}
             and ${folderState.observedFolder} = ${SCREENER_GATE})`
      : inArray(folderState.lastSetBy, ["us", "peer"]),
    /* THE MAILBOX IS ONE THIS INSTALL STILL ORGANIZES — BOTH HALVES (mail 0083).
     * `status = 'disabled'` alone stopped being sufficient once the loser of an organizer lease
     * became a READER (which is `connected`) rather than a disabled row: without the second clause
     * this pass wrote `desired_folder`/`last_set_by: 'us'` on a mailbox another install arranges. The
     * rows are reachable — a demoted organizer keeps every `'us'` row it filed, and a reader's ingest
     * writes `'peer'` (now admitted). `reconcileFolders` is skipped for a reader, so the intent SITS
     * in `folder_state` and fires in full the instant the install is promoted. ONE `NOT EXISTS`, not
     * two, because the two facts are one question about one row.
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
  /* 5 — THE USER replied from their own mail client. A MACHINE'S reply is not that.
   * Guarded on a non-empty address list (`in ()` is a syntax error) and skipped for a NULL
   * `thread_id`. `and not autoReplyByUsWhere(...)`: an automatic reply looks like a person's act
   * and is not, so a pressed retro would otherwise skip exactly the mail the responder answered.
   * NOT ON A RELEASE RUN: those candidates are all gate-settled rows a person was shown by name
   * and count before pressing "Release N" — the press outranks a reply somewhere in the thread
   * (measured: this exclusion kept ALL 57 offered rows on a live account, 101 presses moved zero;
   * `heldReleaseSummary` never applies it, so skipping it here is what makes the number offered
   * the number that moves). The message-level exclusions above bind a release run unchanged.
   */
  if (opts.ownAddresses.length > 0 && !isReleaseRun(rule)) {
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
 * `sender` is an equality on `lower(from_address)` — `messages_account_from_addr_idx`.
 * `domain` is an equality on the FIRST-`@` domain — `messages_account_from_domain_idx` — never
 * `like '%@corp.com'` (no index, and matches `evil-corp.com`) and never `split_part(…, '@', 2)`
 * (differs on a two-`@` address); the same expression `screener-service#heldRowsForDomain` uses, so
 * the set a rule MOVES and the set it COVERS match. A `header` rule reaches here as a predicate that
 * matches NOTHING (no surface composes one — `rule_create` has no `header` member), completing
 * immediately having moved nothing rather than matching every message.
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
 * The persisted row in the shape `evaluateRules` reads — NOTHING else is invented.
 * The rules layer looks at four things: sender, subject, headers, and — since `body_contains`
 * (mail 0052) — the plain text, all already on disk, so this opens no IMAP and re-parses no MIME.
 * `textBody` is `message_bodies.text` read back (the byte-identical string ingest matched), `""`
 * where no body row exists (a body rule then declines — fail-closed for a narrowing conjunct).
 * `htmlBody` stays empty because no rule reads it; if one ever does, this is where that becomes a
 * visible lie. Identical in shape to the sibling `asRuleInput` (`ohbox-tidy.ts`, `sensitive-rescreen.ts`).
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
