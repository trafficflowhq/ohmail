import { silentLogger } from "@trafficflow/core";
import { resyncMailbox } from "@trafficflow/db/cloud";
import { resolveStaffSession, staffTokenOf, type StaffIdentity } from "./admin-staff.js";
import { mailboxResyncAnswer } from "../admin-write-wire.js";
import { withStaffStepUp } from "../staff-step-up.js";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import type { ApiDeps } from "../deps.js";
import type { Handler, Route } from "../router.js";

/** A note shorter than this is refused — the same floor the console's form enforces. */
const MIN_NOTE_LENGTH = 8;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * `POST /admin/mailboxes/resync` — releases a quarantined mailbox (mail 0039). Two credentials in
 * series: the shared `TF_ADMIN_SECRET` proves the call came through the console's server-side
 * proxy, and a live staff session from the body's token names a person an audit row can blame.
 * Unarmed ⇒ 404, secret or session missing ⇒ 401, an eight-character note, `no-store`, `deps.db`.
 * It clears `mailboxes.retry_after` so the leader re-dials on its next roster pass; it does not
 * force a folder pass, re-read UIDVALIDITY, touch `status` or `retry_count`, or claim a sync it
 * has not observed (see `resyncMailbox` in packages/db).
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

    const staff = await resolveStaffSession(deps.db, staffTokenOf(body), deps.now());
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
  // `changed: false` is a mailbox that was not parked — a 200 that wrote no audit row, exactly as
  // a replayed suspend is, and `audit` is null beside it. The console renders the difference
  // rather than calling both of them success, because "released" and "there was nothing to
  // release" are different things to the person deciding what to try next. The audit row's
  // IDENTITY travels too: a surface that displays a row it was not given is displaying a guess.
  return {
    status: 200,
    body: mailboxResyncAnswer({
      mailboxId: input.mailboxId,
      accountId: outcome.accountId,
      changed: outcome.changed,
      clearedRetryAfter: outcome.clearedRetryAfter,
      auditId: outcome.auditId,
      auditAt: outcome.auditAt,
      actor: staff.email,
      at: deps.now(),
    }),
  };
}


/**
 * `public + anonymous + raw`, exactly as the reads and the staff sign-in routes, and for the same
 * reason: ANONYMOUS_PIPELINE resolves no customer session, so there is no `users` row whose state
 * could be confused with the target account's. The authority is the shared secret plus, inside the
 * handler, a live `staff_sessions` row — and `withStaffStepUp`, which adds the third thing this
 * write asks for: that the person holding that session proved a second factor in the last few
 * minutes (`STAFF_STEP_UP_WINDOW_SECONDS`). CARRIED, not flagged: the control travels with the
 * route into whatever composition mounts it, and reaches no door that mounts none of these.
 */
const OPTIONS = {
  public: true, anonymous: true, raw: true, middleware: [withStaffStepUp],
} as const;
const COST = "unauthenticated" as const;

/* `relay: false` throughout: the hosted console's own surface, never forwarded by a Cloud-mode
 * install's relay. Declared per route because the field has no default. */
export const adminActionRoutes: Route[] = [
  { method: "POST", pattern: "/admin/mailboxes/resync", relay: false, cost: COST, options: OPTIONS, handler: staffMailboxWriteRoute("resync", resync) },
];
