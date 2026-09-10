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
 * THE ONLY CROSS-ACCOUNT READER IN THE REPO.
 *
 * Every other service in this package is account-scoped by construction: it takes a
 * `ServiceContext` whose `accountId` came from the session, and every query it writes carries
 * `where accountId = ctx.accountId`. That is the invariant the whole product's isolation rests
 * on, and the way it dies is not by someone deleting it — it is by someone relaxing ONE
 * existing service "just for admin" and leaving a method that can be called with any account
 * id from a route that forgot to check. So the cross-account reads live here, in a module that
 * takes a bare `Db` and no context at all, and the fact that it has no `ServiceContext` is what
 * makes "did this query have an account scope?" a question with an obvious answer everywhere
 * else.
 *
 * ── IT RUNS ON A DIFFERENT CONNECTION FROM THE REST OF THE API ────────────────────────────
 * Every function here takes an {@link AdminDb}, not a `Db`, and the difference is not
 * decorative: `AdminDb` is a NOMINAL BRAND that only `adminDbFor` in `@trafficflow/db` can
 * mint, and it only mints one after asking the database to refuse a mail-content read. So
 * handing this module the runtime handle — which is what every route once did — is a
 * COMPILE ERROR, and the handle it does get is connected as `ohmail_admin`, a Postgres role
 * with column grants that answer 42501 to the reads below that are forbidden.
 *
 * The boundary is staff-surface vs. user-serving runtime, NOT "the API must not read content":
 * the API must read a message's display fields to serve them to the account's own user — that
 * is the product working. Only THIS module's connection is blind.
 *
 * ── WHAT THIS MODULE MAY NOT SELECT ───────────────────────────────────────────────────────
 * Every select below names its columns explicitly. There is no `select()` without a projection
 * anywhere in this file, and that is a rule rather than a style. It is now the SECOND of two
 * mechanisms rather than the only one — the grant is the first — and it is still here because
 * a query that names a forbidden column now fails as a 503 rather than as a leak, and a 503
 * nobody predicted is a worse way to find out than a review comment.
 *
 *  · **No message content — and NO MESSAGE ROW EITHER.** `messages` is not touched at
 *    all, and the role holds no privilege on it — not `subject`, and not `id`. Nor on
 *    `change_log`, `folder_state` or `flag_state`. A review established that a two-column
 *    `messages(id, mailbox_id)` grant is minimal as a projection and still sufficient as a
 *    channel, because `count(*)` names no column and a row's EXISTENCE around a delivery the
 *    tester chose is a receipt fact — staff must never be able to confirm that a particular
 *    mail reached a particular account. See `pendingMoves` below for the three
 *    console fields that paid for it and the argument against replacing them.
 *    The published FAQ answer is a promise to customers, and it is enforced twice: an
 *    api-level test seeds real mail with distinctive markers and fails if one reaches a
 *    response, and a role-level test against real Postgres proves the role refuses the
 *    relations outright AND that a chosen delivery to one of two otherwise identical accounts
 *    changes nothing the role can select.
 *  · **No secrets.** `mailbox_credentials` is read for the PRESENCE of a row
 *    (`hasImapCredential`); the grant covers its composite primary key and nothing else, so
 *    the encrypted credential, its key version and its connection meta are not merely
 *    unprojected, they are unreadable. Nothing here touches `sessions`, `totp_secrets`,
 *    `recovery_codes`, `login_tokens` or `invites`, none of which the role holds a grant on.
 *  · **No Stripe payload.** `billing_events.payload` is the one column on that table that can
 *    carry a customer's name, address or line-item description. The operator queue needs
 *    `stripe_event_id` (what you paste into the dashboard) and `error` (why it failed), and
 *    `listFailedBillingEvents` in `packages/db` already projects exactly those.
 *  · **NO OPEN JSONB BAG AT ALL, and the un-granting is what changed here.** `credit_ledger.meta`,
 *    `audit_log.payload` and `audit_log.inverse` are columns whose CONTENTS no field name
 *    bounds. An earlier gate rendered them through a default-deny projection (`staffMeta`)
 *    after finding
 *    that `pipeline.ts` was writing the raw RFC822 Message-ID into a classify charge's meta.
 *    The grant now denies all three, so the projection is gone and so is the gate: the bags
 *    cannot be read, by this module or by the endpoint somebody adds next. `LedgerEntry.meta`
 *    and `AuditEntry.payload` are therefore always empty. That is a real, accepted loss of
 *    operator detail (the renewal invoice id was the useful one) and the way back is the only
 *    one that is safe: **the producer promotes the value to a NAMED COLUMN**, which is then
 *    granted by name. The bag is never granted.
 *  · **No mail-derived DIGEST either, and this one was a live false claim for a while — a
 *    review caught it.** `credit_ledger.source` is `classify:<mailbox>:<sha256(mid:<Message-ID>)>`
 *    and `draft:<message>:<sha256(<Idempotency-Key>)>`, and this module's own comment called
 *    that "safe by construction". It is not: both inputs are guessable — a sender chooses the
 *    `Message-ID` of mail it sends to the account, a natural client uses the SUBJECT as its
 *    idempotency token — so a staff reader who can see the digest can confirm candidates
 *    offline. The column is now un-granted, and `loadLedger` reads `admin.credit_ledger`,
 *    which truncates the digest away. History closed with the grant: the ledger is append-only
 *    and the plaintexts were destroyed when the digests were introduced, so no re-keying was
 *    possible even in principle.
 *  · **Only `admin.*` audit rows, and the filter is in the DATABASE now.** `audit_log` is
 *    shared with the PRODUCT's own domain audit — `move`, `adopt_external`, `hey_migrate`,
 *    `workflow_step` — and a `workflow_step` row's `payload.effect` is whatever the tool
 *    returned, which for `draft_reply` can quote mail. `ohmail_admin` holds no grant on
 *    `public.audit_log`; it reads `admin.audit_log`, a `security_barrier` view that carries the
 *    `LIKE 'admin.%'` predicate and projects four named scalars. The unqualified name below
 *    resolves to that view for this role through its `search_path`, and to the table for every
 *    other role — so ONE query serves the staff surface and the PGlite harness, and a widened
 *    projection fails on the role rather than quietly reading the bag.
 *
 * ── AND IT READS. IT DOES NOT WRITE. ──────────────────────────────────────────────────────
 * There is no INSERT, UPDATE or DELETE in this file. The staff writes (suspend, resume, resync,
 * retry, credit adjustment) are deliberately not built here: they need `users.role`, step-up,
 * an actor identity and an `audit_log` row each, and `adjustCredits` moves money through the
 * credit ledger. `adminActions()` reports the unbuilt ones as unavailable so the console can
 * say so out loud instead of offering a button that does nothing.
 *
 * ── SCALE, STATED HONESTLY ────────────────────────────────────────────────────────────────
 * The roster is assembled by scanning `accounts` and five grouped aggregates, then filtered,
 * ordered and paged IN THIS PROCESS. That is right for a beta whose roster is tens of accounts
 * and wrong for tens of thousands: the ordering key (`attentionRank`) is derived from three
 * aggregates at once, so pushing it into SQL means materialising it, and materialising it is a
 * schema decision this slice deliberately does not take. `total` is a real `count(*)`, so the
 * number on screen is never a guess; the paging is honest, just not cheap. When the roster
 * outgrows this, the fix is a view or a summary table — not a `LIMIT` here, which would make
 * `matched` a lie.
 *
 * THE LEDGER HALF OF THAT PARAGRAPH IS NO LONGER TRUE, and this is what replaced it. Three
 * UNCAPPED aggregates over `credit_ledger` ran on every Billing load, and the account page read
 * the newest fifty raw rows. `credit_ledger` is append-only and never pruned — for four separate
 * reasons the roll-up's own header sets out — so those reads grew with the deployment's whole
 * history. They now read `credit_usage_daily` (hourly) and `credit_usage_totals` (nightly),
 * written by a worker-side pass, and every panel backed by them carries
 * `{ computedAt, expectedEverySeconds }` — its OWN producer's clock and its OWN cadence, because
 * the two are on different ones and a single stamp would have to be wrong about one of them.
 * `credit_ledger` is still read directly for the STATEMENT rows — the non-debit reasons, over a
 * partial index built for exactly that predicate — and for nothing else.
 *
 * A LIST BEING CAPPED IS NOT A LICENCE TO COUNT OVER IT. `WorkerSnapshot.rosterCounts` exists
 * because the console's fault verdict counted mailboxes by filtering a 200-row roster, so a
 * deployment's 201st broken mailbox could not make the verdict worse. Counts come from
 * `count(*) filter (…)`; lists stay capped and say which cap they hit.
 */

