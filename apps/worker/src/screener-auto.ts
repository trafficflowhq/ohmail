import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, accountSyncState, approvals, auditLog, changeLog, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, rules as rulesTbl, recordChange,
  readOwnAddresses, ruleNamesSenderSql, weAnsweredThisSenderWhere, type Tx, auditAction,} from "@trafficflow/db";
import {
  STRONG_BULK_FLOOR_VERSION, migrationBulkPlacement, silentLogger,
  type Destination, type Logger, type NormalizedMessage,
} from "@trafficflow/core";
import { dialect } from "@trafficflow/db/dialect";
import { ruleInputOf, upsertDesired } from "./rule-pass.js";

/* SCREENER AUTO-APPLY — file the OBVIOUS bulk out of the Screener when the account opted in. The Screener
 * stays a consent gate for first-contact strangers; this OPT-IN clears the newsletters and receipts a
 * human would wave through. DETERMINISTIC routing only: each held sender is judged by the strong-bulk
 * floor the live engine and Ohbox backfill use (`rules.ts#migrationBulkPlacement`: `List-Unsubscribe`
 * REQUIRED plus a corroborating `List-Id`/`List-Unsubscribe-Post`/`Feedback-ID`/`Precedence: bulk`) and
 * only that bulk is filed to Reads/Receipts. It does NOT call the model and does NOT spend (imports
 * neither). SENSITIVITY (`sensitivity_category`/`no_ai`) is KEPT, one guard in the loop, matching
 * `pipeline.ts:563-567`. Durable and reversible: `folder_state.desired_folder` + a `change_log` move + an
 * `audit_log` inverse; NO `rules` row (grants no admission), never IMAP (organize-in-place). OPT-IN and
 * continuous while on (`screener_auto_apply_at IS NOT NULL`), idempotent, paced by `SCREENER_AUTO_WRITES_PER_CYCLE`. */

/** Where held strangers wait. */
const SCREENER: Destination = "ohmail/Screener";

/**
 * The held set the walk pages over, as the held page spells it: LITERALS, so a partial index on
 * exactly this predicate is provable at plan time whatever the driver does with parameters. The
 * hot-path spec `folder_state_screener_held_floor_idx` carries the same two values, pinned by a test.
 */
export const HELD_PAGE_PREDICATE = { folder: SCREENER, setBy: "us" } as const;
/** The first held page's cursor: below every uuid, so every page is the same statement. */
const BEFORE_EVERY_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Rows examined per transaction — the same 100 as the sibling passes: {@link recordChange} takes the
 * account's `account_sync_state` row lock for the length of its transaction, so a whole-queue
 * transaction would stall every API write for that account.
 */
export const SCREENER_AUTO_BATCH = 100;

/**
 * Moves this pass may CREATE for one account in one cycle. The reason is downstream and identical to
 * `ohbox-tidy.ts`: the reconciler walks pending folder states serially, one IMAP move per row inside
 * the sync cycle, and queuing a few hundred moves at once makes the cycle miss its heartbeat.
 */
export const SCREENER_AUTO_WRITES_PER_CYCLE = 100;

/**
 * Pages one account's queue may walk in one cycle. A bound, not a `while (true)`: a kept row whose
 * floor could not be marked (a sensitive message, a row with no body yet, one an exclusion keeps)
 * STAYS on the page, so termination is the cursor, monotone in the held `folder_state.message_id`,
 * or a short page — never an empty one.
 */
export const SCREENER_AUTO_MAX_PAGES = 500;

/** How long an account may go on incremental walks before a full one — the missed-wake backstop. */
export const SCREENER_AUTO_FULL_EVERY_MS = 60 * 60_000;

/** Marks at another floor version withdrawn per full walk; a bump is re-judged over hours. */
export const SCREENER_FLOOR_WITHDRAW_LIMIT = 1000;

/**
 * Where an account's last COMPLETED walk left it, in worker memory (a restart walks in full). The
 * next walk reads only held rows whose message moved in `change_log` since `headSeq`; a full walk is
 * due when the opt-in or the mailbox roster changed, the log was pruned past the mark, a change that
 * can re-admit a kept row landed (a rule disabled or deleted, a triage state, a draft or decision
 * withdrawn, our own writing changed), or {@link SCREENER_AUTO_FULL_EVERY_MS} passed.
 */
