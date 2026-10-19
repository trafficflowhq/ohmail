import {
  isMetered,
  type EntitlementsComposition, type PlaneOpsAlert, type PlaneOpsAnswer, type PlaneOpsPass,
  type PlaneOpsReader, type PlaneOpsSeverity, type PlaneOpsVerdict,
} from "./entitlements-port.js";

export type {
  PlaneOpsAlert, PlaneOpsAnswer, PlaneOpsPass, PlaneOpsReader, PlaneOpsReading, PlaneOpsSeverity,
  PlaneOpsVerdict,
} from "./entitlements-port.js";

/**
 * THE BILLING PLANE'S `POST /v1/ops` ANSWER, read to its wire contract (v1, 2026-10-19).
 *
 * Every closed string rule is mirrored exactly. Stricter would page forever about a healthy plane;
 * looser would put an account or event id into a pager, a mail and an `alert_state` key that is
 * never pruned. One value outside a rule refuses the whole answer, and the refusal names the
 * field's path, never the value. Fields the contract does not name are ignored and never copied.
 * A new stage, severity, verdict or version must ship here before the plane sends it.
 */

export const PLANE_PASS_NAME_RE = /^[a-zA-Z]{1,40}$/;
export const PLANE_ALERT_CODE_RE = /^[A-Za-z0-9_.:+-]{1,96}$/;
export const PLANE_ERROR_CLASS_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const PLANE_EVENT_TYPE_RE = /^[a-z0-9_.]{1,64}$/;
/** ISO 8601 UTC with milliseconds, the only time shape the contract allows. */
export const PLANE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Stripe's id and key prefixes, as the contract lists them. */
export const PLANE_ID_PREFIXES: readonly string[] = [
  "evt_", "cus_", "sub_", "acct_", "sk_", "rk_", "pk_", "whsec_", "in_", "ii_", "il_", "ch_", "pi_", "py_",
  "cs_", "si_", "pm_", "re_", "dp_", "po_", "tr_", "txn_", "src_", "tok_", "card_", "ba_", "bpc_", "prod_",
  "seti_", "cn_",
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A prefix at the start, or after any character that is not a letter or a digit. */
const ID_PREFIX_RE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${PLANE_ID_PREFIXES.map((p) => p.slice(0, -1)).join("|")})_`);
/** A run this long is an id, a key or a hash. */
const LONG_RUN_RE = /[A-Za-z0-9]{20,}/;

/** Could it carry an identifier or a secret: an address, a uuid, an id prefix or a long run? */
export function looksLikeAnIdentifier(s: string): boolean {
  return s.includes("@") || UUID_RE.test(s) || ID_PREFIX_RE.test(s) || LONG_RUN_RE.test(s);
}

export const PLANE_STAGES = ["verify", "apply", "record", "link"] as const;
export const PLANE_VERDICTS: readonly PlaneOpsVerdict[] = ["done", "failed", "timed_out", "skipped_locked"];
export const PLANE_SEVERITIES: readonly PlaneOpsSeverity[] = ["critical", "warning", "signal"];
/** `alerts` carries at most this many entries, the two special keys included. */
export const PLANE_ALERTS_MAX = 50;
/** A bound on `passes`: the plane runs eight. */
export const PLANE_PASSES_MAX = 32;
/** How far `observedAt` may sit from this reader's clock, either way: past it the answer is not now. */
export const PLANE_OBSERVED_SKEW_MS = 15 * 60 * 1000;
/** `alert_state.count` is an int4. */
const INT4_MAX = 2_147_483_647;

type Bad = { bad: string };
const bad = (path: string): Bad => ({ bad: path });

const obj = (v: unknown): Record<string, unknown> | null =>
  (typeof v === "object" && v !== null && !Array.isArray(v)) ? v as Record<string, unknown> : null;
const member = <T>(set: readonly T[], v: unknown): v is T => (set as readonly unknown[]).includes(v);
const whole = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const instant = (v: unknown): v is string =>
  typeof v === "string" && PLANE_TIME_RE.test(v) && Number.isFinite(Date.parse(v));
const kept = (v: unknown, shape: RegExp): v is string =>
  typeof v === "string" && shape.test(v) && !looksLikeAnIdentifier(v);

/** `events_failed`, `unrecorded`, or `<stage>:<code>` whose code could not carry an identifier. */
function alertKeyOk(v: unknown): v is string {
  if (v === "events_failed" || v === "unrecorded") return true;
  if (typeof v !== "string") return false;
  const colon = v.indexOf(":");
  return colon > 0 && member(PLANE_STAGES, v.slice(0, colon)) && kept(v.slice(colon + 1), PLANE_ALERT_CODE_RE);
}

function passOf(raw: unknown, at: string): PlaneOpsPass | Bad {
  const p = obj(raw);
  if (!p) return bad(at);
  if (typeof p.name !== "string" || !PLANE_PASS_NAME_RE.test(p.name)) return bad(`${at}.name`);
  if (typeof p.stale !== "boolean") return bad(`${at}.stale`);
  if (!member(PLANE_SEVERITIES, p.severity)) return bad(`${at}.severity`);
  if (!whole(p.ageSeconds)) return bad(`${at}.ageSeconds`);
  if (!whole(p.staleAfterSeconds)) return bad(`${at}.staleAfterSeconds`);
  if (p.lastDoneAt !== null && !instant(p.lastDoneAt)) return bad(`${at}.lastDoneAt`);
  if (p.lastOutcome !== null && !member(PLANE_VERDICTS, p.lastOutcome)) return bad(`${at}.lastOutcome`);
  if (p.lastOutcomeAt !== null && !instant(p.lastOutcomeAt)) return bad(`${at}.lastOutcomeAt`);
  if (!whole(p.failureStreak)) return bad(`${at}.failureStreak`);
  if (p.lastErrorClass !== null && !kept(p.lastErrorClass, PLANE_ERROR_CLASS_RE)) return bad(`${at}.lastErrorClass`);
  if (typeof p.recorded !== "boolean") return bad(`${at}.recorded`);
  return {
    name: p.name, stale: p.stale, severity: p.severity as PlaneOpsSeverity,
    ageSeconds: p.ageSeconds as number, staleAfterSeconds: p.staleAfterSeconds as number,
    lastDoneAt: p.lastDoneAt as string | null, lastOutcome: p.lastOutcome as PlaneOpsVerdict | null,
    lastOutcomeAt: p.lastOutcomeAt as string | null, failureStreak: p.failureStreak as number,
    lastErrorClass: p.lastErrorClass as string | null, recorded: p.recorded,
  };
}

function alertOf(raw: unknown, at: string): PlaneOpsAlert | Bad {
  const a = obj(raw);
  if (!a) return bad(at);
  if (!alertKeyOk(a.key)) return bad(`${at}.key`);
  if (!member(PLANE_SEVERITIES, a.severity)) return bad(`${at}.severity`);
  if (!whole(a.count, INT4_MAX)) return bad(`${at}.count`);
  if (!instant(a.firstAt)) return bad(`${at}.firstAt`);
  if (!instant(a.lastAt)) return bad(`${at}.lastAt`);
  if (a.eventType !== null && !kept(a.eventType, PLANE_EVENT_TYPE_RE)) return bad(`${at}.eventType`);
  return {
    key: a.key, severity: a.severity as PlaneOpsSeverity, count: a.count as number,
    firstAt: a.firstAt as string, lastAt: a.lastAt as string, eventType: a.eventType as string | null,
  };
}

/** The answer, or the path of the first field outside the contract. `now` is this reader's clock. */
export function parsePlaneOps(body: unknown, now: Date): PlaneOpsAnswer | Bad {
  const b = obj(body);
  if (!b) return bad("body");
  if (b.v !== 1) return bad("v");
  if (!instant(b.observedAt) || Math.abs(Date.parse(b.observedAt) - now.getTime()) > PLANE_OBSERVED_SKEW_MS) {
    return bad("observedAt");
  }
  if (!Array.isArray(b.passes) || b.passes.length < 1 || b.passes.length > PLANE_PASSES_MAX) return bad("passes");
  const passes: PlaneOpsPass[] = [];
  const names = new Set<string>();
  for (const [i, raw] of (b.passes as unknown[]).entries()) {
    const p = passOf(raw, `passes[${i}]`);
    if ("bad" in p) return p;
    if (names.has(p.name)) return bad(`passes[${i}].name`);
    names.add(p.name);
    passes.push(p);
  }
  if (!Array.isArray(b.alerts) || b.alerts.length > PLANE_ALERTS_MAX) return bad("alerts");
  const alerts: PlaneOpsAlert[] = [];
  const keys = new Set<string>();
  for (const [i, raw] of (b.alerts as unknown[]).entries()) {
    const a = alertOf(raw, `alerts[${i}]`);
    if ("bad" in a) return a;
    if (keys.has(a.key)) return bad(`alerts[${i}].key`);
    keys.add(a.key);
    alerts.push(a);
  }
  if (typeof b.alertsTruncated !== "boolean") return bad("alertsTruncated");
  return { v: 1, observedAt: b.observedAt as string, passes, alerts, alertsTruncated: b.alertsTruncated };
}

/** The alert drivers' reader over a host's composition: null unless it meters and its port can ask. */
export function planeOpsReaderOf(entitlements: EntitlementsComposition): PlaneOpsReader | null {
  if (!isMetered(entitlements) || typeof entitlements.readOps !== "function") return null;
  const port = entitlements;
  return () => port.readOps!();
}