/**
 * The handle every function in this module takes.
 *
 * `Db` widened by the nominal brand `@trafficflow/db` mints only after its boot attestation has
 * watched the connection be REFUSED a mail-content read AND compared the role's whole
 * effective capability set to `STAFF_SELECT_GRANTS` (a single denied column was the original
 * proof, and a review showed it proves almost nothing about the rest of the grant). `deps.db`
 * does not satisfy the brand, which is
 * what makes "the staff reads run on the staff connection" a fact the compiler checks for the
 * functions in THIS MODULE instead of a convention each of them has to remember.
 *
 * It brands `Db` (the PGlite ∪ postgres-js union) rather than the postgres-js handle alone,
 * because PGlite has no roles at all: the api-level tests brand a PGlite handle by an explicit
 * cast and prove the PROJECTION half, and a role-level test proves the
 * ROLE half against real Postgres. Neither substitutes for the other.
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

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE STAFF META GATE — BUILT, THEN REMOVED, AND WHY THE REMOVAL IS THE STRONGER STATE
   ════════════════════════════════════════════════════════════════════════════════════════

   The gate rendered `credit_ledger.meta`, `audit_log.payload` and `audit_log.inverse` to staff
   through `staffMeta`: default-deny by KEY (an allowlist naming each live producer) and then
   by VALUE SHAPE (a character class that no address, Message-ID or free text survives). It
   existed because the previous projection was a channel rather than a projection —
   `packages/core/src/pipeline.ts` was charging one AI classification with the raw RFC822
   Message-ID as `meta.dedupKey`, which put a sender, and sometimes a recipient, on the
   console's ledger table. Staff must see neither.

   All three columns are now UN-GRANTED to `ohmail_admin` (`scripts/harden-staff-role.sql`),
   so there is nothing left to project and the gate has been deleted rather than left standing
   as decoration. A gate nobody can forget beats a gate somebody has to remember, and a
   two-stage allowlist that no query can reach is worse than nothing: it reads like a live
   defence in review.

   What that costs, stated rather than buried: `LedgerEntry.meta` and `AuditEntry.payload` are
   now always `{}`, and the most useful thing they carried — the renewal's `in_…` invoice id on
   the Billing page — is gone with them. The way back is the only
   one that is safe by construction: **the PRODUCER promotes the value to a named column**, and
   that column is added to the grant by name. The bag is never granted.

   The response-level guard stays and still bites: `admin-content-isolation.test.ts` taints
   every column of the schema and asserts none of it reaches these six responses. It is now
   proving a property the database also enforces, which is the right number of independent
   mechanisms for the product's first stated priority: staff never see an account's mail. */