export interface ScreenerAutoMark {
  autoApplyAt: string; roster: string; headSeq: bigint; fullAt: number;
}
/** Where a walk stopped by its `until` clock goes on: the mark it will leave, and its cursor. */
export interface ScreenerAutoResume {
  next: ScreenerAutoMark; changed: string[] | null; afterId: string | null; page: number;
}
export type ScreenerAutoWalk = Map<string, ScreenerAutoMark> & { resumes?: Map<string, ScreenerAutoResume> };
export const newScreenerAutoWalk = (): ScreenerAutoWalk =>
  Object.assign(new Map<string, ScreenerAutoMark>(), { resumes: new Map<string, ScreenerAutoResume>() });

export interface ScreenerAutoDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  log?: Logger;
  now?: () => Date;
  /** Test seam. Default {@link SCREENER_AUTO_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link SCREENER_AUTO_WRITES_PER_CYCLE}. */
  writesPerCycle?: number;
  /** Test seam. Default {@link SCREENER_AUTO_MAX_PAGES}. */
  maxPages?: number;
  /** The per-account marks. Absent ⇒ every call is a full walk. */
  walk?: ScreenerAutoWalk;
  /** Test seam. Default {@link SCREENER_AUTO_FULL_EVERY_MS}. */
  fullEveryMs?: number;
  /** Test seam. Default {@link STRONG_BULK_FLOOR_VERSION}. */
  floorVersion?: number;
  /**
   * The cycle tail's clock, asked before every page after the first. A walk it stops RESUMES at its
   * cursor on the next call (`walk.resumes`), so a walk longer than the clock still finishes and the
   * mark still moves; without a resume memory it is a cap.
   */
  until?: () => boolean;
}

export interface ScreenerAutoResult {
  /** False ⇒ the account has NOT opted in; nothing was read past the one-row probe. */
  ran: boolean;
  /** Candidate rows examined. */
  examined: number;
  /** Rows filed out of the Screener. */
  moved: number;
  /** Rows the pass left in the Screener — not strong-bulk, sensitivity-flagged, or user-touched. */
  kept: number;
  /** Kept rows newly marked as read with no strong-bulk floor; the next walks skip them. */
  marked: number;
  /** Destination → how many movers went there. Always a subset of {Reads, Receipts}. */
  destinations: Record<string, number>;
  /**
   * Movers held back BECAUSE they are sensitivity-flagged — the safety margin, so an operator can see
   * how much was deliberately left at the gate for a human rather than filed to Reads/Receipts.
   */
  sensitivityExcluded: number;
  /** True ⇒ the per-cycle write budget ran out; the rest is swept next cycle. */
  capped: boolean;
  /**
   * True ⇒ the account switched auto-apply OFF part-way through this walk and the remaining pages
   * were NOT applied.
   *
   * Distinct from {@link capped} on purpose, because the two mean opposite things to the caller: a
   * cap owes more work and should be re-kicked, a revoke owes none and must not be. Reported rather
   * than left to look like a drained queue — a withdrawn decision that is acted on silently is the
   * defect this field exists to make visible.
   */
  revoked: boolean;
  /** Which walk ran: every held row, or only the rows that changed since the account's mark. */
  mode: "full" | "incremental";
}

/** One candidate, carrying everything the decision reads — all of it from disk. */
interface AutoRow {
  messageId: string;
  mailboxId: string;
  fromAddress: string;
  subject: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  desiredFolder: string;
  sensitivityCategory: string | null;
  noAi: boolean;
  /** A `message_bodies` row exists — an absent one reads `{}` and its floor is not yet known. */
  bodyPresent: boolean;
}

const EMPTY = (): ScreenerAutoResult => ({
  ran: false, examined: 0, moved: 0, kept: 0, marked: 0, destinations: {}, sensitivityExcluded: 0,
  capped: false, revoked: false, mode: "full",
});

/** Change kinds that can make a KEPT row a candidate again without touching its `folder_state`. */
const READMITS = sql`(${changeLog.entityType} = 'message_state'
  or (${changeLog.entityType} in ('rule', 'approval') and ${changeLog.op} in ('update', 'delete'))
  or (${changeLog.entityType} = 'draft' and ${changeLog.op} = 'delete'))`;

