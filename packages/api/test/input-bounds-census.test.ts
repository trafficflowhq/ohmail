import { readFileSync, readdirSync, statSync } from "node:fs";
import ts from "typescript";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiRoutes, createApp, JSON_BODY_MAX_BYTES, LARGE_BODY_ROUTES,
  type ApiDeps, type Route,
} from "@trafficflow/api";
import {
  ATTACHMENT_MAX_FETCH_BYTES, BODIES_IDS_MAX, CONTACTS_QUERY_MAX_CHARS, DEFAULT_PAGE_LIMIT,
  DOWNLOAD_ALL_MAX_BYTES, DOWNLOAD_ALL_MAX_PARTS, DRAFT_MAX_RECIPIENTS,
  DRAFT_SUBJECT_MAX_CHARS, KB_MAX_TAGS,
  MAILBOX_SIGNATURE_MAX_CHARS, MARK_SEEN_MAX_IDS, MAX_PAGE_LIMIT, OHBOX_BAR_MAX_BYTES,
  PROFILE_IMPORT_MAX, SCHEDULE_MAX_AHEAD_MS, SEARCH_QUERY_MAX_CHARS,
  SEED_MAX_ADDRESSES, SEND_ATTACHMENT_FIELD_MAX_CHARS, SEND_ATTACHMENT_MAX_TOTAL_BYTES,
  SEND_MAX_ATTACHMENT_PARTS,
  PROXY_URL_MAX_CHARS, RECIPIENT_ADDRESS_MAX_CHARS, RECIPIENT_NAME_MAX_CHARS,
  SEND_MAX_RECIPIENTS, THREAD_MERGE_MAX_IDS, READER_ZONE_MAX_CHARS, READER_LOCALE_MAX_CHARS,
  WHY_STAYED_IDS_MAX,
} from "@trafficflow/services/mail";
import { FOLDER_PATH_MAX, MAX_WORKFLOW_STEPS } from "@trafficflow/core/mail";
import { IMAP_UINT32_MAX } from "@trafficflow/services/mail";
/*
 * The remaining ceilings are imported from the modules that OWN them rather than through a
 * barrel, deliberately: several are not re-exported (they are enforced entirely server-side and
 * no client has to respect them), and naming the owning module is what makes this census point
 * at where each bound actually lives rather than at a re-export list.
 */
import { PUSH_ENDPOINT_MAX_LEN } from "../../core/src/net/push-endpoint.js";
import {
  ADMIN_BATCH_MAX, ADMIN_MAX_PAGE_SIZE, ADMIN_SEARCH_LIMIT, ADMIN_STAFF_ACTIVITY_PAGE, ADMIN_SYNC_ROSTER_MAX,
  ADMIN_FUNNEL_WINDOW_MAX_DAYS, ADMIN_STORAGE_MAX, ADMIN_RESOLVED_ALERTS_MAX, ADMIN_RESOLVED_ALERTS_MAX_DAYS,
} from "../../services/src/admin-service.js";
import { STAFF_ASSERTION_MAX_REQUESTS } from "../src/staff-assertion.js";
import { BODIES_BYTE_BUDGET, BODIES_MAX_LIMIT } from "../../services/src/message-service.js";
import { DRAFT_HTML_CAP_BYTES } from "../../services/src/outbound-html.js";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import { MAX_BODY_CONTAINS_CHARS, MAX_SUBJECT_CONTAINS_CHARS } from "../../services/src/rules-service.js";
import { MAX_SUGGEST_SENDERS } from "../../services/src/screener-service.js";
import { HELD_RELEASE_GROUPS_MAX } from "../../services/src/held-release-service.js";
import { AUTO_FILED_PAGE_MAX } from "../../services/src/auto-filed-service.js";
import {
  OHBOX_UNSCREENED_GROUPS_MAX, OHBOX_UNSCREENED_MESSAGES_MAX,
} from "../../services/src/ohbox-unscreened-service.js";
import { MAX_TAG_NAME_CHARS } from "../../services/src/tags-service.js";
import { OAUTH_STATE_MAX_CHARS, PASSWORD_MAX_LENGTH } from "../../services/src/auth/auth-service.js";
import {
  SNAPSHOT_CURSOR_MAX_CHARS, SNAPSHOT_DRAFT_PAGE, SNAPSHOT_WINDOW, SYNC_CURSOR_MAX_CHARS,
} from "../../services/src/sync-service.js";
import { PAIRING_LABEL_MAX } from "../../services/src/pairing.js";
import { REVOKE_WEB_SESSIONS_MAX_AGE_DAYS } from "../../services/src/auth/session-lifecycle.js";
import { JUNK_BODY_MAX_BYTES, JUNK_CURSOR_MAX_CHARS, JUNK_SEARCH_MAX_CHARS } from "../src/junk-window.js";
import {
  TRASH_BODY_MAX_BYTES, TRASH_CURSOR_MAX_CHARS, TRASH_SEARCH_MAX_CHARS,
} from "../src/trash-window.js";
import { RETURN_SESSION_ID_MAX_CHARS } from "../src/routes/account.js";
import { SETTINGS_MAX_MAILBOX_ENTRIES } from "../src/routes/consent.js";

/**
 * ═══ THE INPUT-BOUNDS CENSUS ═══════════════════════════════════════════════════════════════
 *
 * ## The class this exists to keep closed
 *
 * Ten of the fourteen findings a max-effort pass raised against 73
 * files of the API surface were one sentence: **a value the caller or the sender chooses reaches
 * a query, a socket, a loop or a buffer before any ceiling is applied.** Not ten bugs — one
 * defect wearing ten coats.
 *
 * The exemplar is `clampLimit`, and it is the shape to keep in mind while reading
 * the sets below. It returned `NaN` for `?limit=abc`; **drizzle omits the `LIMIT` clause
 * entirely for a falsy value**, so the query asked for the account's whole table; the response
 * then did `rows.slice(0, NaN)` and returned nothing; and `BODIES_BYTE_BUDGET` — the one guard
 * written to bound exactly that response — was evaluated inside the resulting empty loop, so it
 * never ran while the bytes it exists to bound had already been fetched. Maximum work, zero
 * result, cheap to repeat, and every individual piece of it looked correct.
 *
 * A patch per instance would have fixed ten routes and taught the table nothing. This file is
 * the part that generalises: **a new caller-chosen count or size cannot reach the route table
 * without an author saying, in a diff, what bounds it.**
 *
 * ## Three censuses, each EXACT over a stated domain
 *
 *  1. **The route table.** Every route in `apiRoutes` is classified, with no remainder. A new
 *     route is red until it is placed.
 *  2. **Query parameters.** Every `searchParams.get("…")` in `packages/api/src`, derived from
 *     the source text. A new query parameter is red until it is dispositioned.
 *  3. **SQL `IN` sinks.** Every `inArray(` in `packages/api/src` and `packages/services/src` —
 *     the sink named in the finding, where an unbounded array becomes an unbounded parameter
 *     list. A new one is red until its array is shown to be bounded or server-derived.
 *
 * ## What it does NOT claim — and this is the honest half
 *
 * The idempotency census next door says its largest set is *"an INVENTORY, NOT A CLEARANCE"*,
 * and the review found that admission was the reason a real defect took ten minutes to place.
 * The same admissions belong here:
 *
 *  · **The `door:` dispositions are an inventory.** Those routes accept a field with no named
 *    ceiling of its own, and {@link JSON_BODY_MAX_BYTES} at the request door is what bounds it —
 *    a real bound, and the ONLY one; remove the door's ceiling and they are unbounded again.
 *    Each entry names the value's DOWNSTREAM SINK, and naming it honestly is the part that
 *    matters: an early draft of this file said a KB entry's content and a workflow step's `args`
 *    had "one column write" as their only sink, and both are later read back — by a tsquery and
 *    a trigram arm, and by the worker that executes the step. Understating a sink is how a value
 *    stops getting a bound of its own.
 *  · **{@link PATH_PARAMS_ONLY} is derived, and the derivation goes one level deep.** A handler
 *    that reads no body and no query string cannot carry a caller-chosen count — that part is
 *    mechanical, from `Function.prototype.toString()` on the handler itself. The obvious hole is
 *    a handler that delegates the reading to a module-level helper, whose source is not part of
 *    the handler's, and naming today's helpers in a list does not close it: the next helper is
 *    not on the list. So the READING HELPERS ARE DERIVED TOO — every top-level declaration in
 *    `packages/api/src` whose body contains a reader — and a `PATH_PARAMS_ONLY` route whose
 *    handler calls one of them is red. That derivation found three routes the hand list had
 *    missed the first time it ran (`GET /contacts/:id/notes`, `GET /threads/:id/notes` and the
 *    Microsoft OAuth callback), which is the evidence that the hand list was not enough.
 *
 *    **What is still open, stated rather than left to be found:** a helper reached TWO levels
 *    down, or through a variable, is invisible to a name match. Closing that needs an AST call
 *    graph, which this file does not build.
 *  · **Section 3 sees `inArray` and not every query.** A caller array reaching a query some
 *    other way — an `OR` chain, a `sql.join`, an `ANY($1)` — is not in its domain.
 *  · **Nothing here proves a bound WORKS.** That is the job of the hostile-value tests beside
 *    this file, which drive the real routes and watch each guard fail when it is removed. This
 *    file proves only that every input has been LOOKED AT and that a new one cannot arrive
 *    unlooked-at.
 */

const key = (r: Route): string => `${r.method} ${r.pattern}`;

/**
 * Every top-level declaration in `packages/api/src` whose body reads caller input.
 *
 * A declaration's body is its own AST NODE TEXT, which covers every form there is — an earlier
 * text version matched `function f(){…}` and brace-bodied `const f = () => {…}` and missed
 * `const f = (req) => new URL(req.url)…`, an expression-bodied arrow, which is exactly the shape
 * the blind spot was demonstrated with.
 *
 * NESTED declarations are collected too, not only top-level ones: `walk` visits every node, so a
 * function declared inside another is a name in this set as well. That over-collects, and
 * over-collecting only makes the assertions that use this STRICTER — a route naming any such
 * function has to be dispositioned.
 *
 * Declared here rather than inside one test because two assertions need it: the one that stops a
 * `PATH_PARAMS_ONLY` route hiding its reads behind a helper, and the one that stops
 * {@link INPUT_VIA_HELPER} naming a helper that does not read anything.
 */
function readingHelpers(): Set<string> {
  const helpers = new Set<string>();
  for (const { ast } of sourcesOf(API_SRC)) {
    for (const node of walk(ast)) {
      // A named function, or a `const name = …` whose initializer is one. The BODY is the node's
      // own source text, which is what makes "reaches one level down" mechanical rather than a
      // guess at where a declaration ends — the regex version cut at the next declaration and
      // missed an expression-bodied arrow, the exact shape the blind spot was shown with.
      if (ts.isFunctionDeclaration(node) && node.name) {
        if (READS_INPUT.test(node.getText(ast))) helpers.add(node.name.text);
        continue;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (READS_INPUT.test(node.getText(ast))) helpers.add(node.name.text);
      }
    }
  }
  return helpers;
}

/** Every route in the table, as `METHOD /pattern`. */
const allRoutes = apiRoutes.map(key);

/**
 * Does this handler's own source read a request body or a query string?
 *
 * Mechanical and cheap: the route table holds the handler functions themselves, so their source
 * is available without a file path, a line number or an import graph — which means this signal
 * cannot go stale the way a `file:line` list does. See the blind spot in the header.
 */