interface SubscriptionRow {
  accountId: string;
  plan: string;
  status: string;
  mailboxLimit: number;
  monthlyCredits: number;
  /** cloud 0022 — the plan price's cadence and the add-on quantities the mirror carries. */
  billingInterval: string;
  addonStorageUnits: number;
  addonMailboxes: number;
  currentPeriodStart: Date | string | null;
  currentPeriodEnd: Date | string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: Date | string | null;
  createdAt: Date | string;
}

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
      /* Mailboxes OUR infrastructure declined to serve (the block-reason columns of mail 0029).
       *
       * DISJOINT FROM `inError` BY CONSTRUCTION, not by coincidence: every writer that moves
       * `status` clears both block columns in the same statement (`apps/worker/src/mailboxes.ts`
       * :743, :768, :826 and `mailbox-service.ts:360-362`), so a row can carry a status other than
       * `connected` or a block, never both. The two counts are additive on `attentionRank` for
       * that reason.
       *
       * `is not null`, NOT `isMailboxSyncBlockReason` — deliberately, and it is the one place the
       * roster count and the detail page disagree. The two predicates differ on `''`, which this
       * counts and the detail page
       * (which narrows) would not show: an account would read "1 blocked" with no blocked mailbox
       * under it. That is unreachable ONLY WHILE `mailboxes_sync_blocked_reason_closed` exists —
       * and that constraint is probed BY NAME (`health.ts:117` is a column-existence probe), never
       * by membership. Accepted rather than
       * hidden: membership narrowing here would make the roster count disagree with a NEWER
       * worker's fourth reason, which is the far likelier failure and exactly the defect that was
       * removed when the block predicate stopped being gated on the reason's membership. */
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

  /* ── `lastActivityAt` USED TO BE READ HERE, AND IT WAS THE SHARPEST ORACLE ON THE SURFACE ──

     The query was `select account_id, max(created_at) from change_log group by account_id` —
     "is this account alive at all", one timestamp, no ids, and the narrowest possible read of a
     table whose grant was already minus its jsonb bag. It is also a receipt oracle with nothing
     left to narrow:

       `packages/core/src/pipeline.ts:512` calls
       `recordChange({ entityType: "message", entityId: stored.id, op: "create" })`
       for EVERY ingested message.

     So staff pick a target account, note its `lastActivityAt`, send mail carrying a chosen
     Message-ID, poll, and watch that one account's stamp advance. Nothing about the query is
     the problem — the ingest write is — and there is no version of this field that survives:

      · Truncating the stamp to the hour does not help. A delivery at 10:07 makes the value
        `10:00` immediately, so the delta is observable inside the same bucket. A bucket that a
        single event can advance is not aggregation, it is rounding.
      · Lagging it by a whole period only delays the observation. The test for a
        bucket argument is whether it DEFEATS a chosen-delivery probe or merely slows it.
      · A minimum-count threshold is a statement about a POPULATION, and this value's population
        is one account. k events reach any threshold k, and the observer chooses the events.

     So the grant on `change_log` is gone entirely — which is also what removes the
     `entity_id → messages.id` join key the same review flagged — and the field is null. The
     console renders null as "—", so the roster column degrades to a dash
     rather than to a wrong timestamp.

     WHAT AN OPERATOR STILL HAS for the same question: `syncLagSeconds` on this same row, from
     `mailboxes.last_sync_at` — the worker's own stamp, which advances on every cycle whether or
     not mail arrived and therefore carries no receipt information at all. "Is this account
     alive" was always better answered by "is the worker reaching their mailbox" than by "did
     anything change in their account", and the `sync_lag` alert rule pages on exactly that.

     THE WAY BACK, if a console ever needs change VOLUME rather than change IDENTITY: a
     deployment-wide count in an owner-side aggregate with no `account_id` column. Not a grant
     on this table. */

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

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE PER-MAILBOX PENDING-MOVE COUNT — REMOVED, AND WHY NO VIEW REPLACES IT
   ════════════════════════════════════════════════════════════════════════════════════════

   `pendingMovesByMailbox` used to live here. It was the ONE place in this file that touched
   `messages`, it selected exactly one column of it (`mailbox_id`, a foreign key), and the
   comment above it said so with some pride. A review rated it High:

     > The staff role first resolves the target account's mailbox address and UUID from
     > `mailboxes`, then reads the current `messages.id` set (or just `count(*)`) for that
     > `mailbox_id`. It sends the chosen probe carrying the candidate RFC822 Message-ID, polls
     > the same query, and observes a new message row in that mailbox.

   The grant was minimal AS A PROJECTION and sufficient AS A CHANNEL. The information is in the
   row's EXISTENCE, `count(*)` names no column, and no narrower column list reaches it. So
   `public.messages`, `public.folder_state` and `public.flag_state` are un-granted outright and
   this function is deleted; `MailboxHealth.pendingMoves` is 0 and `oldestPendingMoveSeconds`
   null for every mailbox.

   ── WHY THE OBVIOUS FIX — A BUCKETED admin VIEW — IS NOT BUILT ──────────────────────────────

   The review proposed replacing row access with "purpose-built aggregates in schema `admin`, carrying
   no stable per-message identifier, with timestamps bucketed or delayed and a minimum
   aggregation threshold". That is the right shape for a cluster number and the wrong shape for
   this one, and the reason is a single sentence:

     **Aggregation is a statement about a population, and the population of a per-mailbox number
     is one mailbox — which is one account.**

   Every mechanism on that list is a population argument, so none of them applies here:

    · A bucket ladder (report 0 below 10, then 10 / 25 / 50 …) is defeated by driving the
      mailbox to the boundary. The observer cannot do that on a HEALTHY mailbox — the reconcile
      pass drains it in seconds, so the standing count is 0 — but on a mailbox whose reconcile
      path is broken the count climbs and the boundary arrives on its own.
    · A delay (`updated_at < now() - interval '15 minutes'`) is the strongest single mechanism
      available, because a healthy reconcile pass applies a chosen delivery's move and removes
      the row long before it qualifies. It is still not enough alone: a target whose reconcile
      path IS broken lets the observer wait the delay out.
    · A minimum threshold of k rows is reached by k chosen deliveries. The observer picks the
      recipient, so keylessness buys nothing either — a delivery addressed to the target is
      self-attributing, and an aggregate with no key still answers "did MY message land" when
      the observer is the one who sent it.

   ── AND WHY THE CLUSTER-WIDE NUMBER IS NOT BUILT HERE EITHER ────────────────────────────────

   A deployment-wide backlog IS a real population, and the shape that works is:

       pending      = count(*)                      over folder_state ⋈ messages
       mailboxes    = count(DISTINCT m.mailbox_id)     where reconcile_status = 'pending'
       oldest       = min(f.updated_at)                  AND f.updated_at < now() - D
       …all three suppressed entirely unless `mailboxes >= k`,
       …`pending` and `mailboxes` reported as floors on a ladder of 5.

     **D = 15 minutes**, argued: the reconcile pass runs on the worker's cycle, so a move still
     pending after fifteen minutes has missed many cycles. Below D the surface is blind BY
     CONSTRUCTION, so a chosen delivery to a healthy deployment can never register in it at all
     — which is the property a bucket ladder cannot give, because a ladder always has a
     boundary and a delay has no boundary to sit on.

     **k = 5 distinct mailboxes**, argued — and the argument is not anonymity-set size, which
     would be arbitrary. Every fault mode this panel exists to detect is SYSTEMIC: a stopped
     worker, a lost shard lease, a provider throttling every connection. All of them put the
     whole shard's mailbox set into the pending state at once and clear k=5 immediately. A
     single mailbox that cannot apply its moves is not a reconciler fault — it is that mailbox's
     fault, and it is already fully visible to staff through `mailboxes.status`, `error_code`,
     `error_detail`, `failed_at`, `retry_count` and `last_sync_at`, all legitimately granted.
     So k=5 separates the two populations the panel is meant to distinguish, rather than merely
     making attribution statistically harder. Below it the aggregate would be a single account's
     row wearing an aggregate's name.

   That view is not created here, and the reason is mechanical rather than a judgement
   about the design. `admin.audit_log` and `admin.credit_ledger` are readable by ONE query that
   also serves the PGlite harness, because each is a column-subset of a `public` relation of the
   same name and `search_path = admin, public` picks the right one per role. An AGGREGATE has no
   `public` counterpart, so serving it needs either a migration creating `public.reconcile_backlog`
   or a second copy of the view's SQL inside a test harness, which is the built-tested-unreachable
   pattern this codebase has been burned by.

   ── THE WAY BACK, WHICH IS THE ONE THIS FILE ALREADY NAMES ──────────────────────────────────

   **The PRODUCER promotes the value to a named column.** The reconciler knows its own backlog;
   `worker_heartbeats` is already granted, already keyless (one row per SHARD, never per
   mailbox), already written once per cycle, and already the relation the review checked and
   cleared as "aggregate-only". A `pending_moves` column there, carrying the bucketed value
   computed worker-side with D and k above, is the same number with none of the joins — and it
   needs a migration and a worker change, so it is filed as deferred work rather than done
   here. Until then the panel reads zero, which is the same honest-nothing
   this module already publishes for `LedgerEntry.meta`, `AuditEntry.payload`, `crons` and
   `retryBackoffSeconds` — and a zero on an ops panel is a smaller lie than a live receipt
   oracle is a breach.
   ════════════════════════════════════════════════════════════════════════════════════════ */

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
      // Mail 0023 closed the gap this comment used to apologise for: `mailboxes` records WHY.
      //
      // `lastError` is the taxonomy plus an ALLOWLISTED token — an IMAP response code, a Node
      // errno, a TLS constant, an SQLSTATE — and NEVER the error's message. That is what makes
      // the field safe to show an operator at all: a raw sync error can embed RFC822 header
      // bytes, and staff never see an account's mail. The redaction is at the
      // WRITE (`markMailboxFailed`), so this projection does not have to remember to be narrow.
      //
      // `retryBackoffSeconds` stays null, honestly: the backoff lives in the worker's in-memory
      // quarantine map and is not persisted. `retryCount` (how big this outage is) and the
      // backoff (when the next attempt lands) are different questions, and only the first is
      // durable — see the 0023 migration header.
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