/**
 * …AND A CHANGE TO THE ACCOUNT'S OWN WRITING. Exclusion 5 reads our replies in the held row's
 * thread, so our reply re-threaded away (`thread-service.ts`'s merge, the join heal) or deleted
 * lifts it with no change row of the held message's own. Joined by `entity_id`: a tombstone keeps
 * its row and joins; a purged row is gone and cannot, and waits for the hourly full walk.
 */
function ownWritingChanged(own: readonly string[]): SQL {
  if (own.length === 0) return sql`false`;
  return sql`(${changeLog.entityType} = 'message' and ${changeLog.op} in ('update', 'delete') and exists (
    select 1 from ${messages} om
     where om.id = ${changeLog.entityId} and om.account_id = ${changeLog.accountId}
       and lower(om.from_address) in (${sql.join(own.map((a) => sql`${a}`), sql`, `)})))`;
}

/** True ⇒ sensitivity-flagged (`sensitivity_category` set OR `no_ai`) — never auto-moved. */
function isSensitivityFlagged(row: AutoRow): boolean {
  return row.sensitivityCategory !== null || row.noAi;
}

/**
 * THE PASS, for ONE account. A no-op for every account that has not opted in; otherwise a bounded,
 * idempotent sweep of the held Screener queue that files obvious strong-bulk out and leaves
 * everything else — strangers, sensitive mail, user-touched mail — exactly where it is.
 *
 * Pure and hermetic — a db/tx handle, a clock and a logger — so a test drives it against PGlite
 * with no worker, no lease and no network. The `FOR UPDATE OF folder_state` lock behaves as a no-op
 * on PGlite (single connection); its concurrent-move claim is the sibling passes' `*.pg.test.ts`
 * territory and holds here for the same reason it holds there.
 */