const READS_INPUT = /readBody\s*[<(]|readObjectBody\s*\(|\.json\(\)|\.text\(\)|\.formData\(|searchParams/;
const readsInputInline = (r: Route): boolean => READS_INPUT.test(String(r.handler));

/* ─────────────────────────────────────────────────────────────────────────────────────────
   SECTION 1 — THE ROUTE TABLE
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Routes whose handler reads NOTHING from the caller but the path parameters `matchRoute`
 * extracted. Frozen, and cross-checked against the derived signal in both directions.
 *
 * A route here cannot carry a caller-chosen COUNT OR SIZE, because there is no channel for one —
 * and count and size are the only things this file is about. (Several are nonetheless bounded:
 * `POST /messages/:id/attachments/download-all` runs into `DOWNLOAD_ALL_MAX_PARTS`, but that bound
 * applies to a SERVER-derived set, which is a different question again.)
 *
 * ── A PATH PARAMETER *IS* CALLER-CHOSEN INPUT. IT IS BOUNDED BY SHAPE, IN SECTION 6 ──────────
 *
 * This header used to say a route here "reads NOTHING from the caller", full stop, and that
 * sentence was load-bearing in the wrong direction for the whole of this file's life. A `:param`
 * is a caller-chosen STRING that reaches a `uuid` column verbatim; what it cannot carry is a
 * count or a size. The distinction was never drawn, so eighty-six routes sat on a frozen list
 * whose name implied they had no caller input at all, and `GET /drafts/:id` answered
 * an internal error to `/drafts/not-a-uuid` in production — over and over within minutes on
 * one id — while this census of thousands of lines stayed green over it
 * (the project's design notes).
 *
 * The census was not wrong about counts. It was silent about a question it never asked, which is
 * the more dangerous state: a green guard reads as coverage. SECTION 6 now asks it, by DRIVING
 * `createApp(apiRoutes)` rather than by reading source, and this list keeps its original job.
 */
const PATH_PARAMS_ONLY: ReadonlyArray<string> = [
  "GET /health",
  "GET /hello",
  "POST /internal/alerts",
  "GET /internal/alerts/run",
  "GET /internal/alerts",
  // The fault probe (cloud 0033). Nothing on the wire chooses anything at all — no query, no
  // body, no path param: the secret IS the entire request, and the route's only act is to throw
  // a fixed error so the envelope's recording seam can be exercised on a real deployment. There
  // is no count and no size a caller could name, and no value of theirs reaches a column.
  "POST /internal/fault",
  "GET /internal/sessions/reap",
  "GET /internal/mailboxes/smtp-size",
  "GET /internal/sends/scheduled/run",
  // The stranded-reservation reconciler. Nothing on the wire chooses anything: the batch is
  // `SEND_RECONCILE_BATCH`, the staleness cutoff and the give-up are constants in the pass, and
  // the route reads no query and no body at all — the secret is the entire request.
  "GET /internal/sends/reconcile/run",
  // mail 0087 — the away responder's clock. Its sibling's bucket exactly: a scheduler pokes it
  // with a shared secret and NO body, no query and no path parameter, so there is no channel for a
  // caller-chosen count or size. What one call may cause is bounded inside the pass by constants
  // nothing on the wire can reach (`AWAY_SENDS_PER_RUN`, `AWAY_ACCOUNTS_PER_RUN`, one candidate
  // page per account) — a server-derived bound, which is the different question this file's header
  // separates out.
  "GET /internal/away/run",
  // the drain, and the away clock's bucket exactly: a scheduler pokes it
  // with a shared secret and NO body, no query and no path parameter, so nothing on the wire
  // chooses anything. What one call may cause is bounded inside the service by constants a
  // caller cannot reach — accounts, targets per account, the clock and the window — and the
  // handler is asserted to choose none of them
  // (`internal-unsubscribe-drain.test.ts`).
  "GET /internal/unsubscribe/drain",
  // The send's READ half — what happened under this idempotency key. No body and no query. It
  // reads ONE thing of the caller's that is not a path parameter, the `Idempotency-Key` header,
  // and that is stated here rather than left to be noticed: its whole sink is one equality
  // predicate against `outbound_sends.idempotency_key`, it is written nowhere, and it carries
  // neither a count nor a size — which is what this file is about. `POST /drafts/:id/send` reads
  // the same header and is in the CENSUS instead, because it also reads a body.
  "GET /drafts/:id/send-attempt",
  // The sign-in throttle's security notices, the same bucket: a scheduler's shared secret and no
  // body, query or path parameter. One run claims at most fifty owed rows (`drainSecurityNotices`).
  "GET /internal/security-notices/run",
  // The vendor-cost pull reads nothing from the request: which providers to ask is decided by
  // which keys the deployment holds, never by the caller.
  // The PLATFORM SIGNAL poll (cloud 0030), its neighbour's bucket exactly: no body, no query, no
  // path parameter — the shared secret is the entire request. WHICH projects are polled comes
  // from the deployment's own env (`VERCEL_SIGNAL_PROJECTS`), never from the caller, and the
  // WINDOW is computed from the clock and aligned to the cadence rather than passed in.
  //
  // The one bound worth naming, because this route walks a PAGED endpoint and its siblings do
  // not: the walk stops at `SIGNAL_PAGE_BUDGET` pages per project, a constant in the port. The
  // length of that walk is a property of the platform's traffic and not of anything a caller
  // supplies — and a caller could not lengthen it if they wanted to, because there is no channel.
  "GET /internal/platform-signals/run",
  "GET /auth/session",
  "POST /auth/2fa/webauthn/register/options",
  "POST /auth/2fa/totp/enroll",
  "DELETE /auth/2fa/totp",
  "POST /auth/2fa/recovery-codes",
  "GET /devices",
  "DELETE /devices/:id",
  // The approval page's three doors read their request id from the path, shape-checked as a uuid.
  "GET /auth/desktop-approval/:id",
  "POST /auth/desktop-approval/:id/confirm",
  "POST /auth/desktop-approval/:id/deny",
  "POST /auth/step-up/webauthn/options",
  "DELETE /pair/:id",
  "GET /pair",
  "POST /sync/pull",
  "GET /events",
  "GET /push/vapid-key",
  "DELETE /push/subscriptions/:id",
  "GET /mailboxes/:id",
  // mail 0094 — the mirrored settings of a mailbox another install organizes. The sibling above's
  // bucket exactly: no body, no query, and nothing on the wire but the id `matchRoute` extracted,
  // so there is no channel for a caller-chosen count or size. What it returns is bounded by the
  // SERVER: exactly one row of `mailbox_profile_mirror`, whose `doc` was itself size-capped when a
  // reader wrote it (`PROFILE_DOC_MAX_BYTES` on the read that produced it) — a server-derived
  // bound, which is the different question this file's header separates out. It opens no socket,
  // so there is not even a provider's response to bound.
  "GET /mailboxes/:id/profile",
  "POST /mailboxes/:id/resync",
  "POST /mailboxes/:id/inbound-quiet/dismiss",
  // mail 0088 — the organizer notice's dismissal and "stop organizing this mailbox". Both are the
  // sibling above's bucket exactly: one timestamp on the caller's own mailbox row, chosen by the
  // SERVER's clock, with no body, no query and nothing on the wire but the id `matchRoute`
  // extracted. Neither can carry a caller-chosen count or size because neither reads anything a
  // caller wrote.
  "POST /mailboxes/:id/organizer-notice/dismiss",
  "POST /mailboxes/:id/release",
  "GET /mailboxes/:id/organizer",
  // The self-check: no body, no query, nothing on the wire but the id. What it asks the provider
  // is one STATUS per stored folder row, capped at `MAILBOX_CHECK_FOLDERS_MAX` and a whole-read budget.
  "GET /mailboxes/:id/self-check",
  "GET /mailboxes/:id/profile-import",
  "GET /mailboxes/oauth/microsoft/availability",
  // The held-release summary: the caller writes nothing at all — no body, no query, not even
  // an id. The answer is one grouped read over their own rules and their own held mail, and
  // its own row count is bounded by `HELD_RELEASE_GROUPS_MAX` on the server's side of the wire.
  "GET /screener/held-releases",
  // What the Screener filed on its own: the caller writes nothing at all, and the answer is
  // bounded by `AUTO_FILED_PAGE_MAX` on the server's side of the wire.
  "GET /screener/auto-filed",
  // The undecided-sender summary, for the same reason one line up: the caller writes nothing at
  // all, and the answer's own row count is bounded by `OHBOX_UNSCREENED_GROUPS_MAX` on the
  // server's side of the wire.
  "GET /screener/unscreened",
  // What waits on the organizer: the caller writes nothing at all, and the answer is bounded by
  // `WAITING_REQUESTS_READ_MAX` on the server's side of the wire.
  "GET /organizer-requests",
  "GET /rules",
  "GET /rules/:id",
  "GET /messages/:id",
  "GET /messages/:id/body",
  "POST /messages/:id/draft",
  "DELETE /messages/:id",
  /* mail 0099 — put a deleted message back where it was. `PATH_PARAMS_ONLY`, and by the same
     argument as its neighbour above: NO BODY, no query, nothing on the wire but the id
     `matchRoute` extracted. The destination is not the caller's to choose — it is read from
     `folder_state.trashed_from`, recorded when the message was deleted, and resolved against the
     mailbox's own live folders — so there is no caller-chosen count and no caller-chosen size
     for this census to bound. That the destination is the SERVER's is the point of the route, not
     an omission in it. */
  "POST /messages/:id/restore",
  "GET /threads/:id",
  "GET /screener/junk/sweep",
  "POST /screener/junk/sweep",
  "GET /views/focus-reply",
  "POST /messages/:id/load-remote",
  "POST /messages/:id/unsubscribe",
  "GET /contacts/:id",
  "DELETE /notes/:id",
  "GET /snippets/:id",
  "DELETE /snippets/:id",
  "DELETE /notify-rules/:id",
  "GET /away-responder",
  "GET /messages/:id/attachments",
  "GET /attachments/:id/meta",
  "GET /attachments/:id",
  "POST /messages/:id/attachments/download-all",
  "GET /kb/:id",
  "DELETE /kb/:id",
  "GET /tags",
  "DELETE /tags/:id",
  "DELETE /folders/:id",
  "DELETE /folders/:id/op",
  // Clearing a refused "Not junk": no body, no query, nothing on the wire but the command's id.
  "DELETE /screener/junk/rescue/:id",
  "GET /folders/:id/summary",
  "GET /drafts/:id",
  "DELETE /drafts/:id",
  "DELETE /drafts/:id/schedule",
  "GET /workflows",
  "GET /workflows/:id",
  "DELETE /workflows/:id",
  "POST /workflows/:id/run",
  "POST /workflow-runs/:id/undo",
  "GET /workflows/proposals",
  "POST /workflows/proposals/:id/dismiss",
  "DELETE /account",
  /* No body, no parameter, nothing a caller chooses: the account is the SESSION's, and what
     comes back are the limits it may act within. */
  "GET /account/access",
  // The wall's export door: reads nothing from the request — no body, no query, no path
  // parameter; the account is the SESSION's. What comes back is bounded by the account's own
  // row counts (its mailboxes' profiles and one settings row), never by anything a caller picks.
  "GET /account/export",
  "GET /account/ai",
  "GET /account/screening",
  "GET /consent/seed",
  "GET /consent/reset",
  "POST /consent/reset",
];

/**
 * Routes that DO read caller input, through a module-level helper the handler's own source does
 * not contain — the derived signal's blind spot, closed by naming every instance and its helper.
 *
 * The helper is named so the claim is checkable by reading one function rather than by trusting
 * this list, and the census asserts each of these routes reads nothing INLINE, which is what
 * stops an entry rotting into a stale exemption after its handler starts reading directly.
 */
interface HelperRead {
  /** How the route reaches its input, for a person reading this file. */
  via: string;
  /**
   * The top-level declaration that actually performs the read, checked against the derivation.
   * `null` when the read is not through a named declaration — the entry's `via` says what it is.
   */
  reader: string | null;
}

const INPUT_VIA_HELPER: Readonly<Record<string, HelperRead>> = {
  // `adminRead(...)` wraps all seven console reads: the gate, the staff session header, the
  // blind handle and the timeout, written once. `accountQueryOf(req)` is where the query string
  // is read, and it already bounds `?search` at 200 characters and `?pageSize` at
  // ADMIN_MAX_PAGE_SIZE.
  "GET /admin/overview": { via: "adminRead (a factory) → accountQueryOf", reader: "accountQueryOf" },
  // Cloud 0047's three: each reads its query string through one named helper in `admin.ts`.
  "GET /admin/accounts/:id/staff-activity": { via: "adminRoute (a factory) → activityCursorOf", reader: "activityCursorOf" },
  "GET /admin/search": { via: "adminRoute (a factory) → searchTermOf", reader: "searchTermOf" },
  "GET /admin/sync-roster": { via: "adminRoute (a factory) → syncRosterQueryOf", reader: "syncRosterQueryOf" },
  "GET /admin/accounts": { via: "adminRead (a factory) → accountQueryOf", reader: "accountQueryOf" },
  "GET /admin/accounts/:id": { via: "adminRead (a factory) → accountQueryOf", reader: "accountQueryOf" },
  // The funnel's window and the resolved alerts' window go through one bounds reader.
  "GET /admin/funnel": { via: "adminRoute (a factory) → funnelWindowOf → windowBoundsOf", reader: "windowBoundsOf" },
  "GET /admin/worker": { via: "adminRead (a factory) → accountQueryOf", reader: "accountQueryOf" },
  "GET /admin/actions": { via: "adminRead (a factory) → accountQueryOf", reader: "accountQueryOf" },
  "GET /admin/engagement": { via: "adminRoute (a factory); reads no query string", reader: null },
  "GET /admin/storage": { via: "adminRoute (a factory) → storageQueryOf", reader: "storageQueryOf" },
  "GET /admin/staff-activity": { via: "adminRoute (a factory) → staffFeedQueryOf", reader: "staffFeedQueryOf" },
  "GET /admin/alerts/history": { via: "adminRoute (a factory) → resolvedWindowOf → windowBoundsOf", reader: "windowBoundsOf" },
  // A POST read: no body is read, the session rides in the header like every adminRoute read.
  "POST /admin/staff/list": { via: "adminRoute (a factory); reads no body and no query string", reader: null },
  // `qp(req)` — the contacts module's own query reader, shared by the contact list and both note
  // lists. Found by the DERIVATION above rather than by hand: the two note routes were parked in
  // `PATH_PARAMS_ONLY` because their handlers name no reader, which is exactly the blind spot.
  "GET /contacts": { via: "qp", reader: "qp" },
  "GET /contacts/:id/notes": { via: "qp", reader: "qp" },
  "GET /threads/:id/notes": { via: "qp", reader: "qp" },
  // `q(url, name)` — `mailbox-oauth.ts`'s own null-and-empty-tolerant query reader.
  "GET /mailboxes/oauth/microsoft/callback": { via: "q(url, name)", reader: "q" },
};

/** What bounds a route's caller-chosen counts and sizes. Exactly one shape per route. */
interface Disposition {
  /**
   * The named ceilings that bound every caller-chosen COUNT or SIZE this route accepts.
   * Values, not strings: a constant that is deleted or renamed does not compile, and one that
   * becomes `undefined` fails the finite-and-positive assertion below.
   */
  bounds?: ReadonlyArray<number>;
  /**
   * This route accepts at least one field with NO named ceiling. What bounds it is the request
   * DOOR — {@link JSON_BODY_MAX_BYTES} for a body field, the host's request-line limit for a
   * query one, and the host's own large ceiling on `POST /drafts/:id/send`, which carries a JSON
   * body and is deliberately not held to the JSON number.
   *
   * The string names the value's DOWNSTREAM SINK, and it is not always a terminal one — several
   * entries here name a sink that is genuinely further on (an away-responder's text is later sent
   * over SMTP; a draft's plain body reaches the transport; a KB entry's content is indexed and
   * read back). Saying "its only sink is one column write" of those was the earlier version of
   * this field and it was false; understating a sink is how a value stops getting a bound of its
   * own, so the entry says where the value actually goes.
   */
  door?: string;
  /**
   * No caller-chosen count or size that COSTS anything: scalars, enums, ids, booleans and opaque
   * tokens.
   *
   * A token's length is chosen by the caller in the literal sense — it is a string on the wire —
   * and it is included here because the only thing done with one is a constant-time comparison or
   * an indexed lookup against a stored value, both of which a long value cannot make expensive.
   * The request door bounds what can arrive. Saying "no caller-chosen size at all" of these was
   * imprecise, and the distinction that matters is cost, not authorship.
   */
  scalarsOnly?: true;
}

/**
 * EVERY ROUTE THAT READS CALLER INPUT, and what bounds it.
 *
 * A route may carry both `bounds` and `door` — most write routes do, because a bounded list
 * usually arrives beside a free-text name.
 */
const CENSUS: Readonly<Record<string, Disposition>> = {
  // ── the wall's nightly sweep and its erase door (cloud 0040): a scheduler's shared secret and
  // ONE uuid each — `?after=` the keyset position the sweep goes on from, `?account=` the one
  // account the door is asked about; anything but a canonical uuid is a 400. Neither is a count.
  "GET /internal/account-lifecycle/run": { scalarsOnly: true },
  "GET /internal/account-lifecycle/erase": { scalarsOnly: true },
  // ── the operator console's writes: a staff token, an account id, and an operator's note ──
  "POST /admin/staff/session": { scalarsOnly: true },
  "POST /admin/staff/totp/begin": { scalarsOnly: true },
  "POST /admin/staff/totp/confirm": { scalarsOnly: true },
  "POST /admin/staff/step-up": { scalarsOnly: true },
  // The recovery command's four fields are all scalars, and the only one that is kept is the
  // operator's own `note` — one row in `staff_audit_log`, the same shape the writes' notes have.
  "POST /admin/staff/totp/reset": { door: "`operator` and `note` are free text, stored on one staff_audit_log row" },
  "POST /admin/staff/whoami": { scalarsOnly: true },
  "POST /admin/staff/sign-out": { scalarsOnly: true },
  // Cloud 0047. The mint takes at most STAFF_ASSERTION_MAX_REQUESTS requests, each a method, a
  // path (refused past its length bound) and a hash; the roles change takes four scalars.
  "POST /admin/staff/assertion": { bounds: [STAFF_ASSERTION_MAX_REQUESTS] },
  "POST /admin/staff/roles": { scalarsOnly: true },
  "POST /admin/mailboxes/resync": { door: "`note` is an operator's free text, stored on one audit row" },
  // A staff token, a reason code from its closed set and a ticket reference refused past 64.
  "POST /admin/accounts/:id/billing-link": { scalarsOnly: true },
  "POST /admin/oauth/microsoft": { door: "tenant/client identifiers, stored as columns" },
  "POST /admin/oauth/microsoft/save": { door: "tenant/client identifiers and a secret, stored as columns" },
  // The one field with a character ceiling here is `metric` (refused above 64, a literal in the
  // handler rather than a shared constant, which is why it is named in words). `provider` is a
  // closed set (`COST_PROVIDERS`), `month` must match `YYYY-MM` exactly, `costCents` must be a
  // non-negative integer, and `currency`/`value` are scalars — every one stored as a column on
  // one `platform_costs` row, plus the operator's `note` on one audit row.

  "GET /mailboxes/:id/profile-import/status": {
    door: "`?fingerprint=` is sliced to 200 characters at the handler and reaches one equality against the mailbox row's own ticket, never a query of its own",
  },
  "DELETE /mailboxes/:id": {
    door: "`?erase=1` is one word against one word; the body's `confirm` (or an older client's `?confirm=`) is capped at RECIPIENT_ADDRESS_MAX_CHARS and reaches one case-folded comparison against the mailbox's own `address`, never a query",
  },
  // ── the identity ceremony: credentials, codes and opaque tokens ──────────────────────────
  "POST /auth/register": {
    bounds: [PASSWORD_MAX_LENGTH],
    door: "`displayName` is stored on one column; the invite code is looked up by equality; `locale` is one of two words that picks the mail's language, anything else is English",
  },
  /* One field, `locale`, one of two words for the mail's language and otherwise English. The
     recipient is still the SESSION's own address: there is no field for it. */
  "POST /auth/verify-email/resend": { scalarsOnly: true },
  // The MAXIMUM only — a stored password shorter than today's minimum must still sign in. This
  // disposition was FALSE until a review round: `login` called `requireField` alone, so the
  // ceiling whose docstring names the scrypt-CPU attack was applied on `register` and not on the
  // route an anonymous caller actually reaches.
  "POST /auth/login": { bounds: [PASSWORD_MAX_LENGTH] },
  "POST /auth/verify-email": { scalarsOnly: true },
  "POST /auth/logout": { scalarsOnly: true },
  "POST /auth/refresh": { scalarsOnly: true },
  // The web's sign-out door: an opaque refresh token from the cookie or the body, one indexed lookup.
  "POST /auth/refresh/logout": { scalarsOnly: true },
  "POST /auth/desktop-link": { scalarsOnly: true },
  "POST /auth/desktop-claim": { scalarsOnly: true },
  // The desktop approval: `label` is cut to 64 characters in the service and stored on one row;
  // the claim's id is shape-checked (uuid) before any query, the verifier capped at 512 before a hash.
  "POST /auth/desktop-approval": { door: "`label` is capped at 64 characters and stored on one login_tokens row" },
  "POST /auth/desktop-approval/claim": { scalarsOnly: true },
  "POST /auth/2fa/totp/activate": { scalarsOnly: true },
  "POST /auth/2fa/totp/verify": { scalarsOnly: true },
  "POST /auth/2fa/recovery-codes/verify": { scalarsOnly: true },
  "POST /auth/step-up/totp": { scalarsOnly: true },
  // A WebAuthn credential is a caller-chosen OBJECT, parsed by the authenticator library and
  // compared against a stored challenge. Nothing iterates it and nothing stores it by length.
  "POST /auth/2fa/webauthn/register/verify": { door: "an attestation blob, parsed once and compared to a stored challenge" },
  "POST /auth/2fa/webauthn/assert/options": { door: "a login token, looked up by equality" },
  "POST /auth/2fa/webauthn/assert/verify": { door: "an assertion blob, parsed once and compared to a stored challenge" },
  "POST /auth/step-up/webauthn/verify": { door: "an assertion blob, parsed once and compared to a stored challenge" },
  "GET /oauth/authorize": { bounds: [OAUTH_STATE_MAX_CHARS], door: "`client_id` and `redirect_uri` are compared for equality against a registered client; `code_challenge` is shape-checked as a 43-character SHA-256 digest" },
  // The confirming half. It reads ONE field, the request handle, which is length-bounded before
  // `hashToken` touches it and then compared by equality against a stored hash — every other
  // parameter of the ceremony comes off the server's own row and never off this body, which is
  // the property the split was made for.
  "POST /oauth/authorize": { door: "a request handle, bounded at 512 and looked up by equality" },
  "GET /oauth/authorize/request": { door: "a request handle, bounded at 512 and looked up by equality" },
  "POST /oauth/token": { scalarsOnly: true },
  "GET /auth/audit": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  // MOVED OUT of PATH_PARAMS_ONLY when the bulk web-session revoke grew a body. It took nothing
  // but a cookie before; it now reads ONE optional field, `olderThanDays`, and the
  // classification it held had stopped being true of it — the same shape as
  // `POST /mailboxes/:id/organize` two sections down, and the same reason it is written here
  // rather than quietly left where it was.
  //
  // `bounds` and not `door`: the field is refused outside 1…REVOKE_WEB_SESSIONS_MAX_AGE_DAYS by
  // shape, at the route AND inside the verb (`assertWebSessionAge`), so it is a named ceiling
  // rather than a value the request door happens to bound. What the value CHOOSES is how much
  // of the caller's own session list is revoked, which is bounded by that list either way — the
  // ceiling exists so a nonsense value is a 400 instead of a silent clamp.
  "POST /devices/revoke-web-sessions": { bounds: [REVOKE_WEB_SESSIONS_MAX_AGE_DAYS] },

  // ── device pairing: an opaque token, a closed-set grant, and a label ────────────────────
  "POST /pair": { bounds: [PAIRING_LABEL_MAX] },
  "POST /pair/redeem": { scalarsOnly: true },
  // A link's state by its hash: one string, refused unless it is sha256's 43 base64url characters.
  "POST /pair/state": { scalarsOnly: true },

  // ── sync ────────────────────────────────────────────────────────────────────────────────
  // `?types=` is validated against a closed set of nine entity names (`VALID_TYPES`), so its
  // length is bounded by the vocabulary rather than by the caller.
  "GET /sync": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, SYNC_CURSOR_MAX_CHARS] },
  // closed. The caller chooses the page limit and the cursor; what the
  // SERVER then walks is bounded by three more named ceilings, and those are the ones the row was
  // about — a bootstrap's cost is the mailbox's size, not the request's. `maxRows` stops the
  // message window (the recency floor alone paged a dense mailbox entirely) and `SNAPSHOT_DRAFT_PAGE`
  // pages the drafts, which page 1 emitted in full. The labeled tail is bounded by how much mail
  // carries a tag and has no ceiling of its own, deliberately: a tagged message the bootstrap
  // never delivers is unreachable for ever.
  "GET /sync/snapshot": {
    bounds: [
      DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, SNAPSHOT_CURSOR_MAX_CHARS,
      SNAPSHOT_WINDOW.maxRows, SNAPSHOT_DRAFT_PAGE,
    ],
  },

  // `?counts=1` alone: a closed-set switch that turns on the sender counts, nothing a caller sizes.
  "GET /consent": { scalarsOnly: true },

  // ── mailboxes ───────────────────────────────────────────────────────────────────────────
  "GET /mailboxes": { scalarsOnly: true },
  "POST /mailboxes": { door: "host, port, username and a credential — each stored as one column and dialled once" },
  "PATCH /mailboxes/:id": { door: "host, port, username and a credential — each stored as one column and dialled once" },
  "POST /mailboxes/oauth/microsoft/start": { door: "`returnTo` is compared against the allow-list, never concatenated" },
  "POST /mailboxes/oauth/microsoft/complete": { scalarsOnly: true },
  // The counts come from a document in the mailbox, not from this body — the body is a
  // fingerprint. PROFILE_IMPORT_MAX bounds each of the document's four lists before the
  // transaction opens.
  "POST /mailboxes/:id/profile-import": {
    bounds: [PROFILE_IMPORT_MAX.screener, PROFILE_IMPORT_MAX.rules, PROFILE_IMPORT_MAX.notifyRules, PROFILE_IMPORT_MAX.tagNames],
  },
  // The gap offer's answer: a boolean and a count compared with the row's own integer, no more.
  "POST /mailboxes/:id/gap-letters": { scalarsOnly: true },
  "POST /mailboxes/:id/profile-import/decline": { scalarsOnly: true },
  "POST /mailboxes/:id/profile-import/replace": { scalarsOnly: true },
  // RENAMED from `POST /mailboxes/:id/takeover` and MOVED OUT of PATH_PARAMS_ONLY in the same
  // breath (mail 0083). The old route took a path parameter and nothing else; this one carries a
  // body — `{ imap?: { pass }, screening?: { dormancyDays?, scope? } }` — so the classification it
  // inherited had stopped being true of it. That is the census working: the route was renamed and
  // given inputs in one commit, and this file is what refused to keep quiet about the second half.
  //
  // `dormancyDays` and `scope` are bounded (1–365 and a two-member enum, both enforced inside
  // `organizeHere`'s transaction rather than at the route, so no caller can be added past them).
  // What earns `door` is `imap.pass`: a password has no named ceiling anywhere in this codebase,
  // and naming one here would be inventing a limit the credential columns do not have.
  // The test action. `imap.pass` is the same unbounded-by-name field the create and claim paths
  // carry, and for the same reason: a password has no named ceiling in this codebase and should
  // not acquire an invented one. `host` and `user` are bounded by the door too — both reach one
  // socket and neither is stored, since this route writes nothing.
  "POST /mailboxes/probe": {
    door: "a host, a username and a mailbox password — dialled once, stored never",
  },
  "POST /mailboxes/:id/organize": {
    door: "a mailbox password — proved by one IMAP LOGIN, then stored as one credential column",
  },

  // ── rules ───────────────────────────────────────────────────────────────────────────────
  // The DELETE reads the raw body only to HASH it for `Idempotency-Key`, never to interpret it;
  // nothing iterates it and nothing stores it, so its cost is one sha256 over what the door let
  // in. It reads the query string for the same hash, through `canonicalQuery`.
  "DELETE /rules/:id": { door: "the body is read once to compute the idempotency request hash" },
  "POST /rules": {
    bounds: [MAX_SUBJECT_CONTAINS_CHARS, MAX_BODY_CONTAINS_CHARS],
    door: "`match` is stored on one column and compared for equality at routing time",
  },
  "PATCH /rules/:id": {
    bounds: [MAX_SUBJECT_CONTAINS_CHARS, MAX_BODY_CONTAINS_CHARS],
    door: "`match` is stored on one column and compared for equality at routing time",
  },

  // ── messages ────────────────────────────────────────────────────────────────────────────
  "GET /messages": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "GET /messages/bodies": { bounds: [BODIES_MAX_LIMIT, BODIES_IDS_MAX, BODIES_BYTE_BUDGET] },
  // The History rail: one grouped read of the SESSION's own messages, bounded by the account's
  // months. `?zone=` picks which calendar they are counted in and is capped at the parser.
  "GET /messages/timeline": { bounds: [READER_ZONE_MAX_CHARS] },
  "PATCH /messages": { bounds: [MARK_SEEN_MAX_IDS] },
  "PATCH /messages/:id": { bounds: [FOLDER_PATH_MAX] },
  "POST /messages/:id/move": { bounds: [FOLDER_PATH_MAX] },
  "POST /messages/:id/triage": { bounds: [SCHEDULE_MAX_AHEAD_MS] },
  "GET /messages/:id/tracker-events": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "GET /tracker-events": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "GET /views/power-through": { scalarsOnly: true },

  // ── threads ─────────────────────────────────────────────────────────────────────────────
  "POST /threads/merge": { bounds: [THREAD_MERGE_MAX_IDS] },
  "PATCH /threads/:id": { scalarsOnly: true },
  "POST /threads/:id/rename": { door: "`subject` is stored on one column" },

  // ── screener + junk ─────────────────────────────────────────────────────────────────────
  "GET /screener": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  // The sender sheet's "why did these stay": the caller names message ids, refused above this
  // many (and the raw list above that many ids' length) before any row is read.
  "GET /screener/stayed": { bounds: [WHY_STAYED_IDS_MAX] },
  "POST /screener/suggest": { bounds: [MAX_SUGGEST_SENDERS] },
  // The press names the groups and the contact-only senders it releases. The two counts are the
  // only caller-chosen sizes on the route, and the service refuses more than this many of either
  // (and an address over 320 characters) before it reads any of them.
  "POST /screener/held-releases": { bounds: [HELD_RELEASE_GROUPS_MAX] },
  // Put back names the messages it returns to the gate, at most one read's page of them; the
  // service refuses more, and an id over 64 characters, before it reads a row.
  "POST /screener/auto-filed/undo": { bounds: [AUTO_FILED_PAGE_MAX] },
  // "Not now" carries ONE caller-chosen string, the offer's fingerprint, and the service refuses
  // anything over 128 characters before it writes (the migration's CHECK is the belt).
  "POST /screener/held-releases/dismiss": { scalarsOnly: true },
  // The press names the sender groups it screens. The count of addresses is the only
  // caller-chosen size on the route, and the service refuses more than this many — and any
  // address over 320 characters — before it reads a row.
  "POST /screener/unscreened": { bounds: [OHBOX_UNSCREENED_GROUPS_MAX] },
  // What agreeing will screen: one mailbox id matched to the caller's own, a window refused outside
  // 1-365 days or two scopes, and an answer cut at the move bound by a walk of at most 25 pages.
  "GET /screener/unscreened/count": { bounds: [OHBOX_UNSCREENED_MESSAGES_MAX] },
  "POST /screener/:id": { scalarsOnly: true },
  // The list reads ENVELOPES, not bodies, so `JUNK_BODY_MAX_BYTES` is not its ceiling and citing
  // it here was a false disposition. What the REQUEST carries is bounded (the cursor's wire size,
  // entry count, uuid keys and uint32 epochs); what the SERVER may return per envelope is not —
  // a sender can deliver a Junk message with a very large folded Subject and this page
  // materializes it. That is on the adapter side, and it is named here
  // rather than papered over with a constant that does not apply.
  "GET /screener/junk": { bounds: [JUNK_CURSOR_MAX_CHARS], door: "per-envelope header bytes are the adapter's to bound" },
  "GET /screener/junk/body": { bounds: [JUNK_BODY_MAX_BYTES, IMAP_UINT32_MAX] },
  "GET /screener/junk/search": { bounds: [JUNK_SEARCH_MAX_CHARS], door: "per-envelope header bytes, and the provider SEARCH result the adapter sorts before slicing" },
  "POST /screener/junk/rescue": { bounds: [IMAP_UINT32_MAX], door: "`allow.sender` is free text — trimmed, lowercased, compared in two rule predicates and inserted into `contacts` and possibly `rules`" },
  // The TRASH window, the Junk window's shape read for read: the list's caller-chosen input is
  // its cursor and nothing else, the body read carries the transfer ceiling and the UID's
  // protocol range, and the search carries its term length. Per-envelope header bytes are the
  // adapter's to bound in all three, exactly as they are for Junk.
  "GET /trash/window": { bounds: [TRASH_CURSOR_MAX_CHARS], door: "per-envelope header bytes are the adapter's to bound" },
  "GET /trash/window/body": { bounds: [TRASH_BODY_MAX_BYTES, IMAP_UINT32_MAX] },
  "GET /trash/window/search": { bounds: [TRASH_SEARCH_MAX_CHARS], door: "per-envelope header bytes, and the provider SEARCH result the adapter sorts before slicing" },

  // ── approvals + triage ──────────────────────────────────────────────────────────────────
  "GET /approvals": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "POST /approvals/:id": { scalarsOnly: true },
  "GET /triage": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },

  // ── search ──────────────────────────────────────────────────────────────────────────────
  "GET /search": {
    bounds: [SEARCH_QUERY_MAX_CHARS, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT],
    door: "`folder`/`sender` are equality comparisons, and a ceiling on them refused a facet this service itself emits — see SearchService",
  },

  // ── privacy ─────────────────────────────────────────────────────────────────────────────
  // `?u=` is a sender-named URL this process fetches; the RESPONSE is what has to be bounded
  // and is (`REMOTE_MAX_BYTES`), while the URL itself is parsed once and compared to a policy.
  "GET /img": { bounds: [PROXY_URL_MAX_CHARS] },

  // ── contacts + notes ────────────────────────────────────────────────────────────────────
  "PATCH /contacts/:id": { door: "`name` is stored on one column" },
  "POST /contacts/:id/notes": { door: "`body` is a note, stored on one column" },
  "POST /threads/:id/notes": { door: "`body` is a note, stored on one column" },
  "PATCH /notes/:id": { door: "`body` is a note, stored on one column" },

  // ── snippets, notify rules, away responder ──────────────────────────────────────────────
  "GET /snippets": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "POST /snippets": { door: "`title` and `body` are stored on two columns" },
  "PUT /snippets/:id": { door: "`title` and `body` are stored on two columns" },
  "GET /notify-rules": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "POST /notify-rules": { door: "`target` is stored on one column and compared for equality" },
  // BOUNDED 2026-09-13, and it is the entry that made the rule below worth stating: the body is
  // stored once and then placed in an `OutboundMessage` the worker sends over SMTP to every
  // eligible correspondent for as long as the responder is on, so the request door's ceiling
  // bounds ONE request and not the value's life — one PUT bought unbounded outbound bytes. It
  // takes `DRAFT_BODY_MAX_BYTES`, the same ceiling the other plain body this product sends
  // already carries, rather than a second number on the same kind of value. `subject` is ignored
  // by the door (the responder is reply-only) and stores nothing.
  "PUT /away-responder": { bounds: [DRAFT_BODY_MAX_BYTES], door: "`subject` is accepted from a client one release behind and stored nowhere" },

  // ── attachments ─────────────────────────────────────────────────────────────────────────
  "GET /files": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  // `DOWNLOAD_ALL_MAX_BYTES` is the archive's total AND the per-part ceiling (each part is fetched
  // under the REMAINING budget); `ATTACHMENT_MAX_FETCH_BYTES` belongs to the single-attachment
  // path and is deliberately not named here. `filter.minSizeBytes` is a caller-chosen number on
  // the BODY — not a query parameter — declared `number` in `FilesFilter` and arriving from
  // `JSON.parse`, so the type said nothing at runtime.
  "POST /files/download-all": { bounds: [DOWNLOAD_ALL_MAX_PARTS, DOWNLOAD_ALL_MAX_BYTES] },
  // THE `door:` DISPOSITION THIS ROW USED TO CARRY WAS THE PLACE THE DEFECT WAS WRITTEN DOWN.
  // It said the request door bounds `filename` and `contentType`, which is true PER REQUEST and
  // false for the value's actual life: each is persisted on a ticket, a caller may hold
  // STAGING_MAX_OUTSTANDING_TICKETS of them, and one send gathers all of them into one message's
  // MIME headers — a fan-in no per-request ceiling can see. A `door:` disposition is a claim that
  // the request ceiling is the WHOLE bound, so it is only honest for a value whose life ends with
  // the request. Both fields now carry SEND_ATTACHMENT_FIELD_MAX_CHARS, the same ceiling the
  // INLINE entrance (`decodeSendAttachments`) applies to the same two MIME parameters.
  "POST /attachments/staging": { bounds: [SEND_ATTACHMENT_FIELD_MAX_CHARS, SEND_ATTACHMENT_MAX_TOTAL_BYTES] },

  // ── knowledge base + tags ───────────────────────────────────────────────────────────────
  "GET /kb": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "POST /kb": { bounds: [KB_MAX_TAGS, MAX_TAG_NAME_CHARS], door: "`title` and `content` are stored on two columns AND indexed — `KbService.retrieve` runs a tsquery and a trigram arm over them" },
  "PUT /kb/:id": { bounds: [KB_MAX_TAGS, MAX_TAG_NAME_CHARS], door: "`title` and `content` are stored on two columns AND indexed — `KbService.retrieve` runs a tsquery and a trigram arm over them" },
  "POST /tags": { bounds: [MAX_TAG_NAME_CHARS] },
  "PATCH /tags/:id": { bounds: [MAX_TAG_NAME_CHARS] },
  "POST /messages/:id/tags": { bounds: [MAX_TAG_NAME_CHARS] },

  // ── folders ─────────────────────────────────────────────────────────────────────────────
  "POST /folders": { bounds: [FOLDER_PATH_MAX] },
  "PATCH /folders/:id": { bounds: [FOLDER_PATH_MAX] },

  // ── drafts + send ───────────────────────────────────────────────────────────────────────
  "POST /drafts": {
    bounds: [DRAFT_MAX_RECIPIENTS, RECIPIENT_ADDRESS_MAX_CHARS, RECIPIENT_NAME_MAX_CHARS,
      DRAFT_SUBJECT_MAX_CHARS, DRAFT_HTML_CAP_BYTES, DRAFT_BODY_MAX_BYTES],
  },
  "PUT /drafts/:id": {
    bounds: [DRAFT_MAX_RECIPIENTS, RECIPIENT_ADDRESS_MAX_CHARS, RECIPIENT_NAME_MAX_CHARS,
      DRAFT_SUBJECT_MAX_CHARS, DRAFT_HTML_CAP_BYTES, DRAFT_BODY_MAX_BYTES],
  },
  "POST /drafts/:id/schedule": { bounds: [SCHEDULE_MAX_AHEAD_MS] },
  // The resolution verb. Its body carries ONE field, `outcome`, a two-member enum
  // (`arrived` | `not_arrived`) refused by shape before the transaction opens — so there is no
  // caller-chosen count and no caller-chosen size, which is what this file is about. It is not
  // PATH_PARAMS_ONLY: it DOES read a body, and that list's derived cross-check would refuse it.
  /* One body field, `draftId`, shape-checked as an id and recorded only when the account holds that
     draft; the key is the `Idempotency-Key` header, one equality predicate on the reservation. */
  "POST /sends/withdraw": { scalarsOnly: true },
  "POST /drafts/:id/resolve": { door: "the only body field is a two-member enum, bounded by shape; the ids it writes are its own path parameter and the ledger rows already attached to it" },
  "POST /drafts/:id/send": {
    // `forwardZone`/`forwardLocale` name how the quoted header dates the original, capped at the parsers.
    bounds: [SEND_MAX_ATTACHMENT_PARTS, SEND_ATTACHMENT_MAX_TOTAL_BYTES, SEND_MAX_RECIPIENTS,
      SEND_ATTACHMENT_FIELD_MAX_CHARS, READER_ZONE_MAX_CHARS, READER_LOCALE_MAX_CHARS],
  },

  // ── workflows ───────────────────────────────────────────────────────────────────────────
  "POST /workflows": { bounds: [MAX_WORKFLOW_STEPS], door: "`name` is stored on one column; each step's `args` OBJECT is shape-checked but not sized, and the worker resolves and executes it" },
  "PATCH /workflows/:id": { bounds: [MAX_WORKFLOW_STEPS], door: "`name` is stored on one column; each step's `args` OBJECT is shape-checked but not sized, and the worker resolves and executes it" },
  "GET /workflow-runs": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },

  // ── push ────────────────────────────────────────────────────────────────────────────────
  "POST /push/subscriptions": { bounds: [PUSH_ENDPOINT_MAX_LEN] },

  // ── billing ─────────────────────────────────────────────────────────────────────────────
  // `plan` and `interval` are closed sets; `quantity` is an integer inside MAX_ADDON_QUANTITY.

  // ── account + consent ───────────────────────────────────────────────────────────────────
  "PATCH /account/ai": { scalarsOnly: true },
  /* Three fields, `lang`, `plan` and `interval`, each read as a member of its closed set and
     otherwise dropped. The account is still the SESSION's: a manage link for an account the caller
     merely named would be a link to somebody else's payment details. */
  "POST /account/manage-link": { scalarsOnly: true },
  /* One field, the session id the return address carried, refused 400 unless it is a token of at
     most this many letters, digits, `_` or `-`. The account is the SESSION's, as above. */
  "POST /account/checkout/confirm": { bounds: [RETURN_SESSION_ID_MAX_CHARS] },
  "PATCH /account/screening": { bounds: [OHBOX_BAR_MAX_BYTES] },
  "PATCH /consent/settings": { bounds: [SETTINGS_MAX_MAILBOX_ENTRIES, MAILBOX_SIGNATURE_MAX_CHARS] },
  // `SEED_MAX_ADDRESSES`, not `SEED_SCAN_LIMIT`: the latter counts MESSAGES scanned by the
  // review, and `confirmSeed` says in its own docstring that deriving an address ceiling from it
  // refuses the product's own output. Naming the wrong one here would have sent a reader to a
  // constant this route deliberately does not apply.
  "POST /consent/seed": { bounds: [SEED_MAX_ADDRESSES] },

  // ── the waitlist ────────────────────────────────────────────────────────────────────────
  // `source` is truncated to 32 characters by the service; `email` is validated as an address.
  "POST /waitlist": { door: "`tier` is a closed set; `email` is validated as an address and stored" },
};

