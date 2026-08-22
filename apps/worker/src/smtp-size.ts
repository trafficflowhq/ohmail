import { and, eq, isNull } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import type { makeDb } from "@trafficflow/db/cloud";
import { WORKER_NET_TIMEOUTS, verifySmtpLogin } from "@trafficflow/core/adapters/imap";
import type { TransportCreds } from "./mailboxes.js";

/**
 * WHAT THE SENDING SERVER SAID IT WILL ACCEPT — learned for a mailbox that is ALREADY CONNECTED.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────────────────────
 *
 * `mailboxes.smtp_max_size_bytes` is the RFC 1870 `SIZE` a submission server announced in its
 * EHLO. Since attachment bytes stopped riding the send request — the browser puts them straight
 * into object storage and the send carries references — that column is the ONLY ceiling left on a
 * hosted send: the compose form promises `min(surface, SIZE)` and `SendService` enforces the same
 * pair, with the surface explicitly uncapped because no request body stands between them.
 *
 * An unprobed mailbox announces nothing, and nothing is deliberately read as the strict product
 * constant rather than as "no limit" — an unknown ceiling read as no ceiling costs somebody a
 * message they composed and waited for. That rule is right and is not touched here.
 *
 * What was missing is the other half: nothing ever LEARNED the number for a mailbox that already
 * existed. The column is written when a mailbox is created with an SMTP block, and when a PATCH
 * re-dials SMTP — which means the person re-entering their password. So every mailbox connected
 * before the column existed announced nothing for ever and was pinned to the strict fallback
 * regardless of what its provider actually accepts. Measured against the live database before this
 * landed: 15 of 16 rows held NULL, and the one exception was a row created after the column was.
 *
 * ── WHY THE WORKER AND NOT A ROUTE ──────────────────────────────────────────────────────────
 *
 * This process already decrypts these credentials, already walks every enabled mailbox on its
 * roster pass, and holds no request-body limit of its own to confuse the question with. Putting it
 * here means no new authenticated surface, no client change at all, and no user action: the number
 * appears in the mailbox list the compose form already reads, on the next pass.
 *
 * ── THE BOUNDS, BECAUSE THIS DIALS SOMEBODY ELSE'S SERVER ───────────────────────────────────
 *
 *  · ONE LOGIN PER MAILBOX PER PROCESS, at most. `attach` runs again whenever a mailbox detaches
 *    and re-attaches, and a mailbox that flaps would otherwise log in to its provider on every
 *    pass — which is how a provider decides to throttle a customer. The `attempted` set is marked
 *    BEFORE the dial, so a failure counts as an attempt too.
 *  · NEVER FOR AN OAUTH TRANSPORT. `buildImapAuth` yields a token callback for those, not a
 *    password, and `verifySmtpLogin` authenticates with a static password — handing it a refresh
 *    token in the password seat is the one mistake this narrowing exists to prevent. An oauth
 *    mailbox keeps the strict fallback until its own connect flow probes it.
 *  · NEVER THROWS. A submission server that refuses a login must cost this mailbox its ceiling
 *    and nothing else; an exception here would abort an attach, and an attach that aborts is a
 *    mailbox that stops syncing mail over an attachment limit.
 *  · SILENCE IS NOT A CEILING. A server that advertises no `SIZE`, a bare `SIZE` keyword, or
 *    `SIZE 0` (RFC 1870 §6: "no fixed maximum") all resolve to `null` and write NOTHING, leaving
 *    the strict fallback in place. Writing `0` would be a ceiling no message can clear.
 */

/** The dial this module performs, injectable so its decisions are testable without a server. */
export type SmtpSizeDial = (smtp: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => Promise<{ maxMessageBytes: number | null }>;

export type SmtpSizeOutcome =
  /** The column already holds an announcement. No dial was made. */
  | { outcome: "known"; maxMessageBytes: number }
  /** Nothing to dial with, or nothing to learn. No dial was made. */
  | { outcome: "skipped"; reason: "no_smtp_credentials" | "oauth_transport" | "already_attempted" }
  /** Dialled, and the server announced a usable ceiling. The caller records it. */
  | { outcome: "learned"; maxMessageBytes: number }
  /** Dialled, and the server announced nothing usable. Nothing to record. */
  | { outcome: "silent" }
  /** The dial failed. Reported, never thrown. */
  | { outcome: "failed"; error: string };

/** True for an SMTP credential that carries a static password — the only kind this can dial. */
function passwordAuth(smtp: TransportCreds): { user: string; pass: string } | null {
  const auth = smtp.auth as { user?: unknown; pass?: unknown };
  return typeof auth?.user === "string" && typeof auth?.pass === "string"
    ? { user: auth.user, pass: auth.pass }
    : null;
}

export async function learnSmtpMaxSize(input: {
  mailboxId: string;
  /** The stored `smtp_max_size_bytes`, or `null` when this mailbox has never announced one. */
  announced: number | null;
  /** The decrypted SMTP credential, absent when the mailbox has no `smtp` row. */
  smtp: TransportCreds | undefined;
  /** Mailbox ids this process has already tried. Mutated here — see the once-per-process bound. */
  attempted: Set<string>;
  dial: SmtpSizeDial;
}): Promise<SmtpSizeOutcome> {
  const { mailboxId, announced, smtp, attempted, dial } = input;

  // A stored announcement is the answer. Re-dialling to confirm it would spend a provider login
  // per pass to learn what the column already says.
  if (typeof announced === "number" && Number.isFinite(announced) && announced > 0) {
    return { outcome: "known", maxMessageBytes: announced };
  }
  if (attempted.has(mailboxId)) return { outcome: "skipped", reason: "already_attempted" };
  if (!smtp) return { outcome: "skipped", reason: "no_smtp_credentials" };

  const auth = passwordAuth(smtp);
  if (!auth) return { outcome: "skipped", reason: "oauth_transport" };

  // BEFORE the dial, so a failure counts. See the once-per-process bound in the header.
  attempted.add(mailboxId);

  try {
    const proof = await dial({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth });
    const bytes = proof.maxMessageBytes;
    // The same admissibility test the column's readers apply, restated here rather than trusted:
    // this is the last point at which a `0` or a `NaN` could become a stored ceiling.
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0
      ? { outcome: "learned", maxMessageBytes: bytes }
      : { outcome: "silent" };
  } catch (err) {
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** The production dial: a real SMTP login on the TLS floor, on the worker's own timeouts. */
export const smtpSizeDial: SmtpSizeDial = (smtp) => verifySmtpLogin(smtp, WORKER_NET_TIMEOUTS);

/**
 * Record what the server announced — and ONLY over a row that still announces nothing.
 *
 * The `IS NULL` predicate is not belt-and-braces: this runs on a roster pass, and a PATCH that
 * re-dialled SMTP in the meantime is a MORE recent measurement of the same server by the same
 * ceremony that owns the column. Overwriting it with a value this dial learned earlier would move
 * the ceiling backwards for the user who just re-entered their password.
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
