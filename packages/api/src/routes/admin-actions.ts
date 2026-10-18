import { silentLogger } from "@trafficflow/core";
import {
  BILLING_LINK_CAP, BillingLinkAuditError, claimBillingLink, handBackBillingLink, resyncMailbox,
} from "@trafficflow/db/cloud";
import { actorOf, resolveStaffSession, staffTokenOf, type StaffIdentity } from "./admin-staff.js";
import { recordStaffEvents, adoptRequestId, rolesAdmit, staffEventRow, StaffAuditWriteError } from "../staff-audit.js";
import { isUuid, STAFF_REASON_CODES, type StaffReasonCode, type StaffRole } from "@trafficflow/services";
import { billingLinkAnswer, mailboxResyncAnswer } from "../admin-write-wire.js";
import { withStaffStepUp } from "../staff-step-up.js";
import { presentsSecret, secretRouteJson as json } from "../secret-auth.js";
import { entitlementsPort } from "./shared.js";
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
  input: { mailboxId: string; note: string; requestId: string },
  staff: StaffIdentity,
  deps: ApiDeps,
) => Promise<{ status: number; body: unknown }>;

/** The roles a mailbox write admits; `billing` does not operate mailboxes. */
const MAILBOX_WRITE_ROLES: readonly StaffRole[] = ["support", "ops", "owner"];

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

    const requestId = adoptRequestId(req, deps);
    if (!rolesAdmit(staff.roles, MAILBOX_WRITE_ROLES)) {
      try {
        await recordStaffEvents(deps.db, [{
          requestId, at: deps.now(), actor: actorOf(staff), action: "write.mailbox.resync",
          outcome: "refused", refusalCode: "role_required", targetMailboxId: str(body.mailboxId).trim(),
        }]);
      } catch (err) {
        log.error("admin_audit_failed", { err });
        return json(503, { error: { code: "audit_failed" } });
      }
      return json(403, { error: { code: "role_required" } });
    }

    const mailboxId = str(body.mailboxId).trim();
    if (!mailboxId) return json(400, { error: { code: "mailbox_id_required" } });
    const note = str(body.note).trim();
    if (note.length < MIN_NOTE_LENGTH) return json(400, { error: { code: "note_required" } });

    try {
      const out = await run({ mailboxId, note, requestId }, staff, deps);
      return json(out.status, out.body);
    } catch (err) {
      if (err instanceof StaffAuditWriteError) {
        log.error("admin_audit_failed", { err: err.cause });
        return json(503, { error: { code: "audit_failed" } });
      }
      log.error("admin_write_failed", { err });
      return json(503, { error: { code: "admin_write_failed" } });
    }
  };
}