export async function screenerAutoApplyPass(
  db: Tx, deps: ScreenerAutoDeps, nowArg?: Date,
): Promise<ScreenerAutoResult> {
  const log = deps.log ?? silentLogger;
  const now = () => nowArg ?? deps.now?.() ?? new Date();
  const batch = deps.batch ?? SCREENER_AUTO_BATCH;
  const budget = deps.writesPerCycle ?? SCREENER_AUTO_WRITES_PER_CYCLE;
  const maxPages = deps.maxPages ?? SCREENER_AUTO_MAX_PAGES;
  const floorVersion = deps.floorVersion ?? STRONG_BULK_FLOOR_VERSION;
  const accountId = deps.accountId;

  // ── THE OPT-IN PROBE ───────────────────────────────────────────────────────────────────────
  //
  // One PK read. `screener_auto_apply_at IS NOT NULL` IS the opt-in; a NULL, an absent row, and (up
  // the stack) a failed read all mean OFF, and OFF moves nothing. This is the whole cost of the pass
  // for every account that has not turned it on — which is every account by default.
  const [settings] = await db.select({ autoApplyAt: accountSettings.screenerAutoApplyAt })
    .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  if (!settings?.autoApplyAt) { deps.walk?.delete(accountId); deps.walk?.resumes?.delete(accountId); return EMPTY(); }

  // The account's own addresses (the one set, `readOwnAddresses`) — for the "the user replied from
  // their own client" exclusion. Read once here rather than in SQL so the candidate query stays one
  // indexable statement. Every mailbox row is the roster the walk mark is keyed on (a promotion, a
  // re-enable or a removal re-admits).
  const ownAddresses = [...await readOwnAddresses(db as unknown as Tx, accountId)];
  const rosterRows = await db.select({
    id: mailboxes.id, address: mailboxes.address, status: mailboxes.status, role: mailboxes.organizerRole,
  }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
  const roster = rosterRows.map((r) => `${r.id}:${r.status}:${r.role}:${r.address.toLowerCase()}`).sort().join(",");

  const result: ScreenerAutoResult = { ...EMPTY(), ran: true };
  const autoApplyAt = new Date(settings.autoApplyAt).toISOString();
  // A walk the clock stopped goes on where it stopped, under the mark it read before its first page
  // — the same walk, only longer. Taken once: a revoke, a finish or a cap leaves no resume behind.
  const held = deps.walk?.resumes?.get(accountId);
  deps.walk?.resumes?.delete(accountId);
  const resume = held && held.next.autoApplyAt === autoApplyAt && held.next.roster === roster ? held : undefined;
  const plan = resume ? { changed: resume.changed, next: resume.next }
    : await planWalk(db, deps, { accountId, autoApplyAt, roster, ownAddresses, now: now() });
  result.mode = plan.changed === null ? "full" : "incremental";
  let afterId: string | null = resume?.afterId ?? null;
  const pages = plan.changed === null ? maxPages : Math.ceil(plan.changed.length / batch);
  let clockStop = false;
  let endedShort = false;

  // STEP 0, full walks only: withdraw marks written under another floor version, so this walk's
  // pages judge those rows again. Its own statement, no lock but the rows'; bounded per walk.
  if (plan.changed === null && !resume) {
    await dialect(db).exec(db, staleFloorWithdrawSql({ accountId, version: floorVersion }));
  }

  for (let page = plan.changed === null ? 0 : resume?.page ?? 0, ran = 0; page < pages; page++, ran++) {
    if (result.moved >= budget) { result.capped = true; break; }
    if (ran > 0 && deps.until?.()) {
      clockStop = true;
      result.capped = true;
      deps.walk?.resumes?.set(accountId, { next: plan.next, changed: plan.changed, afterId, page });
      break;
    }

    const outcome = await db.transaction(async (tx) => {
      // THE OPT-IN IS RE-READ HERE, LOCKED, AND IT IS THE REVOKE CHECK. The probe above runs ONCE; the
      // pass then files up to SCREENER_AUTO_WRITES_PER_CYCLE across `maxPages` transactions, and an account
      // that turns auto-apply OFF mid-walk had the rest applied anyway — a completed opt-out then up to a
      // hundred moves on their real mailbox. `ohbox-tidy.ts` holds this shape (its settings row is
      // serialization point AND revoke check); `screener-auto-revoke.pg.test.ts` watches both. TWO
      // properties: the RE-READ catches the withdrawn opt-in (each page reads fresh under READ COMMITTED,
      // with or without the lock — dropping `.for("update")` does not redden the revoke test); the LOCK
      // serializes two drivers (a cycle tail and a failover worker). LOCK ORDER: `account_settings` first,
      // before `folder_state` (`selectCandidates` FOR UPDATE OF) and the `account_sync_state` counter — the
      // one order this tree uses. The 30 s posture cache in `index.ts` gates whether the pass STARTS, not this.
      const [live] = await tx.select({ autoApplyAt: accountSettings.screenerAutoApplyAt })
        .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1).for("update");
      if (!live?.autoApplyAt) {
        return {
          revoked: true, held: 0, lastHeld: null, rows: 0, moved: 0, kept: 0, marked: 0, sensitivityExcluded: 0,
          capped: false, destinations: {} as Record<string, number>,
        };
      }

      // A full walk pages over the HELD ids by their own index, then asks the candidate statement
      // about exactly those; an incremental walk asks it about its slice of changed ids.
      const held = plan.changed?.slice(page * batch, (page + 1) * batch)
        ?? await heldPage(tx, { accountId, afterId, limit: batch });
      const candidates = held.length === 0 ? []
        : await selectCandidates(tx, { accountId, ownAddresses, limit: batch, only: held });

      let moved = 0;
      let kept = 0;
      let sensitivityExcluded = 0;
      // Rows read with NO strong-bulk floor and a body row present: the floor is a pure function of
      // headers written once, so the row is kept on every later walk too — mark it, skip it after.
      const toMark: string[] = [];
      let capped = false;
      const destinations: Record<string, number> = {};

      for (const c of candidates) {
        // Budget enforced PER ROW, so the cap is exact and the cursor resumes at the last row this
        // pass actually decided about — never past one it skipped.
        if (result.moved + moved >= budget) { capped = true; break; }

        // THE ONLY DETERMINISTIC JUDGMENT A STRANGER GETS: the strong-bulk floor. Null ⇒ keep (a
        // plain stranger, a relevant alert). No model call, no spend, computed from headers on disk.
        const to = migrationBulkPlacement(asRuleInput(c));
        if (to === null) { kept++; if (c.bodyPresent) toMark.push(c.messageId); continue; }

        // ── SENSITIVITY KEEP — this is `pipeline.ts:563-567`. Drop it and a flagged strong-bulk row
        // moves; keeping it means a stranger's login code stays at the gate for a human. ──────────
        if (isSensitivityFlagged(c)) { sensitivityExcluded++; kept++; continue; }

        await upsertDesired(tx, c, to, now());
        // The optimistic, user-wins `move` delta the client mirror converges on, carrying the TRUE
        // previous folder so a later undo needs nothing extra written.
        await recordChange(tx, {
          accountId, entityType: "message", entityId: c.messageId, op: "move",
          meta: { from: SCREENER, to },
        });
        // The undo the account is owed: this pass moved mail they did not individually place, so
        // "put it back" has to be expressible. No `rules` row and no learning-path read — the move
        // teaches no consent and grants no admission, so the sender still screens next time.
        await tx.insert(auditLog).values({
          accountId, action: auditAction("screener_auto_apply_move"),
          payload: { mailboxId: c.mailboxId, messageId: c.messageId, from: SCREENER, to },
          inverse: { messageId: c.messageId, from: to, to: SCREENER },
        });
        moved++;
        destinations[to] = (destinations[to] ?? 0) + 1;
      }

      // ONE statement, this transaction, rows already locked FOR UPDATE by the candidate statement.
      // scoped-by: the ids are the candidate statement's own rows, read under this account.
      const marked = toMark.length === 0 ? 0
        : (await dialect(tx).exec(tx, floorMarkSql({ ids: toMark, version: floorVersion }))).length;

      return {
        revoked: false, held: held.length, lastHeld: held[held.length - 1] ?? null,
        rows: candidates.length, moved, kept, marked, sensitivityExcluded, capped, destinations,
      };
    });

    // A REVOKE STOPS THE WALK, and it is reported rather than looking like a drained queue. The
    // pages already committed stand — they were applied while the opt-in was live, and the account
    // is owed the undo each one wrote to `audit_log`, not a silent reversal.
    if (outcome.revoked) {
      result.revoked = true;
      log.info("screener_auto_apply_revoked", {
        accountId, examined: result.examined, moved: result.moved,
        reason: "auto-apply was switched off during this walk; the remaining pages were not applied",
      });
      break;
    }

    result.examined += outcome.rows;
    result.moved += outcome.moved;
    result.kept += outcome.kept;
    result.marked += outcome.marked;
    result.sensitivityExcluded += outcome.sensitivityExcluded;
    for (const [to, n] of Object.entries(outcome.destinations)) {
      result.destinations[to] = (result.destinations[to] ?? 0) + n;
    }
    if (outcome.capped) { result.capped = true; break; }
    // A short HELD page is the end of the queue. The cursor is the last held id, never a
    // candidate's: candidates are a subset of the page in the same order, so a page of kept rows
    // advances past all of them and the walk terminates.
    if (plan.changed !== null) continue;
    if (outcome.held < batch) { endedShort = true; break; }
    afterId = outcome.lastHeld ?? afterId;
  }

  // THE MARK MOVES ONLY OVER A WALK THAT FINISHED: a capped or revoked walk leaves it where it was,
  // so the next walk re-reads everything this one did not decide. A full walk that ran out of pages
  // is capped in effect and moves nothing either.
  const finished = !result.capped && !result.revoked && !clockStop && (plan.changed !== null || endedShort);
  if (deps.walk && result.revoked) deps.walk.delete(accountId);
  else if (deps.walk && finished) deps.walk.set(accountId, plan.next);

  if (result.moved > 0) {
    log.info("screener_auto_apply", {
      accountId, examined: result.examined, moved: result.moved, kept: result.kept,
      destinations: result.destinations, sensitivityExcluded: result.sensitivityExcluded,
      capped: result.capped,
    });
  }
  return result;
}

