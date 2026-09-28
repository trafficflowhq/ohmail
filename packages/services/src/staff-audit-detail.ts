import { STAFF_ROLES } from "@trafficflow/db/cloud";
import type { StaffAuditAction, StaffReasonCode } from "./admin-dto.js";

/**
 * THE STAFF AUDIT'S CLOSED VOCABULARY (cloud 0047) — the actions, the reason codes and, per
 * action, the only `detail` keys a row may carry with the shape of each value. One list for
 * both sides: the API's writer throws on anything outside it before the insert, and the staff
 * reads narrow every stored row through it again, so a row planted by any other writer
 * renders only what the list admits.
 */

export const STAFF_AUDIT_ACTIONS = [
  "read.overview", "read.roster", "read.search", "read.account", "read.account.activity",
  "read.sync_roster", "read.funnel", "read.worker", "read.actions",
  "read.oauth_provider", "assert.external", "write.mailbox.resync", "write.oauth_provider",
  "staff.signin", "staff.signin_failed", "staff.stepup", "staff.stepup_failed",
  "staff.signout", "staff.role_grant", "staff.role_revoke", "staff.totp_reset",
] as const satisfies readonly StaffAuditAction[];

/** Compile-time: the DTO's union and this list name the same members. */
type MissingAction = Exclude<StaffAuditAction, (typeof STAFF_AUDIT_ACTIONS)[number]>;
export const STAFF_AUDIT_ACTIONS_EXHAUSTIVE: MissingAction extends never ? true : never = true;

export const STAFF_REASON_CODES = [
  "customer_request", "incident", "billing_dispute", "fraud_or_abuse", "ops_maintenance", "legal",
] as const satisfies readonly StaffReasonCode[];

type Scalar = string | number | boolean | null;
type Check = (v: unknown) => boolean;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const oneOf = (...members: readonly string[]): Check => (v) => typeof v === "string" && members.includes(v);
const count: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000;
const flag: Check = (v) => typeof v === "boolean";
/** A request path's shape without its query: no `@`, no `%`, no whitespace, so no address fits. */
export const AUDIT_PATH_RE = /^\/[A-Za-z0-9/_.:~-]{0,255}$/;
const path: Check = (v) => typeof v === "string" && AUDIT_PATH_RE.test(v);

/** Per action, the only keys `detail` may carry and the shape each value must have. */
const DETAIL: Record<StaffAuditAction, Readonly<Record<string, Check>>> = {
  "read.overview": {},
  "read.roster": { filter: oneOf("all", "attention"), page: count, ids: count },
  "read.search": {},
  "read.account": {},
  "read.account.activity": { views: flag },
  "read.sync_roster": { limit: count },
  "read.funnel": {},
  "read.worker": {},
  "read.actions": {},
  "assert.external": {
    method: oneOf("GET", "POST", "PUT", "PATCH", "DELETE"), path, scope: oneOf("read", "write"),
    tier: (v) => v === 0 || v === 1 || v === 2, index: count,
  },
  "write.mailbox.resync": { changed: flag },
  "read.oauth_provider": {},
  "write.oauth_provider": {},
  "staff.signin": {},
  "staff.signin_failed": { step: oneOf("password", "totp") },
  "staff.stepup": {},
  "staff.stepup_failed": {},
  "staff.signout": {},
  "staff.role_grant": { role: oneOf(...STAFF_ROLES), targetStaffUserId: isUuid },
  "staff.role_revoke": { role: oneOf(...STAFF_ROLES), targetStaffUserId: isUuid },
  "staff.totp_reset": { sessionsRevoked: count },
};

export class StaffAuditDetailError extends Error {
  constructor(readonly action: string, readonly key: string) {
    super(`staff audit detail refused: ${action} carries no key ${key}`);
    this.name = "StaffAuditDetailError";
  }
}

/** The write-side check: every key allowlisted, every value its shape — else it throws. */
export function checkedDetail(action: StaffAuditAction, detail: Record<string, Scalar> | undefined): Record<string, Scalar> | null {
  if (!detail) return null;
  const allowed = DETAIL[action];
  for (const [key, value] of Object.entries(detail)) {
    const check = allowed[key];
    if (!check || !check(value)) throw new StaffAuditDetailError(action, key);
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

/** The read-side check: keeps what the allowlist admits and drops the rest, never throwing. */
export function narrowedDetail(action: string, raw: unknown): Record<string, Scalar> {
  const allowed = (DETAIL as Record<string, Readonly<Record<string, Check>> | undefined>)[action];
  if (!allowed || !raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const check = allowed[key];
    if (check && check(value)) out[key] = value as Scalar;
  }
  return out;
}

