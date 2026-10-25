import { describe, it, expect } from "vitest";
import { managedDomain } from "../../../test/support/fixture-credentials.js";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
// BOTH namespaces, because the sweep below enumerates the schema itself and the schema is now in
// two halves. `@trafficflow/db` carries the mail tables; the hosted ones moved to
// `@trafficflow/db/cloud` so the desktop engine's bundle stops carrying them. The sweep must see
// every table either half defines — the pinned column count is the assertion, and reading only the
// root barrel would quietly shrink it rather than fail.
import * as dbMail_ from "@trafficflow/db";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import * as dbCloud_ from "@trafficflow/db/cloud";
import {
  accountSettings,
  accounts,
  approvals,
  attachments,
  auditLog,
  awayReplies,
  awayResponderSent,
  awaySenderState,
  awayResponders,
  changeLog,
  contactNotes,
  devices,
  drafts,
  flagState,
  graduations,
  idempotencyKeys,
  kbEntries,
  learningSignals,
  mailboxCredentials,
  mailboxProfileMirror,
  mailboxes,
  messageFailures,
  messageInstances,
  messageStates,
  notifyRules,
  organizerRequests,
  outboundSends,
  outboundSentCopies,
  pairingTokens,
  refreshTokens,
  routingDecisions,
  snippets,
  threadNotes,
  trackerEvents,
  workflowProposals,
  workflowRuns,
  workflows,
  accountSyncState,
  tags,
  messageTags,
  unsubscribeRecords,
  mailboxFolders,
  folderOps,
  junkRescues,
  listAddresses,
} from "@trafficflow/db";
import {
  accountLifecycleNotices,
  alertState,
  authEvents,
  authThrottle,
  creditRefundObligations,
  credentials,
  invites,
  loginTokens,
  pushSubscriptions,
  recoveryCodes,
  totpSecrets,
  waitlist,
  workerHeartbeats,
} from "@trafficflow/db/cloud";
import { createApp, apiRoutes, type AdminConfig, type AlertsConfig, type ApiDeps } from "@trafficflow/api";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import {
  makeDeps, seedSession, seedStaffSession, seedMailbox, seedMessage, seedBody,
  seedThread, seedContact, seedRule, seedPendingApproval, req, FIXED_NOW,
} from "./helpers.js";
import type { Db, StaffRole } from "@trafficflow/services";

/**
 * **THE ADMIN CONSOLE CANNOT SEE MAIL**, asserted by taint rather than by a field list.
 *
 * The "Account isolation is absolute, and it binds staff too" invariant: *"An account's MAIL — bodies, subjects, senders, recipients, snippets — is
 * reachable by that account's own users and by nobody else, including operators and the admin
 * console. … Enforcement must be structural and asserted by a test that has been shown to
 * fail, never a projection someone remembers to keep narrow."*
 *
 * ── WHY THIS FILE EXISTS NEXT TO `admin-routes.test.ts` ───────────────────────────────────
 *
 * That file already seeds a subject, a snippet, a sender, a body and a Stripe payload and
 * scans the six responses for them. It is a good test and it caught nothing, because it can
 * only catch what somebody thought to seed. The two leaks the first staff review actually found were both outside
 * its marker set:
 *
 *  1. A metering `meta` bag carried `dedupKey: "mid:<raw RFC822 Message-ID>"` on every AI
 *     classification, and the projection passed any string straight through. A Message-ID is
 *     chosen by the SENDING server and routinely carries the sender's domain — and, from an
 *     ESP, the recipient's address. That table has since left this server entirely, which is
 *     the strongest possible form of the fix and the reason its own assertions are gone.
 *  2. `StaleSend.idempotencyKey` was the CLIENT's `Idempotency-Key` header verbatim, and that
 *     one is still asserted below.
 *
 * Neither is a column anybody would have thought to seed with a subject. So this file inverts
 * the question: instead of enumerating what must not appear, it **writes a marker into every
 * text and jsonb column of every table in the schema** and asserts that not one of them
 * reaches a staff response. A column added tomorrow is tainted tomorrow; a projection that
 * widens to reach it fails here without anyone editing this file. That is the property the account-isolation
 * invariant asks for and a hand-listed allowlist cannot have.
 *
 * ── WHAT IS DELIBERATELY *NOT* TAINTED, AND WHY THAT IS NOT A HOLE ────────────────────────
 *
 * Two closed sets, and both are censuses rather than filters — every member is named, and an
 * unnamed column that behaves like a member FAILS the run instead of being skipped:
 *
 *  · {@link STAFF_VISIBLE} — columns an operator legitimately reads (the account name, the
 *    owner's login address, the mailbox address, the plan, the allowlisted failure token).
 *    Tainting one would make a CORRECT projection fail, so the test would be answered by
 *    narrowing the console rather than by fixing a leak. Each entry says which DTO field it
 *    feeds.
 *  · {@link PREDICATE_COLUMNS} — columns a staff QUERY filters on (`folder_state.reconcile_
 *    status = 'pending'`, `audit_log.action LIKE 'admin.%'`). Tainting one empties the
 *    response and every "no marker found" assertion passes vacuously. This is the failure mode
 *    that makes taint tests worthless, so the visibility assertions below run **inside the
 *    tainted world**, in the same test, against the same rows.
 *
 *  · {@link REFUSED_BY_CONSTRAINT} — columns whose UPDATE the DATABASE rejects (a CHECK the
 *    hand-written migrations impose). Pinned, so a new constrained column fails the census and
 *    has to be classified rather than silently skipped.
 *  · {@link UNSEEDED_TABLES} — tables this file plants no row in, so their columns cannot be
 *    tainted. Pinned for the same reason: a NEW TABLE lands in the computed list, mismatches
 *    the pin, and fails. That line in the diff is the review.
 *
 * ── AND IT IS THE RENDER PATH ONLY ────────────────────────────────────────────────────────
 *
 * This proves no staff RESPONSE carries mail. It does not prove the API's database ROLE could
 * not read `messages.subject` if some future code asked — that is the column-granted Postgres
 * role tracked as that change, which needs migrations and a second connection string and cannot be
 * asserted against PGlite (which has no roles). Do not read a green run here as the whole of
 * The "Account isolation is absolute, and it binds staff too" invariant.
 */

const app = createApp(apiRoutes);

const ADMIN_SECRET = "content-isolation-admin-fixture-token";
const ALERT_SECRET = "content-isolation-alerts-fixture-token";
const ADMIN: AdminConfig = { secret: ADMIN_SECRET, environment: "test" };
const ALERTS: AlertsConfig = { secret: ALERT_SECRET, environment: "test", sinks: [] };

/**
 * The staff session the reads demand besides the secret (NEW-ADMIN-READ-NO-SESSION). Seeded
 * AFTER `taintSchema` in the tainted worlds, deliberately: the staff tables stay in
 * `UNSEEDED_TABLES` (the sweep measures emptiness at taint time), and a fixture row planted
 * for authentication carries no marker to leak.
 */
const STAFF_TOKEN = "content-isolation-staff-session-fixture-token";
const asStaff = {
  bearer: ADMIN_SECRET, headers: { [STAFF_SESSION_HEADER]: STAFF_TOKEN },
} as const;

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/* ════════════════════════════════════════════════════════════════════════════════════════
   The routes: every `/admin/*` route the table mounts, sent or exempt by name
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * What the sweeps send to each `/admin/*` route, checked against the route table in both
 * directions: a route the table mounts and this census does not name fails, and so does a name
 * the table no longer mounts. A `read` is sent by the taint sweep, as an owner-role session, and
 * by the ops sweep; a `write` by the ops sweep alone, which reads what the write answers ops; `ops`
 * is the status an ops-only session gets. An `exempt` route says why it can answer no account's data.
 */
type RouteSweep =
  | { send: "read" | "write"; ops: 200 | 403 }
  | { send: "exempt"; why: string };

const STAFF_IDENTITY = "staff identity (a staff session, its second factor, its roles); reads no account";

const ADMIN_ROUTE_SWEEP: Readonly<Record<string, RouteSweep>> = {
  "GET /admin/overview": { send: "read", ops: 200 },
  "GET /admin/accounts": { send: "read", ops: 200 },
  "GET /admin/accounts/:id": { send: "read", ops: 200 },
  "GET /admin/accounts/:id/staff-activity": { send: "read", ops: 200 },
  "GET /admin/search": { send: "read", ops: 200 },
  "GET /admin/sync-roster": { send: "read", ops: 200 },
  "GET /admin/funnel": { send: "read", ops: 200 },
  "GET /admin/worker": { send: "read", ops: 200 },
  "GET /admin/actions": { send: "read", ops: 200 },
  "GET /admin/engagement": { send: "read", ops: 200 },
  "GET /admin/storage": { send: "read", ops: 200 },
  "GET /admin/staff-activity": { send: "read", ops: 200 },
  "GET /admin/alerts/history": { send: "read", ops: 200 },
  // POST reads: the session rides in the header (the staff list) or the body (the registration).
  "POST /admin/staff/list": { send: "read", ops: 403 },
  "POST /admin/oauth/microsoft": { send: "read", ops: 200 },
  // Writes ops may call or is refused; sent last, as ops only.
  "POST /admin/mailboxes/resync": { send: "write", ops: 200 },
  "POST /admin/accounts/:id/billing-link": { send: "write", ops: 403 },
  "POST /admin/staff/session": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/totp/begin": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/totp/confirm": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/step-up": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/totp/reset": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/whoami": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/sign-out": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/assertion": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/staff/roles": { send: "exempt", why: STAFF_IDENTITY },
  "POST /admin/oauth/microsoft/save": {
    send: "exempt",
    why: "writes the deployment's provider registration and answers what POST /admin/oauth/microsoft answers, which both sweeps read",
  },
};

const adminRoutesInTable = apiRoutes.filter((r) => r.pattern.startsWith("/admin/"));
const keyOf = (r: { method: string; pattern: string }): string => `${r.method} ${r.pattern}`;

/** A pattern with each `:param` filled; a parameter the sweep has no value for fails it. */
function fill(pattern: string, params: Readonly<Record<string, string>>): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const value: string | undefined = params[name];
    if (value === undefined) throw new Error(`${pattern}: the sweep has no value for :${name}`);
    return value;
  });
}

/** What the sweeps put in a path or a query: the world's account and mailbox, its login, and a run from inside the login's local part. */
interface SweepTerms { accountId: string; mailboxId: string; login: string; mailbox: string; loginPart: string }

const DAY_MS = 86_400_000;
const enc = encodeURIComponent;

/** Each read's query forms, sent beside its bare path. */
const QUERY_FORMS: Readonly<Record<string, (t: SweepTerms) => string[]>> = {
  // The batch by id, and the paged roster searched by a run of the login and by its domain.
  "GET /admin/accounts": (t) => [
    `ids=${t.accountId}`, `search=${enc(t.loginPart)}`, `search=${enc(t.login.slice(t.login.lastIndexOf("@") + 1))}`,
  ],
  "GET /admin/search": (t) => ["q=account", `q=${enc(t.login)}`, `q=${enc(t.mailbox)}`],
  // Around the wall clock: the seeded accounts take the database's own `now()`.
  "GET /admin/funnel": () => [
    `from=${new Date(Date.now() - 30 * DAY_MS).toISOString()}&to=${new Date(Date.now() + DAY_MS).toISOString()}`,
  ],
  "GET /admin/staff-activity": () => ["reads=1"],
};

/** What a POST the sweeps send carries beside the session token. */
const POST_BODY: Readonly<Record<string, (t: SweepTerms) => Record<string, unknown>>> = {
  "POST /admin/mailboxes/resync": (t) => ({ mailboxId: t.mailboxId, note: "ops sweep: release the backoff" }),
};

/** Every GET the table mounts under `/admin/`, bare and in each of its query forms. */
function adminGets(t: SweepTerms): Array<{ key: string; path: string }> {
  return adminRoutesInTable.filter((r) => r.method === "GET").flatMap((r) => {
    const path = fill(r.pattern, { id: t.accountId });
    const forms = QUERY_FORMS[keyOf(r)]?.(t) ?? [];
    return [path, ...forms.map((q) => `${path}?${q}`)].map((p) => ({ key: keyOf(r), path: p }));
  });
}

interface Answer { path: string; status: number; text: string }

/**
 * Every census route as one staff session: each GET form, then the POST reads, then (as ops) the
 * writes. An answer is held to its status: the census's `ops` one for an ops session, else 200.
 */
