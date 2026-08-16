import type { Alert, AlertSink } from "@trafficflow/db/cloud";
import type { OperatorAlertContext, MailService } from "./mail-service.js";

/**
 * The SECOND delivery path for an operator alert: mail.
 *
 * ## Why two paths at all
 *
 * The first path is `webhookAlertSink` in `packages/db`: one JSON POST, no dependencies,
 * usable from the worker. It is the one that reaches a phone. This one is mail, and it
 * exists because an alerting system whose only delivery path can fail silently is an
 * alerting system with the same defect as the thing it watches. The two share no
 * infrastructure — a chat provider and Resend are independent — so a single vendor outage
 * degrades the pager instead of removing it.
 *
 * ## Why it is not in `packages/db` with the other one
 *
 * `MailService` lives in `packages/services`, and the WORKER may not import that package at
 * all (the worker's dependency test pins it). Putting this sink next to the webhook sink
 * would put a `packages/services` import in `packages/db`, which every worker build would
 * then drag in. The seam is the point: `AlertSink` is declared in `db`, implemented on both
 * sides of the boundary, and the API host composes whichever ones it can reach.
 *
 * ## It never throws
 *
 * `AlertSink.notify` promises not to, and `MailService` already guarantees the same for
 * `send`. The catch here is the belt to that suspenders: a sink that throws would abort the
 * pass and the OTHER sink — the one that might have reached a human — would never run.
 *
 * ## IT HOLDS A LIMITER, NOT A DATABASE
 *
 * This sink is built inside the alert graph and lives for the process's lifetime, so whatever
 * it captures is a capability that exists behind a staff credential. It used to capture
 * `makePooledDb(cfg.databaseUrlPooled) as never`: the unrestricted runtime connection, silenced
 * by a double assertion, in the one path advertised as running "wholly on the blind
 * connection". {@link OperatorAlertContext} carries the single write the operator mail actually
 * makes — one `auth_throttle` slot claim — and nothing that can name a row.
 */
export function mailAlertSink(
  mail: MailService,
  ctx: OperatorAlertContext,
): AlertSink {
  return {
    name: "mail",
    async notify(alerts: readonly Alert[], notifyCtx): Promise<boolean> {
      try {
        const result = await mail.sendOperatorAlert(ctx, {
          alerts: alerts.map((a) => ({ title: a.title, detail: a.detail, severity: a.severity })),
          source: notifyCtx.source,
          environment: notifyCtx.environment,
        });
        // `skipped` is NOT success. The two reasons it can happen here are "no operator
        // address is configured" and "the per-recipient limiter refused", and treating
        // either as delivered would stamp `notified_at` on an alert nobody received —
        // which is the precise failure this whole slice exists to prevent, reproduced
        // inside the thing meant to prevent it.
        return result.status === "sent";
      } catch {
        return false;
      }
    },
  };
}