interface RollupState {
  /** Newest completed run of EITHER arm — what the hourly daily rows are as fresh as. */
  computedAt: string | null;
  /** When `credit_usage_totals` was last written. NIGHTLY, and a different clock entirely. */
  totalsComputedAt: string | null;
  /** `findCreditDivergence`'s count from the newest run that measured it; `-1` ⇒ never. */
  divergentAccounts: number;
  /**
   * Eligible days the setup-spend fold has not reached, from the newest run that folded.
   * `0` ⇒ drained; `> 0` ⇒ a drain in progress; `-1` ⇒ no pass has ever folded.
   */
  setupSweepBacklog: number;
}

/**
 * `admin.*` audit rows only. Today there is no writer for that namespace, so the answer is
 * always `[]`, and the console renders that as the empty state it already has.
 *
 * ── THE UNQUALIFIED NAME IS DOING WORK ────────────────────────────────────────────────────
 *
 * drizzle emits `from "audit_log"` with no schema qualifier, and `ohmail_admin`'s `search_path`
 * is `admin, public`. So this ONE query reads:
 *
 *  · `admin.audit_log` — a `security_barrier` VIEW carrying the `LIKE 'admin.%'` predicate and
 *    projecting four named scalars — when the connection is the staff role;
 *  · `public.audit_log` — the table — under PGlite, where the harness has no roles at all.
 *
 * The role holds NO grant on `public.audit_log`, so widening this projection back to `payload`
 * or `inverse` raises 42501 in production instead of quietly reading a jsonb bag whose contents
 * no field name bounds. The `LIKE` below is therefore a duplicate of the view's own predicate,
 * and it stays: it is what keeps the PGlite path identical, and a filter stated in both places
 * cannot be widened in one.
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
 * The account's SECURITY events — today exactly one kind, `refresh_reuse_revoked` (the rotation's
 * reuse branch writes it when a consumed refresh token is re-presented and the family is swept).
 * Surfaced on the account view because the sweep is silent on every user surface, and the Aug-21
 * incident was reconstructed from raw session rows for want of exactly this list.
 *
 * COLUMNS ARE THE STAFF ALLOWLIST'S (`staff-grants.ts`: auth_events id/account_id/user_id/
 * event/at) — never `device` (a client-chosen user-agent string, or the reuse row's family id:
 * both are investigation detail read over a privileged database connection, not console
 * material) and never `ip`. The filter is `event = 'refresh_reuse_revoked'`, not "all auth
 * events": login/logout traffic is activity, and this panel is for the rows that mean an
 * incident.
 *
 * ISOLATION POSTURE, same as the alert rules': a staff handle the provisioner's widened grant
 * has not reached yet answers 42501 — that must cost exactly this list (empty, and the page
 * renders), never the account view. Anything else propagates.
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

/* ════════════════════════════════════════════════════════════════════════════════════════
   Billing
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE TWO QUANTITIES, KEPT APART.
 *
 * A review of the console put it plainly: *"you are mixing Credits outstanding and
 * actual billing / revenue data."* It was right, and the mixing was structural rather than
 * cosmetic — this function used to answer `totals: { accounts, creditsOutstanding, mrrCents }`,
 * one object holding an account count, a number of CREDITS and a number of CENTS, which the
 * console rendered as three peers in one definition list.
 *
 * A credit is a LIABILITY: service already owed, whether it was paid for or handed out. Money
 * is money. They are different sides of the business, they are denominated in different units,
 * and neither converts to the other at any rate this database knows. So the snapshot now
 * carries {@link BillingRevenue} (cents, and nothing but) and {@link CreditLiability} (credits,
 * and nothing but), and the console has a panel for each.
 *
 * ── WHAT THE BLIND ROLE CAN AND CANNOT ESTABLISH ──────────────────────────────────────────
 * `billing_events.payload` is still un-granted and still off limits — the raw Stripe event
 * carries the customer's name and postal address, and nothing here reads it. What CHANGED
 * (cloud 0029) is that a settled-revenue figure no longer requires it: `billing_invoices`
 * promotes the one integer the board needs onto a table with no name, no address and no line
 * item, granted to the staff role whole (`staff-grants.ts`). `revenue.cash` is read from it —
 * see {@link CashRevenue} and `loadCashRevenue` below. Every other query here reads columns
 * `ohmail_admin` already held before this slice:
 *   · `credit_ledger(account_id, delta, reason)` — via `admin.credit_ledger`, the redacting view
 *   · `credit_balances(account_id, balance)`
 *   · `billing_events(type, status)`
 *   · `billing_subscriptions(plan, status)`
 *
 * ── SEQUENTIAL, NOT PARALLEL ──────────────────────────────────────────────────────────────
 * The blind pool is `max: 1` and deadlocks when a second read opens while one holds the
 * connection. Every await below is deliberately serial; do not `Promise.all` them.
 */