async function sweepRoutes(d: ApiDeps, token: string, t: SweepTerms, o: { ops: boolean }): Promise<Answer[]> {
  const status = (key: string): number => {
    const c = ADMIN_ROUTE_SWEEP[key];
    return o.ops && c !== undefined && c.send !== "exempt" ? c.ops : 200;
  };
  const out: Answer[] = [];
  const keep = async (key: string, path: string, res: Response): Promise<void> => {
    expect(res.status, `${key} → ${path}`).toBe(status(key));
    out.push({ path: key.startsWith("GET ") ? path : key, status: res.status, text: await res.text() });
  };
  for (const { key, path } of adminGets(t)) {
    await keep(key, path, await H(req("GET", path, { bearer: ADMIN_SECRET, headers: { [STAFF_SESSION_HEADER]: token } }), d));
  }
  for (const send of ["read", "write"] as const) {
    if (send === "write" && !o.ops) continue;
    for (const r of adminRoutesInTable.filter((x) => x.method === "POST" && ADMIN_ROUTE_SWEEP[keyOf(x)]?.send === send)) {
      const path = fill(r.pattern, { id: t.accountId });
      const body = JSON.stringify({ sessionToken: token, ...(POST_BODY[keyOf(r)]?.(t) ?? {}) });
      await keep(keyOf(r), path, await H(req("POST", path, {
        bearer: ADMIN_SECRET, headers: { [STAFF_SESSION_HEADER]: token }, body,
      }), d));
    }
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   The two censuses
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * What a reader holding only `ops` is served of a staff-visible column: the value (`whole`), its
 * domain (`masked`, `•••@domain`), or nothing (`withheld`, null). `ops` reads the platform, not
 * the people. The ops sweep below plants a marker in every masked or withheld column and reads
 * every census route as ops, so a field that serves one of them whole fails there.
 */
type OpsServed = "whole" | "masked" | "withheld";

interface StaffColumn {
  /** The DTO field it feeds. */
  feeds: string;
  /** What `ops` alone is served of it. */
  ops: OpsServed;
  /** Why ops is served that. */
  why: string;
}

const PLATFORM = "ours: the platform's own state, composed by this repository's code";

/**
 * `table.column` an operator is SUPPOSED to see, with the DTO field it feeds and what an ops-only
 * reader is served of it.
 *
 * Nothing here is mail. An account's own name, its owner's login address and its mailbox's own
 * address are the account's IDENTITY — the ruling behind the account-isolation invariant says in the
 * same breath that "subscription/usage data for user management" is legitimately visible, and
 * an operator who cannot tell one account from another cannot do user management at all.
 */
const STAFF_VISIBLE: ReadonlyMap<string, StaffColumn> = new Map<string, StaffColumn>([
  ["accounts.name", { feeds: "AccountSummary.name", ops: "whole", why: "the account's own name, how an operator tells accounts apart" }],
  ["users.email", { feeds: "AccountSummary.ownerEmail — the LOGIN address", ops: "masked", why: "a person's address" }],
  ["mailboxes.address", { feeds: "MailboxHealth.address — the account's OWN mailbox", ops: "masked", why: "a person's address" }],
  ["mailboxes.display_name", { feeds: "MailboxHealth.displayName — user-chosen at connect", ops: "withheld", why: "the name a person sends as" }],
  ["mailboxes.provider", { feeds: "MailboxHealth.provider", ops: "whole", why: "the provider word" }],
  ["mailboxes.auth_kind", { feeds: "MailboxHealth.authKind", ops: "whole", why: "password or oauth" }],
  ["mailboxes.status", { feeds: "MailboxHealth.status (and the roster's error count)", ops: "whole", why: "a closed status word" }],
  ["mailboxes.error_code", { feeds: "MailboxHealth.lastError — the 0023 taxonomy", ops: "whole", why: "a closed fault word" }],
  ["mailboxes.error_detail", { feeds: "MailboxHealth.lastError — 0023's CLOSED allowlist", ops: "whole", why: "a protocol constant from a closed list" }],
  ["worker_heartbeats.instance_id", { feeds: "WorkerInstanceHealth.instanceId", ops: "whole", why: PLATFORM }],
  ["alert_state.alert_key", { feeds: "GET /internal/alerts", ops: "whole", why: PLATFORM }],
  ["alert_state.kind", { feeds: "GET /internal/alerts", ops: "whole", why: PLATFORM }],
  ["alert_state.severity", { feeds: "GET /internal/alerts", ops: "whole", why: PLATFORM }],
  ["alert_state.detail", { feeds: "GET /internal/alerts — composed from counts and ages", ops: "whole", why: PLATFORM }],
  // cloud 0030 — the incident/signal split's two TEXT columns, both echoed by
  // `GET /internal/alerts` and by the console's Reliability page.
  //
  // `cls` is a two-word CHECK-constrained vocabulary, so the taint marker cannot be stored in it
  // at all and it never reaches this list — it is refused by the database, which is the stronger
  // outcome. `fix_href` is free-form text and therefore has to be CLASSIFIED here rather than
  // refused, and the classification is this: it is composed by the rule that fires, from a
  // literal console path with at most a UUID interpolated into it (`/worker`, `/billing`,
  // `/accounts/<uuid>`). Every producer is in `alerts.ts` and every one of them is a string
  // literal in this repository's own source; no value from `mailboxes`, `messages` or any
  // customer input reaches it, and there is no branch that could put one there.
  //
  // `affected_accounts` is an integer, so it is structurally untaintable and does not appear.
  ["alert_state.fix_href", { feeds: "GET /internal/alerts — a literal console path", ops: "whole", why: PLATFORM }],
  // cloud 0030 — `title` is free-form text and IS echoed to a staff surface, so it is classified
  // here rather than refused, on `fix_href`'s exact terms one line up.
  //
  // What makes it safe is that every producer is a string literal in this repository's own
  // source: `alerts.ts` composes each rule's title from counts, ages and closed vocabulary words
  // it computed itself. No value from `mailboxes`, `messages`, a header or any customer input
  // reaches it, and there is no branch that could put one there — the table's own header rules
  // mail content out of every field.
  //
  // It is persisted precisely BECAUSE it must cross this boundary: two alert rules are keyed by
  // driver and one by role, so a console read cannot evaluate them and can only project what the
  // worker wrote. The alternative was every reader reconstructing the title from the detail's
  // first sentence, which is a sentence nobody wrote and a heading nobody meant.
  //
  // Its neighbour `count` is an INTEGER and therefore structurally untaintable; it does not
  // appear in this list for the reason `affected_accounts` does not.
  ["alert_state.title", { feeds: "GET /internal/alerts — the rule's own sentence", ops: "whole", why: PLATFORM }],
]);

/**
 * `table.column` a staff QUERY filters on. Tainting one does not leak anything — it makes the
 * row invisible, which turns every assertion below into a tautology.
 *
 * Each entry names the predicate. If one stops being a predicate, delete it from here and let
 * the sweep taint it.
 */
const PREDICATE_COLUMNS: ReadonlySet<string> = new Set([
  // `folder_state.reconcile_status` WAS HERE ("= 'pending' → MailboxHealth.pendingMoves") and is
  // deliberately gone — No staff query filters on it any more, because no staff query
  // reads `folder_state` at all, so the sweep should TAINT it and prove the marker never
  // surfaces. That is this set's own stated rule: "if one stops being a predicate, delete it
  // from here and let the sweep taint it."
  "outbound_sends.status",           // = 'pending'  → listStuckSends
  "mailbox_credentials.transport",   // = 'imap'     → MailboxHealth.hasImapCredential
  "audit_log.action",                // LIKE 'admin.%' → AuditEntry (and it IS the DTO field)
]);

/**
 * Columns the DATABASE refuses to take a marker for — a CHECK constraint from the hand-written
 * migrations. Pinned so a NEW constrained column fails this census and gets classified.
 *
 * A closed-set status column is, by definition, a column that cannot carry mail: the set of
 * values it may hold was chosen by us and is enumerated in a migration.
 */
const REFUSED_BY_CONSTRAINT: readonly string[] = [
  "sessions.scope",   // CHECK scope in ('full','enrollment')
  // cloud 0040 / 0037 — both seeded since the account page reads their tables (cloud 0047):
  // a lifecycle notice's kind and an owed reversal's reason are closed sets behind a CHECK.
  "account_lifecycle_notices.kind",
  "credit_refund_obligations.reason",
  // …and an owed reversal's `action`, a `SpendAction` word this repository writes, bounded by a
  // length CHECK the sweep's marker exceeds. Not projected by any staff read either.
  "credit_refund_obligations.action",
  // mail 0074 — CHECK op in ('create','rename','delete') / status in ('pending','failed').
  // Both closed sets this repo enumerated; no mail server, sender or message participates in
  // choosing either, so the sweep's marker is refused by the database rather than excused
  // here. Their neighbours `to_folder` and `error` are the opposite shape — the user's own
  // folder name and a refusal code column — and are TAINTED (see the count's 166 → 168 note).
  "folder_ops.op",
  "folder_ops.status",
  // mail 0117 — CHECK status in ('pending','refused'), and CHECK last_error_class IS NULL OR IN
  // the four reconcile classes. Both sets are this repository's own: the first is whether the
  // queued move is still outstanding, the second the four sentences the worker can write about a
  // server's refusal. No mail server, sender or message participates in choosing either, so the
  // sweep's marker is refused by the database rather than excused here. Their neighbour `folder`
  // is the opposite shape — the user's own Junk folder name — and is TAINTED (the pin's note).
  "junk_rescues.status",
  "junk_rescues.last_error_class",
  // mail 0133 — CHECK act_refusal in the four refusals the act on suggestions can record. This
  // repository's own closed set; no mail server, sender or message chooses a member.
  "routing_decisions.act_refusal",
  // mail 0148 — CHECK sender_check in ('none','impersonation'): the identity fact this repository
  // computes about a message. No sender chooses a member; the brand beside it is a dictionary name.
  "messages.sender_check",
  // mail 0149 — CHECK sender_check_by in ('ingest','backfill'): which of this repository's own writers
  // gave that fact. No mail server, sender or message chooses a member.
  "messages.sender_check_by",
  // cloud 0030 — CHECK cls in ('incident','signal'). A two-word set this repository enumerated,
  // and the one column of the reliability split whose marker the database itself refuses. No
  // mail server, sender or message participates in choosing it: the value is decided by the rule
  // that fires, from a population count the rule computed. Its neighbour `fix_href` is the
  // opposite shape — free-form text, deliberately echoed to a staff surface — and is classified
  // in `STAFF_VISIBLE` instead (see the pin's note).
  "alert_state.cls",
  "waitlist.tier",    // CHECK tier in the three plan names
  // mail 0042 — CHECK `ohbox_policy IS NULL OR ohbox_policy IN ('people_only','people_and_replied')`.
  // Same bucket and the same argument as `mailboxes.disabled_reason` below: the posture is chosen by
  // the account owner out of two literals this repo enumerated (`OhboxPolicy`), so there is no value
  // a mail server or a sender can put here and the sweep's marker is refused by the database rather
  // than excused by this file. Its neighbour `ohbox_bar` is the opposite shape and is TAINTED — see
  // the pin's 153 → 154 note.
  "account_settings.ohbox_policy",
  // mail 0053 — CHECK `locale IS NULL OR locale IN ('en','de')`. The same bucket and the same
  // argument as `ohbox_policy` two lines up, with one difference worth stating because it makes the
  // classification stronger rather than weaker: this column's closed set is not merely enumerated by
  // us, it is enumerated by WHICH FILES EXIST — `apps/webapp/messages/<locale>.json` — so a value
  // outside it names a catalogue that cannot be loaded. No mail server, no sender and no message
  // participates in choosing one; the only writer is a person pressing a two-member segmented
  // control in Settings → General.
  //
  // `account_settings_locale_supported` is what makes this a fact about the database rather than a
  // hope about callers, which is why this classification and that constraint's
  // `SCHEMA_CHECK_MARKERS` entry landed in the same commit.
  "account_settings.locale",
  // mail 0082 — CHECK `theme_face in ('paper','ohmarchy')`. `locale`'s bucket and `locale`'s
  // argument one row up, member for member: the value is chosen by the account owner out of two
  // literals this repo enumerated (the appearance faces), no mail server, sender or message
  // participates in choosing one, and `account_settings_theme_face_supported` is what makes the
  // refusal a fact about the database rather than a hope about callers — this classification and
  // that constraint's `SCHEMA_CHECK_MARKERS` entry land in the same commit, 0053's pairing.
  "account_settings.theme_face",
  // mail 0083 — CHECK `screening_scope IN ('window','all_time')`. `theme_face`'s bucket and
  // `theme_face`'s argument member for member: two literals this repo enumerated, chosen by the
  // account owner on the first-run window screen (and in Settings after it), and
  // `account_settings_screening_scope_closed` is what makes the refusal a fact about the database
  // rather than a hope about callers.
  //
  // Its neighbours in the same migration are the reason this line is a classification and not a
  // rubber stamp: `organized_by_name` on `mailboxes` is a CUSTOMER MACHINE NAME — free text a
  // person typed — and it is NOT in this bucket. It is tainted, and `admin-dto.ts` never names it,
  // so staff see the organizing role and its kind and never what somebody called their laptop.
  "account_settings.screening_scope",
  // mail 0051 — CHECK `audience in ('screened_in','everyone')`. Same bucket and the same argument as
  // `ohbox_policy` directly above: the audience is chosen by the account owner out of two literals
  // this repo enumerated, so there is no value a mail server or a sender can put here and the
  // sweep's marker is refused by the database rather than excused by this file. Its neighbours on
  // the same table — `subject` and `body`, the words that actually go out — have been TAINTED since
  // the sweep existed, and its new sibling table's `sender` is tainted too (see the pin's 154 → 156
  // note), so nothing about this feature is being waved through by this line.
  "away_responders.audience",
  // mail 0087 — CHECK throttle IN ('always','per_message','per_day','per_week'). This bucket for
  // `audience`'s reason exactly, one line up: a closed enum the OWNER picks in Settings out of a
  // set we defined, so it can carry no mail and a marker cannot be stored in it at all. The words
  // that actually go out — `body` — have been TAINTED since the sweep existed, and the two tables
  // this migration adds are both seeded and tainted (see the pin's 172 → 178 note), so nothing
  // about this feature is waved through by this line.
  "away_responders.throttle",
  // mail 0087 — CHECK outcome IN ('pending','sent','unverified','throttled','suppressed'). Same
  // bucket and same argument: a five-member verdict this system writes about its own decision. Its
  // sibling columns on the same table are where the content lives — `sender` is a correspondent's
  // address and `reason` is a suppression member — and BOTH are tainted by the sweep.
  "away_replies.outcome",
  // mail 0088 — CHECK `kind IN ('screener.decide','rule.create','rule.update','rule.delete')` and
  // `state IN ('pending','sent','applied','expired')`. Same bucket and same argument: two closed
  // sets this repo enumerated, one naming which applier runs and one naming how far the request
  // has travelled. Neither is chosen by a mail server, a sender or a message — the deciding door
  // picks the kind out of its own verb list and the reader's cycle advances the state. Their
  // sibling `payload` is the opposite shape (it carries whatever the person decided, including a
  // correspondent's address) and is TAINTED by the sweep, which is what the count's own note
  // records.
  "organizer_requests.kind",
  "organizer_requests.state",
  // mail 0091 — CHECK `refused_reason IS NULL OR refused_reason IN (…)`, the eight-member refusal
  // vocabulary. 0090 shipped this column as FREE TEXT and this list did not classify it, so the
  // sweep tainted it and the count below went one over — which is how it was found, and the pin was
  // right to refuse.
  //
  // The classification is an argument ABOUT THE CHECK, exactly as `sync_blocked_reason`'s is. What
  // the column can hold in code is already closed: an organizer's acknowledgement is VERIFIED under
  // the account's key before it is read at all, `parseAck` maps any reason outside the vocabulary
  // to NULL, and `markRequestsRefused` is the only writer — so no value a mail server, a sender or
  // a message body chose can reach it. But a closed set that lives only in a parser is invisible to
  // this sweep and stops being true the day a second write path is added, with nothing failing when
  // it is. With the constraint in the schema the DATABASE refuses the marker, which is what this
  // list means. Take the CHECK away and this line becomes an assertion about free text.
  "organizer_requests.refused_reason",
  // mail 0096 — CHECK `piles <@ ARRAY['INBOX','ohmail/News']`, the two piles the away responder
  // may be asked to answer. THE FIRST ARRAY COLUMN IN THIS SCHEMA, and it enters the sweep in the
  // same change that taught `textishColumns` to see arrays at all — before that it was absent
  // rather than classified, which is the one outcome a census must never have.
  //
  // The classification is an argument ABOUT THE CHECK, as `refused_reason`'s is. Nothing a mail
  // server, a sender or a message body chose can reach this column: the only writer is the
  // settings `PUT`, whose validator admits members of the engine's own constant and 400s anything
  // else, and the offered set in the settings control is that same constant imported. But a closed
  // set that lives only in a validator is invisible to this sweep and stops being true the day a
  // second write path is added, so the DATABASE refuses a non-member. Take the CHECK away and this
  // line becomes an assertion about free text.
  //
  // It is not `STAFF_VISIBLE` either: no staff surface reads it. `away_responders`, `piles` and
  // `awayResponders` appear zero times in `admin-service.ts`, in the staff console and in
  // `routes/admin.ts` — the readers are the away pass, its service and the settings row. If a
  // console panel ever renders somebody's away scope, THIS sweep is what fails, which is the point
  // of classifying it rather than naming it in a skip list.
  "away_responders.piles",
  // mail 0027 — CHECK disabled_reason in the three `organized_elsewhere:*` values. It belongs in
  // THIS bucket rather than in `STAFF_VISIBLE`, and the difference is the point of the column's
  // design: the reason a mailbox stood down is chosen by `decideLease` out of a set we
  // enumerated, so there is no value a mail server or a message could put here. That is what
  // `error_detail` had to be retrofitted into after that change found a shape test admitting a
  // server-chosen token; this one starts closed.
  "mailboxes.disabled_reason",
  // ── mail 0083, THE THREE CONSTRAINED COLUMNS OF THE ORGANIZING ROLE ──────────────────────
  //
  // CHECK `organizer_role IN ('organizer','reader')`, `organized_by_kind IN ('cloud','local',
  // 'unknown')`, `organizer_state IN ('held','stopped')`. `disabled_reason`'s bucket directly
  // above and its argument verbatim: each set is enumerated by this repo, each is written only by
  // the lease's own verdict (`decideLease`, and the worker/sidecar sites that record it), and no
  // mail server, sender or message participates in choosing any of the three values.
  //
  // THE FOURTH COLUMN OF THAT GROUP IS NOT HERE, AND THAT IS THE POINT OF WRITING THIS BLOCK OUT.
  // `mailboxes.organized_by_name` is the name a person gave their own computer — free text with no
  // CHECK behind it — so it is TAINTED by the sweep. It is also unreachable from any staff
  // response for a second, structural reason: `admin-dto.ts` is an ALLOWLIST OF SHAPE, and it does
  // not name the field at all. (Not a deny-list — there is none; "a projection that cannot name a
  // column cannot leak it" is that file's own rule, and it is the stronger guarantee.) Staff see
  // that a mailbox is read by a `local` install; they do not see what it is called. Classifying
  // the three enums here without naming the exception would be exactly the shape of review this
  // census exists to prevent.
  "mailboxes.organizer_role",
  "mailboxes.organized_by_kind",
  "mailboxes.organizer_state",
  // mail 0104 — CHECK `takeover_intent in ('join','takeover')`. The three columns above, member
  // for member: two literals this repo enumerated (`ORGANIZER_INTENTS`), written by the door a
  // person pressed and by nothing else, so no mail server, sender or message participates in
  // choosing one and the sweep's marker is refused by the database rather than excused here.
  // `mailboxes_takeover_intent_closed` is what makes that a fact about the database. Its
  // neighbour `takeover_authorized_at` is a timestamp and carries no marker either way; neither
  // is projected by `admin-service.ts`, and `staff-grants.ts` names neither.
  "mailboxes.takeover_intent",
  // mail 0029 — CHECK sync_blocked_reason in the three `MAILBOX_SYNC_BLOCK_REASONS`. Same bucket
  // and the same argument as the column above, one step stronger: these three name the ways OUR
  // OWN infrastructure declined to serve a mailbox, so the set is enumerable by reading the
  // worker, the worker is the column's only writer, and no mail server participates in choosing a
  // value. The taint sweep therefore cannot plant a marker here, and should not be able to.
  //
  // What makes that safe rather than convenient is `mailboxes_sync_blocked_reason_closed` — which
  // is why this classification and that constraint's `SCHEMA_CHECK_MARKERS` entry landed in the
  // same commit. Take the CHECK away and this line becomes an assertion about free text.
  "mailboxes.sync_blocked_reason",
  // mail 0062 — CHECK `withheld_reason IS NULL OR withheld_reason IN ('storage_cap')`. Same
  // bucket and the same argument as `ohbox_policy` above: WHY a body row holds no content is
  // decided by the ingest reserve out of one literal this repo enumerated, no mail server,
  // sender or message participates in choosing it, and the sweep's marker is refused by the
  // DATABASE (`message_bodies_withheld_reason`) rather than excused by this file. Its
  // neighbours on the same row — `text`, `html`, `headers`, the mail itself — have been TAINTED
  // since the sweep existed, so nothing about the storage cap is waved through by this line.
  "message_bodies.withheld_reason",
  // mail 0125 — CHECK `source IN ('text','html','headers_only')` (`SEARCH_SOURCES`): where a
  // search document's words came from, chosen by the writer out of three literals; the marker is
  // refused by the DATABASE (`message_search_source_closed`). Its neighbours — the two word
  // vectors and `terms`, the mail's own words — are TAINTED like the body row's.
  "message_search.source",
  // mail 0059 — CHECK `grant IN ('invite','device-pair')`. Same bucket and the same argument as
  // `sessions.scope` at the top of this list: what redeeming a pairing token buys is chosen by
  // the minting service out of two literals this repo enumerated (`PairingGrant`), no mail
  // server, sender or message participates in choosing one, and the sweep's marker is refused by
  // the DATABASE (the migration's `pairing_tokens_grant_check`) rather than excused by this
  // file. Its free-text siblings `token_hash` and `label` are TAINTED — see the pin's 160 → 162
  // note — so nothing about the ceremony is waved through by this line.
  "pairing_tokens.grant",
  // mail 0032 — CHECK state in ('claimed','sent','refused','failed'). Same bucket and the same
  // argument as the two above: the four members name what THIS SERVICE decided to do about an
  // outbound request, they are written in exactly one file, and no mail server and no sender
  // participates in choosing one. So the sweep cannot plant a marker here and should not be able
  // to.
  //
  // The two columns beside it are NOT in this bucket and are tainted normally, which is the
  // distinction worth keeping straight: `unsubscribe_records.list_key` is a SENDER-CHOSEN string
  // (`List-ID`, else the From address) and is therefore exactly the kind of free text this file
  // exists to chase, and `refusal` is ours but nullable and unconstrained. Only `state` is closed.
  "unsubscribe_records.state",
  // mail 0041 — CHECK code in the five `MessageFailureCode` members. Same bucket and the same
  // argument as the three above, and it is the one where the argument is load-bearing rather than
  // tidy: the values name why OUR OWN ingest path could not read a message, `classifyIngestFault` is
  // their only writer, and the alternative — a free-text reason — is a column into which a throw out
  // of the parser embeds RFC822 header bytes and a Postgres data exception quotes the offending row.
  // `mailboxes.error_detail` had to be retrofitted out of exactly that; this one starts closed, and
  // `message_failures_code_closed` is what makes this line a fact about the database rather than a
  // hope about callers.
  "message_failures.code",
  // mail 0063 — CHECK `smtp_size_probe_code IS NULL OR … IN (…)`, the eight members of
  // `SMTP_SIZE_PROBE_CODES`. Same bucket as `sync_blocked_reason` two entries up and the same
  // argument at its sharpest, because this is the one column on the list whose value is DERIVED
  // FROM A THIRD PARTY'S RESPONSE and is still closed: the four failure members come from
  // `classifySmtpSizeFailure`, which reads nodemailer's own `code` field through a closed switch
  // whose default is `unknown` — never its message, which embeds the submission server's AUTH
  // response line and routinely carries the username. So a mail server DOES participate in which
  // member is chosen, and cannot participate in what the members ARE.
  //
  // That is exactly the `error_detail` shape retrofitted the right way round from the start, and
  // `mailboxes_smtp_size_probe_code_closed` is what makes this line a fact about the database
  // rather than a hope about the one call site — which is why this classification and that
  // constraint's `SCHEMA_CHECK_MARKERS` entry landed in the same commit. Its sibling
  // `smtp_size_probed_at` is a timestamp and is tainted normally.
  "mailboxes.smtp_size_probe_code",
  // mail 0097 — CHECK `last_error_class IS NULL OR IN ('refused','no_such_folder','read_only',
  // 'over_quota')`. The closest sibling of the line directly above, and the same argument: the
  // value comes FROM A MAIL SERVER'S RESPONSE and is still closed, because what a mail server
  // supplies is which MEMBER is chosen and never what the members ARE.
  //
  // `classifyMoveRefusal` in `apps/worker/src/sync.ts` reads the server's bracketed IMAP response
  // code through a closed switch whose default is `refused` — never its message text, which is
  // where a provider puts free prose and, on some hosts, echoes the folder path back. The
  // migration's own header states the same rule from the schema's side: `folder_state` forbids a
  // free-text error column, and what went wrong in the server's own words still goes only to the
  // `reconcile.move.failed` audit row.
  //
  // So the database itself refuses the sweep's marker, which is what makes this line a fact about
  // the database rather than a hope about the one call site — and the constraint arrived in the
  // same migration as the column for exactly that reason.
  "folder_state.last_error_class",
];

/**
 * Columns the sweep cannot UPDATE because the ROW is immutable, and which {@link seedWorld}
 * therefore writes the marker into at INSERT.
 *
 * EMPTY today: the one append-only table in this schema left with the money. Kept as a named,
 * empty set rather than deleted, because the mechanism is what a future immutable table needs
 * and the sweep would otherwise throw on the first UPDATE against one.
 */
const INSERT_TAINTED: ReadonlySet<string> = new Set<string>();

/**
 * Tables this file plants no row in, so nothing in them can be tainted.
 *
 * A NEW TABLE appears here automatically and fails the equality below. Seed it, or add it with
 * a reason — that line in the diff is the review, exactly as `SEAM_FIELDS` works for the
 * console's own field census.
 */
const UNSEEDED_TABLES: readonly string[] = [
  // ── MAIL 0093: THE ACCOUNT'S CLAIM ON THE CONTENT OF A SEND ──────────────────────────────
  //
  // Unseeded, and the entry says WHY rather than only that. A row here is `(account_id,
  // mailbox_id, fingerprint, send_id, created_at)` and its one text column is a SHA-256 the send
  // path computes, held to `CHECK (fingerprint ~ '^[0-9a-f]{64}$')` — so the sweep could not plant
  // a marker in it even with a row present, which is the same shape as every member of
  // {@link REFUSED_BY_CONSTRAINT}. It is structurally incapable of carrying mail: a digest is not
  // a message, and nothing a mail server, a sender or a message body chooses reaches the column.
  //
  // The other half of the argument is the read side, which is where an `UNSEEDED_TABLES` line
  // usually goes wrong. `outbound_send_fingerprints` appears NOWHERE in the staff console, nowhere
  // in `admin-service.ts` and nowhere in `routes/admin.ts`; its only readers are the send path and
  // the worker's maintenance sweep. No staff response can carry it whether or not it is tainted.
  //
  // Seeding it would also mean inventing a reservation to hang it off, which is a fixture about
  // the sending machinery rather than about an account's world — and `seedWorld` plants one
  // ACCOUNT's world. The pin below is unchanged BY THIS EDIT and that is the classification's own
  // consequence, not an oversight: an unseeded table taints no columns.
  "outbound_send_fingerprints",
  // ── CLOUD 0032: THE API'S OWN 5xx RECORD ─────────────────────────────────────────────────
  //
  // Unseeded, on `outbound_send_fingerprints`' reasoning above and in a stronger form: this table
  // has NO `account_id` and can have none. The error envelope records a fault ABOVE the session,
  // and a route that failed for want of a connection has nothing resolved to attribute it to — so
  // `seedWorld`, which plants ONE ACCOUNT's world, has no place to hang a row. Seeding one would
  // be a fixture about the request pipeline, not about an account.
  //
  // COLUMN INCAPACITY, which is the first half an UNSEEDED entry owes. Every column is a literal
  // this repository chose or an integer: `route` is the matched route PATTERN from the API's own
  // table (never a request target), `method` an HTTP verb, `status` an integer the database holds
  // to 500-599, `error_class` a class NAME and never a message, `request_id` our own uuid, and
  // `arm` a two-word closed set with a CHECK behind it. No mail server, no sender and no message
  // body participates in choosing any of them.
  //
  // THE READ SIDE, which is the half these entries usually get wrong. `api_faults` appears nowhere
  // in the staff console, nowhere in `admin-service.ts` and nowhere in `routes/admin.ts` — measured,
  // not assumed; its only readers are `evaluateAlerts` and the worker's retention sweep. It IS
  // granted to the blind staff role, because the API arm of the alert pass reads it through that
  // connection — a grant for an alert evaluation, not for a console projection, and the console
  // renders `alert_state` rather than this table.
  //
  // TAINTED_COLUMN_COUNT is unchanged by this edit, and that is the classification's own
  // consequence rather than an oversight: an unseeded table taints no columns.
  "api_faults",
  // ── MAIL 0116: WHERE THE UNSUBSCRIBE DRAIN'S WINDOW WALK STOPPED ────────────────────────
  //
  // Unseeded, and on `api_faults`' terms rather than by analogy: this table has NO `account_id`
  // and can have none. It holds ONE row per named pass for the whole deployment — the pass is
  // deployment-wide, walking every account's window in one order — so `seedWorld`, which plants
  // ONE ACCOUNT's world, has nowhere to hang a row. Its sibling `unsubscribe_examined` IS seeded
  // and stays out of this list, which is the difference stated rather than assumed.
  //
  // COLUMN INCAPACITY, the half an UNSEEDED entry owes. `pass` is a literal this repository
  // chose; `cursor_at` and `cursor_message_id` are a POSITION in the walk's `(updated_at,
  // message_id)` order, a timestamp and a row id this database minted; `updated_at` is a
  // timestamp. Nothing a mail server, a sender or a message body chooses reaches any of them.
  //
  // The read side: it appears nowhere in the staff console, nowhere in `admin-service.ts` and
  // nowhere in `routes/admin.ts` — the drain is its only reader. TAINTED_COLUMN_COUNT is
  // unchanged by this entry, which is what an unseeded table means.
  "unsubscribe_drain_state",
  // ── CLOUD 0043: AN ERASED ACCOUNT'S TOKEN HASHES ─────────────────────────────────────────
  //
  // A row is `(token_hash, account_id, expires_at)`: a SHA-256 of a random secret this server
  // minted, a uuid and an instant, written only by the erasure. Nothing a mail server, a sender or
  // a message chooses reaches any column. Unseeded because a row exists only for an ERASED
  // account, and `seedWorld` plants a live one. The read side: the table appears nowhere under
  // the staff console, `admin-service.ts`, `admin-dto.ts` or the admin routes (0 hits beside
  // `mailboxCount`'s 386); its one reader is the session door. The pin is unchanged by it.
  "erased_bearers",
  "oauth_auth_codes",        // the OAuth authorization-code exchange; no admin projection
  "webauthn_challenges",     // a 60-second passkey nonce
  "webauthn_credentials",    // passkey public keys
  // ── THESE TWO ARRIVED WHEN THE SWEEP GOT WIDER, NOT WHEN THE SCHEMA GOT BIGGER ──────────
  //
  // The Cloud tables moved to `@trafficflow/db/cloud`, and this file now enumerates BOTH
  // namespaces explicitly (see the import header). That is what put the staff tables in front of
  // the sweep: they were in the schema all along and the single-namespace read was not reaching
  // them, so the "not vacuous" claim was weaker than it read. It is stronger now, and the pin has
  // to absorb the difference rather than the difference being argued away.
  //
  // Neither is seedable HERE and neither should be. `seedWorld` plants ONE ACCOUNT's world —
  // its mail, its mailboxes, its ledger — and a staff identity is not part of any account's
  // world; it is the operator on the other side of the boundary this file exists to police.
  // Planting one would also be the wrong assertion: the question is whether a staff RESPONSE
  // carries an account's mail, and a staff row carries none of that to begin with. The surfaces
  // that do read these two are asserted in `admin-staff.test.ts`.
  //
  // NEW-ADMIN-READ-NO-SESSION did put a staff session in front of every read, so the worlds now
  // plant one AS A CREDENTIAL — always AFTER `taintSchema`, so these two entries stay true of
  // the sweep (emptiness is measured at taint time) and the fixture row carries no marker.
  "staff_sessions",          // a staff cookie's hash + expiry; no account data, no projection
  "staff_users",             // operator identity (email, password hash, TOTP); never account mail
  // Cloud 0036, on `staff_users`' terms exactly: what an OPERATOR did to a staff account (the
  // second-factor recovery), keyed `staff_user_id` with no `account_id` and no place to hang one
  // in a one-account world. Its three text columns are the action word, the operator's own name
  // and their reason — all typed by the person running an operator command, none chosen by a mail
  // server, a sender or a message. No admin read projects it: it appears nowhere under
  // the staff console, nowhere in `admin-service.ts` and nowhere in `routes/admin.ts`, and the blind
  // role is granted nothing on it. TAINTED_COLUMN_COUNT is unchanged, which is what an unseeded
  // table means.
  "staff_audit_log",
  // Cloud 0047, on the two staff tables' terms: an operator's roles and an operator's own trail,
  // keyed `staff_user_id`. The trail is written by the staff reads themselves, after the taint,
  // and the account page renders it — every text column there is an action word, a closed
  // outcome or reason, or the staff member's own label, and `detail` is narrowed through the
  // per-action allowlist on read (`admin-staff-audit.test.ts` plants a hostile row).
  "staff_audit_events",
  "staff_role_grants",
  // Cloud 0009. Unseeded HERE for the same reason as the three above, and each half is worth
  // naming because they fail the seed for DIFFERENT reasons.
  //
  // `oauth_provider_config` is not an account's data at all: it is ONE row for the whole
  // deployment holding the operator's Entra application registration, and its actor column FKs
  // `updated_by → staff_users`, which the one-account world does not plant. It is also the one
  // table in this schema whose content is a CREDENTIAL of ours rather than of a user's, and no
  // admin read projects it — the registration screen goes through `POST /admin/oauth/microsoft`,
  // which is not one of the six reads this sweep covers, and which projects `secretSet: boolean`
  // and never the envelope. Its own guard is `admin-oauth.test.ts`, over the serialized body.
  //
  // `mailbox_oauth_ceremonies` DOES belong to an account and is still not seeded, deliberately:
  // a row exists for the ninety seconds between pressing Connect Outlook and Microsoft
  // redirecting back, so a `seedWorld` that planted one would be asserting against a state no
  // account is ever found in at rest. Nothing projects it either — it is read only by the two
  // routes that mint and spend it, both keyed by `state`, neither an admin surface.
  "mailbox_oauth_ceremonies",
  "oauth_provider_config",
  // Cloud 0027 — the DEVICE-CODE ceremony. Unseeded HERE for `mailbox_oauth_ceremonies`'s reason
  // and it holds slightly better: a row exists for the fifteen minutes somebody spends walking to
  // a browser to approve a sign-in, so a `seedWorld` that planted one would be asserting against a
  // state no account is ever found in at rest.
  //
  // Its content-bearing columns are `user_code` and `verification_uri`, and neither is an
  // account's data in the sense this file polices: the URI is a Microsoft constant, and the code is
  // a short one-time string Microsoft minted that names nothing about the person. The one column
  // that IS a credential (`device_code_enc`) is a KEK envelope, and nothing projects any of them —
  // the table is read only by the two routes that mint and poll it and by the prune, all keyed by
  // `state` or by the clock, none an admin surface, and the six reads this sweep covers do not
  // join to it. If an admin surface ever reads this table, it belongs in `seedWorld` and in
  // `STAFF_VISIBLE` or nowhere, and that decision belongs in the diff that adds the read.
  "mailbox_oauth_device_ceremonies",
  // Cloud 0015 — the hosted send's upload tickets. Unseeded HERE for the same reason
  // `mailbox_oauth_ceremonies` above is, and it is the stronger version of that reason: a row
  // exists for at most 24 hours between a compose window admitting a file and the retention
  // sweep removing it, so a `seedWorld` that planted one would be asserting against a state no
  // account is ever found in at rest.
  //
  // ITS CONTENT-BEARING COLUMN IS `filename`, AND IT IS THE USER'S OWN WORDS, so the placement is
  // a judgement rather than a formality: "Q3-restructuring-final.pdf" is exactly the shape of
  // thing the "Account isolation is absolute, and it binds staff too" invariant is about. Nothing projects it — the table is read only by the mint that
  // writes it, the send that resolves it, and the sweep that deletes it, all keyed by id or by
  // the clock, none of them an admin surface, and the six reads this sweep covers do not join to
  // it. If an admin surface ever reads this table, it belongs in `seedWorld` and in
  // `STAFF_VISIBLE` or nowhere, and that decision should be made in the diff that adds the read.
  "attachment_staging",
  // ── CLOUD 0030 — THE RELIABILITY BOARD'S TWO TABLES ──────────────────────────────────────
  //
  // Unseeded, and in both cases the reason is the stronger form of it: neither has an
  // `account_id` and neither can have one.
  //
  //  · `alert_pass_runs` is one row per ALERT DRIVER — a driver word, a timestamp and four
  //    counts. It is OPS bookkeeping about a PROCESS, not about any account's world, so a
  //    one-account `seedWorld` has no honest row to plant. Its only textish column is `driver`,
  //    which is CHECK-constrained to two words, so a marker could not be stored in it even if a
  //    row existed — the database refuses it, which is stronger than the sweep proving it.
  //  · `platform_signals` is what OUR hosting platform served for OUR projects: a provider word
  //    (CHECK-constrained), a project name this repository chooses, a window, two counts, a flag
  //    and a fetch time. `project` is the only free-form text, and its every value is a
  //    deployment name from this repo's own configuration — the poller composes rows from the
  //    platform's aggregate counts and drops the path, the query string, the request id and the
  //    address before a row is formed, so nothing a request carried can reach a column.
  //
  // Both ARE echoed by staff surfaces (the Reliability page's driver panel and 5xx strip), which
  // is exactly why the placement is written out rather than assumed: what makes it safe is that
  // no account is reachable from either row in either direction — no `account_id`, no FK into
  // the account graph — so there is no join by which mail could arrive in one.
  "alert_pass_runs",
  "platform_signals",
  // Cloud 0048, on `alert_pass_runs`' terms: per driver per day, a driver word from a two-value
  // CHECK, a date, two counts and a timestamp. No `account_id`, no FK into the account graph.
  "alert_driver_gaps",
  // Cloud 0051, on the same terms: a drill run's kinds, a driver word, a sink name, closed outcome
  // codes, timestamps and an ack token's sha256, every text column held to a shape by a CHECK. No
  // `account_id`, no FK into the account graph; no staff console read selects it.
  "alert_drills",
];

/**
 * How many columns the sweep actually poisons. EXACT, not a floor — it is the third census.
 *
 * A new text or jsonb column on an already-seeded table changes nothing else in this file: it
 * is tainted automatically and, if no projection reaches it, everything stays green. Pinning
 * the total is what turns that silence into one line in a diff, next to the sentence "the
 * admin console never reads mail". A number that only ever drifts upward on its own is a
 * number that stops meaning anything.
 */
// 145 → 147 (mail 0031): `tags.name` and `tags.hue`. Reviewed, which is what this pin asks
// for: a tag NAME is the user's own words about their own mail — "Invoices" is dull, but
// "oncologist", "lawyer — divorce" and "job hunt" are the same column — so it is mail content by
// every standard this file applies, and no staff surface may render it. No admin projection joins
// `tags` or `message_tags`, and the sweep above now proves that rather than assuming it.
// 147 → 149 (mail 0032): `unsubscribe_records.list_key` and `unsubscribe_records.refusal`.
// Reviewed, which is what this pin asks for. `list_key` is the sharper of the two and is genuinely
// sensitive: it is the sender's own `List-ID`, or failing that the From address, of a list this
// user LEFT — so the table read end to end is a profile of what someone unsubscribed from, and
// "left a fertility clinic's list" is the same column as "left a shoe shop's". `refusal` is ours
// and closed in practice but unconstrained in the catalog, so it is tainted rather than excused.
// No admin projection joins `unsubscribe_records` — `admin-service.ts` and the staff console name it
// nowhere — and this sweep now proves that instead of assuming it. `state` is in
// REFUSED_BY_CONSTRAINT, so it is not among these two.
// 149 → 150 (mail 0037): `drafts.html`, the rich half of an outgoing message. Reviewed, which is
// what this pin asks for, and it is the easiest review in this list to get right: it is the same
// mail as `drafts.body` in a different encoding — the body of something this account is about to
// send — and `body`, `subject`, `to` and `cc` on that table have been tainted since the sweep
// existed. So it is content by every standard this file applies and no staff surface may render
// it. No admin projection reads `drafts` at all: `admin-service.ts` names the table only in a
// comment about an idempotency header, and the staff console names it nowhere. The sweep proves that
// rather than resting on it — the marker planted in this column reaches no staff response.
// 150 → 152 (mail 0041): `message_failures.folder` and `message_failures.attempted_version`.
// Reviewed, which is what this pin asks for.
//
//  · `folder` is the same review as `message_instances.folder` further down: an IMAP folder PATH on
//    the user's own server, never a value a sender chooses.
//  · `attempted_version` is a build identity — a git sha, or `dev`. It is OURS end to end
//    (`buildVersionOf` reads two platform variables and a file in our own image), so no mail server
//    and no sender participates in choosing one. Tainted rather than excused, so the marker proves
//    the absence instead of this sentence asserting it.
//
// `code` is not among these two — it is in `REFUSED_BY_CONSTRAINT` — and the table's remaining columns
// are a UID, an epoch, a counter and four timestamps, none of which can carry a marker.
//
// What earns the SEED rather than an `UNSEEDED_TABLES` line is that this table's PURPOSE invites
// content: it is the record of a message nobody could read, and the obvious "helpful" addition to it
// is the subject or the parser's error text. Tainting what text it has proves no staff response echoes
// it, and would fail the day a console panel grows a failed-ingest view.
// 152 → 153 (mail 0045): `drafts.bcc`. Reviewed, which is what this pin asks for.
//
// It is the fourth recipient-or-body column on `drafts` to be tainted — `body`, `subject`, `to` and
// `cc` have been since the sweep existed, and `html` was added at 149 → 150 above — so by every
// standard this file already applies it is mail content and no staff surface may render it.
//
// It is also the MOST private column on that table, which is worth saying rather than leaving to be
// inferred. Bcc rides the SMTP envelope and never the message headers (`0045_draft_bcc.sql`:
// `SendService.reserve` copies these into `OutboundMessage.bcc`, and nodemailer with `keepBcc` off
// writes no Bcc header into either the transmitted message or the Sent-folder copy). The column is
// therefore the ONLY place a blind-copied recipient is recorded at all: not in the sent mail, not in
// the recipient's copy, nowhere else in this database. A staff surface that echoed it would disclose
// something the sender's own Sent folder does not.
//
// No admin projection reads `drafts`. `admin-service.ts` names the table once, at :1311, in a comment
// about the `Idempotency-Key` header; the operator console's type file names it once, in the same
// comment; `staff-grants.ts` grants nothing on it, so the blind role cannot SELECT it. The sweep
// proves that rather than resting on it — the marker planted in this column reaches no staff response,
// which is the sibling assertion in this describe and it was watched passing over the 153-column set
// before this line moved.
//
// WHY THE PIN WAS STALE: `0045` landed in that change (2026-08-07) and this number was last set by
// (2026-08-05), two days earlier. Nothing was dropped and nothing stopped being classified;
// the census went UP by one and the line that is the review had not been written yet.
// 153 → 154 (mail 0042): `account_settings.ohbox_bar`, which is here because the table it lives on
// was SEEDED in this pass rather than exempted. Reviewed, which is what this pin asks for.
//
// `account_settings` has existed since mail 0035 and was invisible to this sweep for its whole life:
// every column was a uuid, an integer or a timestamp, so `textishColumns()` never emitted one and the
// table never reached `emptyTables`. Mail 0042 gave it its first two text columns and it surfaced as
// an unseeded table — which is the census reporting a hole it had always had, not a new one.
//
// `ohbox_bar` is the account owner's plain-language bar for their own Ohbox, in their own words, up to
// 2 KiB, rendered in Settings and threaded into the classifier's user turn. That is free text a person
// typed about who they want to hear from, which is mail content by every standard this file applies —
// "only people I have replied to" is dull, "nothing from the clinic" is the same column. So it is
// seeded and tainted rather than exempted: the marker proves no staff response echoes it, instead of a
// sentence here asserting that nobody will ever add a panel that does.
//
// An `UNSEEDED_TABLES` line would have been the cheap way out and it would have been the wrong one. The
// two staff tables and `account_suspensions` are exempt because a one-account world genuinely plants no
// operator; `account_settings` is one row of the account's OWN world, and nothing stopped it being
// planted except that nobody had.
//
// `ohbox_policy` is not among this delta — it is in `REFUSED_BY_CONSTRAINT`, where the database refuses
// the marker because the column is a closed set of two literals.
//
// 154 → 155 (mail 0050): `rules.subject_contains`, and it is the most straightforwardly TAINTED column
// added to this census in a while — the review this pin asks for, written out rather than asserted.
//
// It is the second term on a sender rule: *from this address AND with this in the subject*. The value
// is LITERAL SUBJECT-LINE TEXT — `[NinjaFirewall]`, `Rechnung 2026`, whatever fragment the account
// owner took from their own mail — so it is mail content by every standard this file applies, and by a
// shorter argument than `ohbox_bar` needed. `rules.match` beside it is an address, which this sweep has
// always tainted; a subject fragment is not a weaker case than an address, it is a stronger one.
//
// It is SEEDED AND TAINTED rather than exempted, on `ohbox_bar`'s reasoning: the marker planted here
// must reach no staff response, and the sibling assertion in this describe proves it does not. No admin
// surface projects `rules` at all today — `admin-service.ts` never selects the table — but a sentence
// here asserting that nobody will ever add a rules panel is worth nothing, whereas the marker is worth
// something on the day somebody does.
//
// Neither skip list would have been honest for it. `STAFF_VISIBLE` is for columns an operator is
// SUPPOSED to read, and this is the opposite; `REFUSED_BY_CONSTRAINT` is for a closed set, and
// `rules_subject_contains_nonempty` refuses only blank and over-long values — it accepts the marker
// perfectly well, which is exactly why the marker can do its job here.
// 155 → 157 (mail 0051): `away_responder_sent.sender` and `away_responder_sent.minted_message_id`.
// Reviewed, which is what this pin asks for, and `sender` is the sharpest column this sweep has
// gained since `unsubscribe_records.list_key` — for the same reason and one degree worse.
//
//  · `sender` is a CORRESPONDENT'S EMAIL ADDRESS, held because we sent them mail. `list_key` is a
//    profile of what somebody unsubscribed from; this table read end to end is a profile of who
//    wrote to them while they were away, with a timestamp each. It is squarely inside the
//    account-isolation invariant's "senders", and it is somebody else's personal data as well as the account owner's.
//  · `minted_message_id` is `<uuid@own-domain>` — an id WE chose for a reply WE sent, so it carries
//    no sender-chosen text. Tainted rather than excused, so the marker proves that instead of this
//    sentence asserting it.
//
// It earns the SEED rather than an `UNSEEDED_TABLES` line by `message_failures`' rule: the table is
// one row of the ACCOUNT'S OWN world (nothing stops a one-account seed planting one), and its
// purpose invites content — the obvious "helpful" addition is the subject that was answered. No
// admin projection reads it: `admin-service.ts` and the staff console name it nowhere, and
// `staff-grants.ts` grants nothing on it, so the blind role cannot SELECT it. This sweep is what
// fails the day a console panel grows an away-reply view.
//
// 157 → 158 (mail 0052): `rules.body_contains`, on `subject_contains`' review verbatim with the
// argument one notch stronger — the value is a fragment the account owner took from a message
// BODY, which is the exact content class this whole sweep exists to fence, and a body fragment
// ("your one-time code is", an account number's label) can be more sensitive than any subject
// line. Seeded and tainted rather than exempted, like its sibling: no admin surface projects
// `rules` today, and the marker is what catches the day one does. Neither skip list would be
// honest for it, for the sibling's reasons — staff are not supposed to read it, and
// `rules_body_contains_nonempty` refuses only blank and over-long values, so it accepts the
// marker perfectly well.
//
// 158 → 159 (cloud 0010): `login_tokens.challenge_hash`. THE REVIEW, since this line is it —
// and it is the easiest one this census has been handed in a long time, which is exactly why it
// is written out rather than waved through.
//
// The column holds ONE thing: the base64url SHA-256 digest a desktop install commits to before
// it asks for a sign-in handoff code, so that the code can be handed back over a URL scheme and
// still be worthless to any other program that claims the scheme. Three properties, each of
// which independently answers this sweep's question:
//
//  · It is not mail. It is a digest of 32 random bytes a process on somebody's machine invented
//    seconds earlier. No subject, sender, snippet, body, header or attachment name can be in it,
//    because none of those is ever an input to it — there is no code path that writes a message
//    field here, and a digest could not carry one legibly if there were.
//  · The only writer bounds it to a charset that cannot hold a sentence. `issueDesktopLink`
//    refuses anything that is not a fixed-length token of `[A-Za-z0-9_-]`, so no production path can
//    put text in this column at all. That is an argument about the writer and NOT a reason to
//    exempt the column here — this sweep writes with raw SQL precisely so that it does not
//    depend on a service's validation staying where it is.
//  · Nothing staff-facing reads `login_tokens` at all. `admin-service.ts` never selects the
//    table and `staff-grants.ts` grants nothing on it, so the content-blind role cannot SELECT
//    it. The sibling assertions in this describe are what prove that rather than assert it.
//
// So it is SEEDED AND TAINTED like every other new column, on `rules.subject_contains`' rule:
// neither skip list would have been honest. `STAFF_VISIBLE` is for columns an operator is
// supposed to read and this is the opposite; `REFUSED_BY_CONSTRAINT` is for a value the
// DATABASE rejects, and the column carries no constraint at all — the bound lives in the
// service, where this file deliberately does not take its evidence from.
//
// 159 → 160 (mail 0057): `messages.from_name` — the From header's display name, exactly as the
// SENDER wrote it. This one is mail content in the "Account isolation is absolute, and it binds staff too" invariant's own words ("senders"), i.e. the class
// this sweep exists to fence, so the review is short: it lands on `messages`, which since that change
// carries NO staff grant at all (not a column — the relation), `admin-service.ts` names it
// nowhere, and the marker scan below is what catches the day any staff response echoes it.
// Found by this census going red one slice after the column shipped (the VWR-2 slice updated
// parse → row → DTO and not this pin), which is the census doing its job.
//
// 160 → 162 (mail 0059): `pairing_tokens.token_hash` and `pairing_tokens.label`, the pairing
// ceremony's two free-text columns (its third text column, `grant`, is CHECK-closed and sits in
// `REFUSED_BY_CONSTRAINT`). THE REVIEW, since this line is it:
//  · `token_hash` follows `login_tokens.token_hash`'s exact reasoning three paragraphs up — a
//    sha256 digest whose writer bounds it to base64url, seeded and tainted anyway because this
//    sweep takes no evidence from a service's validation staying put.
//  · `label` is the USER'S OWN WORDS ("grandma's invite", "kitchen iPad") — content by this
//    file's standard. No staff surface may render it: `admin-service.ts` never names the table
//    and `staff-grants.ts` grants nothing on it, and the marker scan below is what catches the
//    day either stops being true.
// 163 → 165 for `mailboxes.junk_folder` and `mailboxes.trash_folder` (mail 0065) — the
// provider's own \Junk/\Trash paths, discovered at connect. THE REVIEW, since this line is it:
// both are FOLDER PATHS on the user's own server — `message_instances.folder`'s exact class,
// user-shaped but never a value a sender chooses — and NEITHER is on the staff allowlist
// (`staff-grants.ts` grants sixteen named `mailboxes` columns; these are not among them) nor in
// any admin projection, so the sweep taints them and no staff response can echo the marker.
// Their slice's commit did not move this pin, so the census sat red a day — working, late.
// 165 → 166 for `alert_state.notified_signature` (cloud 0025) — the renotify policy's
// condition signature. THE REVIEW, since this line is it: the value is composed by `alerts.ts`
// itself from an alert's severity and count (or a rule's own named dimensions), never from a
// subject, sender, snippet, body, header or attachment name — the table's own header rules mail
// content out of every field. The blind ROLE may read and write it (the alert pass's claim
// names the column, and the API driver runs over that role — `staff-grants.ts` lists it), but
// no staff RESPONSE projects it: the console reads alerts via `listOpenAlerts`, whose SELECT
// names its columns and does not name this one. Tainted here so that stays provably true.
// `alert_state.claimed_until` (cloud 0026) does NOT move this pin: it is a timestamptz, so
// the marker sweep cannot taint it — a timestamp is structurally unable to carry a subject,
// sender, snippet, body, header or attachment name, which is the whole question this census
// asks. Named here anyway so the column's absence from the count reads as reviewed, not
// missed.
// 166 → 168 is mail 0074 (`folder_ops`), which adds TWO taintable text columns to seeded
// tables. THE REVIEW, since this line is it:
//  · `folder_ops.to_folder` — a rename's target path: the user's own folder name, the same
//    class as `message_instances.folder` but chosen freehand, so strictly more sensitive. No
//    staff surface reads the table; the sweep now proves no staff response carries it.
//  · `folder_ops.error` — a closed refusal code in the product, but the column itself is free
//    text, so it is tainted rather than trusted.
// `mailbox_folders.folder` (the seeded subject row) was already counted — the table was seeded
// before this slice.
// 168 → 169 for `mailboxes.signature` (mail 0075) — the per-mailbox sign-off text, USER-AUTHORED
// CONTENT outright, the most content-shaped column this census has admitted. THE REVIEW, since
// this line is it: no staff surface reads it — `staff-grants.ts` grants sixteen named
// `mailboxes` columns and `signature` is not among them (so the API's blind role cannot even
// SELECT it), `admin-service.ts` never names it, and the staff console contains no signature surface
// — so the sweep taints it and no staff response can echo the marker. Its slice's commit did
// not move this pin, so the census sat red for a day — working, late — exactly as
// `mailboxes.junk_folder`'s did. `mailboxes.junk_sweep_requested_at` (mail 0076) does NOT move
// the pin: a timestamptz cannot carry a subject, sender, snippet, body, header or attachment
// name; named here so its absence from the count reads as reviewed, not missed.
// 169 → 171 is mail 0077 (Send later), which adds TWO taintable text columns to `drafts`, a
// seeded table. THE REVIEW, since this line is it:
//  · `drafts.send_key` — the scheduled send's Idempotency-Key, minted server-side by
//    `ScheduleService.schedule` (`randomUUID`), never user-authored and never mail content —
//    but it is a CREDENTIAL for the reservation gate, so keeping it off staff surfaces is
//    load-bearing twice over. `materializeDraft` deliberately omits it from the client DTO
//    for the same reason.
//  · `drafts.send_error` — the failure sentence from an appointment that could not be kept.
//    Server-composed words (`ServiceError.message`, or the pass's own fixed sentences), but
//    the column itself is free text, so it is tainted rather than trusted — `folder_ops.error`'s
//    exact ruling.
// No staff surface reads either: `staff-grants.ts` grants nothing on `drafts` at all (so the
// API's blind role cannot even SELECT the table), `admin-service.ts` never names it, and
// the staff console has no drafts surface — the sweep taints both and no staff response can echo
// the marker. `drafts.send_at` (same migration) does NOT move the pin: a timestamptz cannot
// carry a subject, sender, snippet, body, header or attachment name; named here so its
// absence from the count reads as reviewed, not missed.
// 171 → 172 with mail 0083. The organizing-role migration added six columns; five of them are
// timestamps, closed-set enums or the constrained `screening_scope` classified above, and exactly
// ONE is taintable free text: `mailboxes.organized_by_name`, the name a person gave their own
// computer. Two independent things keep it off a staff screen, and they prove different halves:
// this sweep proves no staff RESPONSE echoes the marker, and `admin-dto.ts` — an allowlist of
// shape that never names the field — is why no projection could express it in the first place.
// 172 → 178 (mail 0087): the away responder's ledger and its per-correspondent throttle state.
// SIX taintable columns across two new tables, and each was reviewed against the question this pin
// exists to ask — can a staff surface echo it?
//
//  · `away_replies.sender` and `away_sender_state.sender` — a CORRESPONDENT'S EMAIL ADDRESS. Third
//    party personal data, held only because we sent them mail. The sharpest content this feature
//    stores, and the reason both tables are seeded here rather than exempted.
//  · `away_replies.reason` — the suppression member (`list_mail`, `already_replied`, …). Free text
//    at the column level, so tainted rather than trusted, on `folder_ops.error`'s ruling.
//  · `away_replies.text_hash` and `away_sender_state.last_text_hash` — a sha256 of the responder's
//    own words. Not the words, but a column that could hold anything, so it is tainted.
//  · `away_replies.minted_message_id` — the `<uuid@domain>` we chose for the reply, the same shape
//    and the same ruling as `away_responder_sent.minted_message_id` (the 154 → 156 note).
//
// No staff surface reads any of it: `staff-grants.ts` grants nothing on either table, so the API's
// blind role cannot SELECT them; `admin-service.ts` names neither; and the staff console has no away
// surface at all. `away_replies.outcome` and `away_responders.throttle` do NOT move this pin —
// both are closed CHECK enums that refuse a marker outright, and they are classified in
// REFUSED_BY_CONSTRAINT. The timestamptz columns (`decided_at`, `sent_at`, `last_replied_at`,
// `enabled_at`) cannot carry a marker either.
// 178 → 179 (mail 0088): `organizer_requests.payload`. ONE taintable column on the new table, and
// it was reviewed against the question this pin exists to ask — can a staff surface echo it?
//
//  · `payload` is the DECISION ITSELF. For a `screener.decide` request that is a correspondent's
//    address plus the verdict passed on them; for a rule request it is the user's own matching
//    text. A jsonb bag, which is the shape the blind connection made unreadable rather than merely unprojected, so
//    it is seeded and tainted like every other bag.
//  · `kind` and `state` do NOT move this pin — both are closed CHECK enums that refuse a marker
//    outright, and they are classified in REFUSED_BY_CONSTRAINT.
//  · The timestamptz columns (`decided_at`, `sent_at`, `resolved_at`, `created_at`) and the three
//    uuids cannot carry a marker at all.
//
// No staff surface reads any of it: `staff-grants.ts` grants nothing on this table, so the API's
// blind role cannot SELECT it; `admin-service.ts` does not name it; and the staff console has no
// organizer-request surface.
//
// 183 → 184 for `mailboxes.organized_by_capabilities` (0.14.1, the symmetric-takeover request
// channel). Reviewed against the question this pin exists to ask — can a staff surface echo one:
//
//  · it holds a comma-joined, lower-cased SET OF CAPABILITY TOKENS, written only by
//    `capabilitiesColumn` (`packages/db/src/organizer-role.ts`) from the `X-Ohmail-Capabilities`
//    header of the claim the mailbox's holder wrote. Not mail, not derived from mail: the
//    vocabulary is this codebase's own (`requests` is the only member any build has ever
//    advertised, and no build advertises it today).
//  · free text at the column level rather than CHECK-constrained, and the migration says why: a
//    later build may advertise a member this one has never heard of, so a closed set would make
//    the row unwritable the day that ships. Tainted rather than trusted, exactly as
//    `billing_invoices.billing_reason` above is, and swept for the same reason.
//  · it is on no staff response. The console's mailbox rows carry status, provider and the
//    holder's display name; this column is not projected into any admin DTO. That is what the
//    sweep below proves, and it is the guard that fails the day somebody adds it.
// 184 → 185 for `mailboxes.organized_by_install_id` (mail 0091), which has ENTERED the sweep.
// THE REVIEW, since this line is it:
//
// The column holds WHICH INSTALL holds the mailbox's organizer claim. Two kinds of value reach it
// and neither is mail. Ours is composed by this repository — `cloudInstallId(environment)` in
// `packages/core/src/organizer-install.ts`, an `ohmail-cloud`-prefixed literal scoped by
// environment. A foreign one is read off a claim in the `ohmail/_meta` folder, so it is chosen by
// another INSTALL rather than by a mail server, a sender or a message; it is an identifier for a
// piece of software, and it carries no subject, sender, snippet, body, header or attachment name.
//
// It is TAINTED rather than exempted, and deliberately so: the value is free text with no CHECK
// (its schema comment explains why — NULL means "we cannot say it is ours", and a closed set would
// make an unknown newer organizer's id unwritable), so the honest classification is the one that
// makes the sweep prove the absence instead of this file asserting it. Nothing on a staff surface
// reads it today: `admin-service.ts` and the staff console name it nowhere, and its only readers are
// `mailbox-service.ts`'s own-claim comparison and `health.ts`'s column-existence marker pair,
// which probes that the column EXISTS and never reads a row's value. If a console panel ever
// renders which install holds a mailbox, THIS sweep is what fails — which is the point of tainting
// it rather than naming it in a skip list.
//
// Its neighbour `organized_by_name` is a different shape — a customer's MACHINE NAME, bounded at
// the write site and on the admin DTO deny-list — and `organized_by_kind` is CHECK-closed to three
// words; the three columns are classified separately for those reasons.
//
// 185 → 184 for `organizer_requests.refused_reason`, which has LEFT the sweep. The pin moved as
// the CONSEQUENCE of the review below, not to make a red test green; bumping — or lowering — the
// number is the one thing this line must never be.
//
// ── THE COLUMN WENT UP AND CAME BACK DOWN, AND BOTH MOVEMENTS WERE THE SAME ARGUMENT ──────────
//
// 0090 shipped the column as FREE TEXT and this pin rose 184 → 185 to taint it. The paragraph that
// recorded the rise gave the reason plainly: the write path was already closed — a signed
// acknowledgement, verified under a key derived from the mailbox password, parsed by a reader that
// maps anything outside its vocabulary to NULL — but a closed set that lives only in application
// code is invisible to this sweep, so the honest classification was TAINTED. That was right.
//
// It also named what would change it: a CHECK. 0091 (`0091_request_refusal_closed.sql`) adds one,
// so the eight-member vocabulary is now refused by the DATABASE rather than by review, and the
// column moves into the classified list beside `mailboxes.disabled_reason` (0027) and
// `mailboxes.sync_blocked_reason` (0029), which are the same shape for the same reason. The count
// returns to 184 because the sweep no longer has a free-text column to taint.
//
// ── THE OBJECTION THE OLD PARAGRAPH RAISED, ANSWERED RATHER THAN DROPPED ──────────────────
//
// It argued against a CHECK: a NEWER organizer may answer with a member this build has never heard
// of, and a closed set would make that row unwritable the day it ships. That objection is real and
// 0091 does not ignore it — it answers it twice over. NULL is already this column's word for "a
// refusal whose named cause this build does not recognise", so an unknown word is stored as
// nothing rather than as free text, which is what the parser did with it anyway. And the
// constraint is WIDENED AHEAD OF THE CODE that writes a ninth reason, the same deploy rule 0090's
// own state CHECK carries: a row an older build wrote still satisfies it, and narrowing is the
// direction that needs a fleet-wide stop.
//
// What has NOT changed is the other half of the review, and it is still the half that would catch
// a regression: NO STAFF SURFACE READS THE TABLE AT ALL. `organizer_requests` /
// `organizerRequests` / `refused_reason` / `refusedReason` appear ZERO times in
// `admin-service.ts`, zero times anywhere in the staff console, and zero times in
// `routes/admin.ts`; the readers are `packages/db/src/organizer-requests.ts`, `schema-mail.ts`,
// `screener-service.ts` and `account-deletion-service.ts`. A column in the classified list is
// asserted to be refused by the schema, not merely unread — and it is: take the CHECK away and
// this line becomes an assertion about free text, which is what the classification's own marker
// beside the column says.
//
// Found twice, and the second time is worth recording: the pin was red on main after that change
// landed the column, which is how it came to be 185; it went red again here the moment 0091
// classified the column out, which is how the two numbers came to disagree by one. A pin that
// refuses in BOTH directions is doing its job — but it is only a review if somebody performs the
// review, and this is that.
//
// Cloud 0030 (the incident/signal split) does NOT move this pin, and that is the interesting
// outcome rather than a quiet one — all four of its columns land in a bucket that is not "swept",
// each for a different structural reason, and every one of those reasons is stronger than a
// taint would have been:
//  · `alert_state.fix_href` is on `STAFF_VISIBLE`, because the console renders it as a link. THE
//    REVIEW, since that entry and this line are it: the value is composed by the rule that fires,
//    from a string literal in `alerts.ts` with at most a UUID interpolated into it (`/worker`,
//    `/billing`, `/accounts/<uuid>`). Every producer is in this repository's own source and there
//    is no branch by which a subject, sender, snippet, body, header or attachment name reaches
//    it. `alert_state.detail` sits in the same bucket on the same argument.
//  · `alert_state.cls` is CHECK-constrained to two words, so the DATABASE refuses the marker —
//    `REFUSED_BY_CONSTRAINT`, the strongest of the three outcomes.
//  · `alert_state.affected_accounts` is an integer and `worker_heartbeats.ai_circuit_open_since`
//    is a timestamptz: both are structurally unable to carry anybody's words, which is the whole
//    question this census asks.
// 185 → 186 (mail 0094): `mailbox_profile_mirror.doc`. ONE taintable column on the new table, and
// it was reviewed against the question this pin exists to ask — can a staff surface echo it?
//
//  · `doc` is THE ORGANIZER'S WHOLE PROFILE DOCUMENT as a reader cached it: the screener list's
//    correspondent addresses, the user's own rule text, the away-responder BODY they wrote, their
//    tag names. This is the richest single bag added to the schema since `change_log.meta`, and it
//    is a jsonb bag — the shape the blind connection made unreadable rather than merely unprojected — so it is
//    seeded and tainted like every other bag rather than argued about.
//  · `uidvalidity` (bigint) and `uid` (integer) are numbers, `read_at` is a timestamptz, and
//    `mailbox_id` / `account_id` are uuids: five columns structurally unable to carry anybody's
//    words, which is the whole question this census asks.
//
// No staff surface reads any of it: `staff-grants.ts` grants nothing on this table, so the API's
// blind role cannot SELECT it; `admin-service.ts` does not name it; and the staff console has no
// profile surface. The marker scan below is what catches that changing.
// 186 → 187 (mail 0095): `outbound_sends.resolved_by`. ONE taintable column of the two the
// migration adds, and the review the pin exists to be is this:
//
//  · `resolved_by` is WHO settled a send this server could not confirm. It is free text and not
//    CHECK-constrained on purpose — the migration's header carries that argument — so it cannot be
//    `REFUSED_BY_CONSTRAINT`, and it is swept like every other free-text column rather than
//    argued about. The values any build writes are the literals `'person'`, `'sent_folder'`
//    and `'discard'` (`schema-mail.ts` names each): `drafts-service.ts` writes the first in
//    `resolve` and the third in `remove`, `send-service.ts` the second in
//    `finalizeSentFromUnverified` — each a single `set` of a literal, and no other producer
//    exists: nothing interpolates a subject, a sender, a snippet, a body, a header or an
//    attachment name into it.
//  · NO STAFF SURFACE READS IT, measured rather than asserted: `scripts/harden-staff-role.sql`
//    grants `ohmail_admin` a COLUMN-SCOPED select on this table — `(id, account_id, status,
//    created_at)` — so the API's blind role cannot SELECT the column at all;
//    `admin-service.ts` does not name it; the staff console has no surface for a resolution. If a
//    console panel ever renders who resolved a send, that grant is the edit and the marker scan
//    below is what fails first.
//  · `resolved_at` is a timestamptz and structurally unable to carry anybody's words, which is
//    the whole question this census asks — so it is not in the sweep and the pin moves by one, not
//    by two.
//
// 187 → 188 for `mailboxes.signature_html` (mail 0098) — the signature's markup half, which has
// ENTERED the sweep. THE REVIEW, since this paragraph is it: it is USER-AUTHORED FREE TEXT, the
// same content its neighbour `mailboxes.signature` is (168 → 169 above states that case in full)
// and by the same route — a person types it in Settings → Signatures. Being markup rather than
// prose changes nothing this census asks: the question is whether a column can carry somebody's
// words, and a `<p>` around them does not stop them being words.
//
// It is not on `STAFF_VISIBLE` and must not be. No console panel reads it, and none should: a
// signature is the account's own writing, so the sweep taints it and no admin response may echo
// the marker. If a support view ever renders a mailbox's signature, THIS sweep fails, which is
// the outcome the census exists to produce.
//
// 188 → 189 for `folder_state.trashed_from` (mail 0099) — the folder a delete moved a message out
// of, which has ENTERED the sweep. THE REVIEW, since this paragraph is it: it is A FOLDER PATH,
// and a folder path CAN carry somebody's words — a user names their own folders, so
// "Steuerbescheid 2025" or a client's name is exactly the kind of string this column holds. So it
// is TAINTED, correctly, and that is the answer rather than a concession: it carries no subject,
// no sender, no snippet, no body, no header and no attachment name, which is what the sweep asks,
// and it is somebody's own private filing vocabulary either way.
//
// It is not on `STAFF_VISIBLE` and must not be. No console panel reads it, and none should: the
// two doors that select it are the account's own Trash list and its own restore. If a support view
// ever renders where somebody's deleted mail came from, THIS sweep fails, which is the outcome the
// census exists to produce.
//
// 189 -> 178 AT THE BOUNDARY: the sixteen metering tables left this schema, and eleven taintable
// columns left with them — the four the invoice mirror carried, `setup_grant_spends.source`, and
// the six on the customer, event, balance and usage tables. Every `billing_*`/`credit_*` line
// left STAFF_VISIBLE, PREDICATE_COLUMNS, REFUSED_BY_CONSTRAINT and UNSEEDED_TABLES in the same
// edit. RE-DERIVED from the schema at this tip rather than by arithmetic on the old number.
// 178 -> 179 is mail 0110_resurface_time, `account_settings.resurface_time`.
// THE REVIEW, since this line is it: an 'HH:MM' wall-clock string the account holder picks in the
// resurface chooser, refused by the route in any other shape. It carries no subject, sender,
// snippet, body, header or attachment name, and nothing a correspondent chooses reaches it. No
// staff surface reads it: it is not on STAFF_VISIBLE and `admin-service.ts` and the staff console name
// it nowhere, so the sweep taints it and no admin response echoes the marker. If a console panel
// ever renders it, THIS sweep fails.
// 179 -> 180 is mail 0113_refresh_consumed_by_attempt, `refresh_tokens.consumed_by_attempt`.
// THE REVIEW, since this line is it: the sha256 of a client-chosen attempt id, so a retry of a
// refresh whose answer was lost stops reading as a reuse. It is a HASH of an opaque id the
// client mints — it carries no subject, sender, snippet, body, header or attachment name, and
// nothing a correspondent writes reaches it. No staff surface reads it: it is not on
// STAFF_VISIBLE and neither `admin-service.ts` nor the staff console names it, so the sweep taints
// it and no admin response echoes the marker. If a console panel ever renders it, THIS sweep
// fails. The batch's three other new mail columns are timestamps and structurally untaintable.
// 180 -> 181 is mail 0117_junk_rescues, `junk_rescues.folder`. THE REVIEW, since this line is it:
// the column holds the person's own Junk folder PATH as it stood at the press — the same shape as
// `message_instances.folder` and `message_failures.folder` above, a folder name on the user's own
// server and never a value a sender chooses. It carries no subject, sender, snippet, body, header
// or attachment name. No staff surface reads the table at all: `junk_rescues` / `junkRescues` /
// `junk_rescues.folder` appear nowhere in the staff console, nowhere in `admin-service.ts` and
// nowhere in `routes/admin.ts`; the readers are the rescue route, the worker's pass and the two
// erasure sweeps. So the sweep taints it and no admin response echoes the marker — and if a
// console panel ever renders it, THIS sweep is what fails. The table's other new columns are two
// CHECK-closed sets (REFUSED_BY_CONSTRAINT, above), a bigint, an integer and three timestamps.
// 182 -> 183 is mail 0121_release_refusal, `mailboxes.release_refusal`. THE REVIEW, since this
// line is it: one of a closed set the release pass writes ('sibling_lapse'), coerced to that set
// at the projection, NULL on every other row. It carries no subject, sender, snippet, body,
// header or attachment name, and nothing a correspondent chooses reaches it. No staff surface
// reads it: `releaseRefusal` and `release_refusal` appear nowhere in the staff console, nowhere in
// admin-service.ts or admin-dto.ts and nowhere in the three admin routes — measured beside a
// positive control through the same paths (`mailboxCount`, 8 hits) — so the sweep taints it and
// no admin response echoes the marker. If a console panel ever renders it, THIS sweep fails.
// The range's other new column, `account_sync_state.pruned_through_seq`, is a bigint and
// structurally untaintable.
// 183 -> 186 is cloud 0041_desktop_approval: `login_tokens.label`, `.platform`, `.ip_class`. THE
// REVIEW: the desktop's own hostname (control and bidi characters stripped, 64 at most), a closed
// set's display name and a network class — no subject, sender, snippet, body, header or attachment
// name. No staff surface reads the table: `loginTokens`/`login_tokens` appear nowhere under
// the staff console, admin-service.ts, admin-dto.ts or the admin routes (0 hits beside `mailboxCount`'s 36).

// 186 → 187 for mail 0125's `message_search.terms` — the message's subject, people and file names
// lower-cased, the mail itself and so TAINTED and seeded; its two word vectors are not text columns
// the sweep writes, and `source` is refused by its CHECK. REVIEW: no staff surface reads the table —
// `message_search`/`messageSearch` appear nowhere in the staff console, admin-service.ts or the admin
// routes, and `packages/core/test/message-search-census.test.ts` closes its reader set.

// 187 → 188 for mail 0127's `mailboxes.signed_out_meta` — where a signed-out mailbox's servers are
// (host, port, secure, login), never a password. REVIEW: no staff surface reads it — every
// `mailboxes` read in admin-service.ts is a named projection without it, the mailbox DTO does not
// carry it, and it appears nowhere in the staff console or the admin routes.
// 188 → 191 for mail 0129's three text columns on `mailboxes` — a press of Import settings the
// organizer finishes: `profile_import_ask_fingerprint` (a digest of the settings document, never
// its content), `profile_import_ask_outcome` and `profile_import_ask_reason` (closed sets).
// REVIEW: no staff surface reads them — every `mailboxes` read in admin-service.ts is a named
// projection without them, the mailbox DTO does not carry them, and they appear nowhere under
// the staff console or the admin routes.
// 191 → 192 for mail 0132's `mailboxes.sent_folder` — the mailbox's own Sent
// folder PATH, written at attach: `junk_folder`'s exact class (a folder name on the user's own
// server, never a value a sender chooses). REVIEW: not on the staff allowlist, in no admin
// projection, and nowhere in the staff console, admin-service.ts or the admin routes; the mailbox DTO
// does not carry it.
// 192 → 193 for cloud 0046_totp_pending_replacement's `totp_secrets.pending_secret_enc` — a
// replacement authenticator's sealed secret. REVIEW: nothing under packages/api/src,
// admin-service.ts, admin-dto.ts or the staff console names `totp_secrets` at all.
/* TAINTED_COLUMN_COUNT IS DERIVED (MATURITY-026, ruled 2026-09-27): every textish column of a seeded
 * table that is not skipped or refused is tainted, and its marker is scanned in every staff response,
 * so a new column is swept without a hand-edit here — the sweep is the review. The literal (191)
 * moved with each column and never caught a leak; the notes below are the reviews it carried. */
const taintedColumnCount = (s: SweepResult): number =>
  textishColumns().filter((c) => !s.skipped.includes(`${c.table}.${c.column}`) && !s.emptyTables.includes(c.table)).length
    - s.refused.length;
// 145 is mail 0028_message_instances, which adds THREE text columns to seeded tables.
// THE REVIEW, since this line is it:
//
//  · `message_instances.folder` — an IMAP folder PATH. It is the one of the three that could carry
//    anything user-shaped, and it is a folder name on the user's own server, never a value a sender
//    chooses. It is safe here structurally rather than hopefully: no staff surface reads the table at
//    all (`admin-service.ts` and the staff console name it nowhere), so the sweep taints it and no admin
//    response echoes the marker. If a console panel ever grows a locator view, THIS sweep fails.
//  · `attachments.content_sha256` — a sha256 hex digest of bytes we do not store. It cannot carry a
//    filename, a subject or a sender; it is 64 characters of hex, or NULL.
//  · `messages.auth_verdict` — slice 3's column, written by nothing in this deploy. Its future
//    vocabulary is a closed set of six tokens this application computes, so it cannot carry mail
//    either. Tainted rather than exempted, so the marker proves that instead of asserting it.
// 142 as of that change. The schema did not change — `folder_state.reconcile_status` LEFT
// {@link PREDICATE_COLUMNS} and therefore entered the sweep. THE REVIEW, since this line is it:
// the column is a closed-set token this application writes (`'pending' | 'reconciled'`, derived
// from desired vs observed at every write — mail `0000`/`0024`), so it cannot carry mail in the
// first place; and it is now unreachable from any staff surface, because a review fix retired the
// `messages` and `folder_state` grants together and `MailboxHealth.pendingMoves` is a constant 0.
// Tainting it is strictly better than exempting it: the marker proves the absence instead of the
// exemption asserting it. If a console panel ever renders a reconcile status again, this sweep is
// what fails.
//
// 141 was mail 0026_thread_resolution, which adds `threads.root_message_id_header`.
// THE REVIEW, since this line is it: the column holds a Message-ID, which is
// `<opaque-token>@sender-domain.tld` — so it CAN carry a sender's domain and is squarely inside
// The "Account isolation is absolute, and it binds staff too" invariant's "senders". It is safe here for a structural reason and not a hopeful one: no
// staff surface reads the `threads` table at all (`admin-service.ts` and the staff console name it
// nowhere), so the sweep taints the column and no admin response echoes the marker. If a future
// console panel ever grows a conversation view, THIS sweep is what will fail — which is the
// point of pinning the number rather than letting it drift.

/* ════════════════════════════════════════════════════════════════════════════════════════
   The sweep
   ════════════════════════════════════════════════════════════════════════════════════════ */

/** `ZZB1_MESSAGES__SUBJECT_ZZ` — greppable, JSON-safe, and unique per column. */
const markerFor = (table: string, column: string): string =>
  `ZZB1_${table.toUpperCase()}__${column.toUpperCase()}_ZZ`;

interface SchemaColumn { table: string; column: string; jsonb: boolean }

/**
 * Every non-generated text/jsonb column in the schema, from the schema itself.
 *
 * ── AND EVERY TEXT ARRAY, WHICH THIS USED TO MISS SILENTLY ──────────────────────────────────
 *
 * The filter was a list of four `columnType`s. A `text[]` column's type is `PgArray`, so it
 * matched none of them and was dropped from the sweep with nothing said — not skipped, not
 * classified, not tainted: absent. `away_responders.piles` (mail 0096) is the FIRST array column
 * this schema has ever had, which is exactly why the blind spot had never cost anything and why
 * nobody would have noticed it opening: the pinned count below would have stayed correct, the
 * suite green, and the next `text[]` column — one holding whatever a person typed — would have
 * been invisible to the census that exists to find it.
 *
 * So an array is included when its ELEMENT type is one of the four. The element type is what
 * decides whether the column can carry text at all; the arrayness is storage.
 */
function textishColumns(): SchemaColumn[] {
  const out: SchemaColumn[] = [];
  const both = { ...(dbMail_ as Record<string, unknown>), ...(dbCloud_ as Record<string, unknown>) };
  for (const value of Object.values(both)) {
    if (!is(value, PgTable)) continue;
    const table = getTableName(value);
    for (const column of Object.values(getTableColumns(value))) {
      if (column.generated) continue;
      /* An array is judged by what it HOLDS: `baseColumn` is the element column, so a
         `text[]` reads as text and an `integer[]` is correctly ignored. */
      const base = (column as { baseColumn?: { columnType?: string } }).baseColumn;
      const t = column.columnType === "PgArray" && base?.columnType
        ? base.columnType
        : column.columnType;
      if (t !== "PgText" && t !== "PgVarchar" && t !== "PgJsonb" && t !== "PgJson") continue;
      out.push({ table, column: column.name, jsonb: t === "PgJsonb" || t === "PgJson" });
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function countRows(db: Db, table: string): Promise<number> {
  const res = await db.execute(sql.raw(`select count(*)::int as n from "${table}"`));
  return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
}

interface SweepResult {
  tainted: SchemaColumn[];
  refused: string[];
  emptyTables: string[];
  skipped: string[];
}

/**
 * Write a marker into every taintable column of every populated table.
 *
 * Each UPDATE is its own statement so a constraint rejection classifies ONE column instead of
 * aborting the sweep — and a rejection is never swallowed: it lands in `refused`, which is
 * pinned.
 */
async function taintSchema(db: Db): Promise<SweepResult> {
  const columns = textishColumns();
  const populated = new Map<string, boolean>();
  const tainted: SchemaColumn[] = [];
  const refused: string[] = [];
  const skipped: string[] = [];
  const emptyTables = new Set<string>();

  for (const col of columns) {
    const key = `${col.table}.${col.column}`;
    if (STAFF_VISIBLE.has(key) || PREDICATE_COLUMNS.has(key)) {
      skipped.push(key);
      continue;
    }
    if (!populated.has(col.table)) populated.set(col.table, (await countRows(db, col.table)) > 0);
    if (!populated.get(col.table)) {
      emptyTables.add(col.table);
      continue;
    }
    if (INSERT_TAINTED.has(key)) {
      // Already carrying its marker from `seedWorld`; `verifyTaint` proves it, and it counts
      // as tainted so the response scan below covers it like every other column.
      tainted.push(col);
      continue;
    }
    const marker = markerFor(col.table, col.column);
    // PER-ROW UNIQUE, via `ctid`. A constant would collide with the UNIQUE indexes on
    // `waitlist.email`, `push_subscriptions.endpoint`, `refresh_tokens.token_hash` and six
    // others the moment a second account exists — and a collision is a REFUSED update, i.e. a
    // column silently left clean in exactly the two-account world the cross-account test runs
    // in. The marker stays a prefix, so every `includes(marker)` check is unaffected.
    const value = col.jsonb
      ? `jsonb_build_object('tainted', '${marker}' || ctid::text)`
      : `'${marker}' || ctid::text`;
    try {
      await db.execute(sql.raw(`update "${col.table}" set "${col.column}" = ${value}`));
      tainted.push(col);
    } catch {
      refused.push(key);
    }
  }
  return { tainted, refused, emptyTables: [...emptyTables].sort(), skipped };
}

/** Read every tainted column back. A sweep that wrote nothing must not pass. */
async function verifyTaint(db: Db, tainted: SchemaColumn[]): Promise<string[]> {
  const missing: string[] = [];
  for (const col of tainted) {
    const marker = markerFor(col.table, col.column);
    const res = await db.execute(sql.raw(
      `select count(*)::int as n from "${col.table}" where "${col.column}"::text like '%${marker}%'`,
    ));
    if (Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0) === 0) missing.push(`${col.table}.${col.column}`);
  }
  return missing;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   One account, and a row in (almost) every table
   ════════════════════════════════════════════════════════════════════════════════════════ */

interface World {
  accountId: string;
  userId: string;
  sessionId: string;
  mailboxId: string;
  messageId: string;
  draftId: string;
}

/**
 * Plant one row in every table the sweep can reach, so the taint has something to bite.
 *
 * It deliberately builds a REALISTIC account rather than a minimal one — a stuck send, a
 * failed Stripe event, a pending move, an open alert, an `admin.*` audit row — because those
 * are precisely the rows the six reads project, and a table with no rows contributes nothing
 * to a taint sweep.
 */
async function seedWorld(db: Db, tag: string): Promise<World> {
  const session = await seedSession(db, { now: FIXED_NOW, token: `tok-${tag}` });
  const accountId = session.accountId;
  await db.update(accounts).set({ name: `Account ${tag}` }).where(sql`${accounts.id} = ${accountId}`);
  // One row so the sweep can reach `ohbox_bar` — see TAINTED_COLUMN_COUNT's 153 → 154 note. The
  // policy literal is the one the migration documents as identical in effect to NULL, so seeding this
  // row changes no behaviour any other test in this file observes.
  await db.insert(accountSettings).values({
    accountId, ohboxPolicy: "people_and_replied", ohboxBar: `ohbox bar ${tag}`,
  });

  const mailboxId = await seedMailbox(db, {
    accountId, address: `ops-${tag}@example.com`, folders: [{ folder: "INBOX" }],
  });
  await db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: `enc-${tag}`, keyVersion: 1,
    meta: { host: "imap.example.com", user: `ops-${tag}@example.com` },
  });

  const threadId = await seedThread(db, { accountId, subject: `thread subject ${tag}` });
  // `reconcileStatus: 'pending'` used to be what made `MailboxHealth.pendingMoves` non-zero. It
  // stays seeded after that change for the opposite reason: it is what makes the 0 the console now
  // renders a REDACTION rather than an empty table.
  const message = await seedMessage(db, {
    accountId, mailboxId, threadId,
    subject: `subject ${tag}`, fromAddress: `sender-${tag}@example.com`, snippet: `snippet ${tag}`,
    folder: "ohmail/News", observedFolder: "INBOX", reconcileStatus: "pending",
  });
  await seedBody(db, {
    messageId: message.id, text: `body ${tag}`, html: `<p>body ${tag}</p>`,
    headers: { "message-id": `<${tag}@mail.example.com>` },
  });
  await db.insert(attachments).values({
    accountId, messageId: message.id, filename: `invoice-${tag}.pdf`, contentType: "application/pdf",
  });
  // THE SEARCH DOCUMENT (mail 0125) — the message's own words a second time, so SEEDED: a staff
  // projection that joined it for a "top terms" panel is exactly what the sweep must catch.
  await upsertMessageSearch(db as never, message.id, {
    accountId, subject: `subject ${tag}`, from: { name: null, address: `sender-${tag}@example.com` },
    to: [], cc: [], attachmentNames: [`invoice-${tag}.pdf`], bodyText: `body ${tag}`, source: "text",
  });
  // TAGS (mail 0031). SEEDED rather than exempted, and the reason is what a tag NAME is: the
  // user's own words about their own mail. "Invoices" is dull; "oncologist", "lawyer — divorce"
  // and "job hunt" are the same column, and they are exactly the kind of thing a staff console
  // has no business rendering. Planting the marker in `tags.name` and `tags.hue` is what makes
  // the sweep able to catch a future admin projection that joins this table for a "top labels"
  // panel. `message_tags` carries no text column, so there is nothing in it to taint.
  const [tagRow] = await db.insert(tags).values({
    accountId, name: `tag name ${tag}`, hue: `hue ${tag}`,
  }).returning();
  await db.insert(messageTags).values({ accountId, messageId: message.id, tagId: tagRow!.id });
  // AUTO-UNSUBSCRIBE'S RECORD (mail 0032). SEEDED rather than exempted, and `list_key` is
  // the reason: it is the RFC 2919 `List-ID` of a list the user left, or failing that the
  // sender's address — so this table is a list of WHO THIS PERSON UNSUBSCRIBED FROM. That is a
  // profile. "leaving a fertility clinic's newsletter" and "leaving a debt-advice list" are the
  // same column as "leaving a shoe shop's", and no staff surface may render any of them.
  // Seeding it means the sweep taints `list_key`, `state` and `refusal` and every staff response
  // is then checked for the marker — which PROVES the absence rather than asserting it, and would
  // fail the day an admin panel grows an "unsubscribe activity" view.
  await db.insert(unsubscribeRecords).values({
    accountId, mailboxId, messageId: message.id,
    listKey: `list key ${tag}`, state: "sent", refusal: null, httpStatus: 200,
  });
  // A FOLDER COMMAND AT REST (mail 0074). SEEDED rather than exempted, and `to_folder` is the
  // reason: it is the user's OWN WORDS about their own mail — a rename target like
  // "lawyer — divorce/2026" is exactly the "Account isolation is absolute, and it binds staff too" invariant's shape — and a FAILED command persists at
  // rest until the user dismisses it, so a world with none would be asserting against a state
  // accounts are genuinely found in. Seeding it means the sweep taints `to_folder` and `error`
  // and every staff response is then checked for the marker; `op` and `status` are CHECK-closed
  // and land in REFUSED_BY_CONSTRAINT instead. The subject row is its own mailbox_folders line
  // so the CHECK pairing (`rename` ⇔ `to_folder IS NOT NULL`) holds under the sweep's UPDATE.
  const [cmdFolder] = await db.insert(mailboxFolders).values({
    mailboxId, folder: `Mandate ${tag}`, uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n,
  }).returning();
  await db.insert(folderOps).values({
    accountId, mailboxId, folderId: cmdFolder!.id,
    op: "rename", toFolder: `Mandate ${tag}/2026`, status: "failed", error: `exists ${tag}`,
  });
  // The junk rescue's desired state (mail 0117). SEEDED rather than exempted, on `folder_ops`'
  // rule: the sweep then taints `junk_rescues.folder` — the person's own Junk folder name — and
  // every staff response is checked for the marker. `status` and `last_error_class` are
  // CHECK-closed and land in REFUSED_BY_CONSTRAINT instead. The row is a live command, which is a
  // state accounts are genuinely found in between a press and the organizer's next cycle.
  await db.insert(junkRescues).values({
    accountId, mailboxId, folder: `Junk ${tag}`, uidvalidity: 7n, uid: 3,
  });
  // PHYSICAL identity. SEEDED rather than exempted, deliberately: the
  // sweep then taints `message_instances.folder` and every staff response is checked for the
  // marker, which PROVES the absence instead of an `UNSEEDED_TABLES` line asserting it.
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId: message.id, folder: "ohmail/News", uidvalidity: 1n, uid: 7,
    isPrimary: true,
  });
  // The DURABLE per-message failure ledger (mail 0041). SEEDED rather than exempted, on
  // `message_instances`' rule and with a sharper reason of its own: this table exists to keep a
  // record of a message the product could not read, and the temptation attached to such a record is
  // to make it diagnosable — a subject, a sender, an error string. It holds none of those, and
  // seeding it is what makes the sweep prove that: `message_failures.folder` is tainted and every
  // staff response is checked for the marker. `code` lands in `REFUSED_BY_CONSTRAINT`, which is
  // exactly where a closed set belongs.
  //
  // Take the grant question separately: this table is granted to `ohmail_admin` NOWHERE, because the
  // information is in the row's EXISTENCE and no column list closes that — see the schema's note.
  // This sweep is the render-path half of the same invariant.
  await db.insert(messageFailures).values({
    accountId, mailboxId, folder: "ohmail/News", uidvalidity: 1n, uid: 7,
    code: "mime_unparseable", attemptedVersion: "test",
  });
  await db.insert(messageStates).values({ accountId, messageId: message.id, state: "answer_later" });
  await db.insert(flagState).values({
    messageId: message.id, desiredSeen: false, observedSeen: false, lastSetBy: "us",
  });
  await db.insert(trackerEvents).values({
    accountId, messageId: message.id, kind: "pixel", trackerHost: "track.example.com",
    url: "https://track.example.com/p.gif",
  });
  await seedPendingApproval(db, { accountId, messageId: message.id });

  const contactId = await seedContact(db, { accountId, address: `contact-${tag}@example.com` });
  await db.insert(contactNotes).values({ accountId, contactId, body: `contact note ${tag}` });
  // Mail 0150: an address a list posts as and the brands a press consented there — read off a
  // sender's headers, so seeded and swept like `contacts` rather than named unseeded.
  await db.insert(listAddresses).values({ accountId, address: `list-${tag}@example.com`, consentedBrands: [`brand ${tag}`] });
  await db.insert(threadNotes).values({ accountId, threadId, body: `thread note ${tag}` });
  await seedRule(db, { accountId, match: `sender-${tag}@example.com` });

  const [draft] = await db.insert(drafts).values({
    accountId, mailboxId, subject: `draft subject ${tag}`, body: `draft body ${tag}`,
    to: [{ address: `to-${tag}@example.com` }],
  }).returning();
  // Old enough that `listStuckSends` (10 minutes) picks it up.
  const [stuck] = await db.insert(outboundSends).values({
    accountId, idempotencyKey: `idem-${tag}`, draftId: draft!.id,
    mintedMessageId: `<minted-${tag}@ohmail.app>`, status: "pending",
    createdAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000),
  }).returning();
  // A delivered message's owed Sent copy (mail 0170): its bytes are mail, seeded and swept as such.
  await db.insert(outboundSentCopies).values({
    sendId: stuck!.id, accountId, mailboxId, rawB64: Buffer.from(`owed copy ${tag}`).toString("base64"),
  });

  await db.insert(kbEntries).values({ accountId, title: `kb ${tag}`, content: `kb content ${tag}` });
  await db.insert(snippets).values({ accountId, title: `snip ${tag}`, body: `snip body ${tag}` });
  await db.insert(awayResponders).values({
    accountId, body: `away body ${tag}`, throttle: "per_day", enabledAt: FIXED_NOW,
  });
  await db.insert(awayResponderSent).values({
    accountId, sender: `correspondent-${tag}@example.com`, responderUpdatedAt: FIXED_NOW,
    mintedMessageId: `<away-reply-${tag}@ohmail.app>`,
  });
  /* mail 0087 — the away responder's LEDGER and its per-correspondent throttle state.
     SEEDED rather than exempted, and the reason is the sweep's own subject: both tables key on a
     CORRESPONDENT'S EMAIL ADDRESS — a third party's personal data, held only because we sent them
     mail — and `away_replies` additionally records that a named person wrote to this account and
     when. That is precisely the content no staff response may carry, so it belongs in front of the
     taint rather than behind an exemption. */
  await db.insert(awayReplies).values({
    accountId, mailboxId, messageId: message.id,
    sender: `away-ledger-${tag}@example.com`, outcome: "sent", reason: null,
    textHash: `away-text-hash-${tag}`, mintedMessageId: `<away-ledger-${tag}@ohmail.app>`,
    decidedAt: FIXED_NOW, sentAt: FIXED_NOW,
  });
  await db.insert(awaySenderState).values({
    accountId, sender: `away-state-${tag}@example.com`,
    lastRepliedAt: FIXED_NOW, lastTextHash: `away-state-hash-${tag}`,
  });
  /* mail 0088 — a decision made where the mailbox is READ, waiting for the install that organizes
     it. SEEDED rather than exempted, on the pair above's reasoning: `payload` carries whatever the
     person decided, and for the `screener.decide` kind that is a CORRESPONDENT'S ADDRESS together
     with the verdict passed on them. It is a jsonb bag, which is the shape the blind connection made unreadable
     rather than merely unprojected, so it belongs in front of the taint. `kind` and `state` are
     closed CHECK enums and land in REFUSED_BY_CONSTRAINT. */
  await db.insert(organizerRequests).values({
    accountId, mailboxId, kind: "screener.decide",
    payload: { sender: `request-${tag}@example.com`, verdict: "screened_in" },
    decidedAt: FIXED_NOW, state: "pending",
  });
  /* mail 0094 — the other half of that channel: what the ORGANIZER published, cached by an install
     that only reads this mailbox. SEEDED rather than exempted, on the row above's reasoning and
     more strongly. `doc` is the whole profile document, so it carries correspondent addresses from
     the screener list, the user's own rule text, and the away-responder BODY — a message they
     wrote. It is a jsonb bag, the shape the blind connection made unreadable rather than merely unprojected, so it
     belongs in front of the taint.

     And it is an ordinary at-rest state, which is what separates this from the ceremony tables in
     UNSEEDED_TABLES: a reader install that has read a document once keeps this row indefinitely,
     rather than for the ninety seconds of a redirect. */
  await db.insert(mailboxProfileMirror).values({
    mailboxId, accountId,
    uidvalidity: 1_759_000_000n, uid: 7,
    doc: { v: 1, awayResponder: { body: `profile away body ${tag}` }, tagNames: [`tag-${tag}`] },
    readAt: FIXED_NOW,
  });
  await db.insert(notifyRules).values({ accountId, target: `notify-${tag}@example.com` });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: `act-${tag}`, kind: "move",
    senderAddress: `sender-${tag}@example.com`, senderDomain: "example.com", label: "reads",
  });
  await db.insert(graduations).values({ accountId, patternKey: `sender:sender-${tag}@example.com` });
  const [wf] = await db.insert(workflows).values({ accountId, name: `wf ${tag}` }).returning();
  await db.insert(workflowRuns).values({ accountId, workflowId: wf!.id });
  await db.insert(workflowProposals).values({ accountId, name: `proposal ${tag}` });
  await db.insert(devices).values({ accountId, userId: session.userId, kind: "web", label: `dev ${tag}` });
  await db.insert(pushSubscriptions).values({ accountId, transport: "web", endpoint: `https://push/${tag}` });
  await db.insert(accountSyncState).values({ accountId });

  // `change_log` is the richest non-body content table in the schema — the delta-sync feed.
  await db.insert(changeLog).values({
    accountId, seq: 1n, entityType: "message", entityId: message.id, op: "update",
    meta: { from: "INBOX", to: "ohmail/News" },
  });

  // `admin.*` so `loadAudit`'s namespace filter MATCHES it: an audit row the filter drops
  // would make the payload assertions vacuous. See PREDICATE_COLUMNS.
  await db.insert(auditLog).values({
    accountId, action: "admin.mailbox.resync",
    payload: { account_id: accountId, note: `staff note ${tag}`, actor: "staff_test" },
    inverse: null,
  });

  // Auth material — never staff-visible, and it is here so the sweep proves it.
  await db.insert(credentials).values({ userId: session.userId, passwordHash: `password-hash-${tag}` });
  // With a replacement in progress (cloud 0046) seeded whole, so the CHECK that seals the trio
  // admits the sweep's marker in its ciphertext and that column is tainted rather than refused.
  await db.insert(totpSecrets).values({
    userId: session.userId, secretEnc: `totp-${tag}`, keyVersion: 1,
    pendingSecretEnc: `totp-pending-${tag}`, pendingKeyVersion: 1, pendingStartedAt: FIXED_NOW,
  });
  await db.insert(recoveryCodes).values({
    userId: session.userId, codeHash: `rec-${tag}`, batchId: crypto.randomUUID(),
  });
  await db.insert(refreshTokens).values({
    accountId, userId: session.userId, sessionId: session.sessionId,
    familyId: crypto.randomUUID(), tokenHash: `rt-${tag}`,
    expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
  });
  await db.insert(loginTokens).values({
    userId: session.userId, tokenHash: `lt-${tag}`,
    expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
  });
  // A pairing token (mail 0059) — a credential the user minted, whose `label` is the user's own
  // words. Part of the account's world, so it is SEEDED (unlike the operator-side tables in
  // UNSEEDED_TABLES) and the sweep proves no staff response carries its digest or its label.
  await db.insert(pairingTokens).values({
    createdByUserId: session.userId, grant: "invite", tokenHash: `pt-${tag}`,
    label: `pairing-label-${tag}`, expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
  });
  await db.insert(invites).values({
    codeHash: `inv-${tag}`, email: `invited-${tag}@example.com`,
    expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
  });
  await db.insert(waitlist).values({ email: `wait-${tag}@example.com` });
  await db.insert(authEvents).values({ event: "login", accountId, userId: session.userId });
  // Cloud 0047's account page reads both: seeded so the sweep taints what it projects.
  await db.insert(accountLifecycleNotices).values({ accountId, kind: "closed", anchor: FIXED_NOW });
  await db.insert(creditRefundObligations).values({
    accountId, action: `act-${tag}`, attemptKey: `ak-${tag}`, attempt: `att-${tag}`,
    reason: "drafter_failed", lastFault: `fault-${tag}`,
  });
  await db.insert(authThrottle).values({ key: `throttle-${tag}` });
  await db.insert(idempotencyKeys).values({
    accountId, key: `idemk-${tag}`, requestHash: `hash-${tag}`, responseStatus: 200,
    responseJson: { ok: true }, expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
  });

  return {
    accountId, userId: session.userId, sessionId: session.sessionId,
    mailboxId, messageId: message.id, draftId: draft!.id,
  };
}

