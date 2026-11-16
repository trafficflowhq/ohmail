import { AUTH_EVENTS_RETENTION_MS, CONNECT_ATTEMPTS_RETENTION_MS, SIGN_IN_RECORD_RETENTION_MS } from "./retention.js";
import { AUDIT_LOG_RETENTION_MS } from "./change-log-retention.js";
import { WEBAUTHN_CHALLENGE_RETENTION_MS } from "./webauthn-challenges.js";
import { DEVICE_CEREMONY_RETENTION_MS, OAUTH_CEREMONY_RETENTION_MS } from "./oauth-ceremony.js";
import { SEND_FINGERPRINT_RETENTION_MS } from "./send-fingerprints.js";
import { ERASED_NOTICE_KEEP_YEARS } from "./erased-notices.js";
import { ERASED_REFRESH_KEEP_DAYS } from "./erased-bearers.js";
import { AUTH_THROTTLE_RETENTION_MS } from "./auth-throttle-prune.js";

/**
 * THE HORIZONS: past which instant each pruned table's row is the prune's to take. One list, read
 * by the lock (the worker's role is admitted to a row only once it is past its table's horizon) and
 * by the worker (which runs the prunes). Each expression is written from the product's own constant,
 * the way its prune writes its cutoff, and reads the row's own columns and the database's clock.
 *
 * Two facts of row security decide what each entry admits. A read that locks rows (`FOR UPDATE`)
 * is filtered by the update policies too, so a prune that locks its batch gets an update policy
 * that admits the lock and no write (`lock`). And a statement's sub-selects are filtered as well,
 * so a prune that decides by a row beside the one it takes (`guards`) does not run unbound: its
 * table admits a read of the roster alone, and the prune runs inside each account's binding
 * (`runs: "bound"`). A prune that runs unbound may be guarded only by a table the worker reads wide.
 */

/** One constant a horizon is built from, with the unit its value is in. */
export interface HorizonConstant {
  readonly name: string;
  readonly value: number;
  readonly unit: "ms" | "days" | "years";
}

