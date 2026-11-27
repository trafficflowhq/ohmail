import { and, asc, eq, gt, inArray, isNotNull, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { dialect } from "./dialect/index.js";
// The calendar's tables by name: this sweep is outside the phone's engine, whose schema has none.
import {
  calAlarms, calAttendees, calCalendars, calConnections, calCredentials, calEvents, calLinks, calSettings,
  calSuggestions, calWrites,
  accountSettings,
  accountStorage,
  accountSyncState,
  accounts,
  approvals,
  attachments,
  auditLog,
  awayReplies,
  awayResponders,
  awaySenderState,
  changeLog,
  contactNotes,
  contacts,
  devices,
  drafts,
  flagState,
  folderState,
  graduations,
  idempotencyKeys,
  kbEntries,
  learningSignals,
  listAddresses,
  mailboxCredentials,
  mailboxProfileMirror,
  folderOps,
  junkRescues, screenerLearning,
  mailboxFolders,
  mailboxes,
  messageBodies, messageSearch,
  messageFailures,
  messageInstances,
  messageInvitations,
  messageStates,
  messages,
  notifyRules,
  organizerRequests,
  outboundSendFingerprints,
  outboundSentCopies,
  outboundSends,
  pairingTokens,
  passProgress,
  refreshTokens,
  routingDecisions,
  ruleRemovals,
  scheduledSendFiles,
  rules,
  sessions,
  snippets,
  tags,
  messageTags,
  threadNotes,
  threads,
  ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS,
  trackerEvents,
  unsubscribeRecords,
  unsubscribeExamined,
  users,
  workflowProposals,
  workflowRuns,
  workflows,
} from "./schema-mail.js";
import {
  accountLifecycleNotices,
  accountStorageHolds,
  accountStoragePrefs,
  mailboxStorageStats,
  storageMailSent,
  attachmentStaging,
  authEvents,
  connectAttempts,
  creditRefundObligations,
  authThrottle,
  accountCounters,
  credentials,
  invites,
  loginTokens,
  mailboxOauthCeremonies,
  mailboxOauthDeviceCeremonies,
  oauthAuthCodes,
  pushSubscriptions,
  calPushChannels,
  recoveryCodes,
  screenerSuggestOwed,
  totpSecrets,
  waitlist,
  webauthnChallenges,
  webauthnCredentials,
} from "./schema-cloud.js";
import { setAccountLookupKey } from "./bound.js";
import type { LedgerTx, Tx } from "./change-log.js";
import { recordErasedBearers } from "./erased-bearers.js";
import { readAccountErasedAt } from "./erasure-fence.js";
import { probeRowsOfAccount } from "./imap-admission.js";
import type { ReleaseOutcome } from "./entitlements-port.js";
import { THROTTLE_PREFIX, type ThrottleKeys } from "./auth-throttle-keys.js";
import { rowsAffected } from "./rows-affected.js";

/**
 * Account deletion — Art. 17 erasure, as ANONYMISATION. A ledger-carrying account cannot be
 * `DELETE`d (`migration-0018.roundtrip.test.ts`; Art. 17(3)(b) preserves statutory retention).
 * Every user, mailbox, message, body, credential and note row is deleted; `accounts` survives as
 * a pseudonymous billing subject, `billing_customers.email` redacted in place. Mail on the
 * customer's own IMAP server is untouched. `account-deletion.pg.test.ts` walks
 * `information_schema` for every table FK-reachable from `accounts` or carrying `account_id`:
 * each must be NAMED in {@link DeleteAccountResult.deleted} or exempted. `attachment_staging` is
 * EXPIRED, not deleted — its row is the delete key for bucket bytes.
 */
/*
 * The signup funnel (`invites`, `waitlist`) is keyed by ADDRESS and sits outside that graph
 * entirely, so it has its own scope and its own guard — {@link DeleteAccountResult.redacted}.
 */
export interface DeleteAccountResult {
  accountId: string;
  /** Rows removed, per table, for the audit trail the operator keeps. */
  deleted: Record<string, number>;
  /**
   * Staging tickets brought forward to expire NOW — not deleted. See the header:
   * these rows are the only key to bytes in the object store, so they are reaped
   * WITH their objects by the worker sweep rather than dropped here.
   */
  stagingTicketsExpired: number;
  /** Users whose personal data was erased (count only — the addresses are gone). */
  usersErased: number;
  /**
   * Rows PSEUDONYMISED in place, per table — the signup funnel, which is keyed by a person's
   * address and by nothing else. The row survives because the operator's funnel count is a fact
   * about the service; the address does not, because it is a fact about a person. Separate from
   * {@link deleted} because the guard asks a different question of it: `emailBearingTables` in
   * `helpers/erasure-fixture.ts` demands that every email-bearing table outside the account's
   * foreign-key graph appear HERE or on a written exemption list.
   */
  redacted: Record<string, number>;
  /**
   * Refund obligations still PENDING, kept and pseudonymised rather than deleted: money owed to
   * the person is a financial record, retained on the `accounts` row's Art. 17(3)(b) basis, and
   * the refund drain still settles it. Zero on a host that drains nothing.
   */
  retainedPending: number;
}

interface ErasureContext {
  db: Tx;
  accountId: string;
  now: () => Date;
}

/** Re-read an erasure after a lost response, waiting for a stamp still in flight. */
export async function erasureOutcome(ctx: ErasureContext): Promise<"erased" | "accepted" | "not_erased" | "unknown"> {
  try {
    const [row] = await dialect(ctx.db).forUpdate(
      ctx.db.select({ at: accounts.erasedAt, progress: accounts.erasureProgress }).from(accounts)
        .where(eq(accounts.id, ctx.accountId)).limit(1),
      { mode: "share" },
    );
    if (!row) return "unknown";
    if (row.at === null) return "not_erased";
    return row.progress?.complete === false ? "accepted" : "erased";
  } catch {
    return "unknown";
  }
}

/** Rows affected across the three drivers — see `rows-affected.ts` for why there is one copy. */
const n = rowsAffected;

/** A retention erasure was asked for a date with no delivered erasure-week warning; nothing was erased. */
export class ErasureUnwarnedError extends Error {
  constructor() {
    super("no delivered erasure warning for this erasure date");
    this.name = "ErasureUnwarnedError";
  }
}

/**
 * Erase one account. Runs in ONE transaction: a half-deleted account is worse
 * than an undeleted one, because the user has been told their data is gone.
 *
 * Idempotent — running it twice is a no-op the second time, which matters because
 * the caller may retry after a network failure.
 */
/**
 * `throttleKeys` is what reaches the sign-in throttle rows keyed by an address hash; both
 * production callers pass it (`account-deletion-callers.test.ts` parses for the call). Without it
 * those rows are left to the prune. `drainsRefunds` is true only where a refund drain runs (a host
 * with an entitlements program): pending refunds are then kept for it. Absent, nothing drains them,
 * so they are deleted with the rest. `warnedFor` is a retention erasure's date (the lifecycle pass's
 * door): the erasure-week warning delivered for it is kept, and without one nothing is erased.
 */
interface ErasureOptions {
  throttleKeys?: ThrottleKeys;
  drainsRefunds?: boolean;
  warnedFor?: Date;
  billingOutcome?: ReleaseOutcome;
}

type Progress = NonNullable<(typeof accounts.$inferSelect)["erasureProgress"]>;
const ERASURE_SLICE_ROWS = 1_000;
const BILLING_LEASE_MS = 2 * 60_000;
const BILLING_RETRY_MS = 30_000;
const BILLING_MAX_RETRY_MS = 60 * 60_000;
const ERASURE_LOCK_TIMEOUT = sql`set local lock_timeout = '1s'`;

function erasureProgress(opts: Pick<ErasureOptions, "drainsRefunds" | "warnedFor">): Progress {
  return {
    warnedFor: opts.warnedFor?.toISOString() ?? null, drainsRefunds: opts.drainsRefunds === true,
    billing: opts.drainsRefunds ? "pending" : "none",
    billingLease: null, complete: false, finished: [], deleted: {}, redacted: {},
    stagingTicketsExpired: 0, retainedPending: 0,
  };
}

function recordBillingOutcome(state: Progress, outcome: ReleaseOutcome, at: Date): Progress {
  const billingAttempts = Math.min((state.billingAttempts ?? 0) + 1, 8);
  const delay = Math.min(BILLING_MAX_RETRY_MS, BILLING_RETRY_MS * 2 ** (billingAttempts - 1));
  return {
    ...state, billing: outcome, billingLease: null, billingAttempts,
    billingRetryAt: outcome === "cancel_failed" ? new Date(at.getTime() + delay).toISOString() : null,
  };
}

/** Small accounts still get a complete receipt in their request. Large accounts use the worker. */
export async function accountErasureNeedsBackground(ctx: ErasureContext): Promise<boolean> {
  const tx = ctx.db;
  const candidates = [messages, threads, changeLog, calEvents, calAttendees, auditLog, messageInstances, attachments] as const;
  const probes = [
    sql`exists (select 1 from ${accounts} where ${accounts.id} = ${ctx.accountId} and ${accounts.erasureProgress} is not null)`,
    ...candidates.map((table) => sql`exists (select 1 from ${table}
      where ${table.accountId} = ${ctx.accountId} offset ${ERASURE_SLICE_ROWS} limit 1)`),
  ];
  const [[large] = []] = await dialect(tx).exec(tx, sql`select ${sql.join(probes, sql` or `)}`);
  return large === true;
}

/** The short accepting transaction interlocks auth and ingest before the large cleanup starts. */
export async function acceptAccountErasure(
  ctx: ErasureContext, opts: Pick<ErasureOptions, "drainsRefunds" | "warnedFor">,
): Promise<"accepted" | "erased"> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as LedgerTx;
    const { accountId } = ctx;
    const now = ctx.now();
    const at = await readAccountErasedAt(tx, dialect(ctx.db), accountId, "update");
    if (at === undefined) throw new Error("the account no longer exists");
    if (at !== null) {
      const [row] = await tx.select({ progress: accounts.erasureProgress }).from(accounts).where(eq(accounts.id, accountId));
      return row?.progress?.complete === false ? "accepted" : "erased";
    }
    await checkErasureWarning(tx, accountId, opts.warnedFor);
    const progress = erasureProgress(opts);
    await tx.update(accounts).set({ erasedAt: now }).where(eq(accounts.id, accountId));
    // The same lock order as a mailbox erase. Writers that rely on the mailbox fence see its stamp
    // even before the account sweep removes the mailbox row.
    await tx.execute(sql`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}, hashtext(${accountId}))`);
    await tx.update(mailboxes).set({ status: "disabled", erasedAt: sql`coalesce(${mailboxes.erasedAt}, ${dialect(tx).ts(now)})` })
      .where(eq(mailboxes.accountId, accountId));
    // Keep the evidence before revoking access, under the session lock used by refresh rotation.
    await tx.execute(sql`select count(*) from (select 1 from ${sessions}
      where ${sessions.accountId} = ${accountId} order by ${sessions.id} for update) locked`);
    await recordErasedBearers(tx, accountId, now);
    await tx.update(sessions).set({ revokedAt: now })
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
    progress.redacted = await redactSignupFunnel(tx, accountId);
    await tx.update(accounts).set({ erasureProgress: progress }).where(eq(accounts.id, accountId));
    return "accepted";
  });
}