/**
 * Full or incremental, and the mark a finished walk leaves. One statement, a read with no lock: the
 * page transactions re-check every row under `FOR UPDATE`. The head is read BEFORE any page, so a
 * change committed during the walk has a later seq and is the next walk's.
 */
async function planWalk(
  db: Tx, deps: ScreenerAutoDeps,
  o: { accountId: string; autoApplyAt: string; roster: string; ownAddresses: readonly string[]; now: Date },
): Promise<{ changed: string[] | null; next: ScreenerAutoMark }> {
  if (deps.walk === undefined) {
    return { changed: null, next: { autoApplyAt: o.autoApplyAt, roster: o.roster, headSeq: 0n, fullAt: 0 } };
  }
  const mark = deps.walk.get(o.accountId);
  const fullEvery = deps.fullEveryMs ?? SCREENER_AUTO_FULL_EVERY_MS;
  const incremental = mark !== undefined && mark.autoApplyAt === o.autoApplyAt && mark.roster === o.roster
    && o.now.getTime() - mark.fullAt < fullEvery;
  const since = incremental ? mark.headSeq : null;
  const [row] = await db.select({
    head: accountSyncState.nextSeq,
    pruned: accountSyncState.prunedThroughSeq,
    readmit: since === null ? sql<boolean>`false` : sql<boolean>`exists (
      select 1 from ${changeLog} where ${changeLog.accountId} = ${o.accountId}::uuid
         and ${changeLog.seq} > ${since.toString()}::bigint
         and (${READMITS} or ${ownWritingChanged(o.ownAddresses)}))`,
    changed: since === null ? sql<string[] | null>`null` : sql<string[] | null>`(
      select array_agg(distinct cl.entity_id::text) from ${changeLog} cl
        join ${folderState} fs on fs.message_id = cl.entity_id
       where cl.account_id = ${o.accountId}::uuid and cl.seq > ${since.toString()}::bigint
         and cl.entity_type = 'message' and fs.desired_folder = ${SCREENER} and fs.last_set_by = 'us')`,
  }).from(accountSyncState).where(eq(accountSyncState.accountId, o.accountId)).limit(1);
  const head = BigInt(row?.head ?? 0n);
  const stillIncremental = since !== null && head >= since && BigInt(row?.pruned ?? 0n) <= since
    && row?.readmit !== true;
  const next: ScreenerAutoMark = {
    autoApplyAt: o.autoApplyAt, roster: o.roster, headSeq: head,
    fullAt: stillIncremental ? mark!.fullAt : o.now.getTime(),
  };
  if (!stillIncremental) return { changed: null, next };
  return { changed: idsOf(row?.changed).sort(), next };
}

