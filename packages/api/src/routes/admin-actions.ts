import { silentLogger } from "@trafficflow/core";
import { suspendAccount, resumeAccount, resyncMailbox } from "@trafficflow/db/cloud";
import { resolveStaffSession, type StaffIdentity } from "./admin-staff.js";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route } from "../router.js";

/**
 * `POST /admin/accounts/{suspend,resume}` — THE ONE ADMIN WRITE.
 *
 * This is the file `admin.ts` §2 promised did not exist. Its ceiling paragraph — "the secret
 * buys read-only, cross-account metadata, and bounds it by construction, because no write route
 * exists to be reached with it" — is amended in that file to point here, because that sentence
 * stops being true the moment a POST lands. So this route is held to a STRICTER bar than the
 * reads, and the whole design is that bar:
 *
 * ══ TWO CREDENTIALS IN SERIES, AND THE SECOND ONE IS THE POINT ═════════════════════════════
 *
 *  1. The shared `TF_ADMIN_SECRET`, `Authorization: Bearer …`, constant-time compared exactly as
 *     the six reads compare it. It proves the request came through the console's server-side
 *     proxy and not from a browser — necessary, and NOT sufficient. Several people and two
 *     hosting dashboards hold it; it names nobody.
 *  2. A live STAFF SESSION, resolved from the `staff_sessions` row named by the token the proxy
 *     forwards in the body. This is what turns "somebody with the secret" into a PERSON an audit
 *     row can blame. Every `staff_sessions` row is minted only after the TOTP wall
 *     (`admin-staff.ts`), and an enrolment token is an HMAC and not a row, so `resolveStaffSession`
 *     cannot resolve one — the second factor is structural, not re-checked here.
 *
 * **The URL-key gate cookie, or the shared secret, ALONE authorises NOTHING here.** A request
 * carrying the secret but no live staff session is 401 `staff_session_required`. That is the
 * property `spend-gate`/`admin-actions` tests pin by mutation: drop the `resolveStaffSession`
 * check and the "secret alone is refused" test goes green-should-be-red.
 *
 * ══ WHY THIS RUNS ON `deps.db`, NEVER THE BLIND ROLE ══════════════════════════════════════
 *
 * The six reads run on `deps.adminDb`, the content-blind `ohmail_admin` handle whose boot
 * attestation REFUSES any capability outside its read allowlist — so a write grant there would
 * take the whole console down at boot. The write runs on the RUNTIME connection, exactly as the
 * staff sign-in routes do, and the blind role gains nothing but a two-column SELECT so the console
 * can render who is suspended. `suspendAccount`/`resumeAccount` (packages/db) do the cloud
 * suspension row and the mail `audit_log` row in ONE transaction, idempotently.
 *
 * ══ PURE DELEGATION AT THE HTTP EDGE, LIKE THE REST ═══════════════════════════════════════
 *
 * `accountId` comes from the BODY (contract §1.9 is about SESSION-derived ids; there is no
 * customer session here — the target account is the operator's chosen argument, and it is
 * validated, not trusted). Options mirror the reads: `public + anonymous + raw`, so
 * ANONYMOUS_PIPELINE resolves no customer session and there is no account whose verification
 * state could be confused with the target's.
 */

/** The shared shape a suspend/resume handler returns; the wrapper turns it into a `Response`. */
type WriteRun = (
  input: { accountId: string; note: string },
  staff: StaffIdentity,
  deps: ApiDeps,
) => Promise<{ status: number; body: unknown }>;

/** A note shorter than this is refused — the same floor the console's form enforces. */
const MIN_NOTE_LENGTH = 8;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The wrapper: the unarmed-surface 404, the shared-secret 401, the STAFF-SESSION 401, the JSON
 * body, the note floor, and `no-store` — applied identically to both writes, so "the secret alone
 * authorises no write" is a property of ONE function rather than of two handlers' discipline. Same
 * shape `staffRoute`/`adminRoute` give their groups, for the same reason.
 */