async function checkErasureWarning(tx: LedgerTx, accountId: string, warnedFor?: Date): Promise<void> {
  if (warnedFor === undefined) return;
  const [warning] = await tx.select({ kind: accountLifecycleNotices.kind }).from(accountLifecycleNotices)
    .where(and(
      eq(accountLifecycleNotices.accountId, accountId), eq(accountLifecycleNotices.kind, "erasure_week"),
      eq(accountLifecycleNotices.anchor, warnedFor), isNotNull(accountLifecycleNotices.deliveredAt),
    )).limit(1);
  if (!warning) throw new ErasureUnwarnedError();
}

/** Claim the billing side independently of the database slice so the provider call holds no row lock. */
export async function releaseAcceptedErasure(
  ctx: ErasureContext, release?: (accountId: string) => Promise<ReleaseOutcome>,
): Promise<ReleaseOutcome> {
  if (!release) return "none";
  const db = ctx.db;
  const now = ctx.now();
  const lease = new Date(now.getTime() + BILLING_LEASE_MS).toISOString();
  const billing = await db.transaction(async (tx) => {
    await tx.execute(ERASURE_LOCK_TIMEOUT);
    const [row] = await tx.select({ erasedAt: accounts.erasedAt, progress: accounts.erasureProgress }).from(accounts)
      .where(eq(accounts.id, ctx.accountId)).for("update");
    if (!row?.erasedAt) return "none";
    // Erasures written before the worker kept a receipt may still have a subscription to stop.
    const state = row.progress ?? { ...erasureProgress({ drainsRefunds: true }), complete: true };
    if (state.billing === "cancelled" || state.billing === "none") return state.billing;
    if ((state.billingLease && Date.parse(state.billingLease) > now.getTime())
      || (state.billingRetryAt && Date.parse(state.billingRetryAt) > now.getTime())) return "cancel_failed";
    await tx.update(accounts).set({ erasureProgress: { ...state, billingLease: lease } }).where(eq(accounts.id, ctx.accountId));
    return "claimed";
  });
  if (billing !== "claimed") return billing;
  let outcome: ReleaseOutcome;
  try { outcome = await release(ctx.accountId); } catch { outcome = "cancel_failed"; }
  await db.transaction(async (tx) => {
    await tx.execute(ERASURE_LOCK_TIMEOUT);
    const [row] = await tx.select({ progress: accounts.erasureProgress }).from(accounts)
      .where(eq(accounts.id, ctx.accountId)).for("update");
    if (row?.progress?.billingLease === lease) {
      await tx.update(accounts).set({ erasureProgress: recordBillingOutcome(row.progress, outcome, ctx.now()) })
        .where(eq(accounts.id, ctx.accountId));
    }
  });
  return outcome;
}

export async function resumeAccountErasure(
  ctx: ErasureContext, opts: Pick<ErasureOptions, "throttleKeys"> = {},
): Promise<DeleteAccountResult | null> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as LedgerTx;
    await tx.execute(ERASURE_LOCK_TIMEOUT);
    const [row] = await tx.select({ erasedAt: accounts.erasedAt, state: accounts.erasureProgress }).from(accounts)
      .where(eq(accounts.id, ctx.accountId)).for("update");
    if (!row?.erasedAt || !row.state) return null;
    const state = row.state;
    if (!state.complete) {
      const warned = state.warnedFor === null ? {} : { warnedFor: new Date(state.warnedFor) };
      try {
        await sweepAccount({ ...ctx, now: () => row.erasedAt! }, tx,
          { ...opts, ...warned, drainsRefunds: state.drainsRefunds }, state);
        state.complete = true;
      } catch (err) {
        if (err !== SLICE_FINISHED) throw err;
      }
      await tx.update(accounts).set({ erasureProgress: state }).where(eq(accounts.id, ctx.accountId));
    }
    return state.complete ? receipt(ctx.accountId, state) : null;
  });
}

