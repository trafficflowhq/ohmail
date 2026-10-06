import type { Alert, AlertKind } from "./alert-types.js";
import { ENTITLEMENTS_FAULT_ROUTE_PREFIX } from "./api-faults.js";

/**
 * WHAT THE OPERATOR'S MAIL CARRIES (2026-10-05). A mail is a quota unit and a person's attention,
 * so it pages only for production down, mail stuck, accounts at risk and money; everything else
 * waits for the daily digest. This narrows MAIL sinks only: a sink with no `channel` (a push
 * line, a webhook) still gets every incident, which is the loud default `alertClass` keeps.
 * Pure: the pass in `alerts.ts` asks it inside the claim and owns every write.
 */

export type MailVerdict = "page" | "digest";

/** Routes whose faults are a person who cannot open their mail: they page, every other route waits. */
export const PAGE_ROUTE_PREFIXES: readonly string[] = ["/auth", "/sync"];

/** Accounts behind on sync before `sync_lag:critical` pages: one is usually its provider. */
export const SYNC_LAG_PAGE_ACCOUNTS = 3;

const routeOf = (a: Alert): string | null => {
  const m = /^api_fault_rate:(?:api|worker):(.+)$/.exec(a.key);
  return m ? m[1]! : null;
};

const isEntitlements = (a: Alert): boolean =>
  (routeOf(a) ?? "").startsWith(ENTITLEMENTS_FAULT_ROUTE_PREFIX);

const onPageRoute = (a: Alert): boolean => {
  const route = routeOf(a);
  return route !== null && PAGE_ROUTE_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`));
};

const page = (): MailVerdict => "page";
const digest = (): MailVerdict => "digest";

/**
 * One entry per kind, typed off `AlertKind`, so a new kind without a verdict fails the build.
 * Signals never reach it: the claim loop skips them before any policy is asked.
 */
export const MAIL_POLICY: { readonly [K in AlertKind]: (a: Alert) => MailVerdict } = {
  worker_down: page,
  worker_degraded: page,
  sends_stuck: page,
  credential_replay_wide: page,
  api_5xx_rate: page,
  pooler_refusals: page,
  schema_behind: page,
  alert_driver_dark: page,
  api_fault_rate: (a) => (isEntitlements(a) || onPageRoute(a) ? "page" : "digest"),
  sync_lag: (a) =>
    a.severity === "critical" && (a.affectedAccounts ?? 0) >= SYNC_LAG_PAGE_ACCOUNTS ? "page" : "digest",
  imap_admission_refused: digest,
  storage_at_cap: digest,
  ai_provider_down: digest,
  device_sync_stale: digest,
  session_sync_stale: digest,
  session_reuse_revoked: digest,
  session_refresh_replayed: digest,
};

/** The verdict for one firing incident; an unknown kind pages (the loud direction). */
export function mailVerdictOf(a: Alert): MailVerdict {
  const rule = (MAIL_POLICY as Record<string, ((a: Alert) => MailVerdict) | undefined>)[a.kind];
  return rule ? rule(a) : "page";
}

/** The ordinary page window, and the one kind that asks daily. */
export const MAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DRIVER_DARK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function mailCooldownMs(kind: string): number {
  return kind === "alert_driver_dark" ? DRIVER_DARK_COOLDOWN_MS : MAIL_COOLDOWN_MS;
}

/**
 * How far ahead of this pass's clock a window's stamp may be and still count: two drivers on two
 * hosts disagree by seconds. A stamp further ahead is a wrong clock and states no mail.
 */
export const MAIL_CLOCK_SKEW_MS = 15 * 60 * 1000;

/** The `kind` every policy row carries, beside `cls = 'signal'` and a resolved_at at the epoch. */
export const MAIL_POLICY_ROW_KIND = "mail_policy";

/** The row the daily digest claims. */
export const DIGEST_POLICY_KEY = "mail:digest";

/** How often the digest may go, counted from the last digest a mail sink accepted. */
export const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The window one page shares. Per kind, with the entitlements arm on its own row so both of its
 * paths (`/v1/access`, `/v1/spend`) and both drivers' keys are one window.
 */
export function policyKeyOf(a: Pick<Alert, "kind" | "key">): string {
  if (a.kind === "api_fault_rate" && isEntitlements(a as Alert)) return "mail:api_fault_rate:entitlements";
  return `mail:${a.kind}`;
}

/** Lines one digest prints before it points at the console. */
export const DIGEST_MAX_LINES = 30;

/**
 * One digest line. No `detail`: key, kind, title and timestamps, the fields a resolution notice
 * prints, so nothing here can carry what a message says.
 */
export interface DigestLine {
  key: string;
  kind: string;
  severity: string;
  title: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export interface AlertDigest {
  /** The start of the window: the last accepted digest, or a day before this one. */
  since: string;
  lines: DigestLine[];
  /** Rows past {@link DIGEST_MAX_LINES}, said as a count. */
  more: number;
}

export interface DigestRow {
  key: string;
  kind: string;
  severity: string | null;
  title: string | null;
  openedAt: unknown;
  resolvedAt: unknown;
}

const iso = (d: unknown): string => new Date(d as string).toISOString();

/** Rows arrive in the digest's order (open, critical, newest first); this caps and counts. */
export function renderDigestInput(rows: readonly DigestRow[], since: Date): AlertDigest {
  const lines: DigestLine[] = rows.slice(0, DIGEST_MAX_LINES).map((r) => ({
    key: r.key,
    kind: r.kind,
    severity: r.severity ?? "warning",
    title: r.title,
    openedAt: iso(r.openedAt),
    resolvedAt: r.resolvedAt === null || r.resolvedAt === undefined ? null : iso(r.resolvedAt),
  }));
  return { since: since.toISOString(), lines, more: Math.max(0, rows.length - DIGEST_MAX_LINES) };
}

/** The severity rank a policy row's `notified_signature` stores as `peak|<n>`. */
export function severityRankOf(severity: string): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}

export function storedRankOf(signature: string | null): number {
  const m = /^peak\|(\d+)$/.exec(signature ?? "");
  return m ? Number(m[1]) : 0;
}
