import {
  accountSinkDelivery, dbUnreadableAlert, deliver, DEFAULT_ALERT_REPEAT_MS,
  type AlertDriver, type AlertSink, type DeliveryStreak, type ResolutionNotice,
  type SinkDegradation, type SinkEscalation, type SinkOutcome,
} from "./alerts.js";
import { mailCooldownMs } from "./alert-mail-policy.js";
import { isAlertDatabaseUnreadable } from "./alert-db-fault.js";

/**
 * THE PAGER'S LAST RESORT WHEN THE DATABASE IS GONE OR UNUSABLE. Every alert pass starts with
 * database reads and writes before it delivers, so a shared database that is down, read-only, out
 * of resources or too slow silences both drivers: the two-driver design covers a dead process, not
 * a dead database. This runs from a driver's `alert_pass_failed` path and pages
 * `alert_db_unreadable:<driver>` through the driver's own arms, from process memory alone: no read
 * and no write of any table, `alert_state` included.
 *
 * Per process: a page on the first classified failure of a process that never completed a pass,
 * else on the second in a row; again once an hour while it lasts, mail once every 6 h; one resolved
 * notice to the push and webhook arms when a pass completes again (mail gets none, as the mail
 * policy says). A pager with no usable arm sees nothing at all.
 */

/** Classified failures in a row before a process that has completed a pass pages. */
export const LAST_RESORT_ENTRY_AFTER = 2;
/** The reminder window, the ordinary critical repeat. */
export const LAST_RESORT_REPAGE_MS = DEFAULT_ALERT_REPEAT_MS;

/** One process's memory, like `DeliveryStreak`: the caller holds it for the process's life. */
export interface LastResortState {
  /** This process has completed an alert pass: a cold process pages on its first failure. */
  completedPass: boolean;
  /** Classified failures in a row. */
  streak: number;
  /** ISO of the episode's first classified failure, null between episodes. */
  episodeSince: string | null;
  /** Pages this episode delivered. A resolved notice is owed when it is not 0. */
  episodePages: number;
  /** Epoch ms of the last page any arm accepted. Kept across episodes, so a relapse waits it out. */
  pagedAt: number | null;
  /** Epoch ms of the last page a mail arm accepted. */
  mailedAt: number | null;
  /** A delivery is in flight. */
  busy: boolean;
}

export function newLastResortState(): LastResortState {
  return {
    completedPass: false, streak: 0, episodeSince: null, episodePages: 0,
    pagedAt: null, mailedAt: null, busy: false,
  };
}

export interface LastResortContext {
  sinks: readonly AlertSink[];
  driver: AlertDriver;
  environment: string;
  now: Date;
  /** The driver's own streak, advanced as a pass's delivery would advance it. */
  deliveryStreak?: DeliveryStreak;
}

export interface LastResortReport {
  /** `paged`: the episode's first page; `reminded`: a later one; `refused`: no arm accepted. */
  state: "paged" | "reminded" | "refused" | "resolved";
  alertKey: string;
  delivered: string[];
  failedSinks: string[];
  sinkErrors: string[];
  escalate: SinkEscalation | null;
  sinkDegraded: SinkDegradation[];
}

const usableOf = (sinks: readonly AlertSink[]): AlertSink[] => sinks.filter((s) => !s.unusable);

/**
 * One failed pass. Never throws. Every state change before the first await, so two overlapping
 * failures cannot both send. Returns null when nothing was sent.
 */
export async function lastResortFailed(
  state: LastResortState, err: unknown, ctx: LastResortContext,
): Promise<LastResortReport | null> {
  try {
    if (usableOf(ctx.sinks).length === 0) return null;
    if (!isAlertDatabaseUnreadable(err)) return null;
    const now = ctx.now.getTime();
    state.streak += 1;
    state.episodeSince ??= ctx.now.toISOString();
    if (state.streak < (state.completedPass ? LAST_RESORT_ENTRY_AFTER : 1)) return null;
    if (state.busy) return null;
    if (state.pagedAt !== null && now - state.pagedAt < LAST_RESORT_REPAGE_MS) return null;
    const alert = dbUnreadableAlert(ctx.driver);
    const mailDue = state.mailedAt === null || now - state.mailedAt >= mailCooldownMs(alert.kind);
    const arms = usableOf(ctx.sinks).filter((s) => s.channel !== "mail" || mailDue);
    if (arms.length === 0) return null;
    state.busy = true;
    try {
      const report = await deliver(arms, [alert], { source: ctx.driver, environment: ctx.environment, now: ctx.now });
      const acct = accountSinkDelivery(
        ctx.deliveryStreak, ctx.sinks, report.outcomes, report.delivered, report.failed, report.errors,
        ctx.now, {},
      );
      let next: LastResortReport["state"] = "refused";
      if (report.delivered.length > 0) {
        state.pagedAt = now;
        if (arms.some((s) => s.channel === "mail" && report.delivered.includes(s.name))) state.mailedAt = now;
        state.episodePages += 1;
        next = state.episodePages === 1 ? "paged" : "reminded";
      }
      return {
        state: next, alertKey: alert.key,
        delivered: report.delivered, failedSinks: report.failed, sinkErrors: report.errors,
        escalate: acct.escalate, sinkDegraded: acct.sinkDegraded,
      };
    } finally {
      state.busy = false;
    }
  } catch {
    return null;
  }
}

