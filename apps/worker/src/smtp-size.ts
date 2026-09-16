import { and, eq, isNull } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { makeDb } from "@trafficflow/db/cloud";
import {
  WORKER_NET_TIMEOUTS, verifySmtpLogin, type SmtpSizeDial,
} from "@trafficflow/core/adapters/imap";
import { checkedDial, type DialHostGuard } from "./dial-host-guard.js";

/**
 * THE SYNC HOST'S HALF of the `SIZE` back-fill. The rule is `learnSmtpMaxSize` in
 * `@trafficflow/core/adapters/imap`; what is host-specific is the timeouts and the write. It does NOT work
 * on the managed deployment (measured, not assumed): Railway blocks outbound SMTP submission — 2026-08-22,
 * twelve submission hosts each answered `Connection timeout` while IMAP to the SAME host on 993 completed
 * in ~300 ms. So the managed deployment learns from the API host instead (`packages/api/src/smtp-size.ts`),
 * where the send path proves egress works. This path is KEPT because it is correct wherever egress is open
 * (a self-hosted worker), bounded to one login per mailbox per process. It deliberately does NOT write mail
 * 0063's `smtp_size_probed_at`/`smtp_size_probe_code`: here every dial fails on a blocked port, so stamping
 * would write `unreachable` fleet-wide and suppress the one host whose egress works; its bound stays the in-memory one-dial-per-mailbox-per-process guard. */

/**
 * The production dial from this host: a real SMTP login on the TLS floor, on the worker's timeouts,
 * under the DEPLOYMENT'S OWN POLICY. This is the organizer's fifth dial and it was the one that
 * handed a stored submission name to a fresh socket with no check and no pin, three lines above
 * the attach that checks. Same helper, same call shape and same refusal class as the four adapter
 * sites (`dial-host-guard.ts`). A FACTORY and not a constant, because a guard that can be omitted
 * is a guard: the policy is threaded from the composition root, and `checkedDial` refuses a
 * missing one by name. The refusal reaches `learnSmtpMaxSize`'s catch and becomes a closed code —
 * a probe that may not dial costs this mailbox its ceiling and nothing else.
 */
export function makeSmtpSizeDial(guard: DialHostGuard | undefined): SmtpSizeDial {
  return async (smtp) => verifySmtpLogin(
    { ...smtp, ...(await checkedDial(guard, smtp.host, "smtp")) },
    WORKER_NET_TIMEOUTS,
  );
}

/**
 * Record what the server announced — and ONLY over a row that still announces nothing.
 *
 * The `IS NULL` predicate is not belt-and-braces: this runs on a roster pass, and a PATCH that
 * re-dialled SMTP in the meantime is a MORE recent measurement of the same server by the ceremony
 * that owns the column. Overwriting it with a value this dial learned earlier would move the
 * ceiling backwards for the person who just re-entered their password.
 */
export async function recordSmtpMaxSize(
  db: ReturnType<typeof makeDb>,
  mailboxId: string,
  maxMessageBytes: number,
): Promise<void> {
  await db.update(mailboxes)
    .set({ smtpMaxSizeBytes: maxMessageBytes })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.smtpMaxSizeBytes)));
}