export interface Horizon {
  readonly table: string;
  readonly constants: readonly HorizonConstant[];
  /** Past the horizon when this holds, over the row's own columns and `now()`. */
  readonly using: string;
  /** The prune picks its batch `FOR UPDATE SKIP LOCKED`. */
  readonly lock: boolean;
  /** What the prune reads beside the row it takes. */
  readonly guards: ReadonlyArray<{ readonly table: string; readonly what: string }>;
  /** `unbound`: it decides by the row's own columns. `bound`: per account, after a roster read. */
  readonly runs: "unbound" | "bound";
  /** The worker is admitted only while no account is bound (the staff sessions). */
  readonly onlyUnbound: boolean;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A Postgres interval literal for `ms`, in whole days or hours where it divides. */
export function intervalOf(ms: number): string {
  if (!Number.isInteger(ms) || ms <= 0) throw new RangeError(`a horizon of ${ms} ms`);
  if (ms % DAY_MS === 0) return `interval '${ms / DAY_MS} days'`;
  if (ms % HOUR_MS === 0) return `interval '${ms / HOUR_MS} hours'`;
  return `interval '${ms} milliseconds'`;
}

const ms = (name: string, value: number): HorizonConstant => ({ name, value, unit: "ms" });
/** `column` is past `value` ms ago. */
const ago = (column: string, c: HorizonConstant): string => `${column} < pg_catalog.now() - ${intervalOf(c.value)}`;

const SIGN_IN = ms("SIGN_IN_RECORD_RETENTION_MS", SIGN_IN_RECORD_RETENTION_MS);
const KEEP = { name: "ERASED_REFRESH_KEEP_DAYS", value: ERASED_REFRESH_KEEP_DAYS, unit: "days" } as const;
/** The reaper's discriminator of a browser session (`session-reaper.ts`, private there): restated. */
const COOKIE_WINDOW = ms("COOKIE_WINDOW_UNDER_MS", 100 * DAY_MS);
const NOTICE_KEEP = { name: "ERASED_NOTICE_KEEP_YEARS", value: ERASED_NOTICE_KEEP_YEARS, unit: "years" } as const;
const THROTTLE = ms("AUTH_THROTTLE_RETENTION_MS", AUTH_THROTTLE_RETENTION_MS);

const h = (table: string, constants: HorizonConstant[], using: string, opts: Partial<Pick<Horizon, "lock" | "guards" | "runs" | "onlyUnbound">> = {}): Horizon => ({
  table, constants, using, lock: opts.lock ?? false, guards: opts.guards ?? [], runs: opts.runs ?? "unbound",
  onlyUnbound: opts.onlyUnbound ?? false,
});

export const HORIZONS: readonly Horizon[] = [
  h("login_tokens", [SIGN_IN], ago("expires_at", SIGN_IN), { lock: true }),
  h("oauth_auth_codes", [SIGN_IN], ago("expires_at", SIGN_IN), { lock: true }),
  h("pairing_tokens", [SIGN_IN], ago("expires_at", SIGN_IN), { lock: true }),
  // Unused only: a used invitation answers which invite opened an account.
  h("invites", [SIGN_IN], `consumed_at IS NULL AND ${ago("expires_at", SIGN_IN)}`, { lock: true }),
  h("sessions", [SIGN_IN, KEEP, COOKIE_WINDOW],
    `${ago("revoked_at", SIGN_IN)} OR (revoked_at IS NULL AND refresh_expires_at + interval '${KEEP.value} days' <= pg_catalog.now()) `
      + `OR (device_id IS NULL AND scope = 'full' AND revoked_at IS NULL AND refresh_expires_at < pg_catalog.now() `
      + `AND refresh_expires_at - last_seen_at < ${intervalOf(COOKIE_WINDOW.value)})`,
    { lock: true, runs: "bound", guards: [
      { table: "sessions", what: "a live session of its family" },
      { table: "refresh_tokens", what: "a token the erasure would still name, and the tokens a session has left" },
    ] }),
  h("devices", [SIGN_IN], `ip <> '' AND ${ago("last_seen_at", SIGN_IN)}`,
    { lock: true, runs: "bound", guards: [{ table: "sessions", what: "a session that names the device" }] }),
  h("webauthn_challenges", [ms("WEBAUTHN_CHALLENGE_RETENTION_MS", WEBAUTHN_CHALLENGE_RETENTION_MS)],
    `expires_at < pg_catalog.now() - ${intervalOf(WEBAUTHN_CHALLENGE_RETENTION_MS)}`),
  h("mailbox_oauth_ceremonies", [ms("OAUTH_CEREMONY_RETENTION_MS", OAUTH_CEREMONY_RETENTION_MS)],
    ago("created_at", ms("OAUTH_CEREMONY_RETENTION_MS", OAUTH_CEREMONY_RETENTION_MS))),
  h("mailbox_oauth_device_ceremonies", [ms("DEVICE_CEREMONY_RETENTION_MS", DEVICE_CEREMONY_RETENTION_MS)],
    ago("created_at", ms("DEVICE_CEREMONY_RETENTION_MS", DEVICE_CEREMONY_RETENTION_MS))),
  h("auth_events", [ms("AUTH_EVENTS_RETENTION_MS", AUTH_EVENTS_RETENTION_MS)], ago("at", ms("AUTH_EVENTS_RETENTION_MS", AUTH_EVENTS_RETENTION_MS))),
  h("connect_attempts", [ms("CONNECT_ATTEMPTS_RETENTION_MS", CONNECT_ATTEMPTS_RETENTION_MS)],
    ago("at", ms("CONNECT_ATTEMPTS_RETENTION_MS", CONNECT_ATTEMPTS_RETENTION_MS))),
  h("audit_log", [ms("AUDIT_LOG_RETENTION_MS", AUDIT_LOG_RETENTION_MS)], ago("created_at", ms("AUDIT_LOG_RETENTION_MS", AUDIT_LOG_RETENTION_MS))),
  h("idempotency_keys", [], "expires_at <= pg_catalog.now()"),
  h("erased_bearers", [], "expires_at <= pg_catalog.now()"),
  h("attachment_staging", [], "expires_at <= pg_catalog.now()"),
  h("outbound_send_fingerprints", [ms("SEND_FINGERPRINT_RETENTION_MS", SEND_FINGERPRINT_RETENTION_MS)],
    ago("created_at", ms("SEND_FINGERPRINT_RETENTION_MS", SEND_FINGERPRINT_RETENTION_MS)),
    { runs: "bound", guards: [{ table: "outbound_sends", what: "the send a claim points at, still held" }] }),
  // `accounts` is read wide by the worker's role, so this guard is seen unbound.
  h("account_lifecycle_notices", [NOTICE_KEEP],
    `EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_lifecycle_notices.account_id `
      + `AND a.erased_at <= pg_catalog.now() - interval '${NOTICE_KEEP.value} years')`,
    { guards: [{ table: "accounts", what: "its erasure's stamp" }] }),
  h("account_counters", [THROTTLE],
    `${ago("window_started_at", THROTTLE)} AND (locked_until IS NULL OR locked_until <= pg_catalog.now())`, { lock: true }),
  // The one staff table the worker touches, and only while no account is bound.
  h("staff_sessions", [SIGN_IN], ago("expires_at", SIGN_IN), { lock: true, onlyUnbound: true }),
];

/** The horizon of `table`, or undefined. */
export function horizonOf(table: string): Horizon | undefined {
  return HORIZONS.find((x) => x.table === table);
}

/** The verbs the worker's role holds a horizon policy for on `table`'s horizon. */
export function horizonVerbs(x: Horizon): ReadonlyArray<"SELECT" | "UPDATE" | "DELETE"> {
  if (x.runs === "bound") return ["SELECT"];
  return x.lock ? ["SELECT", "UPDATE", "DELETE"] : ["SELECT", "DELETE"];
}