/** The infrastructure rows — one heartbeat, one open alert. Not account-scoped. */
async function seedInfrastructure(db: Db): Promise<void> {
  await db.insert(workerHeartbeats).values({
    shardIndex: 0, instanceId: "wkr-test", leader: true, shards: 1,
    mailboxes: 1, expected: 1, accounts: 1, quarantined: 0, degraded: false,
    lastCycleAt: FIXED_NOW, startedAt: FIXED_NOW, beatAt: FIXED_NOW,
  });
  await db.insert(alertState).values({
    alertKey: "sends_stuck", kind: "sends_stuck", severity: "critical",
    openedAt: FIXED_NOW, lastSeenAt: FIXED_NOW, notifyCount: 0,
    detail: "1 outbound_sends row(s) have been 'pending' longer than 10m",
  });
  // A resolved key, so the latest-resolved read has a row the sweep taints (its signature).
  await db.insert(alertState).values({
    alertKey: "worker_down:0", kind: "worker_down", severity: "critical",
    openedAt: new Date(FIXED_NOW.getTime() - 7_200_000), lastSeenAt: new Date(FIXED_NOW.getTime() - 3_600_000),
    resolvedAt: new Date(FIXED_NOW.getTime() - 1_800_000), notifiedAt: new Date(FIXED_NOW.getTime() - 3_600_000),
    notifyCount: 1, notifiedSignature: "critical:1",
  });
}

