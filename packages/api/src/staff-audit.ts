import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, bindDb, mailboxes } from "@trafficflow/db";
import { staffAuditEvents, STAFF_DOOR_KEY } from "@trafficflow/db/cloud";
import {
  checkedDetail, isUuid, passContext, StaffAuditDetailError,
  type PassContext, type StaffAuditAction, type StaffAuditOutcome, type StaffReasonCode, type StaffRole, type UnboundDb,
} from "@trafficflow/services";
import { doorDb } from "./context.js";
import type { ApiDeps } from "./deps.js";

/**
 * THE STAFF DOOR'S HANDLE: bound to no account, with the door's word as its key. What a staff
 * route reads and writes the operators' own tables through (their sessions, their roles, the two
 * audit trails), and the only handle that names the word. It reaches those tables and no other:
 * a customer's row is never read or written through it, and it never names an account.
 *
 * Made over the request's handle as its host minted it ({@link doorDb}): a request that was bound
 * to an account is refused, so the door's word never rides beside a customer's session.
 */
export function staffDb(deps: ApiDeps): UnboundDb {
  return bindDb(doorDb(deps), { account: null, key: STAFF_DOOR_KEY });
}

/**
 * THE CONTEXT OF A STAFF ACT ON ONE ACCOUNT, or null where the id the operator named finds no row.
 *
 * THE ID NAMED SELECTS A ROW, AND ONLY THE ROW BINDS. The operator names a mailbox or an account;
 * that id is used once, at the staff door, to read the target's row, and the act then runs on a
 * handle bound to the account THAT ROW carries ({@link passContext}): never to the id as it was
 * typed. An id no row answers binds nothing, and the act does not begin.
 */
export async function staffActOn(
  deps: ApiDeps, target: { readonly mailboxId: string } | { readonly accountId: string },
): Promise<PassContext | null> {
  const door = staffDb(deps);
  const [row] = "mailboxId" in target
    ? await door.select({ accountId: mailboxes.accountId }).from(mailboxes).where(eq(mailboxes.id, target.mailboxId)).limit(1)
    : await door.select({ accountId: accounts.id }).from(accounts).where(eq(accounts.id, target.accountId)).limit(1);
  if (!row) return null;
  return passContext(doorDb(deps), row.accountId, { userId: null, now: deps.now, requestId: deps.requestId });
}

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
