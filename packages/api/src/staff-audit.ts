import { createHmac, randomUUID } from "node:crypto";
import { staffAuditEvents } from "@trafficflow/db/cloud";
import {
  checkedDetail, isUuid, StaffAuditDetailError,
  type StaffAuditAction, type StaffAuditOutcome, type StaffReasonCode, type StaffRole,
} from "@trafficflow/services";
import type { ApiDeps } from "./deps.js";

/**
 * THE STAFF AUDIT'S ONE WRITER (cloud 0047). Every staff read and write the API serves inserts
 * one `staff_audit_events` row on the runtime connection BEFORE it answers; a failed insert is
 * the request's refusal (`503 audit_failed`), never a served answer with no record. `detail`
 * is checked here, before the insert, against the per-action allowlist in the services'
 * `staff-audit-detail.ts`: a key outside it throws, so no free text can be written.
 */

type Scalar = string | number | boolean | null;

/** The keyed hash of a search term: the term is never stored, and the key is the admin secret. */
export function queryHmacOf(secret: string, term: string): string {
  return createHmac("sha256", secret).update(term.trim().toLowerCase()).digest("hex");
}

/** A staff member as the audit names them. */
export interface StaffActor {
  staffId: string;
  sessionId: string | null;
  email: string;
  roles: readonly StaffRole[];
}

export interface StaffEventInput {
  requestId: string;
  actor: StaffActor;
  action: StaffAuditAction;
  outcome: StaffAuditOutcome;
  refusalCode?: string | null;
  reasonCode?: StaffReasonCode | null;
  ticketRef?: string | null;
  targetAccountId?: string | null;
  targetUserId?: string | null;
  targetMailboxId?: string | null;
  resultCount?: number | null;
  queryHmac?: string | null;
  audience?: string | null;
  detail?: Record<string, Scalar>;
  at: Date;
}

const REFUSAL_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ACTOR_LABEL_MAX = 320;

/** One row's values, checked. Exported for the writes that insert inside their own transaction. */
export function staffEventRow(e: StaffEventInput): typeof staffAuditEvents.$inferInsert {
  if (e.refusalCode != null && !REFUSAL_CODE_RE.test(e.refusalCode)) {
    throw new StaffAuditDetailError(e.action, "refusalCode");
  }
  return {
    at: e.at,
    requestId: e.requestId,
    staffUserId: e.actor.staffId,
    staffSessionId: e.actor.sessionId,
    actorLabel: e.actor.email.slice(0, ACTOR_LABEL_MAX),
    roles: [...e.actor.roles],
    action: e.action,
    targetAccountId: isUuid(e.targetAccountId) ? e.targetAccountId : null,
    targetUserId: isUuid(e.targetUserId) ? e.targetUserId : null,
    targetMailboxId: isUuid(e.targetMailboxId) ? e.targetMailboxId : null,
    outcome: e.outcome,
    refusalCode: e.refusalCode ?? null,
    reasonCode: e.reasonCode ?? null,
    ticketRef: e.ticketRef ?? null,
    resultCount: e.resultCount ?? null,
    queryHmac: e.queryHmac ?? null,
    audience: e.audience ?? null,
    detail: checkedDetail(e.action, e.detail),
  };
}

type Inserter = Pick<ApiDeps["db"], "insert">;

/** The one failure a staff route answers `503 audit_failed`: its row could not be written. */
export class StaffAuditWriteError extends Error {
  constructor(readonly cause: unknown) {
    super("staff audit row could not be written");
    this.name = "StaffAuditWriteError";
  }
}

/** Insert rows, all or none. Any failure — a refused detail, a database fault — throws {@link StaffAuditWriteError}. */
export async function recordStaffEvents(db: Inserter, events: readonly StaffEventInput[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await db.insert(staffAuditEvents).values(events.map(staffEventRow));
  } catch (err) {
    throw new StaffAuditWriteError(err);
  }
}

/**
 * The request id both audit trails carry, ADOPTED as this request's id: the caller's
 * `x-request-id` when it is a uuid, else the pipeline's own when that is one, else a fresh one.
 * It is written to `deps.requestId`, so `app.ts`'s one stamp echoes the id the rows carry; a
 * header value is never written or echoed unless it has the uuid shape.
 */
export function adoptRequestId(req: Request, deps: Pick<ApiDeps, "requestId">): string {
  const given = req.headers.get("x-request-id")?.trim();
  const id = isUuid(given) ? given.toLowerCase() : isUuid(deps.requestId) ? deps.requestId : randomUUID();
  deps.requestId = id;
  return id;
}

/** Does this set of roles admit a route that asks for `needed`? `owner` implies every role. */
export function rolesAdmit(roles: readonly StaffRole[], needed: readonly StaffRole[] | "any"): boolean {
  if (roles.length === 0) return false;
  if (needed === "any" || roles.includes("owner")) return true;
  return needed.some((r) => roles.includes(r));
}