/** The sweep's terms for one world: its account and mailbox as stored, and a run from inside the login's local part. */
async function sweepTerms(db: Db, w: World): Promise<SweepTerms> {
  const login = rowsOf<{ email: string }>(await db.execute(sql`select email from users where account_id = ${w.accountId}`))[0]!.email;
  const mailbox = rowsOf<{ address: string }>(await db.execute(sql`select address from mailboxes where id = ${w.mailboxId}`))[0]!.address;
  return {
    accountId: w.accountId, mailboxId: w.mailboxId, login, mailbox,
    loginPart: login.slice(0, login.lastIndexOf("@")).slice(2, -2),
  };
}

/** Every staff-reachable response, as raw text: each census read as an owner-role session, then the alert observer's. */
async function staffResponses(
  deps: ApiDeps, t: SweepTerms,
): Promise<Array<{ path: string; text: string }>> {
  const d = { ...deps, admin: ADMIN, alerts: ALERTS };
  const out = (await sweepRoutes(d, STAFF_TOKEN, t, { ops: false })).map(({ path, text }) => ({ path, text }));
  // The OTHER staff credential: the alert observer. `GET /internal/alerts` is the runbook's
  // documented curl and it whole-row-selects `alert_state`.
  const open = await H(req("GET", "/internal/alerts", { bearer: ALERT_SECRET }), d);
  expect(open.status).toBe(200);
  out.push({ path: "GET /internal/alerts", text: await open.text() });

  const run = await H(req("GET", "/internal/alerts/run", { bearer: ALERT_SECRET }), d);
  expect(run.status).toBe(200);
  out.push({ path: "GET /internal/alerts/run", text: await run.text() });
  return out;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE SWEEP
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("no staff surface carries a marker from ANY column of the schema", () => {
  async function taintedWorld() {
    const { db, deps } = await makeDeps();
    const world = await seedWorld(db, "alpha");
    await seedInfrastructure(db);
    const sweep = await taintSchema(db);
    // AFTER the taint, so `staff_users`/`staff_sessions` stay in the sweep's UNSEEDED pin and
    // the fixture row carries no marker: this is the reads' credential, not part of the world.
    await seedStaffSession(db, { now: FIXED_NOW, token: STAFF_TOKEN });
    return { db, deps, world, sweep };
  }

  it("the sweep is not vacuous: it reached the whole schema and every write landed", async () => {
    const { db, sweep } = await taintedWorld();

    // A NEW TABLE arrives in `emptyTables` and fails this equality until it is seeded or
    // pinned with a reason. Same mechanism as the console's SEAM_FIELDS census.
    expect(
      sweep.emptyTables,
      "a table in the schema has no row, so the sweep could not taint it. Seed it in " +
        "`seedWorld`, or add it to UNSEEDED_TABLES with a reason.",
    ).toEqual([...UNSEEDED_TABLES].sort());

    // A new CHECK-constrained column fails here rather than being silently skipped.
    expect(
      sweep.refused.sort(),
      "the database refused a marker for a column that is not in REFUSED_BY_CONSTRAINT — " +
        "classify it (a closed-set status column cannot carry mail; a free-text one must be " +
        "tainted another way).",
    ).toEqual([...REFUSED_BY_CONSTRAINT].sort());

    expect(
      sweep.tainted.length,
      "a column of a seeded table was neither tainted, skipped nor refused — the sweep left it unread",
    ).toBe(taintedColumnCount(sweep));
    // The skip lists are closed sets, not a filter that grew to fit.
    expect(sweep.skipped.length).toBe(STAFF_VISIBLE.size + PREDICATE_COLUMNS.size);

    // ANTI-VACUITY: every marker is READABLE BACK. An UPDATE that matched zero rows, or a
    // driver that silently swallowed one, would make the whole file pass for the wrong reason.
    expect(await verifyTaint(db, sweep.tainted)).toEqual([]);
    // The file's first test, its first store and a write to every column: 0.8 s as a rule, 2.9 s once on
    // a loaded CI VM, 41 s under 10% of a CPU; no wait of its own.
  }, 90_000);

  it("not one of them appears in any staff response", async () => {
    const { db, deps, world, sweep } = await taintedWorld();
    const responses = await staffResponses(deps, await sweepTerms(db, world));

    const leaks: string[] = [];
    for (const { path, text } of responses) {
      for (const col of sweep.tainted) {
        if (text.includes(markerFor(col.table, col.column))) {
          leaks.push(`${path} ← ${col.table}.${col.column}`);
        }
      }
    }
    expect(leaks, `staff responses carried tainted columns:\n${leaks.join("\n")}`).toEqual([]);
  });

  /**
   * THE OTHER HALF OF THE SWEEP: the response must still SAY SOMETHING.
   *
   * Every assertion here runs against the SAME tainted rows as the assertion above, in the
   * same world. Split across two worlds they would be worthless: tainting a predicate column
   * empties a response, and an empty response contains no markers.
   */
  it("and the console still renders the account data staff need", async () => {
    const { deps, world } = await taintedWorld();
    const d = { ...deps, admin: ADMIN, alerts: ALERTS };
    const get = async (path: string): Promise<Record<string, never> & Record<string, unknown>> =>
      (await H(req("GET", path, asStaff), d)).json();

    const roster = await get("/admin/accounts") as {
      total: number; accounts: Array<Record<string, unknown>>;
    };
    expect(roster.total).toBe(1);
    const account = roster.accounts[0]!;
    expect(account.name).toBe("Account alpha");
    expect(String(account.ownerEmail)).toContain("@lichtgrat.example");
    expect(account.mailboxCount).toBe(1);
    // CONVERTED — Was `expect(account.lastActivityAt).toBeTruthy()  // change_log, still
    // readable`. `pipeline.ts` writes a `change_log` row for every ingested message, so this
    // stamp advancing around a chosen delivery confirms receipt for one named account. The grant
    // is gone; the seeded world still has the `change_log` row (see the seed), so null is the
    // redaction. `syncLagSeconds` — the worker's own stamp, which moves whether or not mail
    // arrived — is what answers "is this account alive" now, and it is asserted live below.
    expect(account.lastActivityAt).toBeNull();
    expect(account.syncLagSeconds).not.toBeNull();

    const detail = await get(`/admin/accounts/${world.accountId}`) as {
      mailboxes: Array<Record<string, unknown>>;
      audit: Array<Record<string, unknown>>;
    };
    expect(detail.mailboxes).toHaveLength(1);
    expect(detail.mailboxes[0]!.address).toBe("ops-alpha@example.com");
    expect(detail.mailboxes[0]!.hasImapCredential).toBe(true);
    // CONVERTED — a review finding. Was `expect(...pendingMoves).toBe(1)` under the comment "THE JOIN TO
    // `messages` STILL HAPPENED". The join is what the finding exploits and the count is the receipt
    // fact, so both the join and the grant behind it are gone. `hasImapCredential` above and
    // `address` are what now prove this row is a real row rather than a query that returned
    // nothing, so the "no marker" assertions are still non-vacuous.
    expect(detail.mailboxes[0]!.pendingMoves).toBe(0);
    expect(detail.mailboxes[0]!.oldestPendingMoveSeconds).toBeNull();
    // The `admin.%` audit row is REACHED — so the payload gate below is being exercised.
    expect(detail.audit).toHaveLength(1);
    expect(detail.audit[0]!.action).toBe("admin.mailbox.resync");

    const worker = await get("/admin/worker") as {
      instances: unknown[]; roster: unknown[]; staleSends: Array<Record<string, unknown>>;
      pendingMoves: Record<string, number>;
    };
    expect(worker.instances).toHaveLength(1);
    expect(worker.roster).toHaveLength(1);
    // CONVERTED — same reason as the per-mailbox count above. The cluster-wide backlog
    // is the one shape that could be aggregated safely (D=15min, k=5 distinct mailboxes; see
    // `admin-service.ts:adminWorker`) and it must be produced by the worker, not joined out of
    // `folder_state ⋈ messages` on a staff connection.
    expect(worker.pendingMoves).toEqual({ total: 0, mailboxes: 0, oldestSeconds: null });
    // The stuck send is REACHED — so dropping `idempotencyKey` is a real narrowing and not a
    // row that never rendered.
    expect(worker.staleSends).toHaveLength(1);
    expect(worker.staleSends[0]!.id).toBeTruthy();
    expect(worker.staleSends[0]!.status).toBe("pending");

    // The added reads answer from the same tainted rows, so their "no marker" is not an empty page.
    const resolved = await get("/admin/alerts/history") as unknown as { latestResolved: Array<{ key: string }> };
    expect(resolved.latestResolved.map((r) => r.key)).toEqual(["worker_down:0"]);
    const syncRoster = await get("/admin/sync-roster") as unknown as { rows: Array<{ accountId: string; firstMailboxAt: string | null }> };
    expect(syncRoster.rows.find((r) => r.accountId === world.accountId)?.firstMailboxAt).toBeTruthy();
    const day = 86_400_000;
    const funnel = await get(`/admin/funnel?from=${new Date(Date.now() - 30 * day).toISOString()}&to=${new Date(Date.now() + day).toISOString()}`) as unknown as {
      window: { signedUp: number; connected: number } | null;
    };
    expect(funnel.window).toMatchObject({ signedUp: 1, connected: 1 });
    const list = await (await H(req("POST", "/admin/staff/list", { ...asStaff, body: "{}" }), d)).json() as { staff: unknown[] };
    expect(list.staff).toHaveLength(1);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The jsonb bags — first projected, then made UNREADABLE
   ════════════════════════════════════════════════════════════════════════════════════════

   The first staff change shipped `staffMeta`, a two-stage default-deny gate over `credit_ledger.meta`,
   `audit_log.payload` and `audit_log.inverse`. The blind connection removed the gate by removing its subject:
   none of the three columns is granted to `ohmail_admin`, `admin-service.ts` no longer selects
   any of them, and `admin.audit_log` — the view the staff role actually reads — has no
   `payload` column to select.

   These tests were rewritten rather than deleted, and the seeds are UNCHANGED: the same
   pipeline meta, the same allowlisted key carrying prose, the same staff-authored note. What
   changed is the expectation, from "the gate refused the value" to "no value arrives at all",
   which is the strictly stronger statement. Every one keeps a POSITIVE CONTROL — the row is
   proven to be reached — so an empty bag can never be the empty bag of a query that returned
   nothing. */

describe("the jsonb bags do not reach a staff surface at all", () => {
  /**
   * The audit half. `admin.audit_log` projects four named scalars; there is no `payload`
   * column on it, so `actor` — which the first staff change recovered FROM the payload — is now genuinely
   * unavailable rather than merely unrendered.
   *
   * That is a real loss and the way back is the one the ruling names: the write path
   * promotes the actor to a NAMED COLUMN, and the column is added to the grant and to the
   * view. The bag is never granted.
   */
  it("an `admin.*` audit row renders its action and NOTHING from its payload", async () => {
    const { db, deps } = await makeDeps();
    await seedStaffSession(db, { now: FIXED_NOW, token: STAFF_TOKEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    await db.insert(auditLog).values({
      accountId: s.accountId, action: "admin.mailbox.resync",
      payload: { note: "spoke to the account holder", actor: "staff_test" },
      inverse: null,
    });
    const detail = await (await H(
      req("GET", `/admin/accounts/${s.accountId}`, asStaff),
      { ...deps, admin: ADMIN },
    )).json() as {
      audit: Array<{ action: string; payload: Record<string, string>; inverse: unknown; actor: string }>;
    };
    // POSITIVE CONTROL: the `admin.%` row IS selected — the filter and the read both ran.
    expect(detail.audit).toHaveLength(1);
    expect(detail.audit[0]!.action).toBe("admin.mailbox.resync");
    expect(detail.audit[0]!.payload).toEqual({});
    expect(detail.audit[0]!.inverse).toBeNull();
    expect(detail.audit[0]!.actor).toBe("");
    expect(JSON.stringify(detail)).not.toContain("spoke to the account holder");
  });

  it("the client's Idempotency-Key does not leave the database", async () => {
    const { db, deps } = await makeDeps();
    await seedStaffSession(db, { now: FIXED_NOW, token: STAFF_TOKEN });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const [draft] = await db.insert(drafts).values({ accountId: s.accountId, mailboxId }).returning();
    // A client is free to choose this string: `routes/drafts.ts` takes any non-empty header.
    await db.insert(outboundSends).values({
      accountId: s.accountId, idempotencyKey: "reply-to-ZZSUBJECTINKEYZZ",
      draftId: draft!.id, mintedMessageId: `<m@${managedDomain()}>`, status: "pending",
      createdAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000),
    });
    const d = { ...deps, admin: ADMIN };
    for (const path of ["/admin/worker", "/admin/actions"]) {
      const text = await (await H(req("GET", path, asStaff), d)).text();
      expect(text.includes("ZZSUBJECTINKEYZZ"), `${path} leaked the idempotency key`).toBe(false);
    }
    // …and the send is still LISTED and still actionable by its own id.
    const worker = (await (await H(req("GET", "/admin/worker", asStaff), d)).json()) as {
      staleSends: Array<{ id: string }>;
    };
    expect(worker.staleSends).toHaveLength(1);
    const catalog = (await (await H(req("GET", "/admin/actions", asStaff), d)).json()) as {
      actions: Array<{ id: string; target: { options: Array<{ id: string; label: string }> } }>;
    };
    const retry = catalog.actions.find((a) => a.id === "retry_send")!;
    expect(retry.target.options).toHaveLength(1);
    expect(retry.target.options[0]!.id).toBe(worker.staleSends[0]!.id);
    expect(retry.target.options[0]!.label).toContain(worker.staleSends[0]!.id);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   Cross-account
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("one account's context never carries another account's mail", () => {
  it("GET /admin/accounts/:id is scoped to that account", async () => {
    const { db, deps } = await makeDeps();
    const alpha = await seedWorld(db, "alpha");
    const beta = await seedWorld(db, "beta");
    await seedInfrastructure(db);
    const sweep = await taintSchema(db);
    // After the taint — the reads' credential, not part of either account's world.
    await seedStaffSession(db, { now: FIXED_NOW, token: STAFF_TOKEN });
    expect(
      sweep.tainted.length,
      "a column of a seeded table was neither tainted, skipped nor refused — the sweep left it unread",
    ).toBe(taintedColumnCount(sweep));

    const d = { ...deps, admin: ADMIN };
    const detailA = await (await H(
      req("GET", `/admin/accounts/${alpha.accountId}`, asStaff), d,
    )).text();
    const detailB = await (await H(
      req("GET", `/admin/accounts/${beta.accountId}`, asStaff), d,
    )).text();

    // Not one row of the other account's world — not its mailbox, not its message, not its
    // draft, not its user, and not the account itself.
    for (const id of [beta.accountId, beta.mailboxId, beta.messageId, beta.draftId, beta.userId]) {
      expect(detailA.includes(id), `alpha's detail carried beta's ${id}`).toBe(false);
    }
    for (const id of [alpha.accountId, alpha.mailboxId, alpha.messageId, alpha.draftId, alpha.userId]) {
      expect(detailB.includes(id), `beta's detail carried alpha's ${id}`).toBe(false);
    }
    expect(detailA).toContain("ops-alpha@example.com");
    expect(detailA).not.toContain("ops-beta@example.com");
    expect(detailB).toContain("ops-beta@example.com");
    expect(detailB).not.toContain("ops-alpha@example.com");

    // ANTI-VACUITY: both details are real, populated answers. The mailbox and the audit row are
    // what carry that now — the usage panel they used to read left with the metering.
    for (const [label, text] of [["alpha", detailA], ["beta", detailB]] as const) {
      const parsed = JSON.parse(text) as {
        mailboxes: unknown[];
        audit: unknown[];
      };
      expect(parsed.mailboxes, label).toHaveLength(1);
      expect(parsed.audit, label).toHaveLength(1);
    }
  });

  it("a customer's own session buys nothing on a staff path, in either direction", async () => {
    const { db, deps } = await makeDeps();
    const alpha = await seedWorld(db, "alpha");
    const beta = await seedWorld(db, "beta");
    const d = { ...deps, admin: ADMIN };

    // ANTI-VACUITY: alpha's token really does authenticate a real route.
    const proof = await H(req("GET", "/mailboxes", { bearer: "tok-alpha" }), deps);
    expect(proof.status, "the seeded session must genuinely authenticate").toBe(200);

    const paths = adminRoutesInTable.filter((r) => r.method === "GET").map((r) => fill(r.pattern, { id: beta.accountId }));
    expect(paths).toContain(`/admin/accounts/${beta.accountId}`);
    for (const path of paths) {
      const res = await H(req("GET", path, { bearer: "tok-alpha" }), d);
      expect(res.status, path).toBe(401);
      const text = await res.text();
      expect(text.includes(beta.accountId), path).toBe(false);
      expect(text.includes(alpha.accountId), path).toBe(false);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The route census
   ════════════════════════════════════════════════════════════════════════════════════════ */

describe("the sweeps send every /admin route the table mounts", () => {
  it("names every /admin route in the table, in both directions", () => {
    expect(
      adminRoutesInTable.map(keyOf).sort(),
      "an /admin route the census does not name, or a name the table no longer mounts: classify it in ADMIN_ROUTE_SWEEP",
    ).toEqual(Object.keys(ADMIN_ROUTE_SWEEP).sort());
  });

  it("sends every GET as a read, fills every parameter, and keys each query form and body by a route it sends", () => {
    const gets = adminRoutesInTable.filter((r) => r.method === "GET");
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) expect(ADMIN_ROUTE_SWEEP[keyOf(r)]?.send, keyOf(r)).toBe("read");
    expect(() => fill("/admin/mailboxes/:mailboxId", { id: "x" })).toThrow(/:mailboxId/);
    const sent = Object.entries(ADMIN_ROUTE_SWEEP).filter(([, c]) => c.send !== "exempt").map(([k]) => k);
    for (const key of [...Object.keys(QUERY_FORMS), ...Object.keys(POST_BODY)]) expect(sent, key).toContain(key);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   The ops role reads the platform, not the people
   ════════════════════════════════════════════════════════════════════════════════════════ */

const OPS_DOMAIN = "ops-mask.example";
const MASKED = `•••@${OPS_DOMAIN}`;
/** A planted column's marker, lowercase so a case-folded answer cannot hide it. */
const opsMarker = (column: string): string => `zzopsmask_${column.replace(".", "__")}_`;
const servedToOps = (p: OpsServed): string[] =>
  [...STAFF_VISIBLE].filter(([, c]) => c.ops === p).map(([k]) => k).sort();

/**
 * Each masked or withheld column gets its marker, unique per row through `ctid` (the login and
 * the active mailbox address are unique indexes); a masked one is an address at OPS_DOMAIN.
 */
async function plantOpsMarkers(db: Db): Promise<void> {
  for (const [key, c] of STAFF_VISIBLE) {
    if (c.ops === "whole") continue;
    const [table, column] = key.split(".") as [string, string];
    const tail = c.ops === "masked" ? ` || '@${OPS_DOMAIN}'` : "";
    await db.execute(sql.raw(
      `update "${table}" set "${column}" = '${opsMarker(key)}' || regexp_replace(ctid::text, '[^0-9]+', '_', 'g')${tail}`,
    ));
  }
}

/** The answers the field checks read, as one staff session was served them. */
interface Served {
  detail: {
    account: { ownerEmail: string }; users: Array<{ email: string }>;
    mailboxes: Array<{ address: string; displayName: string | null }>;
  };
  roster: { accounts: Array<{ ownerEmail: string }> };
  batch: { rows: Array<{ ownerEmail: string }> };
  worker: { roster: Array<{ address: string; displayName: string | null }> };
  actions: { actions: Array<{ id: string; target: { options: Array<{ label: string }> } }> };
  search: { results: Array<{ label: string }> };
}

/**
 * The fields each masked or withheld column is served in, so a masked one is read as the mask and
 * a withheld one as null rather than only as a missing marker. A column moved into either posture
 * fails the census below until it names its fields here.
 */
const SERVED_AT: Readonly<Record<string, (s: Served) => Array<string | null>>> = {
  "users.email": (s) => [
    s.detail.account.ownerEmail, ...s.detail.users.map((u) => u.email),
    ...s.roster.accounts.map((a) => a.ownerEmail), ...s.batch.rows.map((a) => a.ownerEmail),
  ],
  "mailboxes.address": (s) => [...s.detail.mailboxes.map((m) => m.address), ...s.worker.roster.map((m) => m.address)],
  "mailboxes.display_name": (s) => [
    ...s.detail.mailboxes.map((m) => m.displayName), ...s.worker.roster.map((m) => m.displayName),
  ],
};

/** The two labels that name an address beside the account: the release target's and the login's search hit's. */
const addressLabels = (s: Served): { release: string; hit: string } => ({
  release: s.actions.actions.find((a) => a.id === "resync_mailbox")?.target.options[0]?.label ?? "",
  hit: s.search.results[0]?.label ?? "",
});

describe("an ops-only reader is served no customer address whole and no mailbox's name", () => {
  it("every staff-visible column says what ops is served, and each masked or withheld one where", () => {
    expect(servedToOps("masked")).toEqual(["mailboxes.address", "users.email"]);
    expect(servedToOps("withheld")).toEqual(["mailboxes.display_name"]);
    expect(Object.keys(SERVED_AT).sort()).toEqual([...servedToOps("masked"), ...servedToOps("withheld")].sort());
  });

  /**
   * Every census route as `ops` alone, in a world whose masked and withheld columns carry a marker:
   * no answer carries one, a masked field reads `•••@domain`, a withheld one null, and the roster's
   * search matches only what ops is shown of a login. The controls read the same world: an
   * owner-role session is served every marker, and sessions holding owner, support or billing
   * read each field and label whole.
   */
  it("no route serves ops a planted value, and the people roles read them whole", async () => {
    const { db, deps } = await makeDeps();
    const world = await seedWorld(db, "alpha");
    await seedInfrastructure(db);
    await plantOpsMarkers(db);
    const token = (role: StaffRole): string => `content-isolation-${role}-session-fixture-token`;
    for (const role of ["ops", "owner", "support", "billing"] as const) {
      await seedStaffSession(db, { now: FIXED_NOW, token: token(role), roles: [role] });
    }
    const d = { ...deps, admin: ADMIN };
    const t = await sweepTerms(db, world);
    const planted = [...servedToOps("masked"), ...servedToOps("withheld")];
    // The run searched for lies inside the planted login's local part and in nothing ops is shown.
    expect(t.login.startsWith(opsMarker("users.email")) && t.login.endsWith(`@${OPS_DOMAIN}`)).toBe(true);
    expect(`${MASKED} · account alpha`.includes(t.loginPart)).toBe(false);

    const read = async <T>(role: StaffRole, path: string): Promise<T> => {
      const res = await H(req("GET", path, { bearer: ADMIN_SECRET, headers: { [STAFF_SESSION_HEADER]: token(role) } }), d);
      expect(res.status, `${role} ${path}`).toBe(200);
      return await res.json() as T;
    };
    const servedTo = async (role: StaffRole): Promise<Served> => ({
      detail: await read<Served["detail"]>(role, `/admin/accounts/${t.accountId}`),
      roster: await read<Served["roster"]>(role, "/admin/accounts"),
      batch: await read<Served["batch"]>(role, `/admin/accounts?ids=${t.accountId}`),
      worker: await read<Served["worker"]>(role, "/admin/worker"),
      actions: await read<Served["actions"]>(role, "/admin/actions"),
      search: await read<Served["search"]>(role, `/admin/search?q=${enc(t.login)}`),
    });
    const matched = async (role: StaffRole, term: string): Promise<number> =>
      (await read<{ matched: number }>(role, `/admin/accounts?search=${enc(term)}`)).matched;

    // Every census route as ops: no answer carries a planted value, in any case.
    const leaks: string[] = [];
    for (const a of await sweepRoutes(d, token("ops"), t, { ops: true })) {
      for (const key of planted) if (a.text.toLowerCase().includes(opsMarker(key))) leaks.push(`${a.path} ← ${key}`);
    }
    // Soft, so one red run names every ops failure below.
    expect.soft(leaks, `ops was served a planted column:\n${leaks.join("\n")}`).toEqual([]);

    // Masked, not dropped; withheld as null, not as an empty name.
    const ops = await servedTo("ops");
    for (const [key, at] of Object.entries(SERVED_AT)) {
      const values = at(ops);
      expect.soft(values.length, key).toBeGreaterThan(0);
      expect.soft(values, key).toEqual(values.map(() => (STAFF_VISIBLE.get(key)?.ops === "masked" ? MASKED : null)));
    }
    expect.soft(addressLabels(ops).release).toContain(MASKED);
    expect.soft(addressLabels(ops).hit).toContain(MASKED);
    // The roster's search matches what ops is shown of a login, its domain, and never a run of the rest.
    expect.soft(await matched("ops", t.loginPart), "ops matched a login by a run it is not shown").toBe(0);
    expect.soft(await matched("ops", OPS_DOMAIN)).toBe(1);

    // CONTROLS, in the same world: an owner-role session is served every planted value somewhere...
    const owner = await sweepRoutes(d, token("owner"), t, { ops: false });
    expect(
      planted.filter((key) => !owner.some((a) => a.text.includes(opsMarker(key)))),
      "a planted column reached no owner answer",
    ).toEqual([]);
    expect(await matched("owner", t.loginPart)).toBe(1);
    // ...and owner, support and billing read each field and label whole.
    for (const role of ["owner", "support", "billing"] as const) {
      const s = await servedTo(role);
      for (const [key, at] of Object.entries(SERVED_AT)) {
        const values = at(s);
        expect(values.length, `${role} ${key}`).toBeGreaterThan(0);
        expect(values.filter((v) => !v?.startsWith(opsMarker(key))), `${role} ${key}`).toEqual([]);
      }
      expect(addressLabels(s).release, role).toContain(t.mailbox);
      expect(addressLabels(s).hit, role).toContain(t.login);
    }
  });
});