/** A uuid[] as either driver hands it back: an array, or Postgres' `{a,b}` text. */
function idsOf(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  const t = String(v).replace(/^\{|\}$/g, "");
  return t === "" ? [] : t.split(",");
}

/**
 * ONE PAGE OF THE HELD QUEUE, as ids — no lock, ordered by `folder_state.message_id` from the cursor,
 * and only rows whose floor is unjudged (`screener_floor_version is null`): a marked row was read
 * with no strong-bulk floor and is kept by every walk, so no walk reads it again. ORDER BY names the
 * index key (version, then id): `is null` is no equality to the planner, so ordering by the id alone
 * walks the unique index and filters. The join to `messages` scopes the page to the account.
 */
export function heldPageSql(opts: { accountId: string; afterId: string | null; limit: number }): SQL {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 10_000) {
    throw new Error(`a held page of ${String(opts.limit)} rows is not a page`);
  }
  const lit = (v: string): SQL => sql.raw(`'${v.replace(/'/g, "''")}'`);
  return sql`select fs.message_id from ${folderState} fs
    join ${messages} m on m.id = fs.message_id
   where m.account_id = ${opts.accountId}
     and fs.desired_folder = ${lit(HELD_PAGE_PREDICATE.folder)} and fs.last_set_by = ${lit(HELD_PAGE_PREDICATE.setBy)}
     and fs.screener_floor_version is null
     and fs.message_id > ${opts.afterId ?? BEFORE_EVERY_ID}::uuid
   order by fs.screener_floor_version, fs.message_id limit ${sql.raw(String(opts.limit))}`;
}

/** A floor version as a SQL literal; anything but a positive integer is refused. */
function versionLiteral(v: number): SQL {
  if (!Number.isInteger(v) || v < 1) throw new Error(`floor version ${String(v)} is not a version`);
  return sql.raw(String(v));
}

/**
 * THE MARK: this page's kept rows read with no strong-bulk floor, at `version`. One column and
 * nothing else — no `updated_at` (the mirror's window and the drain index must never see it), no
 * change row, no audit row: it records what the walk read, not where the message belongs.
 */
export function floorMarkSql(opts: { ids: readonly string[]; version: number }): SQL {
  const v = versionLiteral(opts.version);
  return sql`update ${folderState} set screener_floor_version = ${v}
   where message_id = any(${sql.param([...opts.ids])}::uuid[])
     and screener_floor_version is distinct from ${v}
   returning message_id`;
}