function staffWriteRoute(name: string, run: WriteRun): Handler {
  return async (req, deps) => {
    const cfg = deps.admin;
    const log = (deps.logger ?? silentLogger).child({ route: `/admin/accounts/${name}` });
    // Unarmed ⇒ this host has no admin surface. 404, not 401 — exactly as the reads answer.
    if (!cfg || cfg.secret.trim().length === 0) return json(404, { error: { code: "not_found" } });

    // (1) The shared secret. Missing and wrong are the same 401 on an anonymous route.
    if (!presentsSecret(req, cfg.secret)) {
      log.warn("admin_write_unauthorized", {});
      return json(401, { error: { code: "unauthorized" } });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { code: "bad_request" } });
    }

    // (2) THE STAFF SESSION — resolved against `staff_sessions` on every request, never cached.
    // The token rides in the body (the proxy forwards the HttpOnly staff cookie there, the same
    // transport totp-begin/confirm use). A caller with only the gate cookie / shared secret has no
    // `sessionToken`, so this is where they are refused. This check is the mutation-watched guard.
    const staff = await resolveStaffSession(deps.db, str(body.sessionToken) || undefined, deps.now());
    if (!staff) {
      log.warn("admin_write_no_staff_session", {});
      return json(401, { error: { code: "staff_session_required" } });
    }

    const accountId = str(body.accountId).trim();
    if (!accountId) return json(400, { error: { code: "account_id_required" } });
    const note = str(body.note).trim();
    if (note.length < MIN_NOTE_LENGTH) return json(400, { error: { code: "note_required" } });

    try {
      const out = await run({ accountId, note }, staff, deps);
      return json(out.status, out.body);
    } catch (err) {
      // `raw`: nothing above this catches. A 503 an operator can read beats the platform's 500.
      log.error("admin_write_failed", { err });
      return json(503, { error: { code: "admin_write_failed" } });
    }
  };
}

async function suspend(
  input: { accountId: string; note: string },
  staff: StaffIdentity,
  deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const outcome = await suspendAccount(deps.db, {
    accountId: input.accountId,
    staffId: staff.staffId,
    note: input.note,
    now: deps.now(),
  });
  return {
    status: 200,
    body: {
      ok: true,
      action: "admin.account.suspend",
      accountId: input.accountId,
      // `changed: false` is a replay of a suspend on an already-suspended account: a 200 no-op
      // that wrote no second audit row. The console renders it as success, because it is one.
      changed: outcome.changed,
      suspendedAt: outcome.suspendedAt?.toISOString() ?? null,
      actor: staff.email,
      at: deps.now().toISOString(),
    },
  };
}

async function resume(
  input: { accountId: string; note: string },
  staff: StaffIdentity,
  deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const outcome = await resumeAccount(deps.db, {
    accountId: input.accountId,
    staffId: staff.staffId,
    note: input.note,
    now: deps.now(),
  });
  return {
    status: 200,
    body: {
      ok: true,
      action: "admin.account.resume",
      accountId: input.accountId,
      changed: outcome.changed,
      suspendedAt: null,
      actor: staff.email,
      at: deps.now().toISOString(),
    },
  };
}

/**
 * ══ THE THIRD WRITE: RELEASING A QUARANTINED MAILBOX (mail 0039) ═══════════════════════════
 *
 * It goes through {@link staffWriteRoute}'s twin, {@link staffMailboxWriteRoute}, and the only
 * difference is the id it validates — `mailboxId` instead of `accountId`. Everything that makes
 * an admin write safe here is unchanged and deliberately not re-implemented: unarmed ⇒ 404,
 * shared secret ⇒ 401, live staff session ⇒ 401, an eight-character note, `no-store`, and
 * `deps.db` rather than the content-blind console role.
 *
 * WHY IT EXISTS. When a mailbox failed, the worker recorded its retry backoff in a `Map` in
 * process memory and nowhere else, so the only exits from quarantine were the exponential ladder
 * expiring and a redeploy. Nobody could release a mailbox: not this console, not a support
 * engineer, not the customer — and a redeploy is both a heavy hammer and unavailable to anyone
 * without deploy rights. Mail 0039 made the instant durable (`mailboxes.retry_after`), and this
 * route is the write that clears it. The leader re-dials on its next roster pass.
 *
 * WHAT IT DELIBERATELY IS NOT. It does not force a folder pass, does not re-read UIDVALIDITY,
 * does not touch `status` or `retry_count`, and does not claim a sync it has not observed — see
 * `resyncMailbox` in `packages/db` for each. The actions catalog's copy was narrowed in the same
 * change to say only this, because a control that reports more than it does is the thing the
 * `available: false` convention exists to prevent.
 */