function receipt(accountId: string, state: Pick<Progress, "deleted" | "redacted" | "stagingTicketsExpired" | "retainedPending">): DeleteAccountResult {
  return { accountId, deleted: state.deleted, redacted: state.redacted, stagingTicketsExpired: state.stagingTicketsExpired,
    retainedPending: state.retainedPending, usersErased: state.deleted.users ?? 0 };
}

async function redactSignupFunnel(tx: LedgerTx, accountId: string): Promise<Record<string, number>> {
  const ownUserIds = tx.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
  const ownEmails = tx.select({ e: users.email }).from(users).where(eq(users.accountId, accountId));
  const ownedInvite = or(inArray(invites.email, ownEmails), inArray(invites.consumedByUserId, ownUserIds));
  const ownedWaitlist = inArray(waitlist.email, ownEmails);
  const key = (value: string | null) => setAccountLookupKey(tx, accountId, value);
  const inviteIds = new Set<string>();
  const waitlistIds = new Set<string>();
  const members = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.accountId, accountId));
  for (const member of members) {
    await key(member.email);
    const byAddress = await tx.select({ id: invites.id }).from(invites).where(eq(invites.email, member.email));
    const waiting = await tx.select({ id: waitlist.id }).from(waitlist).where(eq(waitlist.email, member.email));
    await key(member.id);
    const byConsumer = await tx.select({ id: invites.id }).from(invites).where(eq(invites.consumedByUserId, member.id));
    for (const row of [...byAddress, ...byConsumer]) inviteIds.add(row.id);
    for (const row of waiting) waitlistIds.add(row.id);
  }
  // The immutable key stays visible to the API policy after the address changes.
  const redacted = { invites: 0, waitlist: 0 };
  const erasedInvite = sql`'erased-' || ${invites.id}::text || '@invalid'`;
  for (const id of inviteIds) {
    await key(id);
    redacted.invites += n(await tx.update(invites).set({ email: erasedInvite })
      .where(and(eq(invites.id, id), ownedInvite, ne(invites.email, erasedInvite))));
  }
  for (const id of waitlistIds) {
    await key(id);
    redacted.waitlist += n(await tx.update(waitlist).set({ email: sql`'erased-' || ${waitlist.id}::text || '@invalid'` })
      .where(and(eq(waitlist.id, id), ownedWaitlist)));
  }
  if (members.length > 0) await key(null);
  return redacted;
}

const SLICE_FINISHED = Symbol("account erasure slice complete");

/** Build a bounded primary-key page. The CTE makes the limit apply to the whole write. */
function erasurePage(table: PgTable, where: SQL | undefined, limit: number | undefined): SQL | undefined {
  if (limit === undefined) return where;
  const config = getTableConfig(table);
  const keys = config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
  if (keys.length === 0) throw new Error(`account erasure has no primary key for ${config.name}`);
  const qualified = sql.join(keys.map((column) => sql`${column}`), sql`, `);
  const names = sql.join(keys.map((column) => sql.identifier(column.name)), sql`, `);
  return and(where, sql`(${qualified}) in (with page as materialized (
    select ${qualified} from ${table} where ${where} order by ${qualified} limit ${limit}
  ) select ${names} from page)`);
}

export async function deleteAccount(ctx: ErasureContext, opts: ErasureOptions = {}): Promise<DeleteAccountResult> {
  return ctx.db.transaction(async (tx) => {
    const result = await sweepAccount(ctx, tx as unknown as LedgerTx, opts);
    if (opts.billingOutcome !== undefined) {
      const state = recordBillingOutcome({ ...erasureProgress(opts), complete: true,
        deleted: result.deleted, redacted: result.redacted, stagingTicketsExpired: result.stagingTicketsExpired,
        retainedPending: result.retainedPending }, opts.billingOutcome, ctx.now());
      await tx.update(accounts).set({ erasureProgress: sql`coalesce(${accounts.erasureProgress}, ${JSON.stringify(state)}::jsonb)` })
        .where(eq(accounts.id, ctx.accountId));
    }
    return result;
  });
}