/**
 * One completed pass. Never throws. Clears the episode; if it paged, one resolved notice to the arms
 * that take one (push and webhook; never mail). The last page time is kept.
 */
export async function lastResortSucceeded(
  state: LastResortState, ctx: LastResortContext,
): Promise<LastResortReport | null> {
  try {
    const paged = state.episodePages;
    const since = state.episodeSince;
    state.completedPass = true;
    state.streak = 0;
    state.episodeSince = null;
    state.episodePages = 0;
    if (paged === 0 || since === null || state.busy) return null;
    const arms = usableOf(ctx.sinks).filter((s) => s.channel !== "mail" && s.notifyResolved);
    if (arms.length === 0) return null;
    const alert = dbUnreadableAlert(ctx.driver);
    const notice: ResolutionNotice = {
      key: alert.key, kind: alert.kind, openedAt: since, resolvedAt: ctx.now.toISOString(), pages: paged,
    };
    const notifyCtx = { source: ctx.driver, environment: ctx.environment, now: ctx.now };
    state.busy = true;
    try {
      const outcomes: SinkOutcome[] = [];
      for (const sink of arms) {
        let ok = false;
        let error: string | null = null;
        let outcome: SinkOutcome["outcome"] | null = null;
        try {
          const out = await sink.notifyResolved!([notice], notifyCtx);
          if (typeof out === "boolean") ok = out;
          else { ok = out.ok; error = out.error ?? null; outcome = out.outcome ?? null; }
        } catch (e) {
          outcome = "threw";
          error = `threw: ${(e as { message?: string })?.message ?? String(e)}`.slice(0, 200);
        }
        outcomes.push({ sink: sink.name, ok, outcome: outcome ?? (ok ? "ok" : "refused"), error });
      }
      const delivered = outcomes.filter((o) => o.ok).map((o) => o.sink);
      const failed = outcomes.filter((o) => !o.ok).map((o) => o.sink);
      const errors = outcomes.filter((o) => !o.ok && o.error).map((o) => `${o.sink}: ${o.error}`);
      const acct = accountSinkDelivery(ctx.deliveryStreak, ctx.sinks, outcomes, delivered, failed, errors, ctx.now, {});
      return {
        state: "resolved", alertKey: alert.key, delivered, failedSinks: failed, sinkErrors: errors,
        escalate: acct.escalate, sinkDegraded: acct.sinkDegraded,
      };
    } finally {
      state.busy = false;
    }
  } catch {
    return null;
  }
}

/** One line a host writes for a report, by a fixed event name; the host makes the named call. */
export interface LastResortLogLine {
  level: "warn" | "error";
  event: "alert_last_resort" | "alerts_undeliverable" | "alert_sink_degraded";
  fields: Record<string, unknown>;
}

/**
 * The lines for one report, with the field names a normal pass uses: `alert_last_resort`, then
 * `alerts_undeliverable` on an escalation and `alert_sink_degraded` per arm lost.
 */
export function lastResortLogLines(report: LastResortReport): LastResortLogLine[] {
  const lines: LastResortLogLine[] = [{
    level: report.state === "refused" ? "error" : "warn",
    event: "alert_last_resort",
    fields: {
      state: report.state, alertKey: report.alertKey,
      delivered: report.delivered, failedSinks: report.failedSinks, sinkErrors: report.sinkErrors,
    },
  }];
  for (const lost of report.sinkDegraded) {
    lines.push({
      level: "error",
      event: "alert_sink_degraded",
      fields: {
        sink: lost.sink, outcome: lost.outcome, consecutiveFailures: lost.consecutiveFailures,
        survivors: lost.survivors, sinkErrors: lost.error ? [`${lost.sink}: ${lost.error}`] : [],
        reason: "one alert sink has refused every delivery for a full streak while another " +
          "delivered — pages are still landing, and the pager is back to a single vendor",
      },
    });
  }
  if (report.escalate) {
    lines.push({
      level: "error",
      event: "alerts_undeliverable",
      fields: {
        firing: 1,
        reason: "every configured alert sink refused delivery, repeatedly — alerts are reaching nobody",
        sinks: report.escalate.sinks,
        consecutiveFailures: report.escalate.consecutiveFailures,
        sinkErrors: report.escalate.errors,
      },
    });
  }
  return lines;
}