/**
 * STEP 0 of a full walk: withdraw up to {@link SCREENER_FLOOR_WITHDRAW_LIMIT} of this account's held
 * marks written under another floor version, so the walk judges them again. Two index ranges on the
 * held floor index (`< N`, `> N`); empty in the steady state.
 */
export function staleFloorWithdrawSql(opts: { accountId: string; version: number }): SQL {
  const v = versionLiteral(opts.version);
  const lit = (x: string): SQL => sql.raw(`'${x.replace(/'/g, "''")}'`);
  return sql`update ${folderState} set screener_floor_version = null
   where message_id in (select fs.message_id from ${folderState} fs
       join ${messages} m on m.id = fs.message_id
      where m.account_id = ${opts.accountId}
        and fs.desired_folder = ${lit(HELD_PAGE_PREDICATE.folder)} and fs.last_set_by = ${lit(HELD_PAGE_PREDICATE.setBy)}
        and (fs.screener_floor_version < ${v} or fs.screener_floor_version > ${v})
      limit ${sql.raw(String(SCREENER_FLOOR_WITHDRAW_LIMIT))})
   returning message_id`;
}

async function heldPage(t: Tx, opts: { accountId: string; afterId: string | null; limit: number }): Promise<string[]> {
  const rows = await dialect(t).exec(t, heldPageSql(opts));
  return rows.map((r) => String(r[0]));
}

/**
 * The candidates among the ids asked about — LOCKED FOR UPDATE, oldest id first, every predicate
 * re-read on the locked row. Held (`desired_folder` the Screener, `last_set_by = 'us'`; `external` is
 * the user's own client, `peer` another install's), on a mailbox this install organizes, and none of
 * the user-intent exclusions: an enabled rule for the sender or domain, a triage state, a reply draft,
 * a decided approval, an own-address reply, a filing the person put back. Sensitivity is the pass's
 * KEEP guard, not a predicate.
 */