async function sweepAccount(
  ctx: ErasureContext, tx: LedgerTx, opts: ErasureOptions, checkpoint?: Progress,
): Promise<DeleteAccountResult> {
    const accountId = ctx.accountId;
    const deleted = checkpoint?.deleted ?? {};
    const redacted = checkpoint?.redacted ?? {};
    const finished = new Set(checkpoint?.finished ?? []);
    let remaining = ERASURE_SLICE_ROWS;
    const deadline = Date.now() + 4_000;
    const step = async (
      key: string, counts: Record<string, number>, run: (limit: number | undefined) => PromiseLike<unknown>,
    ): Promise<void> => {
      if (finished.has(key)) return;
      if (checkpoint && (remaining === 0 || Date.now() >= deadline)) throw SLICE_FINISHED;
      const affected = n(await run(checkpoint ? remaining : undefined));
      counts[key] = (counts[key] ?? 0) + affected;
      if (checkpoint) {
        remaining = Math.max(0, remaining - affected);
        if (remaining === 0) throw SLICE_FINISHED;
        checkpoint.finished.push(key);
      }
    };
    const reopen = async (key: string, select: () => PromiseLike<readonly unknown[]>): Promise<boolean> => {
      if (!checkpoint || !finished.has(key) || (await select()).length === 0) return false;
      finished.delete(key);
      checkpoint.finished = checkpoint.finished.filter((step) => step !== key);
      return true;
    };
    const page = (table: PgTable, where: SQL | undefined) =>
      erasurePage(table, where, checkpoint ? remaining : undefined);
    const drop = (key: string, run: () => PromiseLike<unknown>) => step(key, deleted, run);

    /**
     * The erasure fence's stamp — the FIRST statement. `accounts` survives erasure, so nothing
     * structural refuses a LATE settings writer: a consent PATCH in flight could recreate rows a
     * millisecond after the catalog sweep counted zero. The stamp is the interlock: it takes the
     * account row's exclusive lock at the top of this transaction; every settings writer opens by
     * reading the row `FOR SHARE` and refuses on a stamp (`erasure-fence.ts`). Whichever side
     * wins, zero rows survive. `coalesce` keeps a retried erasure on the FIRST stamp. The instant
     * travels as ISO text: a Date in a raw `sql` fragment is refused by postgres-js while PGlite
     * accepts it — the driver split the pg suite exists to catch.
     */
    if (!checkpoint) {
      await tx.update(accounts)
        .set({ erasedAt: sql`coalesce(${accounts.erasedAt}, ${ctx.now().toISOString()}::timestamptz)` })
        .where(eq(accounts.id, accountId));
      await checkErasureWarning(tx, accountId, opts.warnedFor);
    }
    const warnedFor = opts.warnedFor;

    /**
     * The global lock order: `account_settings` FIRST, the change-log sequence row second
     * (`recordSettingsChange` in consent-seed.ts states it). This transaction once deleted
     * `change_log`/`account_sync_state` before `account_settings` — the reverse order, which
     * deadlocks against a consent PATCH racing the erasure: the PATCH holds the settings row and
     * waits on the sequence row this transaction holds, and Postgres can kill the erasure itself.
     * The settings delete runs first — a delete takes the row lock as an update would, creates
     * nothing, and a knob write inserting afresh queues on it while holding nothing, so no cycle
     * forms.
     */
    await drop("account_settings", () => tx.delete(accountSettings).where(page(accountSettings, eq(accountSettings.accountId, accountId))));
    // The calendar's settings beside the account's own, and for the same reason: a switch's write
    // takes the settings stamp first, so the settings rows go before the counter.
    await drop("cal_settings", () => tx.delete(calSettings).where(page(calSettings, eq(calSettings.accountId, accountId))));

    /**
     * The user- and mailbox-keyed predicates are SUBQUERIES, not materialized id lists. Both
     * parents are deleted at the END of this transaction, so the subqueries read rows still
     * present at every line that uses them. `select`s and not arrays for the reason at the
     * message-keyed deletes below: an id list is one bind parameter per row against a collection
     * with no ceiling — "it is small today" is not a bound, and the subquery form costs nothing.
     * `userRows` is still READ for one thing an `IN` predicate cannot give: the erasure receipt's
     * `usersErased` count.
     */
    const ownUserIds = tx.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
    const ownMailboxIds = tx.select({ id: mailboxes.id })
      .from(mailboxes).where(eq(mailboxes.accountId, accountId));

    if (!checkpoint) {
      // ── SERIALIZE AGAINST THE THREAD BACKFILL, before any lock this transaction takes. ──
      // See {@link ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}: erasure and the backfill lock `threads`
      // and `messages` in opposite orders for reasons neither can give up, so instead of racing
      // to acquire them, whichever gets here first finishes its whole sweep before the other
      // proceeds. Releases at COMMIT, same as every advisory lock this repo takes for this.
      // scoped-by: an advisory lock keyed by this account's own id — no row is read or written
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}, hashtext(${accountId}))`);

      // ── THE MAILBOX ROWS, FOR UPDATE, before any delete. Every ingest commit takes its mailbox row
      // first (the lease fence, the liveness read, or a new message's own key to it), so this orders
      // them all behind the erasure: one in flight commits first and is swept below, a later one waits
      // and is refused by the parent it no longer has. Without it a first sync committed a message and
      // its body between the body and message deletes (23503 on the body's key), or held the counter
      // row this transaction deletes (40P01). After the thread-structure lock, as the mailbox sweep.
      await tx.select({ id: mailboxes.id }).from(mailboxes)
        .where(eq(mailboxes.accountId, accountId))
        .orderBy(asc(mailboxes.id))
        .for("update");
      // THE CALENDAR'S CONNECTIONS, FOR UPDATE, after the mailboxes: a calendar writer's fence
      // (`@trafficflow/db/calendar` `holdCalendarConnection`) holds the account's row, its mailbox's
      // and its connection's FOR SHARE in that order, so one in flight commits first and is swept
      // below, and a later one finds the stamp.
      await tx.select({ id: calConnections.id }).from(calConnections)
        .where(eq(calConnections.accountId, accountId))
        .orderBy(asc(calConnections.id))
        .for("update");

      // ── 0. THE THREAD-FIRST FENCE. Every live writer of a thread takes thread rows before
      // message or draft rows (ingest's mergeThreadMessage, both merge paths, the drafts
      // service's reply-target lock). Erasure's DELETE order is forced the other way by the
      // FKs — children before parents, so messages before threads — which would make it the
      // one transaction acquiring locks against the shared order and a deadlock partner for
      // any concurrent merge. Locking every thread row up front, in the shared stable order,
      // puts erasure's ACQUISITION on the same order as everyone else; the deletes below then
      // touch rows nobody else can be holding the other half of. The rows all die in this
      // transaction anyway, so the locks cost nothing extra.
      await tx.select({ id: threads.id }).from(threads)
        .where(eq(threads.accountId, accountId))
        .orderBy(asc(threads.id))
        .for("update");

    }

    // ── 1. Sends and drafts (drafts reference mailboxes, threads AND messages) ──
    //
    // The content claim goes FIRST and EXPLICITLY, though its foreign key also cascades from
    // `outbound_sends` below. Both, deliberately: the cascade is what makes the other two cleanup
    // paths work (the desktop mirror wipe and the local mirror's per-draft delete, neither of which
    // is going to grow a per-table list), and the explicit delete is what makes this service's
    // ruling on the table READABLE — the erasure census asks for a written ruling per table, and
    // "it happens to cascade from the row below" is not one somebody auditing this can see.
    // The owed Sent copies (a delivered message's bytes) go the same way, and first.
    await drop("outbound_sent_copies", () => tx.delete(outboundSentCopies).where(page(outboundSentCopies, eq(outboundSentCopies.accountId, accountId))));
    // A scheduled letter's kept files, before the drafts that name them.
    await drop("scheduled_send_files", () => tx.delete(scheduledSendFiles).where(page(scheduledSendFiles, eq(scheduledSendFiles.accountId, accountId))));
    await drop("outbound_send_fingerprints", () => tx.delete(outboundSendFingerprints).where(page(outboundSendFingerprints, eq(outboundSendFingerprints.accountId, accountId))));
    await drop("outbound_sends", () => tx.delete(outboundSends).where(page(outboundSends, eq(outboundSends.accountId, accountId))));
    await drop("drafts", () => tx.delete(drafts).where(page(drafts, eq(drafts.accountId, accountId))));

    // 2. Everything hanging off a message. TAGS FIRST, before `messages`: `message_tags` FKs both
    // `messages` and `tags` with `ON DELETE no action`, so deleting either parent while an
    // assignment survives aborts the whole erasure — an Art. 17 request failing on a foreign key.
    // Child before parent is the load-bearing order. This is also where the product's tags claim
    // becomes true: tags are OURS, not IMAP — a disconnect keeps them, erasure takes them, and
    // these two lines are the whole of "takes them"; folders survive because they are real
    // folders in someone else's mailbox. `unsubscribe_records` goes before `messages` and
    // `mailboxes` too: it FKs both, so a missed line fails erasure LOUDLY rather than retaining a
    // list of what somebody unsubscribed from.
    // Child before parent: the marks reference the record by foreign key.
    await drop("unsubscribe_examined", () => tx.delete(unsubscribeExamined).where(page(unsubscribeExamined, eq(unsubscribeExamined.accountId, accountId))));
    await drop("unsubscribe_records", () => tx.delete(unsubscribeRecords).where(page(unsubscribeRecords, eq(unsubscribeRecords.accountId, accountId))));
    await drop("message_tags", () => tx.delete(messageTags).where(page(messageTags, eq(messageTags.accountId, accountId))));
    await drop("tags", () => tx.delete(tags).where(page(tags, eq(tags.accountId, accountId))));
    await drop("attachments", () => tx.delete(attachments).where(page(attachments, eq(attachments.accountId, accountId))));
    await drop("tracker_events", () => tx.delete(trackerEvents).where(page(trackerEvents, eq(trackerEvents.accountId, accountId))));
    await drop("message_states", () => tx.delete(messageStates).where(page(messageStates, eq(messageStates.accountId, accountId))));
    // The invitations' identities (mail 0204). They would go with their letters; named, so the
    // receipt counts them and the sweep does not rest on a cascade.
    await drop("message_invitations", () => tx.delete(messageInvitations).where(page(messageInvitations, eq(messageInvitations.accountId, accountId))));
    // BEFORE `routing_decisions`, since mail 0118 gave `routing_decision_id` a real key.
    await drop("approvals", () => tx.delete(approvals).where(page(approvals, eq(approvals.accountId, accountId))));
    // `routing_decisions` is also where a BOUGHT SCREENER SUGGESTION lives — same table, told
    // apart by `input_provenance` (see `screener-suggestion.ts`). One delete covers both.
    await drop("routing_decisions", () => tx.delete(routingDecisions).where(page(routingDecisions, eq(routingDecisions.accountId, accountId))));
    // BEFORE `messages` AND before `mailboxes` — this table FKs BOTH, `ON DELETE no action`, and
    // every sync writes it. It is the row that says WHERE a message physically is on the server
    // (folder, uidvalidity, uid), one per copy, so it is mail-locator data and it goes.
    await drop("message_instances", () => tx.delete(messageInstances).where(page(messageInstances, eq(messageInstances.accountId, accountId))));
    // BEFORE `mailboxes`, which it FKs `ON DELETE no action`. Content-free by design — a
    // coordinate and a code — but a coordinate into somebody's mailbox is still theirs.
    await drop("message_failures", () => tx.delete(messageFailures).where(page(messageFailures, eq(messageFailures.accountId, accountId))));
    // `message_bodies`, `folder_state` and `flag_state` key off the MESSAGE, not the account. A
    // SUBQUERY — this used to be a materialized id list: one bind parameter PER MESSAGE, three
    // times over, and PostgreSQL refuses a statement with more than 65 535 parameters, so
    // self-serve erasure stopped working exactly for the largest real accounts. Nothing warned —
    // a small mailbox erases fine and every test account is small. The ids now never leave
    // PostgreSQL: no array, no parameter list, no cardinality to bound, and the planner joins
    // instead of matching a literal list. The `messages` delete is still by `account_id` and runs
    // AFTER these three (FK order), so the subquery resolves against rows still present.
    const ownMessageIds = tx.select({ id: messages.id })
      .from(messages).where(eq(messages.accountId, accountId));
    // scoped-by: ownMessageIds — the account-scoped messages subquery two lines up
    await drop("message_bodies", () => tx.delete(messageBodies).where(page(messageBodies, inArray(messageBodies.messageId, ownMessageIds))));
    // The search documents (mail 0125) carry the body's words, so they go with the bodies —
    // before `messages`, which they reference. Keyed by the account like the row itself.
    await drop("message_search", () => tx.delete(messageSearch).where(page(messageSearch, eq(messageSearch.accountId, accountId))));
    // scoped-by: ownMessageIds — the account-scoped messages subquery above
    await drop("folder_state", () => tx.delete(folderState).where(page(folderState, inArray(folderState.messageId, ownMessageIds))));
    // `folder_state`'s twin for the `\Seen` flag, and it has no `account_id` either — which is
    // why the catalog sweep could never have seen it. Read state is user data.
    // scoped-by: ownMessageIds — the account-scoped messages subquery above
    await drop("flag_state", () => tx.delete(flagState).where(page(flagState, inArray(flagState.messageId, ownMessageIds))));

    // ── 3. Notes, then their parents ────────────────────────────────────────────
    await drop("thread_notes", () => tx.delete(threadNotes).where(page(threadNotes, eq(threadNotes.accountId, accountId))));
    await drop("contact_notes", () => tx.delete(contactNotes).where(page(contactNotes, eq(contactNotes.accountId, accountId))));
    // BEFORE `messages`, since mail 0118 — the composite account key on `message_id` is a real
    // reference now, where this table carried a bare id nothing checked. The reasons below are
    // unchanged; only the position is newly load-bearing.
    // BEFORE the responder itself. The 0087 pair is not here for tidiness: `away_replies.sender`
    // and `away_sender_state.sender` are CORRESPONDENTS' email addresses — somebody else's personal
    // data, held because we sent them mail — and `away_replies` additionally records that a named
    // person wrote to this account and when. That is exactly the class the catalog sweep in
    // `account-deletion.test.ts` enumerates (every table with an `account_id` column, failing on any
    // surviving row),
    // so both go, and both were red in that sweep until they did.
    await drop("away_replies", () => tx.delete(awayReplies).where(page(awayReplies, eq(awayReplies.accountId, accountId))));
    await drop("messages", () => tx.delete(messages).where(page(messages, eq(messages.accountId, accountId))));
    await drop("threads", () => tx.delete(threads).where(page(threads, eq(threads.accountId, accountId))));
    await drop("contacts", () => tx.delete(contacts).where(page(contacts, eq(contacts.accountId, accountId))));
    // The addresses the account's mail named as lists, and the brands it consented there (mail 0150).
    await drop("list_addresses", () => tx.delete(listAddresses).where(page(listAddresses, eq(listAddresses.accountId, accountId))));
    // The stored-body byte counter (mail 0062). AFTER `message_bodies`, whose bytes it counts:
    // a number derived from mail somebody erased is itself residue, and the catalog sweep
    // enumerates this table by its `account_id` column, so forgetting this line is a red test.
    await drop("account_storage", () => tx.delete(accountStorage).where(page(accountStorage, eq(accountStorage.accountId, accountId))));

    // ── 4. Mailboxes — the credentials go with them ─────────────────────────────
    // Subqueries for the same reason the message-keyed deletes above use them: the SELF-HOST
    // imposes no mailbox count limit at all (`SELF_HOST_MAILBOX_ALLOWANCE`), so a materialized
    // list here has no ceiling either — smaller in practice than the message list and the same
    // shape, which is the whole argument for preferring the subquery everywhere rather than
    // only where a count is known to be large.
    await drop("mailbox_credentials", () => tx.delete(mailboxCredentials).where(page(mailboxCredentials, inArray(mailboxCredentials.mailboxId, ownMailboxIds))));
    // The folder COMMANDS before the folder inventory they reference (mail 0074). The FK
    // would CASCADE these with the inventory rows anyway; the delete is explicit so the
    // erasure receipt counts them and the ruling is written where the census looks — a
    // rename target is the user's own words, not residue to leave to a side effect.
    await drop("folder_ops", () => tx.delete(folderOps).where(page(folderOps, inArray(folderOps.mailboxId, ownMailboxIds))));
    // The junk rescues beside them, and for the same reason: each row is a command the person
    // pressed, naming their Junk folder and one coordinate in it. No foreign key to `messages`
    // — Junk never enters the mirror — so nothing else would take them.
    await drop("junk_rescues", () => tx.delete(junkRescues).where(page(junkRescues, inArray(junkRescues.mailboxId, ownMailboxIds))));
    await drop("mailbox_folders", () => tx.delete(mailboxFolders).where(page(mailboxFolders, inArray(mailboxFolders.mailboxId, ownMailboxIds))));
    // BEFORE `mailboxes`, since mail 0118 — the composite account key on `mailbox_id` is a real
    // reference now. Both rows still OUTLIVE the mailbox everywhere else: nothing but an account
    // erasure deletes a mailbox row, a removal leaves the tombstone.
    // The reader's outstanding decisions (mail 0088). Its `payload` carries whatever the person
    // decided about a sender — on a `screener.decide` that is a CORRESPONDENT'S ADDRESS and the
    // verdict passed on them, which is the same class as the two rows above it and is held for a
    // shorter time only by luck. The table has no foreign key by design (the record has to outlive
    // the message and the mailbox row), so nothing cascades it and this line is the only thing
    // that removes it. The catalog sweep enumerates every table with an `account_id` column, so
    // this was red there until it landed.
    await drop("organizer_requests", () => tx.delete(organizerRequests).where(page(organizerRequests, eq(organizerRequests.accountId, accountId))));
    // The other half of that channel (mail 0094): what the ORGANIZER published, cached here by an
    // install that only READS this mailbox. `doc` is the whole profile document, so it holds the
    // screener list's CORRESPONDENT ADDRESSES, the person's own rule text and the away-responder
    // body they wrote — a superset of the classes the three rows above it are deleted for, in one
    // bag. It is keyed by mailbox and has no foreign key (the same design as the row above: the
    // cache has to outlive the mailbox row it names), so nothing cascades it and this line is the
    // only thing that removes it.
    await drop("mailbox_profile_mirror", () => tx.delete(mailboxProfileMirror).where(page(mailboxProfileMirror, eq(mailboxProfileMirror.accountId, accountId))));
    await drop("screener_learning", () => tx.delete(screenerLearning).where(page(screenerLearning, eq(screenerLearning.accountId, accountId))));
    await drop("mailboxes", () => tx.delete(mailboxes).where(page(mailboxes, eq(mailboxes.accountId, accountId))));
    // Where the account's one-time passes stood (mail 0203): its mailboxes' rows and its own.
    // AFTER `mailboxes` and `account_settings`, on purpose: the table has no key into either, and
    // a pass writes its row holding its mailbox's row or the settings row. This transaction has
    // waited for that write by the time it gets here, and a write that comes later finds no
    // mailbox and an erased account (`pass-progress.ts`).
    await drop("pass_progress", () => tx.delete(passProgress).where(page(passProgress, eq(passProgress.accountId, accountId))));

    // ── THE CALENDAR (mail 0205), children before the rows they hang on. Rows first, then the
    // counter below, as every writer takes them: below the counter this would deadlock with one.
    await drop("cal_attendees", () => tx.delete(calAttendees).where(page(calAttendees, eq(calAttendees.accountId, accountId))));
    await drop("cal_alarms", () => tx.delete(calAlarms).where(page(calAlarms, eq(calAlarms.accountId, accountId))));
    await drop("cal_writes", () => tx.delete(calWrites).where(page(calWrites, eq(calWrites.accountId, accountId))));
    await drop("cal_suggestions", () => tx.delete(calSuggestions).where(page(calSuggestions, eq(calSuggestions.accountId, accountId))));
    await drop("cal_links", () => tx.delete(calLinks).where(page(calLinks, eq(calLinks.accountId, accountId))));
    await drop("cal_events", () => tx.delete(calEvents).where(page(calEvents, eq(calEvents.accountId, accountId))));
    await drop("cal_calendars", () => tx.delete(calCalendars).where(page(calCalendars, eq(calCalendars.accountId, accountId))));
    await drop("cal_push_channels", () => tx.delete(calPushChannels).where(page(calPushChannels, eq(calPushChannels.accountId, accountId))));
    await drop("cal_credentials", () => tx.delete(calCredentials).where(page(calCredentials, eq(calCredentials.accountId, accountId))));
    await drop("cal_connections", () => tx.delete(calConnections).where(page(calConnections, eq(calConnections.accountId, accountId))));

    // ── 5. Automation, knowledge, preferences ───────────────────────────────────
    await drop("workflow_runs", () => tx.delete(workflowRuns).where(page(workflowRuns, eq(workflowRuns.accountId, accountId))));
    await drop("workflows", () => tx.delete(workflows).where(page(workflows, eq(workflows.accountId, accountId))));
    await drop("workflow_proposals", () => tx.delete(workflowProposals).where(page(workflowProposals, eq(workflowProposals.accountId, accountId))));
    await drop("kb_entries", () => tx.delete(kbEntries).where(page(kbEntries, eq(kbEntries.accountId, accountId))));
    await drop("snippets", () => tx.delete(snippets).where(page(snippets, eq(snippets.accountId, accountId))));
    await drop("notify_rules", () => tx.delete(notifyRules).where(page(notifyRules, eq(notifyRules.accountId, accountId))));
    await drop("away_sender_state", () => tx.delete(awaySenderState).where(page(awaySenderState, eq(awaySenderState.accountId, accountId))));
    await drop("away_responders", () => tx.delete(awayResponders).where(page(awayResponders, eq(awayResponders.accountId, accountId))));
    await drop("rules", () => tx.delete(rules).where(page(rules, eq(rules.accountId, accountId))));
    // The rules the person removed (mail 0178): each row names a rule's key, the person's own words.
    await drop("rule_removals", () => tx.delete(ruleRemovals).where(page(ruleRemovals, eq(ruleRemovals.accountId, accountId))));
    await drop("graduations", () => tx.delete(graduations).where(page(graduations, eq(graduations.accountId, accountId))));
    await drop("learning_signals", () => tx.delete(learningSignals).where(page(learningSignals, eq(learningSignals.accountId, accountId))));

    // ── 6. Sync plumbing and the operational trail ──────────────────────────────
    await drop("change_log", () => tx.delete(changeLog).where(page(changeLog, eq(changeLog.accountId, accountId))));
    await drop("account_sync_state", () => tx.delete(accountSyncState).where(page(accountSyncState, eq(accountSyncState.accountId, accountId))));
    await drop("audit_log", () => tx.delete(auditLog).where(page(auditLog, eq(auditLog.accountId, accountId))));
    await drop("idempotency_keys", () => tx.delete(idempotencyKeys).where(page(idempotencyKeys, eq(idempotencyKeys.accountId, accountId))));
    await drop("push_subscriptions", () => tx.delete(pushSubscriptions).where(page(pushSubscriptions, eq(pushSubscriptions.accountId, accountId))));
    // The worker's suggest-owed mark (cloud 0039): scheduling priority only, but keyed by the
    // account — and `accounts` is RETAINED as a pseudonymous row, so the FK's cascade never fires
    // for an erasure. Without this line the mark would outlive the person it schedules work for.
    await drop("screener_suggest_owed", () => tx.delete(screenerSuggestOwed).where(page(screenerSuggestOwed, eq(screenerSuggestOwed.accountId, accountId))));
    // A lower storage limit's hold (cloud 0055): limits and a date, keyed by the account, same reason.
    await drop("account_storage_holds", () => tx.delete(accountStorageHolds).where(page(accountStorageHolds, eq(accountStorageHolds.accountId, accountId))));
    // The storage estimate's snapshot, the card's dismissal and mail switch, and the storage mails
    // sent (cloud 0057): counts, limits and instants, keyed by the account, the same reason.
    await drop("mailbox_storage_stats", () => tx.delete(mailboxStorageStats).where(page(mailboxStorageStats, eq(mailboxStorageStats.accountId, accountId))));
    await drop("account_storage_prefs", () => tx.delete(accountStoragePrefs).where(page(accountStoragePrefs, eq(accountStoragePrefs.accountId, accountId))));
    await drop("storage_mail_sent", () => tx.delete(storageMailSent).where(page(storageMailSent, eq(storageMailSent.accountId, accountId))));
    // The account's own preferences — the dormancy dial, the Ohbox posture, and
    // `seed_confirmed_at`, which is the CONSENT EVENT of onboarding — were deleted FIRST, at
    // the top of this transaction: consent to something is a record about a person and there
    // is nobody left to have consented, and the settings row is also the first lock in the
    // global order every settings writer takes (see the note at the top).

    // ── 6b. The HOSTED-ONLY account-scoped rows ─────────────────────────────────
    // Seven Cloud tables key off `accounts`, which erasure does NOT delete — so none of these
    // raises a foreign-key error and none of them was ever visible as a failure. They are the
    // quiet half of this fix and they are all personal data.
    //
    // A ceremony holds the KEK-wrapped PKCE verifier for a mailbox connect that was in flight,
    // plus `return_to`. Unconsumed, it is a live half of a consent flow for an account with no
    // users left to finish it.
    await drop("mailbox_oauth_ceremonies", () => tx.delete(mailboxOauthCeremonies).where(page(mailboxOauthCeremonies, eq(mailboxOauthCeremonies.accountId, accountId))));
    // Its DEVICE-CODE sibling (cloud 0027), for the identical reason and with a sharper edge: this
    // row holds the KEK-wrapped `device_code`, which is a BEARER CREDENTIAL for the whole ceremony
    // rather than a PKCE verifier that buys nothing on its own. Same `accounts` FK, same absent
    // cascade, so the same silence — and the opportunistic prune only runs when somebody starts
    // ANOTHER device ceremony on this deployment, which on an account that has just erased itself
    // may be never.
    await drop("mailbox_oauth_device_ceremonies", () => tx.delete(mailboxOauthDeviceCeremonies).where(page(mailboxOauthDeviceCeremonies, eq(mailboxOauthDeviceCeremonies.accountId, accountId))));
    // What an entitlements program holds is erased by THAT program: attempt claims, setup pools,
    // the suspension note and the customer email belong to whoever operates metering, reached
    // through the port's `releaseAccount`, which both callers make BEFORE this transaction (the
    // route, `eraseOneDueAccount`); nothing here dials anything. NOT a delete — the staging
    // row is the only key to bytes in the staging bucket, and the sweep removes row and object
    // together, keyed on `expires_at <= now()`; bringing the expiry forward hands both to the
    // next maintenance pass, while deleting the row would strand the attachment for the life of
    // the deployment. `gt(expires_at, now)` keeps this IDEMPOTENT: a second erasure matches
    // nothing and reports zero.
    const expiry = ctx.now();
    const staging = and(eq(attachmentStaging.accountId, accountId), gt(attachmentStaging.expiresAt, expiry));
    const expired = { attachment_staging: checkpoint?.stagingTicketsExpired ?? 0 };
    try {
      await step("attachment_staging", expired, (limit) => tx.update(attachmentStaging).set({ expiresAt: expiry })
        .where(erasurePage(attachmentStaging, staging, limit)));
    } finally {
      if (checkpoint) checkpoint.stagingTicketsExpired = expired.attachment_staging;
    }

    // WHAT WE STILL OWE THIS ACCOUNT (cloud 0036). `accounts` is kept, so the FK cascade never
    // fires here. A SETTLED row is only a reminder and goes. A PENDING one is money owed to the
    // person, a financial record kept on the `accounts` row's own basis: PSEUDONYMISED in place
    // (`meta`, `last_fault`, `claimed_until` cleared; what stays is ids, a closed reason and
    // counts), and the drain settles it through `release()` like any other. No call from here.
    // Where nothing drains (`drainsRefunds` absent), a kept row would be inert, so all of it goes.
    let retainedPending = checkpoint?.retainedPending ?? 0;
    if (opts.drainsRefunds === true) {
      await drop("credit_refund_obligations", () => tx.delete(creditRefundObligations).where(page(creditRefundObligations, and(
        eq(creditRefundObligations.accountId, accountId), isNotNull(creditRefundObligations.settledAt)))));
      if (!finished.has("pending_refunds")) {
        retainedPending = n(await tx.update(creditRefundObligations)
          .set({ meta: null, lastFault: null, claimedUntil: null })
          .where(and(eq(creditRefundObligations.accountId, accountId), isNull(creditRefundObligations.settledAt))));
        if (checkpoint) {
          checkpoint.retainedPending = retainedPending;
          checkpoint.finished.push("pending_refunds");
        }
      }
    } else {
      await drop("credit_refund_obligations", () => tx.delete(creditRefundObligations).where(page(creditRefundObligations, eq(creditRefundObligations.accountId, accountId))));
    }

    // The wall's notice ledger (cloud 0040). Deleted, never left to the FK CASCADE: the account
    // row SURVIVES erasure as the pseudonymous billing subject, so the cascade never fires. A
    // notice is a reminder about a person's lifecycle, not a financial record. ONE row stays on a
    // retention erasure: the delivered warning for its date, the account's random id, a CHECK-closed
    // word and three instants, so ohmail can show afterwards that the warning went out; the worker
    // deletes it ten years after the erasure (`pruneErasedNotices`). The nightly pass skips erased
    // accounts by `erased_at`, so nothing re-inserts one.
    await drop("account_lifecycle_notices", () => tx.delete(accountLifecycleNotices).where(page(accountLifecycleNotices, and(
      eq(accountLifecycleNotices.accountId, accountId),
      ...(warnedFor !== undefined
        ? [or(ne(accountLifecycleNotices.kind, "erasure_week"), ne(accountLifecycleNotices.anchor, warnedFor))]
        : []),
    ))));
    // How connecting a mailbox ended (cloud 0054): the managed API's record, written through the fence.
    await drop("connect_attempts", () => tx.delete(connectAttempts).where(page(connectAttempts, eq(connectAttempts.accountId, accountId))));

    // ── 7. Sessions, devices, and every credential the user holds ───────────────
    if (!checkpoint) {
      // THE SESSION ROWS, FOR UPDATE, in id order, before anything here reads or deletes a token: every
      // writer of a session family takes its session row first, and without this a renewal racing the
      // step deadlocked it (40P01) or committed behind the token delete (23503). Every transaction
      // that writes a row this erasure deletes opens on the account row (the fence), so it commits
      // before this transaction's first statement or waits behind it; the hot-path renewal needs no
      // fence, it meets the session lock.
      await dialect(ctx.db).forUpdate(tx.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.accountId, accountId))
        .orderBy(asc(sessions.id)));
      // THEN THE USER ROWS, FOR UPDATE and never FOR NO KEY UPDATE: it has to conflict with the KEY SHARE
      // every foreign-key check takes. A write outside the account fence, such as a pairing token,
      // either committed before this, and every such table is deleted below, or waits here and is refused
      // by its key once the users are gone. Sessions then users: the order a renewal and the reaper take.
      await dialect(ctx.db).forUpdate(tx.select({ id: users.id }).from(users)
        .where(eq(users.accountId, accountId))
        .orderBy(asc(users.id)));
      // The live tokens' HASHES are kept first (cloud 0043), so an installed app still holding one
      // is told the account was deleted instead of being answered as a stranger and renewing for
      // ever. A hash of a random secret and the account id — nothing about a person.
      await recordErasedBearers(tx, accountId, ctx.now());
    } else {
      // Revisit the child steps before any parent delete can hit their foreign keys. The
      // account fence excludes new sessions. Lock the sessions this slice can delete to
      // serialize their cleanup with rotations that take the session lock.
      await reopen("sessions", () => tx.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.accountId, accountId)).limit(1));
      if (!finished.has("sessions")) {
        await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, accountId))
          .orderBy(asc(sessions.id)).limit(remaining).for("update");
      }
      await reopen("refresh_tokens", () => tx.select({ id: refreshTokens.id }).from(refreshTokens)
        .where(eq(refreshTokens.accountId, accountId)).limit(1));
    }
    await drop("refresh_tokens", () => tx.delete(refreshTokens).where(page(refreshTokens, eq(refreshTokens.accountId, accountId))));
    await drop("sessions", () => tx.delete(sessions).where(page(sessions, eq(sessions.accountId, accountId))));
    await drop("devices", () => tx.delete(devices).where(page(devices, eq(devices.accountId, accountId))));
    // Pairing tokens are CREDENTIALS THE USER MINTED (mail 0059): a live device-pair token
    // still opens this account, a live invite token still opens this server, and the label is
    // the user's own words. All of it goes — and it must go BEFORE the `users` delete below,
    // whose FK (`created_by_user_id`) would otherwise refuse the erasure outright. First-boot
    // tokens (creator NULL) belong to no user and are untouched.
    await drop("pairing_tokens", () => tx.delete(pairingTokens).where(page(pairingTokens, inArray(pairingTokens.createdByUserId, ownUserIds))));
    const ownLoginTokens = eq(loginTokens.accountId, accountId);
    const dropLoginTokens = () => drop("login_tokens", () => tx.delete(loginTokens).where(page(loginTokens, ownLoginTokens)));
    if (!checkpoint) await dropLoginTokens();
    await drop("oauth_auth_codes", () => tx.delete(oauthAuthCodes).where(page(oauthAuthCodes, inArray(oauthAuthCodes.userId, ownUserIds))));
    await drop("recovery_codes", () => tx.delete(recoveryCodes).where(page(recoveryCodes, inArray(recoveryCodes.userId, ownUserIds))));
    await drop("totp_secrets", () => tx.delete(totpSecrets).where(page(totpSecrets, inArray(totpSecrets.userId, ownUserIds))));
    await drop("webauthn_credentials", () => tx.delete(webauthnCredentials).where(page(webauthnCredentials, inArray(webauthnCredentials.userId, ownUserIds))));
    // Nullable userId, and since cloud 0038 a real key to `users` — so this delete is no longer
    // only about an unconsumed ceremony outliving the user it was started for: without it the
    // `users` delete below is refused outright. NULL rows are left, which is the key's own
    // reading of them.
    await drop("webauthn_challenges", () => tx.delete(webauthnChallenges).where(page(webauthnChallenges, and(isNotNull(webauthnChallenges.userId), inArray(webauthnChallenges.userId, ownUserIds)))));
    await drop("credentials", () => tx.delete(credentials).where(page(credentials, inArray(credentials.userId, ownUserIds))));
    // EVERY THROTTLE ROW THAT NAMES THIS ACCOUNT'S PEOPLE (`throttle-keys.ts`): by user id
    // (`user:`, `factor-day:`, `notice:factor:`), by the keyed hash of each address (`pw:<hA>:`,
    // `known:<hA>:`, `pwa:<hA>`, `notice:ceiling:<hA>`, the hashed `email:` and the mail quota's
    // `mail:unsolicited:<hA>` and `mail:transactional:<hA>`), and the legacy
    // `email:<addr>` a row written before the keys were hashed still carries. The hash needs the
    // server's subkey, so the addresses are read here; hex keys, so a LIKE prefix has no wildcard.
    // And the connect probes' rows, which name the account rather than a person.
    const people = await tx.select({ id: users.id, email: users.email })
      .from(users).where(eq(users.accountId, accountId));
    const exact: string[] = [];
    const prefixes: string[] = [];
    for (const p of people) {
      exact.push(`${THROTTLE_PREFIX.user}${p.id}`, `${THROTTLE_PREFIX.factorDay}${p.id}`,
        `${THROTTLE_PREFIX.notice}factor:${p.id}`, `email:${p.email}`);
      if (opts.throttleKeys) {
        const hA = opts.throttleKeys.address(p.email.trim().toLowerCase());
        exact.push(`${THROTTLE_PREFIX.addressCeiling}${hA}`, `${THROTTLE_PREFIX.notice}ceiling:${hA}`, `email:${hA}`,
          `mail:unsolicited:${hA}`, `mail:transactional:${hA}`);
        prefixes.push(`${THROTTLE_PREFIX.password}${hA}:%`, `${THROTTLE_PREFIX.knownClient}${hA}:%`);
      }
    }
    // Load it now's admission names the account itself, by its keyed hash (`live-body-admit.ts`).
    if (opts.throttleKeys) exact.push(`live-body:${opts.throttleKeys.client(accountId)}`);
    await drop("auth_throttle", () => tx.delete(authThrottle).where(page(authThrottle, or(
      eq(authThrottle.noticeAccountId, accountId),
      ...(exact.length === 0 ? [] : [inArray(authThrottle.key, exact)]),
      ...prefixes.map((pattern) => like(authThrottle.key, pattern)),
      probeRowsOfAccount(accountId),
    ))));
    // The counters that name one of this account's rows carry its id since cloud 0101.
    await drop("account_counters", () => tx.delete(accountCounters).where(page(accountCounters, eq(accountCounters.accountId, accountId))));
    // ── 7b. THE SIGNUP FUNNEL — pseudonymised, not deleted ─────────────────────
    // `invites.email` and `waitlist.email` are the only thing in either row that names a person,
    // and neither table is in the account's foreign-key graph — deliberately, so an erasure never
    // has to choose between Art. 17 and the invite record. That is why the structural guard could
    // not see them and the sweep did not reach them.

    // REDACTED, not dropped: the funnel COUNT is a record about the service, the address is a
    // record about a person. The pseudonym carries the row's own id, so `waitlist_email_unique`
    // holds when two of an account's users were both listed. Built in Postgres, like
    // `auth_throttle` above. BEFORE the `users` delete, which the addresses are read from; an
    // invite matches by binding AND by consumer, so a changed address leaves no row behind.
    if (!checkpoint) Object.assign(redacted, await redactSignupFunnel(tx, accountId));

    // auth_events carries ip + device per login. Account-scoped rows go with the
    // account; user-scoped rows that predate the account (unknown-email attempts)
    // are already anonymous, and there is no key to find them by. It stays BEFORE the `users`
    // delete below, and since cloud 0038 that order is the database's rather than this file's:
    // the composite key refuses the parent while a row still names it.
    if (checkpoint) {
      // Lock the users this slice can remove before checking for tokens from older issuers.
      await tx.select({ id: users.id }).from(users).where(eq(users.accountId, accountId))
        .orderBy(asc(users.id)).limit(remaining).for("update");
      await reopen("login_tokens", () => tx.select({ id: loginTokens.id }).from(loginTokens).where(ownLoginTokens).limit(1));
      await dropLoginTokens();
      // A request already in flight when the erasure was accepted can still add a row that names
      // a user after its step finished. The user lock above holds back any newer one; the steps
      // that found a row run again before the users are deleted.
      const lateRows: Array<[string, () => PromiseLike<readonly unknown[]>]> = [
        ["devices", () => tx.select({ id: devices.id }).from(devices).where(eq(devices.accountId, accountId)).limit(1)],
        ["pairing_tokens", () => tx.select({ id: pairingTokens.id }).from(pairingTokens).where(inArray(pairingTokens.createdByUserId, ownUserIds)).limit(1)],
        ["oauth_auth_codes", () => tx.select({ id: oauthAuthCodes.id }).from(oauthAuthCodes).where(inArray(oauthAuthCodes.userId, ownUserIds)).limit(1)],
        ["recovery_codes", () => tx.select({ id: recoveryCodes.id }).from(recoveryCodes).where(inArray(recoveryCodes.userId, ownUserIds)).limit(1)],
        ["totp_secrets", () => tx.select({ id: totpSecrets.id }).from(totpSecrets).where(inArray(totpSecrets.userId, ownUserIds)).limit(1)],
        ["webauthn_credentials", () => tx.select({ id: webauthnCredentials.id }).from(webauthnCredentials).where(inArray(webauthnCredentials.userId, ownUserIds)).limit(1)],
        ["webauthn_challenges", () => tx.select({ id: webauthnChallenges.id }).from(webauthnChallenges).where(inArray(webauthnChallenges.userId, ownUserIds)).limit(1)],
        ["credentials", () => tx.select({ id: credentials.id }).from(credentials).where(inArray(credentials.userId, ownUserIds)).limit(1)],
      ];
      let late = false;
      for (const [key, select] of lateRows) late = (await reopen(key, select)) || late;
      if (late) throw SLICE_FINISHED;
    }
    const ownAudit = eq(authEvents.accountId, accountId);
    await reopen("auth_events", () => tx.select({ id: authEvents.id }).from(authEvents).where(ownAudit).limit(1));
    await drop("auth_events", () => tx.delete(authEvents).where(page(authEvents, ownAudit)));

    // ── 8. The users themselves ─────────────────────────────────────────────────
    await drop("users", () => tx.delete(users).where(page(users, eq(users.accountId, accountId))));

    // ── 9. The account survives, pseudonymously ─────────────────────────────────
    // Not a soft delete: there is nothing personal left to protect. The row is the
    // billing subject the ledger points at, and a uuid is not personal data.
    await tx.update(accounts).set({ name: "" }).where(eq(accounts.id, accountId));
    return receipt(accountId, { deleted, redacted, stagingTicketsExpired: expired.attachment_staging, retainedPending });
}