/* The console reads and the pairing/webhook bodies, dispositioned like any other input. */
const HELPER_CENSUS: Readonly<Record<string, Disposition>> = {
  "GET /admin/overview": { scalarsOnly: true },
  "GET /admin/accounts": { bounds: [ADMIN_MAX_PAGE_SIZE, ADMIN_BATCH_MAX], door: "`?search` is sliced to 200 characters before it reaches the in-process fold" },
  // Cloud 0047: the activity page is one cursor and a fixed page; search is one term sliced to
  // 320 characters and at most ADMIN_SEARCH_LIMIT results; the sync roster's limit is clamped.
  "GET /admin/accounts/:id/staff-activity": { bounds: [ADMIN_STAFF_ACTIVITY_PAGE] },
  "GET /admin/search": { bounds: [ADMIN_SEARCH_LIMIT], door: "`?q` is sliced to 320 characters before any read" },
  "GET /admin/sync-roster": { bounds: [ADMIN_SYNC_ROSTER_MAX] },
  "GET /admin/accounts/:id": { scalarsOnly: true },
  // `?from&to` are each sliced to 64 characters and parsed as an instant or dropped; the window
  // is clamped to ADMIN_FUNNEL_WINDOW_MAX_DAYS and reaches one grouped statement.
  "GET /admin/funnel": { bounds: [ADMIN_FUNNEL_WINDOW_MAX_DAYS] },
  "GET /admin/worker": { scalarsOnly: true },
  "GET /admin/actions": { bounds: [ADMIN_MAX_PAGE_SIZE] },
  "GET /admin/engagement": { scalarsOnly: true },
  "GET /admin/storage": { bounds: [ADMIN_STORAGE_MAX] },
  // A fixed page; every filter is a uuid, a closed-set word or an instant, dropped otherwise.
  "GET /admin/staff-activity": { bounds: [ADMIN_STAFF_ACTIVITY_PAGE] },
  "GET /admin/alerts/history": { bounds: [ADMIN_RESOLVED_ALERTS_MAX, ADMIN_RESOLVED_ALERTS_MAX_DAYS] },
  "POST /admin/staff/list": { scalarsOnly: true },
  "GET /contacts": { bounds: [CONTACTS_QUERY_MAX_CHARS, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  // The note lists share `qp` and so read `?q=` too; the notes services ignore it, so only the
  // page limit reaches a query.
  "GET /contacts/:id/notes": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  "GET /threads/:id/notes": { bounds: [DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT] },
  // `state` and `code` come back from the provider's redirect, so they are caller-supplied on the
  // wire whatever their origin. Both are refused above a length by the module's own
  // `URL_SAFE_STATE` (512) and `URL_SAFE_CODE` (8192) patterns before anything is looked up.
  "GET /mailboxes/oauth/microsoft/callback": { bounds: [512, 8192] },

};

describe("SECTION 1 — every route is classified for caller-chosen counts and sizes", () => {
  it("partitions the route table with no remainder and no duplicate", () => {
    const classified = [
      ...PATH_PARAMS_ONLY,
      ...Object.keys(CENSUS),
      ...Object.keys(HELPER_CENSUS),
    ];
    const seen = new Set<string>();
    const duplicates = classified.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(duplicates, "a route classified twice").toEqual([]);

    const table = new Set(allRoutes);
    const unclassified = allRoutes.filter((k) => !seen.has(k));
    const stale = classified.filter((k) => !table.has(k));

    // THE MECHANISM. A route added tomorrow lands here with its method and pattern in the
    // message, and the author has to say what bounds its inputs — or that it has none.
    expect(unclassified, "route(s) in the table with no input-bounds disposition").toEqual([]);
    expect(stale, "disposition(s) for a route that no longer exists").toEqual([]);
    expect(seen.size).toBe(allRoutes.length);
  });

  /**
   * ── A `door:` DISPOSITION IS A CLAIM ABOUT THE VALUE'S LIFE, NOT ABOUT THE REQUEST ────────
   *
   * Stated at the attachment door that learned it: "a `door:` disposition is a claim that the
   * request ceiling is the WHOLE bound, so it is only honest for a value whose life ends with the
   * request". `JSON_BODY_MAX_BYTES` bounds one PUT; it says nothing about a value stored once and
   * then SENT AS MAIL for as long as a setting stays on, which is a fan-out no per-request ceiling
   * can see. The away notice was that shape and wore a `door:` for it — the disposition even
   * named the SMTP sink, which is the census describing the hole rather than refusing it.
   *
   * The set is declared rather than derived, for the reason the meta-folder census declares its
   * clock exemptions: nothing in a route table says where a value ends up. What the declaration
   * buys is that adding a route here without a ceiling is red, and that the reviewer of a new
   * stored-and-sent field has a list to add it to.
   */
  it("every route whose stored text is later SENT AS MAIL names a byte ceiling", () => {
    const storedAndSent = ["PUT /away-responder", "POST /drafts", "PUT /drafts/:id"];
    for (const route of storedAndSent) {
      const entry = CENSUS[route];
      expect(entry, `${route} is not in the census`).toBeDefined();
      expect(
        entry?.bounds ?? [],
        `${route} stores text this product later sends, so the request door is not its bound`,
      ).toContain(DRAFT_BODY_MAX_BYTES);
    }
  });

  it("PATH_PARAMS_ONLY is true of the handlers, not merely asserted about them", () => {
    const lying = apiRoutes
      .filter((r) => PATH_PARAMS_ONLY.includes(key(r)) && readsInputInline(r))
      .map(key);
    // A route parked here that has since started reading a body or a query string.
    expect(lying, "listed as path-params-only, but the handler reads caller input").toEqual([]);
  });

  it("every CENSUS route really does read caller input inline", () => {
    const notReading = apiRoutes
      .filter((r) => CENSUS[key(r)] !== undefined && !readsInputInline(r))
      .map(key);
    // Either the route stopped reading input (move it to PATH_PARAMS_ONLY) or it started
    // reading through a helper (move it to INPUT_VIA_HELPER, and say which helper).
    expect(notReading, "dispositioned as an input reader, but reads nothing inline").toEqual([]);
  });

  it("no PATH_PARAMS_ONLY route calls a helper that reads caller input — the blind spot, closed", () => {
    /**
     * ── THE HOLE THIS CLOSES ─────────────────────────────────────────────────────────────
     *
     * `readsInputInline` reads the handler's OWN source, so `handler: (req) => parseFilters(req)`
     * contains none of `READS_INPUT`, could be listed in {@link PATH_PARAMS_ONLY}, and would pass
     * every other assertion here while reading a query string through `parseFilters`. Naming the
     * three helpers that exist today in {@link INPUT_VIA_HELPER} does not close that: it is a
     * hand-maintained list, and the next helper is not on it.
     *
     * So the helpers are DERIVED. Every top-level function in `packages/api/src` whose body
     * contains a reader is a reading helper, whatever it is called, and a `PATH_PARAMS_ONLY`
     * route whose handler MENTIONS one of them is red. That is not an AST call graph — a helper
     * reached two levels down, or through a variable, is still invisible — but it turns the
     * exception list from a claim into a derivation, which is the part that was missing.
     */
    const helpers = readingHelpers();
    // The derivation has to actually find the ones we know about, or it is finding nothing.
    for (const known of ["readBody", "readObjectBody", "accountQueryOf", "qp"]) {
      expect(helpers, `the helper derivation must see ${known}`).toContain(known);
    }

    const viaHelper = new Set(Object.keys(INPUT_VIA_HELPER));
    const hidden = apiRoutes
      .filter((r) => PATH_PARAMS_ONLY.includes(key(r)) && !viaHelper.has(key(r)))
      .filter((r) => {
        const src = String(r.handler);
        return [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(src));
      })
      .map(key);

    expect(hidden, "listed as path-params-only, but the handler calls a reading helper").toEqual([]);
  });

  it("INPUT_VIA_HELPER names exactly the routes that read through a helper", () => {
    const helperKeys = Object.keys(INPUT_VIA_HELPER).sort();
    expect(Object.keys(HELPER_CENSUS).sort(), "every helper route needs a disposition too")
      .toEqual(helperKeys);
    // The blind spot is closed only while these routes genuinely read nothing inline: one that
    // started reading directly would be covered by the derived signal and must move.
    const readsInline = apiRoutes
      .filter((r) => INPUT_VIA_HELPER[key(r)] !== undefined && readsInputInline(r))
      .map(key);
    expect(readsInline, "listed as reading via a helper, but reads inline now").toEqual([]);
    /**
     * And the named READER must be a real one — a top-level declaration that actually contains an
     * input read, as the derivation above finds them. Without this the string is decoration: an
     * entry could name any helper at all, or one that has since stopped reading anything, and the
     * census would agree with it.
     *
     * It is the reader that is checked and not the wrapper, because `adminRead` is a FACTORY: the
     * function stored on the route is the closure it returned, so the wrapper's own name does not
     * appear in the handler's source and cannot be looked for there. `readerOf` names the thing
     * that does the reading, which is the claim worth checking.
     */
    const derivedHelpers = readingHelpers();
    for (const [k, entry] of Object.entries(INPUT_VIA_HELPER)) {
      expect(entry.via.length, `${k} must name the helper it reads through`).toBeGreaterThan(0);
      if (entry.reader === null) continue;   // see the entry's own `via` prose
      expect(
        derivedHelpers.has(entry.reader),
        `${k}: \`${entry.reader}\` is not a declaration that reads caller input`,
      ).toBe(true);
    }
  });

  it("every disposition says something, and every named bound is a usable ceiling", () => {
    for (const [k, d] of [...Object.entries(CENSUS), ...Object.entries(HELPER_CENSUS)]) {
      const said = (d.bounds?.length ?? 0) > 0 || d.door !== undefined || d.scalarsOnly === true;
      expect(said, `${k}: a disposition must claim a bound, a door, or no sized input`).toBe(true);
      for (const n of d.bounds ?? []) {
        // A constant deleted or renamed does not compile; one that has become `undefined`,
        // `NaN`, zero or negative would still compile and would bound nothing — which is the
        // `clampLimit` failure exactly.
        expect(Number.isFinite(n), `${k}: a bound is not a finite number`).toBe(true);
        expect(n, `${k}: a bound must be positive`).toBeGreaterThan(0);
      }
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   SECTION 2 — QUERY PARAMETERS, derived from the source text
   ───────────────────────────────────────────────────────────────────────────────────────── */

const API_SRC = resolve(__dirname, "../src");
const SERVICES_SRC = resolve(__dirname, "../../services/src");
/* The per-mailbox erasure's table walk moved to `@trafficflow/db` so the worker can run it; its
   `IN` lists are still this census's question, so section 3 reads those files by name — the walk
   and the response-cache primitive it scopes to the mailbox. */
const MOVED_FROM_SERVICES = [
  resolve(__dirname, "../../db/src/mailbox-erasure.ts"),
  resolve(__dirname, "../../db/src/idempotency.ts"),
];

const walkDir = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
};

/**
 * ═══ THE EXTRACTORS ARE AN AST WALK, and three text versions are the reason ═════════════════
 *
 * Sections 2 and 3 claim to be EXACT over their domains, and a text scanner cannot make that
 * claim honestly. Three attempts proved it, each defeated by ordinary valid TypeScript:
 *
 *  1. Stripping block comments from raw text is not string-aware: a file with `"/*"` in a string,
 *     a call, and `"*\/"` in another string had the whole span between them erased, and the
 *     "exact" multiset stayed green over code it could not see.
 *  2. Masking strings BEFORE stripping comments is worse, and it shipped for ten minutes: the
 *     comments are still there when the mask runs, and this codebase's prose is full of
 *     apostrophes — `// the caller's array` opens a "string" that runs several lines and blanks
 *     real code. It silently deleted four `inArray` call sites.
 *  3. A single-pass scanner that tracks the five states is defeated by a REGEX LITERAL:
 *     `const marker = /[/*]/;` opens a fictitious block comment that swallows every call until
 *     the next literal `*\/`, and a regex containing a quote or a bracket confuses a balanced
 *     argument scan the same way.
 *
 * Each of those is valid source somebody could write tomorrow. So the calls come from
 * `typescript`'s own parser — `ts.createSourceFile` and a node walk — which knows what a comment,
 * a string, a template and a regex are because it is the thing that defines them. The compiler is
 * already this repository's dependency, so this costs nothing but the import. There is no text
 * preprocessing left anywhere in this file.
 *
 * Both extractors resolve the ALIAS forms that matter — a local `const p = url.searchParams`, and
 * `import { inArray as within }` — because both are ordinary and both were live omissions when
 * they were not resolved. What is still outside the domain, one level up from an alias: a call
 * reached through a VALUE rather than a name, which would need a type-checker program.
 */
function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** Every node in the file, in source order. */
function* walk(node: ts.Node): Generator<ts.Node> {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}

const sourcesOf = (root: string): Array<{ file: string; src: string; ast: ts.SourceFile }> =>
  walkDir(root).map((file) => {
    const src = readFileSync(file, "utf8");
    return { file, src, ast: parse(file, src) };
  });

const rel = (file: string): string => file.replace(/^.*\/src\//, "");

/**
 * Every `?name=` this API reads, keyed `<file>#<name>`, and what bounds it.
 *
 * The four dispositions are the whole vocabulary, and they are the shape of the fix this class
 * wanted: a caller-chosen value is either CLAMPED into a range, checked against a CLOSED SET,
 * length-capped, or it is an identifier/opaque token whose size is not a cost.
 */
type ParamBound =
  /** Passed through `clampLimit`/`clampPageLimit`: total over every double `Number()` returns. */
  | "clamped"
  /** Compared against a fixed vocabulary; anything else is refused or dropped. */
  | "closed-set"
  /** Refused above a named character ceiling. */
  | "length-capped"
  /**
   * A uuid, an integer id, or an opaque cursor, VALIDATED FOR SHAPE before it reaches a query.
   *
   * The shape check is the bound: a value that must be a uuid cannot be long, and one that is not
   * one is refused rather than handed to a `uuid` column as 22P02. This used to be a claim rather
   * than a fact — `decodeListCursor` neither capped nor validated, so `?cursor=eA` decoded to the
   * string `"x"` and every keyset-paginated route answered 500 for a bad query string. The
   * decoder now refuses on length and on shape, which is what makes this disposition true.
   */
  | "identifier"
  /**
   * A free value with no ceiling of its own, bounded only by how large a REQUEST LINE the host in
   * front admits.
   *
   * Deliberately NOT called "door": {@link JSON_BODY_MAX_BYTES} bounds a request BODY, and every
   * value in this census's query-parameter section arrives in a URL. Conflating the two was a
   * false claim about `?u=` on `GET /img`, whose value reaches `new URL()`, a DNS resolution and
   * an outbound fetch — it has a named ceiling now, and this disposition is left for the values
   * whose only cost is being compared once.
   */
  | "request-line";

/**
 * How many times each parameter is READ, where that is more than once.
 *
 * Keyed by file and name, two different readers of the same name in one file are one entry — and
 * `routes/screener.ts` has exactly that: the Screener list's `?cursor=` (the shared
 * `decodeListCursor` identifier) and the Junk window's (a caller-supplied base64 JSON object with
 * its own decoder and its own ceilings). Recording the count is what makes the second one
 * visible; without it, adding or unbounding a reader beside an existing one moved nothing.
 *
 * Absent means one.
 */
const QUERY_PARAM_READS: Readonly<Record<string, number>> = {
  // TWO DECODERS, one file, one name: the Screener list's cursor goes through the shared
  // `decodeListCursor`; the Junk window's is a caller-supplied base64 JSON OBJECT with its own
  // parser and its own ceilings. Keyed by `file#name` alone they were one entry, so the junk one
  // could be added, removed or left unbounded without moving this set — which is how it stayed
  // unbounded while the census recorded its file and name as a shape-checked `identifier`.
  "routes/screener.ts#cursor": 2,
  // The Junk body's mailbox and the organize decision's: two routes, each one identifier.
  "routes/screener.ts#mailboxId": 2,
  // Cloud 0047: the sync roster's keyset cursor and an account's activity cursor, two readers;
  // then the storage read's keyset cursor and the staff feed's `<iso>,<uuid>`, four.
  "routes/admin.ts#cursor": 4,
  // The sync roster's and the storage read's, each through `pagingNumber`.
  "routes/admin.ts#limit": 2,
  // The rest are TWO ROUTES in one file sharing a parameter name. They used to be something
  // else as well — the same value read twice by one handler, a presence test and a conversion —
  // and the paging seam removed that second read: `pagingNumber` takes the raw read and decides
  // absent, blank and out-of-shape in one place (`src/query-bounds.ts`), so each handler now
  // names its parameter once. The counts moved with it, which is this table working.
  "routes/attachments.ts#limit": 1,
  "routes/contacts.ts#limit": 1,
  "routes/kb.ts#limit": 1,
  "routes/messages.ts#limit": 2,
  "routes/notify.ts#limit": 1,
  "routes/privacy.ts#cursor": 2,
  "routes/privacy.ts#limit": 2,
  // TWO ARMS, one file, one name: `?limit=` is read once by the address arm and once by the text
  // search below it. Both go through `clampLimit` in the service, so the disposition is the same
  // for both — but the COUNT is what makes the second reader visible, which is the whole reason
  // this table exists (see the Screener note above, where an unbounded second reader hid behind
  // a bounded first one).
  "routes/search.ts#limit": 2,
  "routes/snippets.ts#limit": 1,
  "routes/sync.ts#limit": 2,
  "routes/triage.ts#cursor": 2,
  // Read twice in a ternary: once to test for presence, once to use.
  "routes/devices.ts#cursor": 2,
  "routes/oauth.ts#scope": 2,
};

const QUERY_PARAMS: Readonly<Record<string, ParamBound>> = {
  "routes/approvals.ts#cursor": "identifier",
  // `=== "all"` is the whole comparison: one word widens the window, anything else is the
  // default. Never parsed as a number, never reaches a query.
  "routes/approvals.ts#limit": "clamped",
  "routes/approvals.ts#status": "closed-set",
  "routes/attachments.ts#cursor": "identifier",
  "routes/attachments.ts#limit": "clamped",
  // `listFiles` does not use `q` at all today; it is read here and dropped, so it reaches no
  // predicate. Recorded rather than removed, because deleting it silently would change the
  // route's accepted shape in a slice about bounds.
  "routes/attachments.ts#q": "request-line",
  "routes/attachments.ts#type": "closed-set",
  "routes/consent.ts#counts": "closed-set",
  // The lifecycle sweep's keyset position and the erase door's account: canonical uuids or a 400.
  "routes/internal.ts#after": "identifier",
  "routes/internal.ts#account": "identifier",
  "routes/contacts.ts#cursor": "identifier",
  "routes/contacts.ts#limit": "clamped",
  "routes/contacts.ts#q": "length-capped",
  "routes/kb.ts#cursor": "identifier",
  "routes/kb.ts#limit": "clamped",
  "routes/mailboxes.ts#counts": "closed-set",
  /* `?erase=1` selects the irreversible removal; `?confirm=` is an older client's spelling of the
     body's `confirm`, the mailbox's own address compared to the row being erased. Both are sliced
     to `RECIPIENT_ADDRESS_MAX_CHARS` at the handler before either reaches the service. */
  "routes/mailboxes.ts#erase": "closed-set",
  "routes/mailboxes.ts#confirm": "length-capped",
  /* The status read's ticket, sliced to 200 characters at the handler; a fingerprint is shorter. */
  "routes/mailboxes.ts#fingerprint": "length-capped",
  "routes/messages.ts#after": "identifier",
  "routes/messages.ts#beforeDate": "identifier",
  "routes/messages.ts#beforeId": "identifier",
  // `view=all`'s inclusive jump: a total instant (`readInstant`) and a uuid, or a 400.
  "routes/messages.ts#atDate": "identifier",
  "routes/messages.ts#atId": "identifier",
  "routes/messages.ts#cursor": "identifier",
  "routes/messages.ts#folderId": "identifier",
  "routes/messages.ts#ids": "clamped",
  "routes/messages.ts#limit": "clamped",
  "routes/messages.ts#view": "closed-set",
  // History's month rail: an IANA name, shape-checked and capped at `READER_ZONE_MAX_CHARS`
  // (`parseReaderZone`), or a 400; a name this runtime cannot read counts in UTC.
  "routes/messages.ts#zone": "length-capped",
  "routes/notify.ts#cursor": "identifier",
  "routes/notify.ts#limit": "clamped",
  "routes/privacy.ts#cursor": "identifier",
  "routes/privacy.ts#limit": "clamped",
  "routes/privacy.ts#mid": "identifier",
  "routes/privacy.ts#u": "length-capped",
  // TWO different inputs under one key, and the read COUNT above is what keeps that visible: the
  // Screener list's cursor is a shared bare-id identifier, and the Junk window's is a base64 JSON
  // mailbox map with its own decoder and its own wire ceiling. Both are bounded; they are bounded
  // by different things, which is why this entry says so rather than picking one.
  "routes/screener.ts#cursor": "identifier",
  // A comma list of uuids, refused above `WHY_STAYED_IDS_MAX` and each validated as a uuid.
  "routes/screener.ts#ids": "clamped",
  "routes/screener.ts#limit": "clamped",
  "routes/screener.ts#mailboxId": "identifier",
  // The organize decision's window: an integer refused outside 1-365, and one of two scope words.
  "routes/screener.ts#dormancyDays": "clamped",
  "routes/screener.ts#scope": "closed-set",
  "routes/screener.ts#q": "length-capped",
  "routes/screener.ts#uid": "identifier",
  "routes/screener.ts#uidValidity": "identifier",
  // The trash window's five, each the Junk window's own treatment: the cursor is a
  // caller-supplied base64 JSON object with its own parser and its own wire ceiling, the term is
  // length-capped, and the three row coordinates are identifiers narrowed at the service (uuid,
  // uint32, a real epoch) so every present and future caller gets the same refusal.
  "routes/trash.ts#cursor": "identifier",
  "routes/trash.ts#q": "length-capped",
  "routes/trash.ts#mailboxId": "identifier",
  "routes/trash.ts#uid": "identifier",
  "routes/trash.ts#uidValidity": "identifier",
  /**
   * `?address=` IS `?sender=`'s TWIN and takes its disposition for its reasons.
   *
   * Both reach ONE predicate — `lower(m.from_address) = lower($1)` — where Postgres compares
   * lengths before bytes, so a long value is one length check per row rather than work
   * proportional to it. That is the difference from `q`, whose trigram and `ILIKE` predicates ARE
   * proportional and which is `length-capped` two lines down.
   *
   * And a ceiling here would be the failure mode `SearchService`'s own header sets out for
   * `sender`: `messages.from_address` is written from whatever `From:` the sending server
   * delivered, so `facets()` can legitimately return an address longer than any bound the
   * product then renders as a control — and clicking it would answer 400, a refusal aimed at a
   * value this API itself emitted. The remaining bound is the request-line limit of whatever
   * host sits in front, which is a different number on every deployment.
   */
  "routes/search.ts#address": "request-line",
  "routes/search.ts#dateFrom": "identifier",
  "routes/search.ts#dateTo": "identifier",
  "routes/search.ts#folder": "request-line",
  // Narrowed by `isAddressSearchDirection` against `ADDRESS_DIRECTIONS`, and an absent or
  // unknown value is a 400 rather than a default — see the route's own header for why there is
  // no direction this door can safely assume.
  "routes/search.ts#direction": "closed-set",
  "routes/search.ts#hasAttachments": "closed-set",
  "routes/search.ts#limit": "clamped",
  // Narrowed by `isSearchParts` against `SEARCH_PARTS`; an unknown value is a 400, never `both`.
  "routes/search.ts#parts": "closed-set",
  "routes/search.ts#q": "length-capped",
  // An opaque page cursor this service wrote, refused past `SEARCH_CURSOR_MAX_CHARS` and on any
  // shape it does not decode to.
  "routes/search.ts#cursor": "length-capped",
  "routes/search.ts#sender": "request-line",
  "routes/search.ts#sort": "closed-set",
  "routes/search.ts#unread": "closed-set",
  // ── The ADMIN console's four, invisible until the query extractor resolved local aliases ──
  // `accountQueryOf` reads them off `const params = new URL(req.url).searchParams`.
  "routes/admin.ts#search": "length-capped",
  "routes/admin.ts#filter": "closed-set",
  "routes/admin.ts#page": "clamped",
  "routes/admin.ts#pageSize": "clamped",
  // Cloud 0047's reads: a search term sliced at 320, an id list cut at ADMIN_BATCH_MAX, a
  // keyset cursor parsed as a uuid (or `<iso>,<uuid>`) and dropped otherwise, a clamped limit.
  "routes/admin.ts#q": "length-capped",
  "routes/admin.ts#ids": "clamped",
  "routes/admin.ts#cursor": "identifier",
  "routes/admin.ts#limit": "clamped",
  // The console's cross-account reads: a window's two instants, sliced to 64 characters and
  // parsed or dropped; the staff feed's actor and account (a uuid or dropped), its action and
  // outcome (closed sets, dropped otherwise) and `reads` (`=== "1"`, nothing else widens).
  "routes/admin.ts#from": "length-capped",
  "routes/admin.ts#to": "length-capped",
  "routes/admin.ts#actor": "identifier",
  "routes/admin.ts#account": "identifier",
  "routes/admin.ts#action": "closed-set",
  "routes/admin.ts#outcome": "closed-set",
  "routes/admin.ts#reads": "closed-set",
  // The credit drill-down's day key. `closed-set` in the sense this census means it: the value is
  // refused outright unless it matches `^\d{4}-\d{2}-\d{2}$` and parses, so the set of values
  // that can reach a query is the set of calendar days and nothing else. NOT "length-capped" — a
  // ten-character value that is not a date is refused rather than truncated, which matters
  // because the value is interpolated into a `::timestamptz` cast.
  // ── `routes/devices.ts`, same alias shape. The reads are `GET /auth/audit`'s, which lives in
  //    that file; `GET /devices` itself takes no query input.
  "routes/devices.ts#cursor": "identifier",
  "routes/devices.ts#limit": "clamped",
  // ── `GET /oauth/authorize`, same alias shape, and two of these were genuinely unbounded ───
  "routes/oauth.ts#response_type": "closed-set",
  "routes/oauth.ts#code_challenge_method": "closed-set",
  // Compared for EQUALITY against a registered client and its registered redirect list, so a
  // long value is one comparison and can match nothing.
  "routes/oauth.ts#client_id": "request-line",
  "routes/oauth.ts#redirect_uri": "request-line",
  // A SHA-256 challenge is exactly 43 base64url characters (RFC 7636 §4.2) — a shape check, and
  // therefore a bound. It is STORED on the authorization-code row.
  "routes/oauth.ts#code_challenge": "identifier",
  // ECHOED into the redirect's `Location` header, so an unbounded one is a caller-chosen header.
  "routes/oauth.ts#state": "length-capped",
  "routes/oauth.ts#scope": "request-line",
  // The ceremony handle the confirmation page carries back. Bounded at 512 characters in
  // `approveAuthorize`/`peekAuthorizeRequest` before `hashToken` runs over it, then matched by
  // equality against a stored hash — it reaches no `LIKE`, no ordering and no allocation.
  "routes/oauth.ts#request": "identifier",
  "routes/snippets.ts#cursor": "identifier",
  "routes/snippets.ts#limit": "clamped",
  "routes/sync.ts#cursor": "length-capped",
  "routes/sync.ts#limit": "clamped",
  // `=== "tail"` at the read is the whole comparison: one word opens the labeled tail, anything
  // else is the ordinary bootstrap walk. Never parsed, never reaches a query.
  "routes/sync.ts#phase": "closed-set",
  "routes/sync.ts#since": "length-capped",
  "routes/sync.ts#types": "closed-set",
  "routes/triage.ts#cursor": "identifier",
  "routes/triage.ts#limit": "clamped",
  "routes/triage.ts#state": "closed-set",
  "routes/workflows.ts#cursor": "identifier",
  "routes/workflows.ts#limit": "clamped",
  "routes/workflows.ts#status": "closed-set",
  "routes/workflows.ts#workflowId": "identifier",
};

describe("SECTION 2 — every query parameter this API reads has a stated bound", () => {
  it("finds no query parameter the census does not name, and counts every read", () => {
    /**
     * THE DOMAIN IS A LITERAL PARAMETER NAME, stated because it is narrower than "every read".
     *
     * `q(url, name)` in `routes/mailbox-oauth.ts` takes the name as a VARIABLE, so no literal
     * exists at the call site and no set keyed on one can hold it. Its routes are dispositioned
     * through {@link INPUT_VIA_HELPER} instead — which is what that list is for — and the reads
     * they make are named in section 1 rather than here.
     *
     * The domain that IS exact: every `searchParams.get("<literal>")`, including through a local
     * alias, in `packages/api/src`.
     */
    const found = new Map<string, number>();
    let total = 0;
    for (const { file, ast } of sourcesOf(API_SRC)) {
      /**
       * ── ALIASES COUNT, and missing them was a LIVE OMISSION, not a theoretical one ──────
       *
       * The first AST version matched only `<x>.searchParams.get("…")`, so
       * `const p = new URL(req.url).searchParams; p.get("client_id")` was invisible — and that is
       * how `routes/oauth.ts` and `routes/devices.ts` read every one of their parameters. Nine
       * real query parameters were outside a census that claimed to be exact over all of them.
       *
       * So the local bindings are collected first: any `const NAME = <…>.searchParams`, per file.
       * A binding passed to another function or stored on an object is still invisible, which is
       * the same one-level ceiling the reading-helper derivation has and is stated in the header.
       */
      const aliases = new Set<string>();
      for (const node of walk(ast)) {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) continue;
        const init = node.initializer;
        if (init && ts.isPropertyAccessExpression(init) && init.name.text === "searchParams") {
          aliases.add(node.name.text);
        }
      }

      for (const node of walk(ast)) {
        if (!ts.isCallExpression(node)) continue;
        const callee = node.expression;
        if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "get") continue;
        const target = callee.expression;
        const onSearchParams = ts.isPropertyAccessExpression(target)
          ? target.name.text === "searchParams"
          : ts.isIdentifier(target) && aliases.has(target.text);
        if (!onSearchParams) continue;
        const [arg] = node.arguments;
        if (!arg || !ts.isStringLiteral(arg)) continue;
        const k = `${rel(file)}#${arg.text}`;
        found.set(k, (found.get(k) ?? 0) + 1);
        total += 1;
      }
    }
    const declared = new Set(Object.keys(QUERY_PARAMS));
    const undeclared = [...found.keys()].filter((k) => !declared.has(k)).sort();
    const stale = [...declared].filter((k) => !found.has(k)).sort();

    // A NEW `?name=` reddens this with its file and its name, and the author has to say which
    // of the five it is. That is the whole mechanism.
    expect(undeclared, "query parameter(s) read with no bound declared").toEqual([]);
    expect(stale, "declared bound(s) for a query parameter nothing reads").toEqual([]);

    /**
     * THE COUNTS, for the same reason the `inArray` section carries them.
     *
     * `routes/screener.ts` reads `?cursor=` TWICE — once for the Screener list, whose value is
     * the shared `decodeListCursor` identifier, and once for the Junk window, whose value is a
     * caller-supplied base64 JSON OBJECT with its own decoder. Keyed by `file#name` alone those
     * two collapse into one entry, so the second reader could be added, removed or left unbounded
     * without moving this set at all — which is how the junk cursor stayed unbounded while the
     * census recorded its file and name as an `identifier`.
     */
    const drift = [...found.entries()]
      .filter(([k, n]) => (QUERY_PARAM_READS[k] ?? 1) !== n)
      .map(([k, n]) => `${k} — found ${n}, census says ${QUERY_PARAM_READS[k] ?? 1}`)
      .sort();
    expect(drift, "the number of reads moved without the census moving").toEqual([]);
    expect(total).toBeGreaterThan(55);
  });

  it("every `?limit=` in the table is CLAMPED, because that is the one this class started with", () => {
    const limits = Object.entries(QUERY_PARAMS).filter(([k]) => k.endsWith("#limit"));
    expect(limits.length).toBeGreaterThan(10);
    for (const [k, bound] of limits) {
      expect(bound, `${k}: a page limit reaches a query builder and must be clamped`).toBe("clamped");
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   SECTION 3 — SQL `IN` SINKS
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every `inArray(column, values)` in the API and service layers, keyed `<file> :: <values>`.
 *
 * This is the sink the finding named: *"puts the raw `fileIds` array into a SQL `IN` predicate
 * BEFORE the 200-part ceiling, so one request can exceed the driver's parameter limit"*. Postgres
 * refuses a statement past its bind-parameter ceiling, so an array whose length the
 * caller chooses is either bounded before it reaches here or it is a 500 the caller can trigger.
 *
 * `server-derived` means the array was built by a query THIS process ran, so its length is a
 * property of the account's data and of the limit on that query — never of a request body.
 */
type ArrayOrigin =
  /** A literal or a module constant: its length is in the source. */
  | "constant"
  /**
   * NOT AN ARRAY AT ALL — a SUBQUERY. The ids never leave Postgres, so there is no parameter
   * list, no materialization and no cardinality to bound: the set can be any size and the
   * statement is one statement.
   *
   * It is the strongest answer available to this class and worth naming separately rather than
   * folding into `bounded`, because it is also the REMEDIATION
   * prescribes for the erasure service's materialized message-id list. A census that could not
   * tell the two apart would call the fix and the defect by the same name.
   */
  | { subquery: string }
  /**
   * Built by a read THIS PROCESS performed, under a ceiling — the entry names it.
   *
   * "the server built it" is not the same as "it is bounded", and treating them as one was a real
   * false negative in this census: `account-deletion-service.ts`'s `messageIds` and
   * `folder-ops-service.ts`'s `subtree` are both built by a query with NO limit, over a table
   * whose size a sender or a repeating caller chooses. They passed as `server-derived` while
   * violating the very class this file exists for.
   */
  | { bounded: string }
  /**
   * Built by a read this process performed, over stored state with NO cardinality ceiling.
   *
   * **An admitted hole, not a clearance.** These are the members of the known
   * unbounded-state set: the array is server-built, so no request field bounds it, and the collection it
   * is built from grows without limit. Listing them here is what stops the census claiming they
   * are safe, and what makes a new one visible.
   */
  | { unbounded: string }
  /** Caller- or sender-chosen, and bounded before it gets here — the entry names the ceiling. */
  | { caller: string };

/**
 * The COUNT of call sites per key, beside the origin.
 *
 * A review round found the first version of this census not exact: it keyed a `Set` by file plus
 * a truncated value expression, so 58 real `inArray(` call sites collapsed into 35 keys —
 * `account-deletion-service.ts` alone has eight `inArray(x, userIds)` calls that became one
 * entry. **Adding an unsafe second `inArray(column, ids)` beside an already-classified one kept
 * the test green**, which is the one thing a census may not do.
 *
 * So each key carries how many times that exact `(file, values-expression)` pair occurs, and the
 * assertion compares the whole multiset. A new call site changes a count and reddens even when
 * its expression is one the file already uses.
 */
const IN_SINKS: Readonly<Record<string, { origin: ArrayOrigin; count: number }>> = {
  // ── CLOSED 2026-09-01. All four were `unbounded` and are now subqueries. ────────────────────
  // The messageIds entry was the critical one and its old disposition is worth keeping in view:
  // "EVERY message uuid the account holds, selected into memory and reused in three deletes. Past
  // a certain size the bind-parameter ceiling aborts the transaction, so self-serve erasure fails
  // exactly for the largest real accounts." It is an Art. 17 obligation, so the failure grew INTO
  // the product as the account grew, and no test could see it because every test account is
  // small. the own remediation for it was the subquery.
  "account-deletion-service.ts :: ownMailboxIds": {
    origin: { subquery: "a `select mailboxes.id where account_id = …` inside the predicate — no id is materialized, so the self-host's absent mailbox ceiling bounds nothing here" },
    // 3 → 4 for `junk_rescues` (mail 0115): the account's queued "not junk" commands, dropped in
    // the same sweep and through the same subquery, beside `folder_ops` and `mailbox_folders`.
    count: 4,
  },
  "account-deletion-service.ts :: ownMessageIds": {
    origin: { subquery: "a `select messages.id where account_id = …` inside the predicate — the ids never leave PostgreSQL, so an account of any size erases in one statement per table" },
    count: 3,
  },
  // The per-mailbox erasure, now in bounded STEPS (`packages/db/src/mailbox-erasure.ts`): every
  // per-row list is one step's page, read by a `limit` on the step's own select, so a mailbox of
  // any size is many bounded statements rather than one unbounded one.
  "mailbox-erasure.ts :: ids": {
    origin: { bounded: "one step's page — at most `ERASE_BATCH` (2 000) message or draft ids, read by a `limit` on the step's own select" },
    // 20 → 21 for `message_search` (mail 0125), deleted with the bodies on the same page; 21 → 22
    // for the drafts that FORWARD a deleted message, unanchored beside the replies.
    count: 22,
  },
  // The response cache at a mailbox erasure: the account's live keys (a 24-hour window) and the
  // ids their stored answers name, both walked in slices of `ID_CHUNK` (500).
  "waiting-requests.ts :: moveKeys": {
    origin: { bounded: "the dedup keys of the waiting list's own read, at most `WAITING_REQUESTS_READ_MAX` (200)" },
    count: 1,
  },
  "idempotency.ts :: chunk": {
    origin: { bounded: "one `ID_CHUNK` (500) slice of the ids the account's live stored responses name" },
    count: 3,
  },
  "idempotency.ts :: keys.slice(i, i + ID_CHUNK)": {
    origin: { bounded: "one `ID_CHUNK` (500) slice of the account's live idempotency keys" },
    count: 1,
  },
  "mailbox-erasure.ts :: touched": {
    origin: { bounded: "the distinct thread ids of one page of messages — at most `ERASE_BATCH`" },
    count: 1,
  },
  "mailbox-erasure.ts :: exclusive": {
    origin: { bounded: "the subset of one page's threads no other mailbox holds — at most `ERASE_BATCH`" },
    count: 4,
  },
  "mailbox-erasure.ts :: decisions": {
    origin: { subquery: "a `select routing_decisions.id where message_id in <the page>` inside the predicate" },
    count: 1,
  },
  "mailbox-erasure.ts :: records": {
    origin: { subquery: "a `select unsubscribe_records.id where message_id in <the page>` inside the predicate" },
    count: 1,
  },
  "account-deletion-service.ts :: ownUserIds": {
    origin: { subquery: "a `select users.id where account_id = …` inside the predicate — no id is materialized" },
    count: 9,
  },
  "account-deletion-service.ts :: ownEmails": {
    origin: { subquery: "`select users.email where account_id = …` — the signup funnel is keyed by address, and the addresses stay in PostgreSQL: no parameter is bound per user and none is materialized here" },
    count: 2,
  },
  // The throttle keys an address as a keyed hash the database cannot compute (the subkey is the
  // server's), so they are built here from the erased account's own users: seven per user.
  "account-deletion-service.ts :: exact": {
    origin: { bounded: "seven keys per user of the ONE account being erased, read in this transaction" },
    count: 1,
  },
  "admin-service.ts :: accountIds": { origin: { bounded: "one admin page, bounded by ADMIN_MAX_PAGE_SIZE" }, count: 2 },
  "admin-service.ts :: ids": { origin: { bounded: "one admin page, bounded by ADMIN_MAX_PAGE_SIZE" }, count: 1 },
  "admin-service.ts :: hits": { origin: { bounded: "a search's ranked matches, cut at ADMIN_SEARCH_LIMIT + 1 before the read" }, count: 1 },
  "admin-service.ts :: pageIds": { origin: { bounded: "one sync-roster page, bounded by ADMIN_SYNC_ROSTER_MAX" }, count: 3 },
  // The batch's and the account page's roster: the asked ids, cut at ADMIN_BATCH_MAX by the
  // route, uuid-checked and deduped; one id for the account page. Accounts, logins, mailboxes.
  "admin-service.ts :: [...ids]": { origin: { bounded: "the asked ids, cut at ADMIN_BATCH_MAX by the route and uuid-checked" }, count: 3 },
  "admin-service.ts :: unique": { origin: { bounded: "one admin page, bounded by ADMIN_MAX_PAGE_SIZE" }, count: 1 },
  // `loadLedger`'s STATEMENT predicate (cloud 0028) — `reason IN (…)` over
  // `credit_ledger_events_idx`'s partial predicate exactly. A CONSTANT in the strongest sense
  // this census has: not a caller's list, not a page of ids, but a literal tuple the type system
  // pins to `AdminLedgerReason`.
  "attachments-service.ts :: input.fileIds": {
    origin: { caller: "DOWNLOAD_ALL_MAX_PARTS and a uuid shape test, in resolveTargets before the predicate is built" },
    count: 1,
  },
  // Arrived from a neighbouring lane's logout-prune commit while this census was being written,
  // and the census made it be classified — which is the mechanism working across lanes rather
  // than only across time. It is the best shape there is: a SELECT inside the predicate, so no
  // id is ever materialized and the user's device count bounds nothing.
  "auth/auth-service.ts :: db.select({ id: devices.id }).from(devices) .where(and(eq(devices.accountId, txC": {
    origin: { subquery: "a `select devices.id where account_id = … and user_id = …` inside the predicate — no ids are materialized" },
    count: 1,
  },
  "auth/session-lifecycle.ts :: families.slice(i, i + 500)": { origin: { bounded: "sliced into 500-family chunks by the caller, explicitly" }, count: 1 },
  "auth/session-lifecycle.ts :: live.map((r) => r.familyId)": { origin: { bounded: "the live families of ONE session's chain, which the refresh ladder bounds" }, count: 1 },
  "auth/session-reaper.ts :: [...new Set(rows.map((c) => c.familyId))]": { origin: { bounded: "the reaper's own claim batch, `limit`ed by its pass size" }, count: 1 },
  "auth/session-reaper.ts :: ids": { origin: { bounded: "the reaper's own claim batch, `limit`ed by its pass size" }, count: 1 },
  // CHUNKED, and the disposition it used to carry — "bounded by SEED_SCAN_LIMIT messages scanned"
  // — was FALSE for the third time the same premise appeared: the review is built from that many
  // MESSAGES and one contributes every distinct recipient on it, so the candidate set can be far
  // larger and this `IN` could exceed the bind-parameter limit on a big mailbox.
  "consent-seed.ts :: part": { origin: { bounded: "WRITE_CHUNK (500) — the same chunking the seed's writes use, and the same parameter-limit arithmetic" }, count: 1 },
  // `resolve`'s two compare-and-swaps, the open-attempt read, and `remove`'s read of the attempts
  // still open (the one that tells a running send from an unverified one): the statuses a stuck
  // send and a stuck draft can be in. Both are frozen literal tuples; nothing chooses their length.
  "drafts-service.ts :: [...SEND_ON_RECORD_STATUSES]": { origin: "constant", count: 4 },
  "drafts-service.ts :: [...HELD_DRAFT_STATUSES]": { origin: "constant", count: 1 },
  // The away-answer stamp's outcome filter: the two ledger outcomes that mean the claim is kept
  // and no second reply will be offered. A literal pair; nothing chooses its length.
  "dto/materialize.ts :: [\"sent\", \"unverified\"]": { origin: "constant", count: 1 },
  "dto/materialize.ts :: [...new Set(ids)]": { origin: { bounded: "one page's ids — every caller passes a `clampLimit`ed page" }, count: 6 },
  "dto/materialize.ts :: firstIds": { origin: { bounded: "one page's ids — every caller passes a `clampLimit`ed page" }, count: 1 },
  // `materializeMessageChildren`, three predicates: the snapshot's own keyset page, so the array
  // is `clampPageLimit`ed (MAX_LIMIT) and never a request-body length.
  "dto/materialize.ts :: ids": { origin: { bounded: "one page's MESSAGE ids — the snapshot passes its keyset page, `clampPageLimit`ed" }, count: 3 },
  // 7 -> 1: the seven reads over `owned` became ONE joined statement (`materializeRows`), whose
  // page predicate is `[...scope.ids]` below; the one `owned` left is the thread read's. Re-DERIVED
  // by reading the sites, never merged.
  "dto/materialize.ts :: owned": { origin: { bounded: "one page's ids — every caller passes a `clampLimit`ed page" }, count: 1 },
  "dto/materialize.ts :: [...scope.ids]": { origin: { bounded: "one page's ids — every caller passes a `clampLimit`ed page" }, count: 1 },
  "dto/materialize.ts :: unique": { origin: { bounded: "one page's ids — every caller passes a `clampLimit`ed page" }, count: 1 },
  // The invoice heal pages the plane's listing at 100 a page for at most INVOICE_RECONCILE_MAX_PAGES
  // pages (or until its time budget), so `observed` — and the customer-id set drawn from it — is
  // bounded by that product before either reaches an `IN`.
  // The cost board walks accounts through `limit COST_ACCOUNT_SCAN_CAP + 1` and slices to the cap,
  // reporting the truncation rather than hiding it; `ids` is that walk's account ids.
  // CLOSED 2026-09-13 by a ceiling on the READ, not by the closure this row kept refusing. The
  // array is still folder PATHS under the delete target, still filtered in JS by
  // `userFolderExclusion` — moving that rule into SQL would change a user-facing number and is
  // still not this change. What moved is the read that BUILDS it: `packages/services/src/
  // read-bounds.ts` gives the inventory read `FOLDER_INVENTORY_MAX + 1` and refuses when the probe
  // row comes back, so the array reaching this `IN` is at most the ceiling and the old failure
  // (a 500 at the driver's parameter limit, on one confirm screen) is a stated refusal. The
  // ceiling restates the adapter's `IMAP_LIST_MAX_FOLDERS` — the mirror is filled from LIST — and
  // `packages/services/test/read-bounds.test.ts` asserts the two have not drifted, refuses at the
  // ceiling plus one, and answers AT the ceiling.
  "folder-ops-service.ts :: subtree": { origin: { bounded: "at most FOLDER_INVENTORY_MAX folder paths — the inventory read takes the ceiling plus a probe row and refuses when the probe arrives, so a subtree larger than one answer may cover is a stated refusal rather than a parameter-limit 500" }, count: 1 },
  // RE-DISPOSITIONED 2026-09-01 — it was a FALSE POSITIVE in the admitted set. `userFoldersByIds`
  // has exactly one caller, `sync-service.ts:539`, and its `folderIds` are filtered out of `rows`
  // — the change-log PAGE, `slice(0, limit)` of a `.limit(limit)` query. That is the same
  // provenance `dto/materialize.ts`'s prefetch arrays already carry, and it is the caller that
  // decides, so this is a bounded page and not an enumeration. Listing a safe site as an admitted
  // hole is not the harmless direction it looks: the admitted set is what the ledger row is
  // triaged from, and padding it hides which entries are real.
  "held-release-service.ts :: ids": { origin: { bounded: "this account's OWN held-release group keys, read out of `heldReleaseGroups` in the statement before and capped at `HELD_RELEASE_GROUPS_MAX` by that query's own `limit` — never a caller's list, even on the press, which filters the caller's ids down to these; the distinct total, the newest-entry reads and the sequence anchor's two reads take the same keys" }, count: 5 },
  // The held offer's sequence anchor reads the change rows since the "Not now": the two op lists
  // are literals, and the fold holds out a page's members by the page's own conversations.
  "held-release-service.ts :: [\"create\", \"move\"]": { origin: "constant", count: 1 },
  "held-release-service.ts :: addresses": { origin: { bounded: "this account's OWN contact-only sender lines, read out of `heldReleaseSenders` for the summary and capped at `HELD_RELEASE_GROUPS_MAX` by that query's own `limit` — never a caller's list" }, count: 1 },
  // The press's pre-check reads the named senders' unchecked rows in the contact line's bag.
  "held-release-service.ts :: [...senders]": { origin: { caller: "HELD_RELEASE_GROUPS_MAX addresses of at most 320 characters each, validated in releaseHeld before the read; a sender matches only rows of this account's own bag" }, count: 1 },
  "auto-filed-service.ts :: [...o.only]": { origin: { caller: "AUTO_FILED_PAGE_MAX and a 64-character id bound in undoAutoFiled before the read; an id matches only through the join to this account's own audit rows" }, count: 1 },
  "held-release-service.ts :: [\"create\", \"update\"]": { origin: "constant", count: 1 },
  "resurfaced-fold.ts :: threads": { origin: { bounded: "the distinct thread ids of ONE `new_for_you` page (a `clampLimit`ed page) or of Power Through's one current row" }, count: 1 },
  "folders.ts :: ids as string[]": { origin: { bounded: "one `/sync` change page's folder ids — the sole caller filters them out of a `slice(0, limit)`ed change-log page, the same provenance the materialize prefetches carry" }, count: 1 },
  "junk-window.ts :: targets": { origin: { bounded: "one junk window page, bounded by the window's own read caps" }, count: 1 },
  "junk-window.ts :: wanted": { origin: { bounded: "the message-ids of one junk page, so bounded by that page" }, count: 1 },
  // The standing-command attribution's three keys, all of them derived from ONE junk page: the
  // mailboxes it spans (the account's connected mailboxes with a junk folder), and the distinct
  // epochs and UIDs of its rows. The page is capped by `FOLDER_PAGE_MAX` per mailbox and the
  // merged answer by `FOLDER_PAGE_MAX` overall, so each of the three is bounded by that answer —
  // never a caller's list, and never the mailbox's whole rescue queue, which a refused row can sit
  // in indefinitely. That last point is why the predicate names the page's keys at all.
  "junk-window.ts :: boxIds": { origin: { bounded: "the mailboxes of one junk page, so bounded by that page" }, count: 1 },
  "junk-window.ts :: epochs": { origin: { bounded: "the distinct UIDVALIDITYs of one junk page, so bounded by that page" }, count: 1 },
  "junk-window.ts :: uids": { origin: { bounded: "the distinct UIDs of one junk page, so bounded by that page" }, count: 1 },
  "trash-window.ts :: wanted": { origin: { bounded: "the message-ids of one trash-window page, so bounded by that page's own read cap" }, count: 1 },
  // CLOSED 2026-09-13 by a DECLARED sanity ceiling on the READ, and the declaration is the honest
  // part. The call site is `requestPull`'s re-stamp, whose ids come from the `select … for update`
  // two lines above it, so the array is every CONNECTED mailbox of one account and the self-host
  // sets no ceiling on that. The read now takes `ACCOUNT_MAILBOXES_MAX_READ + 1` and REFUSES BY
  // NAME when the probe row comes back — never a truncation, because this answer has to cover
  // every connected mailbox and a silent prefix would be the same defect wearing a ceiling's name.
  // The `IN` stays, for the reason this row always gave: dropping it and re-deriving the
  // account+status predicate in the UPDATE is not equivalent under concurrency — `for update` does
  // not lock against INSERTs, so a mailbox connected between the two statements would be stamped
  // without being reported.
  //
  // THE READING IS OWED and the constant says so: what must be measured is the largest real
  // per-account mailbox count and whether a cap exists at all (MANUAL-STEPS item 33). Until then
  // the number is set the way `IMAP_LIST_MAX_FOLDERS` is — far above any honest account, so it
  // catches a runaway without pretending to be a product limit, and each element here costs a
  // stored credential and a mail server that answered.
  "mailbox-service.ts :: mine.map((m) => m.id)": { origin: { bounded: "at most ACCOUNT_MAILBOXES_MAX_READ connected mailboxes — the `for update` read takes the ceiling plus a probe row and refuses by name when the probe arrives, so the parameter list is bounded while the locking semantic is kept; a declared sanity ceiling whose reading is owed (MANUAL-STEPS 33)" }, count: 1 },
  "message-service.ts :: ids": {
    origin: { caller: "BODIES_IDS_MAX / MARK_SEEN_MAX_IDS, each with a uuid shape test before the query" },
    // Three: the bodies read, the batch mark-read's ownership read and the resurface spend; the
    // batch's UPDATE takes `live`, below.
    count: 3,
  },
  // The same checked list less the ids whose read state was decided after the press (mail 0145):
  // a subset of `ids`, so MARK_SEEN_MAX_IDS bounds it too.
  "message-service.ts :: live": { origin: { caller: "a subset of the checked `ids` — MARK_SEEN_MAX_IDS" }, count: 1 },
  // Arrived with the two-query byte-aware selection, and it is a
  // BOUND being added rather than a new hole: `getBodies` used to select whole body values for
  // the entire candidate window and spend `BODIES_BYTE_BUDGET` afterwards, over rows the driver
  // had already transferred. Pass 1 now projects `octet_length` only, and this `IN` names the
  // prefix that fits — so the array's length is the PAGE ceiling and its total BYTES are the
  // budget plus one row. Both passes carry `eq(messages.accountId, …)`: `message_bodies` has no
  // `account_id`, so that predicate is the authorization and it is not inherited from pass 1.
  // One Trash page's restore targets in one read: the page's distinct mailboxes and origin
  // folders, each at most the page's rows, or the one message a restore asks about.
  // The open read's stamp: the rows of the batch's own checked `ids` that were unread.
  "message-service.ts :: wasUnread": { origin: { bounded: "a subset of the batch's checked ids — at most MARK_SEEN_MAX_IDS, the owned read's rows that were unread" }, count: 1 },
  "message-service.ts :: trashMailboxIds": { origin: { bounded: "the distinct mailboxes of one listTrash page — at most MAX_PAGE_LIMIT rows (clampLimit), or the one message restore reads" }, count: 1 },
  "message-service.ts :: trashFolders": { origin: { bounded: "the distinct origin folders of the same page — at most MAX_PAGE_LIMIT rows (clampLimit), or the one message restore reads" }, count: 1 },
  "message-service.ts :: underBudget": {
    origin: { bounded: "the prefix of one candidate window that fits BODIES_BYTE_BUDGET — at most BODIES_MAX_LIMIT (keyset mode) or BODIES_IDS_MAX (ids mode) elements, and at most the budget plus one row of bytes" },
    count: 2,
  },
  /* THE PASS'S MAILBOX NARROWING — one array shape, three call sites, the same origin.
   *
   * `mailboxIds` is supplied by the HOST that runs the pass, never by a request: the sidecar's
   * drain passes exactly one id (its own runtime's mailbox), and the hosted and self-hosted clocks
   * pass none at all. There is no wire between a caller and this array — both routes that reach
   * these passes take no body, no query and no path parameter — so its length is bounded by how
   * many mailboxes one INSTALL holds.
   *
   * THREE since the end date switches a responder off (`expireEndedResponders`): the sweep is
   * narrowed by the same list as the probe, because turning somebody's responder off is a product
   * state change and a drain that named its own mailbox must not make it for another account.
   *
   * `[]` is deliberately NOT collapsed into "absent" at any site (it means "claim nothing"), so
   * no predicate is ever built from an empty array. */
  "away-responder-pass.ts :: [...mailboxIds]": {
    origin: { bounded: "the host's own mailbox list — one id from the sidecar drain, absent on both clocks; never caller-supplied" },
    count: 3,
  },
  /* ── THE BOUNCE SWEEP'S TWO PREDICATES (mail 0096) ──────────────────────────────────────
   *
   * `["sent", "unverified"]` is the ledger outcomes a reply could have BOUNCED from — the two
   * that dialled. A literal pair; nothing chooses its length.
   *
   * `[...dead]` is the correspondents a delivery report came back for on ONE account in ONE
   * run. Its length is bounded by `AWAY_BOUNCE_SCAN` (50), which is the `limit` on the read that
   * produces it, and it is a Set so repeats collapse — a mailbox holding many bounces for
   * one sender yields one member. No request reaches this: both routes that run the pass take no
   * body, no query and no path parameter, and the desktop drain calls it directly. The update is
   * skipped entirely when the set is empty, so the predicate is never built from `[]`. */
  "away-responder-pass.ts :: [\"sent\", \"unverified\"]": { origin: "constant", count: 1 },
  // The release's re-projection: the outcomes a reservation's upsert wrote the sender state for.
  "away-responder-pass.ts :: [\"sent\", \"unverified\", \"pending\"]": { origin: "constant", count: 1 },
  "away-responder-pass.ts :: [...dead]": {
    origin: { bounded: "the bounces one account produced in one run, capped by `AWAY_BOUNCE_SCAN` (50) and de-duplicated by a Set; never caller-supplied" },
    count: 1,
  },
  /* THE ROTATION STAMP'S PREDICATE (mail 0114) — the accounts ONE invocation walked, which is a
     prefix of a page the probe drew with `.limit(AWAY_ACCOUNTS_PER_RUN)`, so its length is 50 at
     the very most and usually the handful the send budget reached. Read off the pass's own page
     and never off a request: both routes that run the pass take no body, no query and no path
     parameter, and the desktop drain calls it directly. The update returns before building a
     predicate when the walk touched nobody, so `IN ()` is unreachable. */
  "away-responder-pass.ts :: [...accountIds]": {
    origin: { bounded: "the accounts one invocation walked, a prefix of the probe's own `AWAY_ACCOUNTS_PER_RUN` (50) page; never caller-supplied" },
    count: 1,
  },
  "schedule-send-pass.ts :: [\"draft\", \"sending\"]": { origin: "constant", count: 1 },
  "schedule-send-pass.ts :: due.map((r) => r.id)": { origin: { bounded: "the pass's own `limit`ed due batch" }, count: 1 },
  /* WHICH MAILBOXES THIS PASS MAY CLAIM FOR — the standalone door's multi-mailbox filter. Bounded
     by the install's OWN ROSTER: the only caller is the local engine, which passes the mailboxes it
     is currently running (`status <> 'disabled'` for one account on one machine), it is absent on
     both cron clocks, and the pass returns early on an empty list rather than issuing an `IN ()`.
     Not caller-supplied in the sense this census is about — no request body reaches it. */
  "schedule-send-pass.ts :: [...mailboxIds]": { origin: { bounded: "the install's own attached roster, one account on one machine; one id on the sidecar drain, absent on both cron clocks, never caller-supplied" }, count: 1 },
  /* ── THE READER'S BULK-MOVE REFUSAL, CHUNKED — AND THE HOLE IT BRIEFLY OPENED ──────────────
   *
   * `refuseBulkMoveOnReader` asks which DISTINCT mailboxes a bulk move would touch, so that an
   * operation reaching a mailbox this install only READS is refused whole before anything is
   * written. It arrived materializing its callers' whole id array into ONE `IN` predicate, and
   * neither caller's array carries a ceiling:
   *
   *   `workflows-service.undoRun`      one id per recorded step of the run, from a
   *                                    `select … from audit_log where runId = …` with no `limit`;
   *   `hey-migration.rerouteToMatchRules`  one id per matching message in the whole account, from
   *                                    a `select … from messages` with no `limit`. This is the
   *                                    FORWARD verb's opt-in re-route, which runs after the rules
   *                                    transaction commits — NOT `undoMigration`, which this entry
   *                                    named when it was first written and which moves no mail.
   *
   * That is the largest of the two by a wide margin, and it made the ceiling deterministic rather
   * than theoretical: an account whose migrated senders match enough messages was refused
   * at Bind, on a verb the person had just opted into, with the rules already committed.
   *
   * `bounded` NOW BECAUSE THE PREDICATE IS SLICED, not because the callers learned a limit — they
   * have not. The question is "which distinct mailboxes do these ids sit on", which is answered
   * exactly by asking it of each 500-id slice and taking the union, so the chunk is a real bound on
   * the statement rather than a bound asserted about the data. The account fence is inside every
   * chunk's `where`.
   *
   * Not caller-supplied in the sense the header separates out — no request field chooses the
   * length. `messageIds.length === 0` returns before the predicate is built, so no `IN ()`. */
  "reader-request.ts :: chunk": {
    origin: { bounded: "READ_CHUNK (500) — an explicit slice of the caller's id array, the same arithmetic and the same number as consent-seed's WRITE_CHUNK" },
    count: 1,
  },
  "screener-service.ts :: messageIds": { origin: { bounded: "one screener page's ids" }, count: 1 },
  // The automatic request's admitted-set read: the representatives `rep` already holds.
  "screener-service.ts :: rows.map((r) => r.messageId)": {
    origin: { bounded: "one representative per named sender — MAX_SUGGEST_SENDERS, refused in parseSenderSet before any query" },
    count: 1,
  },
  "screener-service.ts :: senders": {
    origin: { caller: "MAX_SUGGEST_SENDERS, refused in parseSenderSet before the query" },
    count: 1,
  },
  "inline-cid-backfill.ts :: ids": { origin: { bounded: "one page's message ids, at most ATTACHMENT_FLAG_BATCH" }, count: 2 },
  "inline-cid-backfill.ts :: accountIds": { origin: { bounded: "the distinct accounts of one page, at most ATTACHMENT_FLAG_BATCH" }, count: 1 },
  "inline-cid-backfill.ts :: flip.slice(i, i + chunk)": { origin: { bounded: "one `FLIP_CHUNK` (500) slice of one message's referenced parts" }, count: 1 },
  "sensitive-rescreen.ts :: movedIds as string[]": { origin: { bounded: "one rescreen page, bounded by the pass's page size" }, count: 1 },
  "sync-service.ts :: opts.types": {
    origin: { caller: "VALID_TYPES, a nine-member closed set the route filters the CSV against" },
    count: 1,
  },
  "sync-service.ts :: repliedTo": {
    origin: { subquery: "a `select drafts.in_reply_to_message_id where account_id = …` inside the snapshot tail's predicate" },
    count: 1,
  },
  "sync-service.ts :: forwarded": {
    origin: { subquery: "a `select drafts.forward_of_message_id where account_id = …` inside the snapshot tail's predicate" },
    count: 1,
  },
  "thread-service.ts :: threadIds": {
    origin: { caller: "THREAD_MERGE_MAX_IDS and a uuid shape test, before the transaction opens" },
    count: 1,
  },
  // ONE again, and the drop is the fix for the drain's timeout: the two reads that each carried
  // this predicate — `sweepScreenedOut`'s per-account candidates and `drainScreenedOut`'s
  // account census — now join ONE page-fenced subquery that holds it, so there is a single place
  // the closed `Destination` constant reaches SQL. Nothing a caller supplies reaches it.
  "unsubscribe-service.ts :: REJECT_DESTINATIONS as string[]": { origin: "constant", count: 1 },
  // The 0.22 rename: the News pile is asked for under BOTH spellings, because a rule stored
  // before it still points at the legacy folder. Two module constants, so the predicate is
  // two elements wide whatever the account holds.
  "message-service.ts :: [NEWS_FOLDER, LEGACY_NEWS_FOLDER]": { origin: "constant", count: 1 },
  // The four triage states the Ohbox holds out of "New for you", inside `newForYouFilters`'
  // correlated NOT EXISTS. A module constant of the closed `TriageState` union, four elements
  // wide whatever the account holds and whatever a caller sends: the predicate is about the
  // SCREEN's membership rule, and no request body reaches it.
  "message-service.ts :: NOT_NEW_FOR_YOU as string[]": { origin: "constant", count: 1 },
};

describe("SECTION 3 — every SQL `IN` predicate says where its array came from", () => {
  /**
   * Extract every `inArray(column, values)` by BALANCED PARENTHESES, not by a regex over commas.
   *
   * The first version matched `/inArray\(\s*([^,]+),\s*([\s\S]+?)\s*\)/`, which cuts at the first
   * comma anywhere — so a first argument containing one (`inArray(sql`${a}->>'x'`, ids)`) had part
   * of its COLUMN expression recorded as the values. That is a census keyed on the wrong text.
   */
  /**
   * Every `inArray(column, values)` call and the SOURCE TEXT of its second argument, from the AST.
   *
   * The balanced-parenthesis version this replaces was defeated by an ordinary literal:
   * `inArray(normalize(")"), callerIds)` closed the call at the `")"` before the comma, so the
   * extractor returned nothing and a live caller-controlled parameter list was never
   * dispositioned. A parser has no such problem — it knows the `)` is inside a string.
   *
   * Aliases ARE resolved — see the `names` set below — so `import { inArray as within }` is
   * matched too. What is still outside the domain is a call reached through a VALUE rather than a
   * name (a function stored on an object and called off it), which would need a type-checker
   * program rather than a parse.
   */
  const inArrayValues = (ast: ts.SourceFile): string[] => {
    /**
     * The local names `inArray` is bound to in this file, aliases included.
     *
     * `import { inArray as within } from "drizzle-orm"` then `within(column, callerIds)` is
     * valid, behaves identically, and a name match would not see it — the caveat the header used
     * to carry. Import specifiers carry `propertyName` for exactly this, so the alias is
     * resolvable from the parse and the caveat can go.
     *
     * Nothing in THIS file exercises that arm — no source under review uses an alias today. It is
     * proven by mutation instead: planting `import { inArray as within }` with a call reddens
     * section 3. Recorded because a branch no assertion reaches is a branch nobody has watched.
     */
    const names = new Set<string>(["inArray"]);
    for (const node of walk(ast)) {
      if (!ts.isImportSpecifier(node)) continue;
      if (node.propertyName?.text === "inArray") names.add(node.name.text);
    }

    const out: string[] = [];
    for (const node of walk(ast)) {
      if (!ts.isCallExpression(node)) continue;
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name === null || !names.has(name)) continue;
      const values = node.arguments[1];
      if (!values) continue;
      out.push(values.getText(ast).replace(/\s+/g, " ").slice(0, 80));
    }
    return out;
  };

  it("finds no `inArray` the census does not name, and counts every call site", () => {
    const found = new Map<string, number>();
    let total = 0;
    const moved = MOVED_FROM_SERVICES.map((file) => {
      const src = readFileSync(file, "utf8");
      return { file, src, ast: parse(file, src) };
    });
    for (const { file, ast } of [...sourcesOf(API_SRC), ...sourcesOf(SERVICES_SRC), ...moved]) {
      for (const values of inArrayValues(ast)) {
        const k = `${rel(file)} :: ${values}`;
        found.set(k, (found.get(k) ?? 0) + 1);
        total += 1;
      }
    }

    const declared = new Set(Object.keys(IN_SINKS));
    const undeclared = [...found.keys()].filter((k) => !declared.has(k)).sort();
    const stale = [...declared].filter((k) => !found.has(k)).sort();
    expect(undeclared, "SQL `IN` predicate(s) whose array origin is not declared").toEqual([]);
    expect(stale, "declared origin(s) for an `inArray` that no longer exists").toEqual([]);

    // THE COUNTS, and this is the half a `Set` could not do. Eight of the deletion service's
    // calls share the expression `userIds`; keyed only by that text, a NINTH — with any array at
    // all — joined them silently. Comparing the multiset makes a new call site red even when its
    // expression is one the file already uses.
    const drift = [...found.entries()]
      .filter(([k, n]) => IN_SINKS[k]?.count !== n)
      .map(([k, n]) => `${k} — found ${n}, census says ${IN_SINKS[k]?.count ?? 0}`)
      .sort();
    expect(drift, "the number of call sites moved without the census moving").toEqual([]);

    const declaredTotal = Object.values(IN_SINKS).reduce((n, e) => n + e.count, 0);
    expect(total, "every call site is accounted for").toBe(declaredTotal);
    expect(total).toBeGreaterThan(50);
  });

  it("every non-constant array names its ceiling, or names itself as having none", () => {
    /**
     * "the server built it" is not a bound, and this census said it was.
     *
     * `server-derived` was one bucket and it silently covered two very different things: an array
     * built from a `clampLimit`ed page, and an array built from EVERY row a table holds. The
     * second is the erasure service's whole message-id list,
     * the folder subtree — and both passed this census while violating the class it exists for.
     * So the two are separate origins, each with prose, and neither may be empty.
     */
    let named = 0;
    let admitted = 0;
    for (const [k, entry] of Object.entries(IN_SINKS)) {
      const o = entry.origin;
      if (o === "constant") continue;
      const why = "caller" in o ? o.caller
        : "bounded" in o ? o.bounded
          : "subquery" in o ? o.subquery
            : o.unbounded;
      expect(why.length, `${k}: name the ceiling (or the lack of one), not "it is bounded"`)
        .toBeGreaterThan(20);
      if ("unbounded" in o) admitted += 1; else named += 1;
    }
    expect(named).toBeGreaterThan(15);
    for (const [k, entry] of Object.entries(IN_SINKS)) {
      const o = entry.origin;
      if (typeof o === "object" && "unbounded" in o) {
        expect(o.unbounded, `${k}: an admitted hole must cite the row that tracks it`)
          .toContain("FR-" + "ACCUMULATED-STATE-UNBOUNDED");
      }
    }

    /**
     * THE ADMITTED SET, ENUMERATED — which is stronger than the floor it replaces.
     *
     * This used to be `expect(admitted).toBeGreaterThan(3)`, on the reasoning that "an unbounded
     * derivation the census could not name would be a claim nobody checked". The reasoning is
     * right and a FLOOR is the wrong instrument for it: it says nothing about WHICH holes are
     * open, so closing one and opening another moves nothing, and it goes red for the good news
     * (a hole closed) as loudly as for the bad. One fix closed four
     * account-deletion entries into subqueries on 2026-09-01 and the floor was the only thing
     * that failed.
     *
     * An exact set makes both directions visible in the diff: closing one deletes a line here,
     * opening one adds a line here, and neither can happen without an author saying so.
     */
    const openHoles = Object.entries(IN_SINKS)
      .filter(([, e]) => typeof e.origin === "object" && "unbounded" in e.origin)
      .map(([k]) => k).sort();
    /*
     * EMPTY, and an empty exact set is still the stronger instrument. The floor this replaced
     * (`admitted > 3`) could not have reached this state at all: it went red for a hole being
     * CLOSED. Both members are bounded now — one by a measured ceiling, one by a declared one
     * whose reading is owed on its own constant — and a new unbounded derivation adds a line here.
     */
    expect(openHoles, "the admitted unbounded holes, exactly").toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   SECTION 4 — THE REQUEST DOOR
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("SECTION 4 — the door's large-body exemption is derived, not asserted", () => {
  it("LARGE_BODY_ROUTES is exactly the routes whose handler decodes inline bytes", () => {
    const decodesBytes = apiRoutes
      .filter((r) => /contentBase64|decodeSendAttachments/.test(String(r.handler)))
      .map(key)
      .sort();
    // In BOTH directions. A new route that takes base64 attachment bytes and is not listed would
    // be refused at `JSON_BODY_MAX_BYTES` with no explanation; a listed route that stopped
    // taking them would keep an exemption it no longer needs, which is the quieter of the two
    // failures and the one a hand-kept list produces.
    expect([...LARGE_BODY_ROUTES].sort()).toEqual(decodesBytes);
    expect(decodesBytes.length).toBeGreaterThan(0);
  });

  it("clears the WORST LEGAL BODY the route table declares, product by product", () => {
    /**
     * ── THE DOOR AND THE FIELD CAPS ARE ONE SYSTEM, AND THIS IS WHERE THEY MEET ────────────
     *
     * A door ceiling BELOW the largest body the routes accept refuses a request the service was
     * going to serve — a 413 that names the door's limit while the caller was inside every limit
     * the route publishes. It is the same class of defect one layer out: a bound applied where it
     * cannot see what it is bounding.
     *
     * The three products below are recomputed FROM THE CONSTANTS rather than restated, so a
     * future bump to any of them — a larger signature cap, a longer seed review, more recipients
     * — fails here instead of turning into a 413 somebody has to reproduce. Each is the worst
     * case, not the typical one: a maximal addr-spec, four bytes per UTF-8 character.
     */
      const JSON_STRING_OVERHEAD = 4;     // two quotes, a comma, and slack
    const UUID_KEY_JSON = 41;           // `"<36-char uuid>":` plus a comma
    /**
     * SIX bytes per character, not four, and the correction is the point.
     *
     * The first version of this used 4 — UTF-8's own maximum — and a review round pointed out
     * that `JSON.stringify` escapes a control character as `\u00xx`, which is SIX bytes for one
     * character that every validator here accepts. A formula that undercounts the worst legal
     * body certifies a compatibility the door does not have, which is worse than not checking.
     */
    const JSON_MAX_BYTES_PER_CHAR = 6;

    /**
     * `POST /consent/seed` is deliberately absent, so a longer SEED review does not fail this
     * test — only a larger signature, recipient, subject or html cap does. Its ceiling is a coarse
     * COUNT that exists to
     * stop an unbounded fold; the bytes that count weighs are the door's question, and a
     * confirmation of the maximal count of maximal addr-specs is megabytes and is correctly refused BY the door,
     * in bytes. Including it here would assert that two bounds on different quantities must be
     * mutually consistent, which is not true and would force one of them to be wrong.
     */
    const worst: Array<[string, number]> = [
      // PATCH /consent/settings — a signature per mailbox, and the COUNT multiplies the SIZE.
      //
      // ── MAIL 0098 ADDED A SECOND MAP AND THIS PRODUCT DID NOT MOVE, DELIBERATELY ─────────
      //
      // `signaturesHtml` carries the same values in the same shape at the same character cap.
      // Capped independently it would have DOUBLED this term, which still clears the
      // 4 MiB door but makes `POST /drafts` no longer the largest legal body — and
      // `body-ceiling.ts` states in words that it is. So the route counts the DISTINCT MAILBOXES
      // across both maps against ONE `SETTINGS_MAX_MAILBOX_ENTRIES`, which is the honest unit
      // anyway (a mailbox is one write inside one transaction whichever map names it) and leaves
      // this arithmetic exactly as it was. `consent-routes.test.ts` drives the shared ceiling
      // with 13 + 13 entries and watches the 413.
      ["PATCH /consent/settings",
        SETTINGS_MAX_MAILBOX_ENTRIES
          * (MAILBOX_SIGNATURE_MAX_CHARS * JSON_MAX_BYTES_PER_CHAR + UUID_KEY_JSON)],
      // POST /drafts — the html cap plus the request's recipient TOTAL at its entry ceilings. The
      // ENTRY ceilings are as load-bearing as the count: without them the recipient half of this
      // body was unbounded strings and no product could be computed at all, which the first
      // version of this formula quietly assumed away.
      //
      // ── THE FACTOR IS ONE, NOT THREE, AND THAT IS WHY THE SERVICE CHANGED ────────────────
      //
      // It was `3 * DRAFT_MAX_RECIPIENTS`, for three independently-bounded fields. When
      // DRAFT_MAX_RECIPIENTS became SEND_MAX_RECIPIENTS (so Reply All cannot compose a draft the
      // service refuses), this line computed a figure past the door and failed — on the first change made
      // after the census was written, which is the whole reason it recomputes rather than
      // asserts. No door both admits that many maximal addresses and is worth having, so
      // `DraftsService.boundRecipientTotal` now bounds the REQUEST's total across to/cc/bcc,
      // the same way `SendService.reserve` counts a message's. The factor here follows that.
      ["POST /drafts",
        // The HTML cap is in BYTES and every one of them may be a control character, so it too is
        // multiplied — a review round found the six-byte factor applied to the recipient strings
        // and not here, which is a formula that undercounts precisely where the body is largest.
        //
        // A MAXIMUM, NOT A SUM, AND THAT IS A PROPERTY OF THE ROUTE: `DraftsService.richBody`
        // answers 400 to a request carrying `body` ALONGSIDE `html` (the plain half is derived on
        // the server, never supplied beside the markup), so no legal body holds both at once. The
        // two ceilings are the same number today for the reason `0037_draft_html.sql` gives, and
        // writing the max rather than the literal keeps this formula honest if one of them moves.
        Math.max(DRAFT_HTML_CAP_BYTES, DRAFT_BODY_MAX_BYTES) * JSON_MAX_BYTES_PER_CHAR
          + DRAFT_SUBJECT_MAX_CHARS * JSON_MAX_BYTES_PER_CHAR
          + DRAFT_MAX_RECIPIENTS
            * ((RECIPIENT_ADDRESS_MAX_CHARS + RECIPIENT_NAME_MAX_CHARS) * JSON_MAX_BYTES_PER_CHAR
              + JSON_STRING_OVERHEAD * 4)],
      // PATCH /messages — the largest COUNT-shaped body; small, and included so the comparison
      // is over the whole family rather than the two that happen to be big today.
      ["PATCH /messages", MARK_SEEN_MAX_IDS * (36 + JSON_STRING_OVERHEAD)],
    ];

    for (const [route, bytes] of worst) {
      expect(bytes, `${route}: its worst legal body (${bytes}) must fit through the door`)
        .toBeLessThan(JSON_BODY_MAX_BYTES);
    }

    // And the door must still be small enough to matter: the self-host adapter's cap was 50 MiB,
    // applied to every request including the ones that name no route at all.
    expect(JSON_BODY_MAX_BYTES).toBeLessThan(50 * 1024 * 1024 / 10);
    // …with headroom that is real rather than incidental — a clear margin over the largest.
    const largest = Math.max(...worst.map(([, n]) => n));
    expect(JSON_BODY_MAX_BYTES).toBeGreaterThan(largest * 1.15);
    // The single-field caps are inside it too, which is the weaker claim this used to make alone.
    expect(JSON_BODY_MAX_BYTES).toBeGreaterThan(DRAFT_HTML_CAP_BYTES);
    expect(JSON_BODY_MAX_BYTES).toBeGreaterThan(DRAFT_BODY_MAX_BYTES);
    expect(JSON_BODY_MAX_BYTES).toBeGreaterThan(OHBOX_BAR_MAX_BYTES);

    /**
     * AND THE DOOR MUST CLEAR THE SMALLEST DOOR IN THE FLEET, WHICH IS NOT OURS.
     *
     * The managed host is capped by the platform at `HOSTED_LARGE_BODY_MAX_BYTES` whatever this
     * constant says. A JSON ceiling above it would certify a compatibility that deployment does
     * not have: the request dies at the platform edge with an error neither host wrote, and this
     * door never sees it — a 413 from somebody else's infrastructure, in place of the honest one
     * naming our own limit. So the ordering is asserted rather than assumed, because the obvious
     * fix for a failing worst-body product is to raise the door, and past this line that fix is
     * silently wrong.
     */
    // Read from the hosted adapter's SOURCE rather than imported: `packages/api` does not depend
    // on `apps/api-vercel` and must not start to, and a number copied here would be a second
    // place for the platform's ceiling to be wrong. If the constant is ever renamed this fails
    // loudly, which is the correct outcome for an assertion about somebody else's limit.
    const hostedSrc = readFileSync(
      resolve(__dirname, "../../../apps/api-vercel/src/prefix.ts"), "utf8",
    );
    const m = /export const HOSTED_LARGE_BODY_MAX_BYTES = ([0-9_]+);/.exec(hostedSrc);
    expect(m, "apps/api-vercel/src/prefix.ts must declare HOSTED_LARGE_BODY_MAX_BYTES").not.toBeNull();
    const platform = Number(m![1]!.replace(/_/g, ""));
    expect(largest).toBeLessThan(platform);
    expect(JSON_BODY_MAX_BYTES).toBeLessThanOrEqual(platform);
  });

  it("SETTINGS_MAX_MAILBOX_ENTRIES is a usable batch size, bounded above by the door product", () => {
    /**
     * ── WHY THIS DOES NOT COMPARE AGAINST THE PLAN CEILING, THOUGH IT WANTS TO ──────────────
     *
     * The number was briefly the hosted plan ceiling exactly (`PLAN_LIMITS.pro.mailboxes` +
     * `MAX_ADDON_QUANTITY` = 20), which is the wrong shape for a route the SELF-HOST table mounts
     * — there is no mailbox count limit there at all, so an operator with 21 mailboxes would have
     * been refused by somebody else's price list. It is now a batch size instead, and the obvious
     * assertion is that it CLEARS that ceiling.
     *
     * That assertion is not made here, and the reason is a guard worth respecting rather than
     * widening: the billing-boundaries census named every file that names
     * `PLAN_LIMITS`, on the rule that such a file is *"either the policy, a granter, or a
     * display"* and that anything else is a coincidence. A bounds census is none of those. So the
     * relationship is stated in `routes/consent.ts`'s own docstring, where a reader of the number
     * will find it, and what is CHECKED here is the pair of properties that do not need to cross
     * that boundary: it is a real batch, and the door product above is what caps it.
     */
    expect(SETTINGS_MAX_MAILBOX_ENTRIES).toBeGreaterThan(1);
    expect(Number.isInteger(SETTINGS_MAX_MAILBOX_ENTRIES)).toBe(true);
  });
});

/**
 * SECTION 5 — the door's hosted half may not drag the route table into another app's build.
 *
 * ── THE FAILURE THIS EXISTS FOR, MEASURED ON A REAL DEPLOY ───────────────────────────────
 *
 * `apps/api-vercel/src/prefix.ts` grew `import { apiRoutes, bodyCeilingFor, readBodyWithin }
 * from "@trafficflow/api"` when the body door landed. `apps/webapp/test/api-rewrite.test.ts`
 * imports `API_PREFIX` from that module, and the webapp TYPECHECKS ITS TESTS, so the import
 * joined the WEBAPP's TypeScript program. `@trafficflow/api` is not a webapp dependency:
 * `apps/webapp/node_modules/@trafficflow` holds `core` and nothing else. The production
 * `next build` on the builder failed with *"Cannot find module '@trafficflow/api'"*.
 *
 * ── AND NO LOCAL COMMAND CATCHES IT, WHICH IS WHY THIS IS A TEST AND NOT A COMMENT ───────
 *
 * `pnpm -F @ohmail/webapp build` is what this repository prescribes for precisely this class,
 * and it was GREEN. So was `pnpm -F @ohmail/webapp typecheck` — proven by putting the import
 * back and re-running it, which is the mutation this paragraph would otherwise be asserting
 * without evidence. In a developer tree the package resolves through the workspace root whether
 * or not the app declares it; a clean install scoped to the app is where the accident stops.
 *
 * So the property is checked where it can be: in the SOURCE. `prefix.ts` is a module another
 * app's tests import, so it may not import from this workspace at all.
 */
describe("SECTION 5 — the hosted prefix module stays importable from another app", () => {
  const PREFIX = resolve(__dirname, "../../../apps/api-vercel/src/prefix.ts");

  it("imports nothing from a @trafficflow workspace package", () => {
    const src = readFileSync(PREFIX, "utf8");
    const sf = ts.createSourceFile(PREFIX, src, ts.ScriptTarget.Latest, true);

    const workspace: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        const spec = n.moduleSpecifier;
        // A TYPE-only import would erase, but it is still a resolution the other app's program
        // has to satisfy — `Cannot find module` is a type error, not a bundling one. So the rule
        // is about the specifier, not about whether the binding survives to runtime.
        if (spec && ts.isStringLiteral(spec) && spec.text.startsWith("@trafficflow/")) {
          workspace.push(spec.text);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);

    expect(workspace, `apps/api-vercel/src/prefix.ts imports ${workspace.join(", ")} — `
      + "apps/webapp/test/api-rewrite.test.ts imports this module, and the webapp typechecks its "
      + "tests, so every specifier here must resolve inside the WEBAPP's install. Put the code "
      + "that needs the route table in apps/api-vercel/src/normalize.ts, which nothing outside "
      + "this app imports.").toEqual([]);
  });

  it("…and the module that DOES need the route table is not the one the webapp imports", () => {
    // The other half of the rule: this is not "nobody may import the route table", it is "not
    // from the module another app reaches into". Asserting the door still exists somewhere keeps
    // the fix from being read as a deletion.
    const normalize = readFileSync(
      resolve(__dirname, "../../../apps/api-vercel/src/normalize.ts"), "utf8",
    );
    expect(normalize).toContain("bodyCeilingFor");
    expect(normalize).toContain("readBodyWithin");

    const webappTests = resolve(__dirname, "../../../apps/webapp/test");
    const reaching = readdirSync(webappTests)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) => readFileSync(join(webappTests, f), "utf8").includes("api-vercel/src/normalize"));
    expect(reaching, "a webapp test importing normalize.js would reintroduce the deploy break "
      + "by the other road").toEqual([]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   SECTION 6 — PATH PARAMETERS, bounded by SHAPE

   The question SECTION 1's list was silent about. A `:param` is a caller-chosen string that
   reaches a `uuid` column verbatim; `createApp.handle` refuses one that could never name a row
   with a 400, before any pipeline runs, unless the route declares it opaque.

   Every assertion here DRIVES the app. The census's other sections read source text, which is the
   right tool for "does this handler call a reading helper" and the wrong one for "what does this
   API answer" — a source scan for `requireUuid` would have been green the moment somebody imported
   the symbol, and `routes/drafts.ts` imported it for a body field while its own `:id` went
   unchecked for the route's whole life. `path-param-shape.test.ts` holds the full ten-shape matrix;
   this section holds the CENSUS half — that the partition is total and derived, in both directions.
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Path parameters that are deliberately NOT uuids, keyed `METHOD /pattern#name`.
 *
 * **It ships empty, and that is a measurement.** All 78 `:id` patterns in the table resolve to a
 * `uuid` column — including the three that looked like exceptions: `attachments.id` IS a uuid (its
 * live 502 came from that route's own blanket catch, not from a non-uuid id), `mailbox_folders.id`
 * is one, and `/screener/:id` reads `messages.id`.
 *
 * An entry here is a door left open, so it carries the door it opens — which column or lookup the
 * value reaches, and why a shape check cannot speak for it. Frozen and cross-checked against
 * `route.options.opaqueParams` in both directions below, so neither can move without the other.
 */
const OPAQUE_PATH_PARAMS: Readonly<Record<string, { door: string }>> = Object.freeze({});

/** `"/messages/:id/move"` → `["id"]`. */
const paramNamesOf = (pattern: string): string[] =>
  pattern.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1));

/** Every `METHOD /pattern#name` in the shipped table. */
function allParamKeys(): string[] {
  const out: string[] = [];
  for (const r of apiRoutes) for (const p of paramNamesOf(r.pattern)) out.push(`${key(r)}#${p}`);
  return out;
}

describe("SECTION 6 — every path parameter is bounded by shape or declared opaque", () => {
  it("derives the parameters from the route table, and the derivation cannot be empty", () => {
    const keys = allParamKeys();
    // `readingHelpers`' rule, applied to this derivation: an empty result makes every assertion
    // below vacuously true, and a vacuous pass is indistinguishable from coverage.
    expect(keys.length).toBeGreaterThanOrEqual(70);
    // Named anchors, so a refactor that renames or drops a pattern is a red test rather than a
    // quietly smaller census. One FULL-pipeline route, one `raw`, one `anonymous`.
    for (const k of [
      "GET /drafts/:id#id",
      "GET /attachments/:id#id",
      "GET /admin/accounts/:id#id",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("partitions every parameter into shape-checked or opaque, with nothing in both and nothing in neither", () => {
    const opaque = new Set(Object.keys(OPAQUE_PATH_PARAMS));
    const unaccounted = allParamKeys().filter((k) => !opaque.has(k));
    // Not an emptiness assertion on the leftovers — they are the CHECKED set, and the next test
    // proves the check by driving it. What this asserts is that the two sets partition: an opaque
    // key must name a parameter that exists.
    expect(unaccounted.length + opaque.size).toBe(allParamKeys().length);
    for (const k of opaque) {
      expect(allParamKeys(), `${k} is declared opaque but names no parameter in the table`).toContain(k);
    }
  });

  it("OPAQUE_PATH_PARAMS and the routes' own `opaqueParams` say the same thing, both ways", () => {
    const fromRoutes: string[] = [];
    for (const r of apiRoutes) {
      for (const p of r.options?.opaqueParams ?? []) fromRoutes.push(`${key(r)}#${p}`);
    }
    // Both directions, because either one alone is a list that can drift: a route can widen its
    // own door without arguing for it here, and an argument here can outlive the door it described.
    expect(fromRoutes.sort()).toEqual(Object.keys(OPAQUE_PATH_PARAMS).sort());
    // And every declared param must actually exist on its pattern — an `opaqueParams: ["mid"]` on a
    // route whose param is `:id` is a typo that silently checks everything, which looks exactly
    // like working correctly.
    for (const r of apiRoutes) {
      for (const p of r.options?.opaqueParams ?? []) {
        expect(paramNamesOf(r.pattern), `${key(r)} declares :${p} opaque but has no such param`)
          .toContain(p);
      }
    }
  });

  it("answers 400 for a shape that could never name a row — driven, on one route per pipeline", async () => {
    // `deps` is deliberately a bare cast and never populated. If the check were a middleware, or
    // anywhere below `createApp.handle`, these calls would touch the session store or the database
    // and throw on the empty object — so this passing IS the placement proof, not a shortcut.
    const app = createApp(apiRoutes);
    const deps = {} as unknown as ApiDeps;

    for (const [method, path] of [
      ["GET", "/drafts/not-a-uuid"],              // FULL_PIPELINE
      ["GET", "/attachments/not-a-uuid"],         // RAW_PIPELINE
      ["GET", "/admin/accounts/not-a-uuid"],      // ANONYMOUS_PIPELINE
    ] as const) {
      const res = await app.handle(new Request(`http://localhost${path}`, { method }), deps);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "validation_failed", message: "id must be an id", retryable: false },
      });
    }
  });
});
