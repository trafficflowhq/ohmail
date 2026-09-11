import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { accounts, auditLog, mailboxCredentials, mailboxes, users, isMailboxSyncBlockReason } from "@trafficflow/db";
import {
  authEvents,
  invites,
  waitlist,
  workerHeartbeats,
  evaluateAlerts,
  alertClass,
  listOpenAlerts,
  SCOPED_ALERT_KINDS,
  alertDriverStatuses,
  platformSignalWindow,
  listOpenAlertStamps,
  SIGNAL_BUCKET_MS,
  listStuckSends,
  DEFAULT_ALERT_THRESHOLDS,
  type ContentBlind,
} from "@trafficflow/db/cloud";
import type { Db } from "./context.js";
import type {
  AccountDetail, AccountPage, AccountQuery, AccountSummary, ActionCatalog, ActionSpec,
  AdminAlertDriver, AdminPlatformSignal, AlertSummary, AuditEntry,
  FunnelSnapshot, FunnelStage, MailboxHealth, SecurityEvent,
  StaleSend, WorkerInstanceHealth, WorkerSnapshot,
} from "./admin-dto.js";

/**
 * The ONLY cross-account reader in the repo. Every other service takes a `ServiceContext` whose
 * `accountId` came from the session; the cross-account reads live here, with no context at all,
 * so account scoping has an obvious answer everywhere else. Every function takes an {@link
 * AdminDb} — a nominal brand only `adminDbFor` mints — connected as `ohmail_admin`, whose column
 * grants answer 42501. Every select names its columns; no grant exists on `messages`,
 * `change_log`, `folder_state`, `flag_state`, secrets, or the `audit_log` jsonb bags. Staff must
 * never confirm a particular mail reached a particular account — a row's EXISTENCE is a receipt
 * fact. Reads only; counts come from `count(*) filter (…)`, never from a capped list.
 */

/**
 * The handle every function here takes: `Db` widened by the nominal brand `@trafficflow/db` mints
 * only after its boot attestation watched the connection be REFUSED a mail-content read AND
 * compared the role's whole capability set to `STAFF_SELECT_GRANTS` — one denied column proves
 * little about the rest. `deps.db` does not satisfy the brand, so "staff reads run on the staff
 * connection" is compiler-checked rather than remembered. It brands `Db` (the PGlite ∪
 * postgres-js union) because PGlite has no roles: api-level tests brand a PGlite handle by cast
 * and prove the PROJECTION half; a role-level test proves the ROLE half on real Postgres. Neither
 * substitutes.
 */
export type AdminDb = Db & ContentBlind;

/* ════════════════════════════════════════════════════════════════════════════════════════
   Caps and constants
   ════════════════════════════════════════════════════════════════════════════════════════ */

/** Statement views are capped: an operator reads the newest rows, never all of them. */
export const ADMIN_LIST_LIMIT = 50;
/** The roster page size the console asks for by default. */
export const ADMIN_DEFAULT_PAGE_SIZE = 25;
/** A pageSize a caller may not exceed — the query string is attacker-controlled. */
export const ADMIN_MAX_PAGE_SIZE = 100;
/** Option lists on the Actions page, and the Billing page's adjustment targets. */
export const ADMIN_OPTIONS_LIMIT = 200;
/** Mailboxes listed on the Worker page's roster. */
export const ADMIN_ROSTER_LIMIT = 200;

/**
 * Lag only counts once it is actually notable — the same 300s the console's `attentionRank`
 * uses, for the same reason: an account whose worst mailbox is 44 seconds behind is not a
 * finding, and scoring it made healthy rows reshuffle on noise.
 */
const LAG_MATTERS_AFTER = 300;

/**
 * Drizzle types a `timestamptz` column as `Date`, and postgres-js honours that while PGlite
 * hands back an ISO STRING for the same column. Both drivers run this code (production and the
 * test harness), so every timestamp is normalised through one function rather than by each
 * call site guessing which driver it is on — a class of bug that has bitten this codebase twice
 * (see the `mail-service.ts` note `alerts.ts` quotes).
 */
const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : asDate(value).toISOString();

const secondsSince = (now: Date, then: Date | string | null | undefined): number | null =>
  then === null || then === undefined
    ? null
    : Math.max(0, Math.round((now.getTime() - asDate(then).getTime()) / 1000));

const int = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Case- and accent-insensitive folding — the same rule the console applies to fixtures, so
 * a search that found a row in fixtures finds it live. NFD + stripping combining marks, not a
 * locale collator.
 */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * The staff meta gate — built, then removed; the removal is the stronger state. It rendered
 * `audit_log.payload`/`inverse` through `staffMeta` (default-deny by key, then value shape) after
 * a producer was found writing the raw RFC822 Message-ID into `meta.dedupKey`. Both columns are
 * now UN-GRANTED to `ohmail_admin` (`scripts/harden-staff-role.sql`): nothing left to project, so
 * the gate is deleted — an unreachable allowlist reads like a live defence. Cost:
 * `AuditEntry.payload` is always `{}`. The way back: the PRODUCER promotes the value to a named
 * column; the bag is never granted. `admin-content-isolation.test.ts` still taints every column
 * and asserts none reaches these responses.
 */


/**
 * How much this account needs a human, as one number.
 *
 * IT IS A COPY, AND THE COPY IS ASSERTED. The console carries its own `attentionRank` and this
 * is the server's; a package may not import from an app, so they are written twice and the
 * console's test cases are re-run against this copy at the api level. If they disagree, page 1
 * and page 2 of a paged roster silently omit the same rows — the failure the `AccountPage` doc
 * warns about.
 */