/**
 * THE SIGNUP FUNNEL, as counts.
 *
 * Every figure is a COUNT and nothing here is joined to a person. The top reads the DATE columns
 * granted for the funnel (`staff-grants.ts`: `invites` created/consumed/revoked, `waitlist`
 * created/invited — no address); the four stages read columns the role already held.
 *
 * The stages are monotonic subsets of the accounts set — signed up ⊇ verified ⊇ connected ⊇
 * subscribed — computed as `count(distinct account_id)` so an account with two verified users or
 * three mailboxes still counts once, and a drop-off between two stages is a true conversion.
 *
 * Sequential reads on the `max: 1` blind pool, like every other admin read group here.
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
 * What the platform served over the 5xx rule's own window.
 *
 * READ THROUGH THE SAME FUNCTION THE RULE USES (`platformSignalWindow`), which is the point: the
 * panel says "12 of 900 requests" and the rule pages on those two numbers, so the surface an
 * operator reads and the condition that wakes them cannot drift apart.
 *
 * AN EMPTY ARRAY IS THE UNCONFIGURED STATE and the console must render it as "not measured". It
 * is not a failure and it is not a zero: a deployment with no platform token writes no rows, so
 * there is no row here saying 0 to be mistaken for a measurement.
 */
export async function adminPlatformSignals(
  db: AdminDb, now: Date,
): Promise<AdminPlatformSignal[]> {
  const rows = await platformSignalWindow(db, now, DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs);
  const expectedBuckets = Math.round(
    DEFAULT_ALERT_THRESHOLDS.api5xxWindowMs / SIGNAL_BUCKET_MS,
  );
  return rows
    // ── THE ROW CARRIES ITS COVERAGE; IT IS NOT FILTERED INTO SILENCE ──────────────────
    //
    // Two wrong answers were tried here before this one. Emitting a partial window's figures
    // under a label reading "in the last 15m" reported ten minutes as fifteen. Dropping the row
    // instead handed the console `[]` — which is what a deployment with NO PLATFORM TOKEN sends,
    // so a failed poll became indistinguishable from an unconfigured one, and the panel's
    // "sampled" branch became unreachable because every surviving row was complete by
    // construction. One misstated a measurement; the other hid that a measurement was attempted.
    //
    // The figures and their coverage travel together and the panel says what was measured. An
    // empty list now means exactly one thing: nothing has ever been read for this deployment.
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

  // ── AND THE ROWS THIS READ STRUCTURALLY CANNOT EVALUATE ───────────────────────────────
  //
  // The console is not an alert DRIVER. It evaluates without one, deliberately — a read that
  // named itself an arm would resolve a live driver's row and would report a scheduler dark that
  // is running perfectly. But two rules are gated on exactly that name (`schema_behind`, keyed by
  // the host whose journal is ahead, and `alert_driver_dark`, keyed by the arm being reported),
  // and one more family is gated on `shards`. So the evaluated set NEVER contains them.
  //
  // The consequence was that `schema_behind` — an incident with `fixHref: "/reliability"` — was
  // invisible on the one page its own deep link points at. An operator following the link from a
  // page would arrive at a board that showed nothing wrong.
  //
  // These rows are therefore READ from `alert_state` rather than evaluated: the drivers wrote
  // them, and what the drivers wrote is the only evidence this read can have. `openedAt` and
  // `notifiedAt` come from the row for the same reason. This does not reintroduce the drift the
  // comment above guards against — that argument is about a class the CURRENT pass just
  // recomputed, and here there is no current computation to prefer.
  // ── ONLY WHAT THIS READ GENUINELY COULD NOT EVALUATE ─────────────────────────────────
  //
  // "Scoped kind" is not the same claim as "this read could not evaluate it", and merging on the
  // kind alone reintroduced cleared incidents. `evaluateAlerts` defaults to shard 0 when no
  // shards are given, so THIS read does evaluate `worker_down:0`, `worker_degraded:0` and
  // `ai_provider_down:0` — and when shard 0 has recovered but the driver has not yet deleted the
  // row, their absence from `firing` is the correct answer, not a gap to fill. Merging them back
  // put a cleared critical on the board until the next driver pass.
  //
  // What this read truly cannot answer is narrower and is enumerable:
  //  · the DRIVER-keyed rules, because no driver is named here and both are gated on that;
  //  · the ROLE-scoped one, because the counter lives in a table the content-blind handle this
  //    console reads through is deliberately not granted — a property of the role, not a guess;
  //  · any SHARD-keyed row for a shard outside the set this read used.
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
      // ── PROJECTED, NEVER RECONSTRUCTED ────────────────────────────────────────────────
      //
      // These two used to be invented here: the count was a hardcoded 1 and the title was the
      // detail's FIRST SENTENCE. So a refusal burst of forty connections rendered as "1", under
      // a heading that was really the opening clause of a paragraph — and this branch is not the
      // exceptional path, it is the ONLY path for the two driver-keyed rules and the role-scoped
      // one, because a console read names no driver and runs on the content-blind handle.
      //
      // `alert_state` now persists what the rule said, so both are read. A null means the row
      // predates those columns — a driver mid-deploy — and the fallback SAYS that rather than
      // fabricating a sentence, which is the whole difference between projecting and guessing.
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
   * THE POPULATION, FROM SQL — because the roster above is capped at `ADMIN_ROSTER_LIMIT`.
   *
   * The console's customer-facing verdict counted faults by filtering that capped array. On a
   * deployment with more than 200 mailboxes the 201st cannot contribute to a fault count however
   * broken it is, so the verdict gets QUIETER as the deployment grows — the exact inversion of
   * what it is for, and invisible from any test whose fixture is smaller than the cap.
   *
   * `blocked` gates on the TIMESTAMP and never on `sync_blocked_reason`. The service narrows that
   * reason to this build's closed set, so a block this build cannot name still has a `since`, and
   * gating on the reason would read that row as a healthy mailbox — a defect this projection has
   * shipped once already, and the same rule the console's own `mailboxBlocked` helper carries.
   * Written in SQL here, so the two spellings of one predicate have to agree.
   *
   * Three `count(*) filter (…)` over one scan of a table bounded by the mailbox population, not
   * by the message volume — the same shape as every other count on this console.
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
    // EMPTY IS THE HONEST ANSWER, AND THE SENTENCE EXPLAINING IT NAMES ONLY WHAT RUNS.
    //
    // What the worker's `cycle()` actually runs on a timer, per poll interval: folder
    // RECONCILE (`sync.ts`), the workflow TIME SCAN and DRAIN (`workflow-cron.ts`), and
    // the BUBBLE-UP resurfacing pass (`bubble-up-cron.ts`, gated by `BUBBLE_UP_EVERY_MS`).
    // Nothing writes a row when any of them do: there is no cron telemetry table anywhere in the
    // schema. A row per pass reporting `never` would be a false statement about a job that
    // finished two minutes ago, and a console caught lying once is a console whose other numbers
    // stop being read.
    //
    // This comment and the console string it mirrors used to name "the reconcile, stale-send and
    // proposal passes". Two of those three were false: `proposalGeneratePass` has no production
    // caller (deliberately — no proposer model is configured, so it is deferred with the AI
    // phase), and there is NO stale-send pass anywhere in the codebase — `staleSends` below is a
    // read-only listing computed from `outbound_sends` on this request, not the output of a job.
    // So the empty state explained a blank table by naming work that does not happen, to the one
    // reader who is trying to decide whether the system is healthy. Keep the list of passes here
    // in step with `SCHEDULE_MANIFEST` in `test/every-pass-has-a-producer.test.ts`.
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
  "Suspension, unsuspension and mailbox release are LIVE: each requires a staff session (past the " +
  "TOTP wall), not the console gate alone, and writes one audit_log row naming the operator. The " +
  "stuck-send retry is designed and not wired — its target subsystem does not exist yet — and " +
  "says so on its card.";

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
      // ── THE COPY WAS NARROWED IN THE SAME CHANGE THAT WIRED THE WRITE (mail 0039) ────────
      //
      // It used to promise "requeues a full folder pass — UIDVALIDITY is re-read, not assumed",
      // and none of that ships. Clearing a column requeues nothing, and an attach
      // is connect + lease + folders + kickstart + IDLE and syncs nothing at all — there is no
      // forced folder pass on this path to trigger. The write clears `mailboxes.retry_after` and
      // the leader re-dials on its next roster pass; the honest description of that is one line,
      // so it is one line. A forced reconcile stays filed as its own thing.
      //
      // This matters more than tidiness here. `available` flipping to true is the console making
      // a public claim, and a button whose card overstates what it does is the same defect as one
      // that reports success it cannot achieve — the reason the other two cards say so out loud.
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

