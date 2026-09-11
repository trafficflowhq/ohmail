import { silentLogger, SECRET_VALUE_PATTERNS } from "@trafficflow/core";
import { resyncMailbox } from "@trafficflow/db/cloud";
import {
} from "@trafficflow/services";
import { resolveStaffSession, type StaffIdentity } from "./admin-staff.js";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route } from "../router.js";

/**
 * `POST /admin/accounts/{suspend,resume}` — the one admin write. Two credentials in series: the
 * shared `TF_ADMIN_SECRET` (constant-time compared) proves the request came through the console's
 * server-side proxy — necessary, not sufficient — and a live staff session, from the token the
 * proxy forwards in the body, names a person an audit row can blame; every staff session is
 * minted behind the TOTP wall. The secret alone is 401 `staff_session_required` — the
 * mutation-watched property. The write runs on `deps.db`, never the blind role;
 * `suspendAccount`/`resumeAccount` do the suspension row and the `audit_log` row in one
 * transaction, idempotently. `accountId` comes from the body — the operator's validated argument.
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

/**
 * The third write: releasing a quarantined mailbox (mail 0039), through {@link
 * staffMailboxWriteRoute} — {@link staffWriteRoute}'s twin, differing only in the id it
 * validates. Everything that makes an admin write safe is unchanged: unarmed ⇒ 404, shared secret
 * ⇒ 401, live staff session ⇒ 401, an eight-character note, `no-store`, `deps.db`. Why it exists:
 * `mailboxes.retry_after` (mail 0039) made the quarantine instant durable, and this route is the
 * write that clears it — the leader re-dials on its next roster pass. What it deliberately is
 * not: it does not force a folder pass, re-read UIDVALIDITY, touch `status` or `retry_count`, or
 * claim a sync it has not observed (see `resyncMailbox` in packages/db).
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
 * All FOUR writes are `public + anonymous + raw`, exactly as the reads and the staff sign-in
 * routes, and for the same reason: ANONYMOUS_PIPELINE resolves no customer session, so there is no
 * `users` row whose state could be confused with the target account's. The authority is the shared
 * secret plus, inside the handler, a live `staff_sessions` row.
 */
const OPTIONS = { public: true, anonymous: true, raw: true } as const;
const COST = "unauthenticated" as const;

/* `relay: false` throughout: the hosted console's own surface, never forwarded by a Cloud-mode
 * install's relay. Declared per route because the field has no default. */
export const adminActionRoutes: Route[] = [
  { method: "POST", pattern: "/admin/mailboxes/resync", relay: false, cost: COST, options: OPTIONS, handler: staffMailboxWriteRoute("resync", resync) },
];