export function adminAttentionRank(account: AccountSummary): number {
  let score = 0;
  if (account.mailboxesInError > 0) score += 200 + account.mailboxesInError * 10;
  // Range 165–200, and both bounds are arguments rather than taste — the console's copy of
  // this clause carries the full reasoning: above every plain error (a block is an upstream
  // refusal, not a transient fault), below the error ramp's ceiling.
  if (account.mailboxesBlocked > 0) score += 160 + Math.min(40, account.mailboxesBlocked * 5);
  if (account.syncLagSeconds !== null && account.syncLagSeconds > LAG_MATTERS_AFTER) {
    score += Math.min(150, account.syncLagSeconds / 60);
  }
  return score;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   The roster
   ════════════════════════════════════════════════════════════════════════════════════════ */

async function loadRoster(db: AdminDb, now: Date): Promise<AccountSummary[]> {
  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name, createdAt: accounts.createdAt })
    .from(accounts);
  if (accountRows.length === 0) return [];

  // The OWNER's login address — `users.email`, the account's own identity, never a sender.
  // Oldest user wins: `register` creates the account and its first user in one transaction, so
  // the earliest row is the account's owner.
  const userRows = await db
    .select({ accountId: users.accountId, email: users.email, createdAt: users.createdAt })
    .from(users);
  const ownerEmail = new Map<string, { email: string; createdAt: Date | string }>();
  for (const row of userRows) {
    const held = ownerEmail.get(row.accountId);
    if (!held || asDate(row.createdAt) < asDate(held.createdAt)) {
      ownerEmail.set(row.accountId, { email: row.email, createdAt: row.createdAt });
    }
  }

  const mailboxRows = await db
    .select({
      accountId: mailboxes.accountId,
      total: sql<number>`count(*)::int`,
      inError: sql<number>`count(*) filter (where ${mailboxes.status} <> 'connected')::int`,
      /**
       * Mailboxes OUR infrastructure declined to serve (mail 0029). Disjoint from `inError` by
       * construction: every writer that moves `status` clears both block columns in one
       * statement, so the two counts are additive on `attentionRank`. `is not null`, NOT
       * `isMailboxSyncBlockReason` — the one place the roster count and the detail page disagree
       * (they differ on `''`, unreachable while `mailboxes_sync_blocked_reason_closed` exists).
       * Accepted: membership narrowing here would make the roster count disagree with a NEWER
       * worker's fourth reason, the far likelier failure.
       */
      blocked: sql<number>`count(*) filter (where ${mailboxes.syncBlockedReason} is not null)::int`,
      // Worst lag across the mailboxes that are SUPPOSED to sync. A disabled mailbox is not
      // late — the downgrade path disables it on purpose — so it is excluded, exactly as
      // `evaluateAlerts`'s `sync_lag` rule excludes it.
      oldestSync: sql<string | null>`
        min(coalesce(${mailboxes.lastSyncAt}, ${mailboxes.createdAt}))
          filter (where ${mailboxes.status} <> 'disabled')`,
    })
    .from(mailboxes)
    .groupBy(mailboxes.accountId);
  const mailboxByAccount = new Map(mailboxRows.map((r) => [r.accountId, r]));

  /**
   * `lastActivityAt` used to be read here — `max(created_at) from change_log` — the sharpest
   * receipt oracle on the surface: ingest records a change for EVERY message, so staff could send
   * mail with a chosen Message-ID and watch one account's stamp advance. No version survives:
   * hourly truncation is rounding a single event can advance; a delay only slows the probe; a
   * minimum count is a population argument and this population is one account. The `change_log`
   * grant is gone and the field is null (rendered "—"). An operator still has `syncLagSeconds`
   * from `mailboxes.last_sync_at` — advancing whether or not mail arrived, so carrying no receipt
   * information. The way back for change VOLUME: a deployment-wide count with no `account_id`.
   */

  return accountRows.map((account) => {
    const mb = mailboxByAccount.get(account.id);
    return {
      id: account.id,
      name: account.name,
      ownerEmail: ownerEmail.get(account.id)?.email ?? "",
      mailboxCount: int(mb?.total),
      mailboxesInError: int(mb?.inError),
      mailboxesBlocked: int(mb?.blocked),
      syncLagSeconds: secondsSince(now, mb?.oldestSync ?? null),
      // ALWAYS NULL — see the block above `return` for why there is no safe version
      // of this field. The DTO keeps it so the console needs no change on the day a
      // deployment-wide change-volume aggregate replaces it.
      lastActivityAt: null,
      createdAt: asDate(account.createdAt).toISOString(),
    } satisfies AccountSummary;
  });
}

/**
 * `AccountQuery` → `AccountPage`. The predicates, the order and the clamping are the same
 * rules the console's own roster selection applies to fixtures.
 */