type MailboxWriteRun = (
  input: { mailboxId: string; note: string },
  staff: StaffIdentity,
  deps: ApiDeps,
) => Promise<{ status: number; body: unknown }>;

function staffMailboxWriteRoute(name: string, run: MailboxWriteRun): Handler {
  return async (req, deps) => {
    const cfg = deps.admin;
    const log = (deps.logger ?? silentLogger).child({ route: `/admin/mailboxes/${name}` });
    if (!cfg || cfg.secret.trim().length === 0) return json(404, { error: { code: "not_found" } });

    if (!presentsSecret(req, cfg.secret)) {
      log.warn("admin_write_unauthorized", {});
      return json(401, { error: { code: "unauthorized" } });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { code: "bad_request" } });
    }

    const staff = await resolveStaffSession(deps.db, str(body.sessionToken) || undefined, deps.now());
    if (!staff) {
      log.warn("admin_write_no_staff_session", {});
      return json(401, { error: { code: "staff_session_required" } });
    }

    const mailboxId = str(body.mailboxId).trim();
    if (!mailboxId) return json(400, { error: { code: "mailbox_id_required" } });
    const note = str(body.note).trim();
    if (note.length < MIN_NOTE_LENGTH) return json(400, { error: { code: "note_required" } });

    try {
      const out = await run({ mailboxId, note }, staff, deps);
      return json(out.status, out.body);
    } catch (err) {
      log.error("admin_write_failed", { err });
      return json(503, { error: { code: "admin_write_failed" } });
    }
  };
}

async function resync(
  input: { mailboxId: string; note: string },
  staff: StaffIdentity,
  deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const outcome = await resyncMailbox(deps.db, {
    mailboxId: input.mailboxId,
    staffId: staff.staffId,
    note: input.note,
    now: deps.now(),
  });
  // A mailbox id that matches no row is the operator's mistake, not a no-op, and it must not
  // read as one: 404 rather than a 200 that says `changed: false` beside a wrong id.
  if (outcome.accountId === null) return { status: 404, body: { error: { code: "mailbox_not_found" } } };
  return {
    status: 200,
    body: {
      ok: true,
      action: "admin.mailbox.resync",
      mailboxId: input.mailboxId,
      accountId: outcome.accountId,
      // `changed: false` is a mailbox that was not parked — a 200 that wrote no audit row,
      // exactly as a replayed suspend is. The console renders the difference rather than
      // calling both of them success, because "released" and "there was nothing to release"
      // are different things to the person deciding what to try next.
      changed: outcome.changed,
      clearedRetryAfter: outcome.clearedRetryAfter?.toISOString() ?? null,
      actor: staff.email,
      at: deps.now().toISOString(),
    },
  };
}

/**
 * All three writes are `public + anonymous + raw`, exactly as the reads and the staff sign-in
 * routes, and for the same reason: ANONYMOUS_PIPELINE resolves no customer session, so there is no
 * `users` row whose state could be confused with the target account's. The authority is the shared
 * secret plus, inside the handler, a live `staff_sessions` row.
 */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;
const COST = "unauthenticated" as const;

export const adminActionRoutes: Route[] = [
  { method: "POST", pattern: "/admin/accounts/suspend", cost: COST, options: OPTIONS, handler: staffWriteRoute("suspend", suspend) },
  { method: "POST", pattern: "/admin/accounts/resume", cost: COST, options: OPTIONS, handler: staffWriteRoute("resume", resume) },
  { method: "POST", pattern: "/admin/mailboxes/resync", cost: COST, options: OPTIONS, handler: staffMailboxWriteRoute("resync", resync) },
];
