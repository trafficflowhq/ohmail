import { and, eq, isNull } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { makeDb } from "@trafficflow/db/cloud";
import {
  WORKER_NET_TIMEOUTS, verifySmtpLogin, type SmtpSizeDial,
} from "@trafficflow/core/adapters/imap";

/**
 * THE SYNC HOST'S HALF of the `SIZE` back-fill. The rule itself is `learnSmtpMaxSize` in
 * `@trafficflow/core/adapters/imap`, beside the dial it decides about; what is host-specific is the
 * timeouts and the write, and that is all this file holds.
 *
 * ── AND IT DOES NOT WORK ON THE MANAGED DEPLOYMENT, WHICH IS MEASURED, NOT ASSUMED ──────────
 *
 * Railway blocks outbound SMTP submission. Measured 2026-08-22 on the production worker: twelve
 * distinct submission hosts every one of which answered `Connection timeout`, while the IMAP dial
 * to THE SAME HOST on 993 completed in about 300 ms in the very next log line. That is a port-level
 * block, not a provider problem, and no amount of timeout tuning here changes it.
 *
 * So the managed deployment learns these numbers from the API host instead, on a schedule
 * (`packages/api/src/smtp-size.ts`), where the send path's own SMTP dial already proves the egress
 * works. This path is KEPT rather than deleted because it is correct wherever egress is open — a
 * self-hosted worker in Docker on somebody's own network is exactly that case, and it is bounded to
 * one login per mailbox per process, so on a blocked host it costs one refused connection each and
 * logs it at `info`.
 *
 * ── AND IT DELIBERATELY DOES NOT WRITE MAIL 0063'S ATTEMPT STAMP ────────────────────────────
 *
 * The scheduled pass on the API host records `smtp_size_probed_at` / `smtp_size_probe_code` so a
 * permanently silent server is re-asked on a backoff instead of every day. This arm must NOT: on the
 * managed deployment every dial from here fails on a blocked port, so stamping would write
 * `unreachable` across the whole fleet and suppress the one host whose egress works — the back-fill
 * would converge on "nothing is probeable" while the path that functions sat idle. This arm's bound
 * stays the in-memory one-dial-per-mailbox-per-process guard, which is the right shape for a
 * long-lived process anyway.
 */

/** The production dial from this host: a real SMTP login on the TLS floor, on the worker's timeouts. */
export const smtpSizeDial: SmtpSizeDial = (smtp) => verifySmtpLogin(smtp, WORKER_NET_TIMEOUTS);

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