export async function adminAccounts(db: AdminDb, now: Date, query: AccountQuery = {}): Promise<AccountPage> {
  const roster = await loadRoster(db, now);
  const filter = query.filter ?? "all";
  const search = fold((query.search ?? "").trim());
  const pageSize = Math.min(
    ADMIN_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query.pageSize) || ADMIN_DEFAULT_PAGE_SIZE)),
  );

  const matched = roster.filter((account) => {
    if (filter === "attention" && adminAttentionRank(account) <= 0) return false;
    if (!search) return true;
    return fold(account.name).includes(search) || fold(account.ownerEmail).includes(search);
  });

  matched.sort((a, b) => adminAttentionRank(b) - adminAttentionRank(a) || a.name.localeCompare(b.name));

  // A stale bookmark to page 9 of a roster that shrank is not an error condition; clamp.
  const lastPage = Math.max(0, Math.ceil(matched.length / pageSize) - 1);
  const page = Math.min(Math.max(0, Math.trunc(Number(query.page) || 0)), lastPage);

  return {
    now: now.toISOString(),
    accounts: matched.slice(page * pageSize, page * pageSize + pageSize),
    matched: matched.length,
    total: roster.length,
    page,
    pageSize,
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   One account
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The per-mailbox pending-move count — removed; no view replaces it. It selected one column
 * (`messages.mailbox_id`): minimal AS A PROJECTION, sufficient AS A CHANNEL — the information is
 * in the row's EXISTENCE, and staff must never confirm a chosen delivery landed. `messages`,
 * `folder_state` and `flag_state` are un-granted; `MailboxHealth.pendingMoves` reads 0. A
 * bucketed aggregate cannot fix it: aggregation is about a POPULATION, and this population is one
 * account — every mechanism (ladder, delay, threshold) is defeated when the observer sends the
 * deliveries. The cluster-wide number belongs to the PRODUCER — a keyless per-shard
 * `pending_moves` column on `worker_heartbeats`, deferred. Until then the panel reads zero.
 */

async function loadMailboxes(db: AdminDb, now: Date, accountIds: string[] | null): Promise<MailboxHealth[]> {
  const base = db
    .select({
      id: mailboxes.id,
      accountId: mailboxes.accountId,
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      provider: mailboxes.provider,
      authKind: mailboxes.authKind,
      status: mailboxes.status,
      lastSyncAt: mailboxes.lastSyncAt,
      createdAt: mailboxes.createdAt,
      errorCode: mailboxes.errorCode,
      errorDetail: mailboxes.errorDetail,
      failedAt: mailboxes.failedAt,
      retryCount: mailboxes.retryCount,
      syncBlockedReason: mailboxes.syncBlockedReason,
      syncBlockedSince: mailboxes.syncBlockedSince,
    })
    .from(mailboxes);
  const rows = accountIds === null
    ? await base.orderBy(mailboxes.address).limit(ADMIN_ROSTER_LIMIT)
    : await base.where(inArray(mailboxes.accountId, accountIds)).orderBy(mailboxes.address);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // PRESENCE ONLY. `secret_enc`, `key_version` and `meta` are never projected — this reads
  // whether a mailbox is connectable at all, which is what an operator diagnosing a dead
  // mailbox needs, and reads none of what makes it connectable.
  const credRows = await db
    .select({ mailboxId: mailboxCredentials.mailboxId })
    .from(mailboxCredentials)
    .where(and(inArray(mailboxCredentials.mailboxId, ids), eq(mailboxCredentials.transport, "imap")));
  const hasCred = new Set(credRows.map((r) => r.mailboxId));

  return rows.map((row) => {
    return {
      id: row.id,
      accountId: row.accountId,
      address: row.address,
      displayName: row.displayName,
      provider: row.provider,
      authKind: row.authKind === "oauth" ? "oauth" : "password",
      status: row.status === "error" || row.status === "disabled" ? row.status : "connected",
      lastSyncAt: iso(row.lastSyncAt),
      syncLagSeconds:
        row.status === "disabled" ? null : secondsSince(now, row.lastSyncAt ?? row.createdAt),
      // Mail 0023 closed this gap: `mailboxes` records WHY. `lastError` is the taxonomy plus an
      // ALLOWLISTED token — an IMAP response code, a Node errno, a TLS constant, an SQLSTATE —
      // never the error's message: a raw sync error can embed RFC822 header bytes, and staff
      // never see an account's mail. The redaction is at the WRITE (`markMailboxFailed`), so this
      // projection does not have to remember to be narrow. `retryBackoffSeconds` stays null,
      // honestly: the backoff lives in the worker's in-memory quarantine map and is not persisted
      // — `retryCount` is the durable half.
      lastError: row.status === "error"
        ? (row.errorDetail ? `${row.errorCode ?? "unknown"}: ${row.errorDetail}` : row.errorCode ?? "unknown")
        : null,
      lastErrorAt: row.status === "error" ? iso(row.failedAt) : null,
      // Mail 0029, and its OWN bucket — NOT folded into `lastError`, and NOT gated on `status`.
      //
      // Both of those are the point. This is the case `syncLagSeconds` used to present with no
      // explanation whatsoever: a mailbox reading `connected` with a growing lag and a `lastError`
      // of `null` — a state an operator otherwise stares at with no explanation.
      // A gate on `status === 'error'` — the rule the two lines above follow — would make this
      // field permanently null, because every state it describes happens while the status is
      // `connected`. See the field's own comment in `admin-dto.ts` for why the two buckets must
      // stay separable rather than tidy.
      syncBlockedReason: isMailboxSyncBlockReason(row.syncBlockedReason) ? row.syncBlockedReason : null,
      syncBlockedSince: iso(row.syncBlockedSince),
      retryBackoffSeconds: null,
      // ALWAYS 0 / null — a per-mailbox count of unapplied folder moves is a
      // receipt-confirmation oracle in EVERY form, because its population is one account. The
      // block above this function has the argument in full, the bucketed cluster-wide shape that
      // does work, and where it has to be produced. The DTO keeps both fields so the console
      // needs no change on the day the worker publishes them.
      pendingMoves: 0,
      oldestPendingMoveSeconds: null,
      hasImapCredential: hasCred.has(row.id),
    } satisfies MailboxHealth;
  });
}

async function accountNames(db: AdminDb, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(inArray(accounts.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * THE UUID SHAPE, and it is a real one.
 *
 * This used to be `/^[0-9a-fA-F-]{36}$/`, which admits 36 hyphens and 36 hex digits with no
 * hyphens at all — neither is a uuid, both reach `eq(…accountId, …)`, and Postgres answers
 * SQLSTATE 22P02 into the route's catch-all. The comment at each call site claimed a 404 rather
 * than a 500; this is what makes that true.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/**
 * `admin.*` audit rows only. No writer exists for that namespace yet, so the answer is `[]`. The
 * unqualified name is doing work: drizzle emits `from "audit_log"`, and `ohmail_admin`'s
 * `search_path` is `admin, public` — so this ONE query reads `admin.audit_log` (a
 * `security_barrier` view carrying the `LIKE 'admin.%'` predicate, projecting four named scalars)
 * as the staff role, and `public.audit_log` under PGlite, which has no roles. The role holds no
 * grant on `public.audit_log`, so widening the projection to `payload`/`inverse` raises 42501 in
 * production. The `LIKE` below duplicates the view's predicate on purpose: it keeps the PGlite
 * path identical, and a filter stated twice cannot be widened once.
 */
async function loadAudit(db: AdminDb, accountId: string | null): Promise<AuditEntry[]> {
  const adminNamespace = sql`${auditLog.action} like 'admin.%'`;
  const rows = await db
    .select({
      id: auditLog.id,
      accountId: auditLog.accountId,
      action: auditLog.action,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(accountId === null ? adminNamespace : and(adminNamespace, eq(auditLog.accountId, accountId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(ADMIN_LIST_LIMIT);
  const names = await accountNames(db, rows.map((r) => r.accountId));
  return rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    accountName: names.get(row.accountId) ?? "",
    action: row.action,
    // Both bags are un-granted and unread. The DTO keeps the fields so the console's table
    // needs no change on the day a staff write path promotes an actor to a named column.
    payload: {},
    inverse: null,
    // There is no `audit_log.actor` column and no admin write, so it is empty rather than
    // invented — and it can no longer be recovered from the payload, which is the point.
    actor: "",
    createdAt: asDate(row.createdAt).toISOString(),
  } satisfies AuditEntry));
}

/**
 * The account's SECURITY events — today exactly one kind, `refresh_reuse_revoked`, written when a
 * consumed refresh token is re-presented and the family is swept. Surfaced here because the sweep
 * is silent on every user surface. Columns are the staff allowlist's (`staff-grants.ts`:
 * id/account_id/user_id/event/at) — never `device` (a client-chosen user-agent string or the
 * family id: investigation detail, not console material) and never `ip`. The filter is `event =
 * 'refresh_reuse_revoked'`, not all auth events: login/logout is activity, this panel is for rows
 * that mean an incident. Isolation posture: a staff handle the provisioner has not widened yet
 * answers 42501 — that costs exactly this list (empty, page renders), never the account view.
 */
async function loadSecurityEvents(db: AdminDb, accountId: string): Promise<SecurityEvent[]> {
  try {
    const rows = await db
      .select({ id: authEvents.id, event: authEvents.event, at: authEvents.at })
      .from(authEvents)
      .where(and(eq(authEvents.accountId, accountId), eq(authEvents.event, "refresh_reuse_revoked")))
      .orderBy(desc(authEvents.at))
      .limit(ADMIN_LIST_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      event: r.event as SecurityEvent["event"],
      at: asDate(r.at).toISOString(),
    }));
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "42501") return [];
    throw err;
  }
}

export async function adminAccountDetail(db: AdminDb, now: Date, id: string): Promise<AccountDetail | null> {
  // A malformed id must be a 404, not a Postgres `invalid input syntax for type uuid` 500 —
  // the path segment is whatever the caller typed.
  if (!UUID_RE.test(id)) return null;
  const roster = await loadRoster(db, now);
  const account = roster.find((a) => a.id === id);
  if (!account) return null;

  // Sequential — the max:1 blind pool deadlocks on parallel reads when one opens a
  // transaction (see adminWorker above). Same rule for every admin read group.
  const mailboxList = await loadMailboxes(db, now, [id]);
  const audit = await loadAudit(db, id);
  const securityEvents = await loadSecurityEvents(db, id);

  return {
    now: now.toISOString(),
    account,
    mailboxes: mailboxList,
    audit,
    securityEvents,
  };
}

/**
 * The signup funnel, as counts. Every figure is a COUNT and nothing is joined to a person: the
 * top reads the DATE columns granted for the funnel (`staff-grants.ts`: `invites`
 * created/consumed/revoked, `waitlist` created/invited — no address); the stages read columns the
 * role already held. The stages are monotonic subsets — signed up ⊇ verified ⊇ connected —
 * computed as `count(distinct account_id)`, so an account with two verified users still counts
 * once and a drop-off is a true conversion. Sequential reads on the `max: 1` blind pool, like
 * every other admin read group.
 */
export async function adminFunnel(db: AdminDb, now: Date): Promise<FunnelSnapshot> {
  const [inviteRow] = await db
    .select({
      issued: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${invites.consumedAt} is not null)::int`,
      revoked: sql<number>`count(*) filter (where ${invites.revokedAt} is not null)::int`,
    })
    .from(invites);

  const [waitRow] = await db
    .select({
      waiting: sql<number>`count(*) filter (where ${waitlist.invitedAt} is null)::int`,
      invited: sql<number>`count(*) filter (where ${waitlist.invitedAt} is not null)::int`,
    })
    .from(waitlist);

  const [signupRow] = await db.select({ n: sql<number>`count(*)::int` }).from(accounts);
  const [verifiedRow] = await db
    .select({ n: sql<number>`count(distinct ${users.accountId})::int` })
    .from(users)
    .where(sql`${users.emailVerifiedAt} is not null`);
  const [connectedRow] = await db
    .select({ n: sql<number>`count(distinct ${mailboxes.accountId})::int` })
    .from(mailboxes);
  const signup = int(signupRow?.n);
  const verified = int(verifiedRow?.n);
  const connected = int(connectedRow?.n);

  // Conversion from the previous stage. `null` on the first; guarded against divide-by-zero —
  // a downstream count is a subset, so a zero upstream means a zero downstream, i.e. 0/0 ⇒ null.
  const conv = (count: number, previous: number): number | null =>
    previous === 0 ? null : count / previous;

  const stages: FunnelStage[] = [
    { key: "signup", label: "Signed up", count: signup, ofPrevious: null },
    { key: "verified", label: "Email verified", count: verified, ofPrevious: conv(verified, signup) },
    { key: "connected", label: "Mailbox connected", count: connected, ofPrevious: conv(connected, verified) },
  ];

  const issued = int(inviteRow?.issued);
  const accepted = int(inviteRow?.accepted);
  const revoked = int(inviteRow?.revoked);

  // Signups per ISO week (Monday-anchored), last 8 weeks including the current one, oldest
  // first. `date_trunc('week', …)` is Monday-anchored in Postgres. `created_at` only.
  const weekRows = await db
    .select({
      weekStart: sql<string>`to_char(date_trunc('week', ${accounts.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(accounts)
    .where(sql`${accounts.createdAt} >= date_trunc('week', ${now.toISOString()}::timestamptz) - interval '7 weeks'`)
    .groupBy(sql`date_trunc('week', ${accounts.createdAt})`)
    .orderBy(sql`date_trunc('week', ${accounts.createdAt})`);

  return {
    now: now.toISOString(),
    invites: {
      issued,
      accepted,
      revoked,
      // Outstanding = issued that were neither accepted nor revoked. This can exclude EXPIRED
      // invites (there is no `expires_at` grant), so it is "issued and not yet consumed or
      // revoked" — the console labels it that way rather than claiming "still valid".
      outstanding: Math.max(0, issued - accepted - revoked),
    },
    waitlist: { waiting: int(waitRow?.waiting), invited: int(waitRow?.invited) },
    stages,
    signupsByWeek: weekRows.map((r) => ({ weekStart: r.weekStart, count: int(r.count) })),
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Worker + alerts
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The worker, as the DATABASE sees it — which is less than the worker's own `/health` sees.
 *
 * `worker_heartbeats` holds one row per SHARD, written only by the process holding that shard's
 * advisory lock. So: there is at most one row per shard and never a standby row (a standby
 * writes nothing), `host` / `awaitingCredentials` / `truncated` / the KEK ring have no column,
 * and `healthy` is derived from freshness rather than reported. Every one of those is a `null`
 * on the wire, and the console's own types document why a null and not a zero.
 */
export async function adminWorkerInstances(db: AdminDb, now: Date): Promise<WorkerInstanceHealth[]> {
  const rows = await db
    .select({
      shardIndex: workerHeartbeats.shardIndex,
      instanceId: workerHeartbeats.instanceId,
      leader: workerHeartbeats.leader,
      shards: workerHeartbeats.shards,
      mailboxes: workerHeartbeats.mailboxes,
      expected: workerHeartbeats.expected,
      accounts: workerHeartbeats.accounts,
      quarantined: workerHeartbeats.quarantined,
      degraded: workerHeartbeats.degraded,
      lastCycleAt: workerHeartbeats.lastCycleAt,
      startedAt: workerHeartbeats.startedAt,
      beatAt: workerHeartbeats.beatAt,
    })
    .from(workerHeartbeats)
    .orderBy(workerHeartbeats.shardIndex);

  const staleMs = DEFAULT_ALERT_THRESHOLDS.leaderStaleMs;
  return rows.map((row) => {
    const beatAgeSeconds = secondsSince(now, row.beatAt) ?? 0;
    const beating = beatAgeSeconds * 1000 <= staleMs;
    return {
      instanceId: row.instanceId,
      host: null,
      leader: Boolean(row.leader),
      // A standby writes no heartbeat, so a row is never one. `leader: false` here means the
      // leader RESIGNED (`clearHeartbeat`) — an unheld shard, not a hot spare.
      standby: false,
      healthy: Boolean(row.leader) && beating,
      degraded: Boolean(row.degraded),
      mailboxes: int(row.mailboxes),
      expected: int(row.expected),
      accounts: int(row.accounts),
      quarantined: int(row.quarantined),
      awaitingCredentials: null,
      truncated: null,
      lastCycleAt: iso(row.lastCycleAt),
      lagSeconds: secondsSince(now, row.lastCycleAt),
      shard: { index: int(row.shardIndex), shards: int(row.shards) },
      kek: null,
      error: !Boolean(row.leader)
        ? "this shard has no leader — the last one resigned or lost its lock"
        : beating
          ? null
          : `no heartbeat for ${beatAgeSeconds}s (threshold ${Math.round(staleMs / 1000)}s)`,
      startedAt: asDate(row.startedAt).toISOString(),
    } satisfies WorkerInstanceHealth;
  });
}

/**
 * What is paging right now.
 *
 * `evaluateAlerts` is the SAME pure read the alerter runs, so the console cannot show "all
 * clear" while an operator's phone is buzzing. `alert_state` supplies the two facts an
 * evaluation cannot have — when the fault STARTED and whether a human was actually told.
 */
/**
 * Both alert drivers' last recorded pass — the panel that answers "is the pair still a pair".
 *
 * A thin pass-through over `alertDriverStatuses`, which always returns BOTH arms so an arm that
 * has never run is present and says so. It is a separate read from {@link adminAlerts} because it
 * answers a different question: that one is "what is wrong", this one is "is the thing that
 * would tell me still running".
 */
export async function adminAlertDrivers(db: AdminDb, now: Date): Promise<AdminAlertDriver[]> {
  void now;
  const rows = await alertDriverStatuses(db);
  return rows.map((r) => ({
    driver: r.driver,
    ranAt: iso(r.ranAt),
    firing: r.firing,
    delivered: r.delivered,
    failedSinks: r.failedSinks,
    sinkFailureStreak: r.sinkFailureStreak,
    sinksConfigured: r.sinksConfigured,
  }));
}

/**
 * What the platform served over the 5xx rule's own window. Read through the SAME function the
 * rule uses (`platformSignalWindow`): the panel says "12 of 900 requests" and the rule pages on
 * those two numbers, so the surface an operator reads and the condition that wakes them cannot
 * drift. An empty array is the UNCONFIGURED state, rendered as "not measured" — not a failure and
 * not a zero: a deployment with no platform token writes no rows, so there is no row saying 0 to
 * be mistaken for a measurement.
 */
export async function adminPlatformSignals(
  db: AdminDb, now: Date,
): Promise<AdminPlatformSignal[]> {
  const rows = await platformSignalWindow(db, now, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
  const expectedBuckets = Math.round(
    DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs / SIGNAL_BUCKET_MS,
  );
  return rows
    // The row carries its coverage; it is not filtered into silence. Two wrong answers preceded
    // this: emitting a partial window under "in the last 15m" reported ten minutes as fifteen;
    // dropping the row handed the console `[]` — the same answer as no platform token — so a
    // failed poll and an unconfigured one were indistinguishable and the "sampled" branch was
    // unreachable. Figures and coverage travel together; an empty list now means exactly one
    // thing: nothing has ever been read.
    .map((r) => ({
    provider: r.provider,
    project: r.project,
    requests: r.requests,
    errors5xx: r.errors5xx,
    truncated: r.truncated,
    completeBuckets: r.completeBuckets,
    sampledBuckets: r.sampledBuckets,
    sampleCauses: r.sampleCauses,
    expectedBuckets,
    fetchedAt: r.fetchedAt.toISOString(),
  }));
}

export async function adminAlerts(db: AdminDb, now: Date): Promise<AlertSummary[]> {
  const firing = await evaluateAlerts(db, { now });
  // THROUGH THE DB PACKAGE'S OWN READER, never a select of the table from here: resolution marks
  // rather than deletes now, so a read without `resolved_at IS NULL` renders fixed history as
  // live incidents. One accessor is only one accessor if nothing else can reach the rows.
  const stateRows = await listOpenAlertStamps(db as never);
  const state = new Map(stateRows.map((r) => [r.alertKey, r]));

  const evaluated = firing.map((alert) => {
    const row = state.get(alert.key);
    return {
      key: alert.key,
      kind: alert.kind,
      // `AlertSeverity` is critical|warning; the console's ramp is ok|warn|bad|idle.
      severity: alert.severity === "critical" ? "bad" : "warn",
      title: alert.title,
      detail: alert.detail,
      count: alert.count,
      // No `alert_state` row means this pass is the first observation — the fault opened as
      // far as anyone can tell now, and nobody has been told.
      openedAt: iso(row?.openedAt ?? null) ?? now.toISOString(),
      notifiedAt: iso(row?.notifiedAt ?? null),
      // READ FROM THE FIRING ALERT, not from the `alert_state` row, and the two can legitimately
      // differ for one pass: a promoting rule computes its class from a population that has just
      // moved, and the row still carries what the LAST pass wrote until this one's observation
      // lands. The console must render what is true now — which is what the evaluator just
      // computed — for the same reason this whole function evaluates rather than reading: the
      // surface an operator looks at and the condition that pages them must not drift apart.
      cls: alertClass(alert),
      affectedAccounts: alert.affectedAccounts ?? null,
      fixHref: alert.fixHref ?? null,
    } satisfies AlertSummary;
  });

  // The rows this read structurally cannot evaluate. The console is not an alert DRIVER — a read
  // that named itself an arm would report a running scheduler dark — so rules gated on a driver
  // name (`schema_behind`, `alert_driver_dark`) or on `shards` are never in the evaluated set;
  // they are READ from `alert_state`: what the drivers wrote is the only evidence this read can
  // have. But "scoped kind" is not "could not evaluate": `evaluateAlerts` defaults to shard 0, so
  // this read DOES evaluate `worker_down:0`, `worker_degraded:0` and `ai_provider_down:0`, and
  // their absence from `firing` after recovery is the correct answer — merging them back put a
  // cleared critical on the board. What this read truly cannot answer: driver-keyed rules, the
  // role-scoped one (its counter lives in a table the content-blind handle is not granted), and
  // shard-keyed rows outside the shard set used here.
  const READ_SHARDS = [0];
  const evaluatedHere = new Set<string>();
  for (const shard of READ_SHARDS) {
    evaluatedHere.add(`worker_down:${shard}`);
    evaluatedHere.add(`worker_degraded:${shard}`);
    evaluatedHere.add(`ai_provider_down:${shard}`);
  }
  const scoped = (await listOpenAlerts(db))
    .filter((r) => SCOPED_ALERT_KINDS.has(r.kind)
      && !evaluatedHere.has(r.alertKey)
      && !firing.some((a) => a.key === r.alertKey))
    .map((r) => ({
      key: r.alertKey,
      kind: r.kind as AlertSummary["kind"],
      severity: r.severity === "critical" ? "bad" : "warn",
      // Projected, never reconstructed. The count was once a hardcoded 1 and the title the
      // detail's first sentence — so a refusal burst of forty connections rendered as "1" under a
      // heading that was an opening clause, on the ONLY path for the driver-keyed rules and the
      // role-scoped one. `alert_state` now persists what the rule said, so both are read; a null
      // means the row predates those columns (a driver mid-deploy) and the fallback SAYS so
      // rather than fabricating a sentence — the whole difference between projecting and
      // guessing.
      title: r.title ?? `${r.kind} — recorded by the other alert driver`,
      detail: r.detail ?? "Recorded by the other alert driver; this read cannot evaluate it.",
      count: r.count ?? 0,
      openedAt: r.openedAt.toISOString(),
      notifiedAt: r.notifiedAt ? r.notifiedAt.toISOString() : null,
      cls: r.cls,
      affectedAccounts: r.affectedAccounts,
      fixHref: r.fixHref,
    } satisfies AlertSummary));

  return [...evaluated, ...scoped];
}

export async function adminWorker(db: AdminDb, now: Date): Promise<WorkerSnapshot> {
  // SEQUENTIAL on purpose — see overview() in routes/admin.ts: parallel reads on the max:1
  // blind pool deadlock when one of them opens a transaction. This pair hung /admin/worker
  // for its whole life.
  const instances = await adminWorkerInstances(db, now);
  const roster = await loadMailboxes(db, now, null);
  const names = await accountNames(db, roster.map((m) => m.accountId));

  /**
   * The population, from SQL — the roster above is capped at `ADMIN_ROSTER_LIMIT`. The verdict
   * once counted faults by filtering that capped array, so a deployment's 201st broken mailbox
   * could not contribute and the verdict got QUIETER as the deployment grew — invisible from any
   * fixture smaller than the cap. `blocked` gates on the TIMESTAMP and never on
   * `sync_blocked_reason`: the service narrows the reason to this build's closed set, so a block
   * this build cannot name still has a `since`, and gating on the reason would read that row as
   * healthy — a defect this projection has shipped once. Three `count(*) filter (…)` over one
   * scan bounded by the mailbox population.
   */
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      inError: sql<number>`count(*) filter (where ${mailboxes.status} <> 'connected')::int`,
      blocked: sql<number>`count(*) filter (where ${mailboxes.status} = 'connected' and ${mailboxes.syncBlockedSince} is not null)::int`,
    })
    .from(mailboxes);

  const stuck = await listStuckSends(
    db,
    new Date(now.getTime() - DEFAULT_ALERT_THRESHOLDS.stuckSendMs),
    ADMIN_LIST_LIMIT,
  );
  const stuckNames = await accountNames(db, stuck.map((s) => s.accountId));

  return {
    now: now.toISOString(),
    instances,
    roster: roster.map((m) => ({ ...m, accountName: names.get(m.accountId) ?? "" })),
    rosterCounts: {
      total: int(counts?.total),
      inError: int(counts?.inError),
      blocked: int(counts?.blocked),
    },
    // Empty is the honest answer, and the sentence explaining it names only what runs: folder
    // RECONCILE (`sync.ts`), the workflow TIME SCAN and DRAIN (`workflow-cron.ts`), the BUBBLE-UP
    // pass (`bubble-up-cron.ts`). Nothing writes a row when they run — there is no cron telemetry
    // table — and a row saying `never` would be false about a job that finished two minutes ago.
    // This copy once named "the reconcile, stale-send and proposal passes"; two of the three were
    // false (`proposalGeneratePass` has no production caller; there is no stale-send pass —
    // `staleSends` is a read-only listing computed on this request). Keep the pass list in step
    // with `SCHEDULE_MANIFEST` in `test/every-pass-has-a-producer.test.ts`.
    crons: [],
    // ZERO, for the same reason `crons` is empty: the honest answer is nothing, and
    // the surface that produced this one was a receipt oracle. The full argument, the D=15min /
    // k=5 bucketed shape a cluster-wide backlog number must have, and why it has to be produced
    // by the WORKER rather than joined out of `folder_state ⋈ messages` on a staff connection,
    // are in the block above `loadMailboxes`. Reading it before re-adding a query here is not
    // optional: the query this replaced looked as narrow as a query can look.
    pendingMoves: { total: 0, mailboxes: 0, oldestSeconds: null },
    staleSends: stuck.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      accountName: stuckNames.get(s.accountId) ?? "",
      // `outbound_sends.idempotency_key` IS NOT PROJECTED. It is the CLIENT's
      // `Idempotency-Key` header, verbatim and unvalidated (`routes/drafts.ts` takes any
      // non-empty string), so it is caller-chosen free text of unbounded length rendered on a
      // staff screen. A client that used a draft's SUBJECT as its "one intent" token — a
      // perfectly natural choice — would have put subjects on this console with nothing
      // failing anywhere. It bought an operator nothing either: `id` and the key are 1:1, and
      // `id` is the handle `admin.send.retry` would take.
      status: s.status === "unverified" ? "unverified" : "pending",
      createdAt: s.createdAt.toISOString(),
      ageSeconds: secondsSince(now, s.createdAt) ?? 0,
    } satisfies StaleSend)),
    // The alerter's own numbers, not a second opinion — the UI states the rule it is judging by.
    thresholds: {
      staleSendSeconds: Math.round(DEFAULT_ALERT_THRESHOLDS.stuckSendMs / 1000),
      // The EFFECTIVE sync-lag rule — threshold PLUS the sustain margin — because that sum is
      // what the pager actually fires at (alerts.ts rule 4's debounce: a healthy serialized
      // scan's tail reaches the bare threshold on its own, so the bare number here made the
      // console mark red exactly the boundary kiss the alerter declares healthy — a console
      // disagreeing with the pager, which is the drift this projection exists to prevent).
      syncLagSeconds: Math.round(
        (DEFAULT_ALERT_THRESHOLDS.syncLagMs + DEFAULT_ALERT_THRESHOLDS.syncLagSustainMs) / 1000,
      ),
      leaderStaleSeconds: Math.round(DEFAULT_ALERT_THRESHOLDS.leaderStaleMs / 1000),
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   Actions — designed, documented, NOT BUILT
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Why an action is unavailable, rendered VERBATIM by the console.
 *
 * The console does not paraphrase this and does not hard-code `disabled`: `ActionSpec.available`
 * is data, so an action goes live with no design change the day its write lands. The
 * suspend/resume write has landed, so this reason now covers ONLY the two actions whose target subsystem
 * still does not exist — a button that reports success it cannot achieve is worse than no button.
 */
export const ADMIN_WRITES_UNAVAILABLE =
  "Not in this build. Suspension and mailbox release ship and are wired to staff-authenticated " +
  "writes that record an actor; this action's target subsystem does not exist yet (filed as a " +
  "gap), so wiring it would be a control that reports success it cannot achieve.";

export const ADMIN_ACTIONS_PRECONDITION =
  "Mailbox release is LIVE: it requires a staff session (past the TOTP wall), not the console " +
  "gate alone, and writes one audit_log row naming the operator. The stuck-send retry is " +
  "designed and not wired — its target subsystem does not exist yet — and says so on its card.";

export async function adminActions(db: AdminDb, now: Date): Promise<ActionCatalog> {
  const accountRows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).limit(ADMIN_OPTIONS_LIMIT);
  // Sequential — same max:1 deadlock rule as adminWorker.
  const mailboxRows = await db.select({ id: mailboxes.id, address: mailboxes.address, accountId: mailboxes.accountId })
    .from(mailboxes).orderBy(mailboxes.address).limit(ADMIN_OPTIONS_LIMIT);
  const stuck = await listStuckSends(
    db,
    new Date(now.getTime() - DEFAULT_ALERT_THRESHOLDS.stuckSendMs),
    ADMIN_LIST_LIMIT,
  );
  const names = new Map(accountRows.map((a) => [a.id, a.name]));
  const owners = await ownerEmails(db, accountRows.map((a) => a.id));

  // An ERASED account (Art. 17 anonymises rather than deletes) has neither a name nor an owner
  // address, so the fixture-era `name · email` template renders a bare separator. Both halves
  // are conditional, and the label falls back to the id: an option an operator cannot tell
  // apart from the next one is not a choice.
  const accountOptions = accountRows.map((a) => {
    const owner = owners.get(a.id) ?? "";
    const parts = [a.name, owner].filter((p) => p.length > 0);
    return { id: a.id, label: parts.length > 0 ? parts.join(" · ") : `${a.id} (no name or owner on record)` };
  });
  const withAccount = (head: string, accountId: string): string => {
    const name = names.get(accountId) ?? "";
    return name.length > 0 ? `${head} · ${name}` : head;
  };
  const mailboxOptions = mailboxRows.map((m) => ({ id: m.id, label: withAccount(m.address, m.accountId) }));
  // The send's own id, never its idempotency key — see `staleSends` in `adminWorker` for why
  // the key does not leave the database. `id` is what `admin.send.retry` targets anyway.
  const sendOptions = stuck.map((s) => ({ id: s.id, label: withAccount(s.id, s.accountId) }));

  const actions: ActionSpec[] = [
    {
      id: "resync_mailbox",
      title: "Release a quarantined mailbox",
      // The copy was narrowed in the same change that wired the write (mail 0039). It used to
      // promise "requeues a full folder pass — UIDVALIDITY re-read, not assumed", and none of
      // that ships: clearing a column requeues nothing, and an attach is connect + lease +
      // folders + kickstart + IDLE. The write clears `mailboxes.retry_after` and the leader
      // re-dials on its next roster pass; the honest description is one line, so it is one line.
      // `available` flipping true is the console making a public claim — a card that overstates
      // is the same defect as one reporting success it cannot achieve.
      summary:
        "Clears the retry backoff so the sync leader dials the mailbox again on its next roster pass.",
      effects: [
        "Clears mailboxes.retry_after — the durable backoff a failure recorded",
        "The leader re-attaches within one roster interval (30 s) and resumes from stored state",
        "The outage record is untouched: retry_count, error_code and failed_at all stand",
        "The backoff ladder is NOT reset — a mailbox that fails again waits as long as it would have",
      ],
      target: {
        label: "Mailbox",
        placeholder: mailboxOptions.length ? "Pick a mailbox" : "No mailbox is connected yet",
        options: mailboxOptions,
      },
      requiresNote: true,
      available: true,
      unavailableReason: null,
      auditPreview: {
        action: "admin.mailbox.resync",
        payload: { mailbox_id: "…", account_id: "…", note: "<required>", actor: "staff_<uuid>" },
        inverse: null,
      },
    },
    {
      id: "retry_send",
      title: "Retry a stuck send",
      summary:
        "Re-runs the verify-before-resend pass on an outbound_sends row that never finished. Never sends blind.",
      effects: [
        "Opens the send adapter and calls messageInSent(mintedMessageId) first",
        "Finalizes the row as sent when the message is already there — no second delivery",
        "Only an unambiguous absence is resent, and only under the original idempotency key",
      ],
      target: {
        label: "Stuck send",
        placeholder: sendOptions.length ? "Pick a stuck send" : "No sends are stuck right now",
        options: sendOptions,
      },
      requiresNote: true,
      available: false,
      unavailableReason: ADMIN_WRITES_UNAVAILABLE,
      auditPreview: {
        action: "admin.send.retry",
        payload: {
          send_id: "…", idempotency_key: "idem-…", verified_before_resend: "true",
          note: "<required>", actor: "staff_<uuid>",
        },
        inverse: null,
      },
    },
  ];

  return {
    now: now.toISOString(),
    precondition: ADMIN_ACTIONS_PRECONDITION,
    actions,
    recent: await loadAudit(db, null),
  };
}

async function ownerEmails(db: AdminDb, accountIds: string[]): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({ accountId: users.accountId, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(inArray(users.accountId, accountIds));
  const out = new Map<string, { email: string; createdAt: Date | string }>();
  for (const row of rows) {
    const held = out.get(row.accountId);
    if (!held || asDate(row.createdAt) < asDate(held.createdAt)) {
      out.set(row.accountId, { email: row.email, createdAt: row.createdAt });
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.email]));
}

