import type { Alert, AlertSink } from "@trafficflow/db/cloud";
import type { OperatorAlertContext, MailService } from "./mail-service.js";

/**
 * The SECOND delivery path for an operator alert: mail. The first is `webhookAlertSink` in
 * `packages/db` — the one that reaches a phone. This exists because an alerting system whose only
 * path can fail silently has the same defect as the thing it watches; the two share no
 * infrastructure. Not in `packages/db`: `MailService` lives here and the WORKER may not import
 * this package — `AlertSink` is declared in `db`, implemented on both sides. It never throws: a
 * throwing sink would abort the pass and the OTHER sink would never run. It holds a LIMITER, not
 * a database: {@link OperatorAlertContext} carries the single write the operator mail makes — one
 * `auth_throttle` slot claim — never the runtime connection it once captured.
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