async function selectCandidates(
  t: Tx,
  opts: { accountId: string; ownAddresses: readonly string[]; limit: number; only: readonly string[] },
): Promise<AutoRow[]> {
  const filters = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, SCREENER),
    eq(folderState.lastSetBy, "us"),
    // BOTH HALVES since mail 0083 — see the identical clause in `rule-retro.ts` for the full
    // argument. `status = 'disabled'` alone stopped being sufficient when the loser of an
    // organizer lease became a READER (connected, syncing) instead of a disabled row: a demoted
    // organizer keeps every `folder_state` row it filed while it WAS the organizer, those rows are
    // `last_set_by: 'us'`, and this pass would re-file them on a mailbox another install now
    // arranges. Nothing executes them while the install is a reader, which is the trap — the
    // intent waits in the table and fires in full on the next promotion.
    sql`not exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
    // 1 — the user has ruled on this sender. ANY enabled rule, narrowed or not. THIS PASS MUST NOT NARROW
    // IT. The identical predicate in `sensitive-rescreen.ts` and `drizzle-repo.ts#listScreenerBacklog` was
    // narrowed to un-narrowed rules because `subject_contains`/`body_contains` (mail 0050, 0052) are
    // CONJUNCTIONS, so a narrowed rule speaks only for the mail it matches — right there, and it does not
    // transfer here: {@link screenerAutoApplyPass} decides with `migrationBulkPlacement` and NEVER calls
    // `evaluateRules`, and {@link AutoRow} carries no body text, so narrowing the SQL DISCARDS the question
    // and a held message matching the user's narrowed rule gets auto-moved over the destination they wrote,
    // silently. Conservative is correct here: excluding too much leaves a message at the gate (visible);
    // too little moves their mail where they said not to. If auto-apply grows a real evaluator, this
    // narrows with it, in the same commit — not before.
    sql`not exists (
      select 1 from ${rulesTbl} r
       where r.account_id = ${messages.accountId}
         and r.enabled = true
         and ${ruleNamesSenderSql(dialect(t), { kind: sql`r.kind`, match: sql`r.match` }, sql`lower(${messages.fromAddress})`)}
    )`,
    // 2 — the user has triaged this message.
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    // 3 — the user is replying, or has replied, through the app.
    sql`not exists (
      select 1 from ${drafts} d
       where d.account_id = ${messages.accountId} and d.in_reply_to_message_id = ${messages.id}
    )`,
    // 4 — the user decided on an AI proposal about this message.
    sql`not exists (
      select 1 from ${approvals} a
       where a.account_id = ${messages.accountId} and a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  /* 5 — THE USER ANSWERED THIS SENDER, through `weAnsweredThisSenderWhere` like its two siblings.
   * This pass asked plain thread membership and did not exclude the away responder AT ALL, so a
   * machine's reply on a thread counted as the person's engagement and held mail at the gate. */
  filters.push(sql`not ${weAnsweredThisSenderWhere(dialect(t), {
    accountId: messages.accountId as unknown as SQL,
    threadId: messages.threadId as unknown as SQL,
    fromAddress: messages.fromAddress as unknown as SQL,
    ownAddresses: opts.ownAddresses,
  })}`);
  // 6 — THE PERSON PUT BACK THIS PASS'S FILING (mail 0138). The undo returns the message to the
  // gate through the move door, whose `last_set_by = 'us'` the two filters above admit, so without
  // this the next full walk files it again.
  filters.push(isNull(folderState.autoFilingUndoneAt));
  // ONE array parameter, so the statement's text does not depend on how many ids it is asked about.
  filters.push(sql`${messages.id} = any(${sql.param([...opts.only])}::uuid[])`);

  const rows = await t.select({
    messageId: messages.id,
    mailboxId: messages.mailboxId,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    desiredFolder: folderState.desiredFolder,
    // ONLY THE FIVE KEYS THE FLOOR READS CROSS THE WIRE. `message_bodies.headers` is the whole RFC-822
    // header map (~4 kB per row in production), and this pass re-reads its page every cycle — shipping the
    // full map to answer `hasStrongBulkFloor` sends ~4 kB to read ~86 B. Exact rather than heuristic: this
    // pass runs MIGRATION-BULK ONLY (see {@link asRuleInput}, never `evaluateRules`), so the only header
    // reader downstream is `hasStrongBulkFloor`, which reads exactly these five names — any new header
    // reader MUST be added here or silently see an absent header. `jsonb_strip_nulls` makes an absent key
    // absent rather than `"key": null` (what `headerValues`' `hasOwnProperty` distinguishes); a missing
    // body row (LEFT JOIN nullable side) yields `{}`. `mime.ts` lower-cases header names at ingest.
    headers: sql<Record<string, string[]> | null>`jsonb_strip_nulls(jsonb_build_object(
      'list-unsubscribe',      ${messageBodies.headers} -> 'list-unsubscribe',
      'list-unsubscribe-post', ${messageBodies.headers} -> 'list-unsubscribe-post',
      'list-id',               ${messageBodies.headers} -> 'list-id',
      'feedback-id',           ${messageBodies.headers} -> 'feedback-id',
      'precedence',            ${messageBodies.headers} -> 'precedence'
    ))`,
    sensitivityCategory: messages.sensitivityCategory,
    noAi: messages.noAi,
    // Whether the LEFT JOIN found a body row: `{}` headers from an absent one are not a verdict.
    bodyPresent: sql<boolean>`${messageBodies.messageId} is not null`,
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
    headers: (r.headers as Record<string, string[]> | null) ?? {},
    observedFolder: r.observedFolder,
    desiredFolder: r.desiredFolder,
    sensitivityCategory: r.sensitivityCategory,
    noAi: r.noAi,
    // Only a TRUE reading marks; a projection the driver hands back as anything else reads absent.
    bodyPresent: r.bodyPresent === true,
  }));
}

/**
 * The persisted row in the shape the router reads — sender, subject, headers, all on disk. No IMAP,
 * no MIME re-parse. The body fields are empty because this pass feeds `migrationBulkPlacement`
 * ONLY, which reads headers and the subject — it never runs `evaluateRules`, so `body_contains`
 * (mail 0052) has no reader here and an empty `textBody` is the truth rather than a lie. That is
 * a DIVERGENCE from the sibling passes' `asRuleInput` (`rule-retro.ts`, `ohbox-tidy.ts`,
 * `sensitive-rescreen.ts`), which do evaluate rules and therefore read `message_bodies.text`
 * back; if this pass ever grows a rule evaluation, thread the body in as they do.
 */
function asRuleInput(row: AutoRow): NormalizedMessage {
  return ruleInputOf({ ...row, bodyText: "" });
}