async function resync(
  input: { mailboxId: string; note: string; requestId: string },
  staff: StaffIdentity,
  deps: ApiDeps,
): Promise<{ status: number; body: unknown }> {
  const now = deps.now();
  const outcome = await resyncMailbox(deps.db, {
    mailboxId: input.mailboxId,
    staffId: staff.staffId,
    note: input.note,
    now,
    // The note stays in `audit_log.payload` alone; the staff row carries the outcome only.
    staffEvent: (o) => staffEventRow({
      requestId: input.requestId, at: now, actor: actorOf(staff), action: "write.mailbox.resync",
      outcome: o.outcome, targetAccountId: o.accountId, targetMailboxId: input.mailboxId,
      detail: { changed: o.changed },
    }),
  });
  // A mailbox id that matches no row is the operator's mistake, not a no-op, and it must not
  // read as one: 404 rather than a 200 that says `changed: false` beside a wrong id.
  if (outcome.accountId === null) {
    await recordStaffEvents(deps.db, [{
      requestId: input.requestId, at: now, actor: actorOf(staff), action: "write.mailbox.resync",
      outcome: "refused", refusalCode: "mailbox_not_found", targetMailboxId: input.mailboxId,
    }]);
    return { status: 404, body: { error: { code: "mailbox_not_found" } } };
  }
  // `changed: false` is a mailbox that was not parked — a 200 that wrote no `audit_log` row (the
  // staff audit records it as `no_change`), exactly as
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


/** Who may mail an owner the billing link: support answers the customer; billing and owner too. */
const BILLING_LINK_ROLES: readonly StaffRole[] = ["support", "billing", "owner"];
/** `staff_audit_events.ticket_ref`'s own CHECK, asked before an insert would refuse it. */
const TICKET_RE = /^[A-Za-z0-9#._:-]{1,64}$/;

/** A send the mailer did not take: the answer, and whether its claim goes back (no mail left). */
function notSent(r: { status: string; reason?: string }): { status: number; code: string; handBack: boolean } {
  if (r.status === "failed") return { status: 502, code: "mail_failed", handBack: false };
  if (r.reason === "rate_limited") return { status: 429, code: "mail_throttled", handBack: true };
  if (r.reason === "mailer_disabled") return { status: 503, code: "mailer_unconfigured", handBack: true };
  return { status: 502, code: "recipient_refused", handBack: true };
}

/**
 * `POST /admin/accounts/:id/billing-link` (cloud 0050) — mails the account's owner the app's
 * billing door. The shared secret, a live staff session holding support, billing or owner, and a
 * fresh second factor (`withStaffStepUp`). The claim (three per account in any 24 hours) and its
 * `ok` row commit before the mail leaves; every refusal is recorded or the answer is 503.
 */
const billingLink: Handler = async (req, deps, params) => {
  const cfg = deps.admin;
  const log = (deps.logger ?? silentLogger).child({ route: "/admin/accounts/:id/billing-link" });
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
  if (body === null || typeof body !== "object") return json(400, { error: { code: "bad_request" } });
  const staff = await resolveStaffSession(deps.db, staffTokenOf(body), deps.now());
  if (!staff) {
    log.warn("admin_write_no_staff_session", {});
    return json(401, { error: { code: "staff_session_required" } });
  }

  const accountId = isUuid(params.id) ? params.id.toLowerCase() : null;
  const event = { requestId: adoptRequestId(req, deps), actor: actorOf(staff), action: "write.billing_link" as const, targetAccountId: accountId };
  let why: { reasonCode?: StaffReasonCode; ticketRef?: string | null } = {};
  const refuse = async (status: number, code: string, outcome: "refused" | "failed" = "refused", extra: object = {}) => {
    try {
      await recordStaffEvents(deps.db, [{ ...event, ...why, at: deps.now(), outcome, refusalCode: code }]);
    } catch (err) {
      log.error("admin_audit_failed", { err });
      return json(503, { error: { code: "audit_failed" } });
    }
    return json(status, { error: { code }, ...extra });
  };

  if (!rolesAdmit(staff.roles, BILLING_LINK_ROLES)) return refuse(403, "role_required");
  const reasonCode = STAFF_REASON_CODES.find((c) => c === body.reasonCode);
  if (!reasonCode) return json(400, { error: { code: "reason_required" } });
  const ticket = body.ticketRef ?? null;
  if (ticket !== null && (typeof ticket !== "string" || !TICKET_RE.test(ticket))) {
    return json(400, { error: { code: "bad_ticket" } });
  }
  why = { reasonCode, ticketRef: ticket as string | null };
  if (accountId === null) return refuse(404, "account_not_found");
  const mail = deps.services?.customerMail;
  if (!mail?.sendBillingLink) return refuse(503, "mailer_unconfigured", "failed");
  if (!entitlementsPort(deps)) return refuse(404, "no_billing_page");

  let claim: Awaited<ReturnType<typeof claimBillingLink>>;
  try {
    claim = await claimBillingLink(deps.db, {
      accountId, now: deps.now(),
      staffEvent: (o) => staffEventRow({
        ...event, ...why, at: deps.now(), outcome: "ok", targetUserId: o.userId, detail: { sendsToday: o.sendsToday },
      }),
    });
  } catch (err) {
    const audit = err instanceof BillingLinkAuditError;
    log.error(audit ? "admin_audit_failed" : "admin_write_failed", { err: audit ? err.cause : err });
    return json(503, { error: { code: audit ? "audit_failed" : "admin_write_failed" } });
  }
  if (claim.kind === "refused") {
    return refuse(claim.code === "rate_limited" ? 429 : 404, claim.code, "refused",
      claim.retryAt ? { retryAt: claim.retryAt.toISOString() } : {});
  }

  let sent: { status: string; reason?: string };
  try {
    sent = await mail.sendBillingLink({ db: deps.db, now: deps.now }, { to: claim.to, locale: claim.locale, anchor: claim.anchor });
  } catch (err) {
    // A mailer that throws instead of answering is read as a transport failure: the claim stays.
    log.error("billing_link_mailer_threw", { err });
    sent = { status: "failed" };
  }
  if (sent.status === "sent") {
    return json(200, billingLinkAnswer({
      accountId, sendsToday: claim.sendsToday, limit: BILLING_LINK_CAP,
      auditId: claim.auditId, auditAt: claim.auditAt, actor: staff.email, at: claim.anchor,
    }));
  }
  const miss = notSent(sent);
  const failure = { ...event, ...why, at: deps.now(), outcome: "failed" as const, refusalCode: miss.code, targetUserId: claim.userId };
  try {
    if (miss.handBack) await handBackBillingLink(deps.db, { accountId, anchor: claim.anchor, staffEvent: staffEventRow(failure) });
    else await recordStaffEvents(deps.db, [failure]);
  } catch (err) {
    log.error("admin_audit_failed", { err });
    return json(503, { error: { code: "audit_failed" } });
  }
  log.warn("billing_link_not_sent", { accountId, code: miss.code });
  return json(miss.status, { error: { code: miss.code } });
};

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
  { method: "POST", pattern: "/admin/accounts/:id/billing-link", relay: false, cost: COST, options: OPTIONS, handler: billingLink },
];
